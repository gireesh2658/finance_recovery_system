import type { PrismaClient } from '@prisma/client';
import type { StateMachineService } from '../state/service';
import type { ReasonerService } from '../reasoner/service';
import type { RecoveryToolExecutor } from '../tools';
import { evaluateActionPolicy } from '../policy/engine';
import type { OrchestratorResult, VerifierBoundary } from './types';
import type { RecoveryCaseStatus } from '../state/types';
import type { ActionType, PolicyEvaluationContext } from '../policy/types';
import type { SanitizedCaseContext, ReasonerOutput } from '../reasoner/types';
import { LLMBudgetTracker } from '../../evaluation/types';

export class AgentOrchestrator {
  private prisma: PrismaClient;
  private stateService: StateMachineService;
  private reasonerService: ReasonerService;
  private toolExecutor: RecoveryToolExecutor;
  private verifier: VerifierBoundary;

  constructor(
    prisma: PrismaClient,
    stateService: StateMachineService,
    reasonerService: ReasonerService,
    toolExecutor: RecoveryToolExecutor,
    verifier: VerifierBoundary
  ) {
    this.prisma = prisma;
    this.stateService = stateService;
    this.reasonerService = reasonerService;
    this.toolExecutor = toolExecutor;
    this.verifier = verifier;
  }

  /**
   * Processes a single RecoveryCase through the deterministic workflow loop.
   */
  async processCase(caseId: string, tracker?: LLMBudgetTracker): Promise<OrchestratorResult> {
    const startTime = Date.now();
    let transitions = 0;
    const actionsAttempted: ActionType[] = [];
    const policyDecisions: Array<{ action: string; allowed: boolean; reason: string }> = [];
    
    // Initial fetch to get state
    let cCase = await this.prisma.recoveryCase.findUnique({ where: { id: caseId } });
    if (!cCase) throw new Error(`Case ${caseId} not found`);

    let currentState = cCase.status as RecoveryCaseStatus;
    const initialState = currentState;

    let reasonerResult: ReasonerOutput | null = null;
    let fallbackAlternatives: ActionType[] = [];
    let failureReason: string | undefined;
    let reasonerSuccess = false;
    let _latestToolResult: any = null;

    // Helper to safely transition state via the strict state machine service
    const advance = async (nextState: RecoveryCaseStatus, reason: string, payload?: { amountRecovered?: number }): Promise<boolean> => {
      try {
        const res = await this.stateService.requestTransition(caseId, currentState, nextState, reason, payload);
        if (res.success) {
          currentState = res.nextState;
          transitions++;
          return true;
        } else {
          currentState = res.nextState; // Stale or forced escalation
          return false;
        }
      } catch (err: any) {
        failureReason = `State transition error: ${err.message}`;
        return false; // Break loop on critical failure
      }
    };

    // Main orchestration loop
    while (!['RECOVERED', 'ESCALATED', 'CLOSED', 'WAITING_FOR_CUSTOMER'].includes(currentState)) {
      // Emergency circuit breaker for the loop itself
      if (transitions >= 25) {
        failureReason = 'Orchestration loop runaway detected';
        break;
      }

      switch (currentState) {
        case 'DETECTED': {
          await advance('DIAGNOSING', 'Beginning diagnosis phase');
          break;
        }

        case 'DIAGNOSING': {
          // Fetch SOP Policy deterministically
          const sopPolicies = await this.prisma.policy.findMany({
            where: { ruleType: 'STANDARD_OPERATING_PROCEDURE', isActive: true },
            orderBy: { priority: 'desc' }
          });
          
          if (sopPolicies.length === 0) {
            failureReason = 'Missing application business policy (SOP). Cannot safely reason.';
            await advance('ESCALATED', 'Escalating due to missing SOP');
            break;
          }
          
          if (sopPolicies.length > 1) {
            failureReason = 'Configuration error: Multiple active SOPs found. Cannot safely reason.';
            await advance('ESCALATED', 'Escalating due to multiple active SOPs');
            break;
          }
          
          let parsedSOP;
          try {
            parsedSOP = JSON.parse(sopPolicies[0].conditions);
          } catch (e) {
            failureReason = 'Malformed SOP policy JSON. Cannot safely reason.';
            await advance('ESCALATED', 'Escalating due to malformed SOP');
            break;
          }

          // Fetch context for reasoner
          const fullData = await this.prisma.recoveryCase.findUnique({
            where: { id: caseId },
            include: { payment: { include: { customer: true } } }
          });
          if (!fullData || !fullData.payment) throw new Error('Missing case data');

          const context: SanitizedCaseContext = {
            caseId,
            payment: {
              amountPaise: fullData.payment.amount,
              currency: fullData.payment.currency,
              method: fullData.payment.method,
              failureCode: fullData.payment.failureCode || 'UNKNOWN',
              failureReason: fullData.payment.failureReason || 'Unknown',
            },
            customer: {
              riskTier: fullData.payment.customer.riskTier,
              successfulPayments: fullData.payment.customer.totalPayments - fullData.payment.customer.failedPayments,
              failedPayments: fullData.payment.customer.failedPayments,
            },
            recoveryState: {
              status: currentState,
              attemptCount: fullData.attemptCount,
            },
            policiesSummary: ['Active policies applied deterministically by Engine.'],
            standardOperatingProcedures: parsedSOP,
          };

          const aiResult = await this.reasonerService.executeReasoning(context, `att_${Date.now()}`, tracker);
          
          if (aiResult.success && aiResult.data) {
            reasonerSuccess = true;
            reasonerResult = aiResult.data;
            // Build strategy stack (primary + alternatives)
            fallbackAlternatives = [reasonerResult.recommendedAction, ...reasonerResult.alternativeActions];
            // Remove duplicates
            fallbackAlternatives = [...new Set(fallbackAlternatives)];
            
            await advance('DIAGNOSED', 'AI Diagnosis complete');
          } else {
            reasonerSuccess = false;
            failureReason = `Reasoner failed: ${aiResult.error}`;
            await advance('ESCALATED', 'Escalating due to reasoner failure');
          }
          break;
        }

        case 'DIAGNOSED': {
          await advance('STRATEGY_PENDING', 'Moving to strategy formulation');
          break;
        }

        case 'STRATEGY_PENDING': {
          await advance('POLICY_CHECK', 'Evaluating strategy against policies');
          break;
        }

        case 'POLICY_CHECK': {
          if (fallbackAlternatives.length === 0) {
            failureReason = 'No viable actions remaining';
            await advance('POLICY_DENIED', 'No viable actions');
            break;
          }

          // Pick the next action to evaluate
          const actionToEvaluate = fallbackAlternatives.shift()!;
          
          // Fetch context for policy evaluation
          const fullData = await this.prisma.recoveryCase.findUnique({
            where: { id: caseId },
            include: { payment: { include: { customer: true } } }
          });
          const policies = await this.prisma.policy.findMany({ where: { isActive: true } });

          const evalContext: PolicyEvaluationContext = {
            requestedAction: actionToEvaluate,
            caseState: fullData!,
            paymentInfo: fullData!.payment!,
            customerInfo: fullData!.payment!.customer,
            policies,
            currentTimestampMs: Date.now()
          };

          // Deterministic Policy Evaluation
          let policyDecision;
          try {
            policyDecision = evaluateActionPolicy(evalContext);
          } catch (e: any) {
            failureReason = `Policy Engine Error: ${e.message}`;
            await advance('POLICY_DENIED', 'Policy Engine failed closed');
            break;
          }

          policyDecisions.push({
            action: actionToEvaluate,
            allowed: policyDecision.allowed,
            reason: policyDecision.reason
          });

          if (policyDecision.allowed) {
            // Push it back to the front so EXECUTING knows what to do
            fallbackAlternatives.unshift(actionToEvaluate);
            await advance('ACTION_APPROVED', `Policy approved action: ${actionToEvaluate}`);
          } else {
            await advance('POLICY_DENIED', `Policy denied action: ${actionToEvaluate}`);
          }
          break;
        }

        case 'POLICY_DENIED': {
          if (fallbackAlternatives.length > 0) {
            // We have more alternatives to try
            await advance('STRATEGY_PENDING', 'Trying alternative strategy');
          } else {
            // Exhausted all safe options
            await advance('ESCALATED', 'All available strategies denied by policy');
          }
          break;
        }

        case 'ACTION_APPROVED': {
          await advance('EXECUTING', 'Executing approved action');
          break;
        }

        case 'EXECUTING': {
          const actionToExecute = fallbackAlternatives.shift(); // Exhaust the strategy
          if (!actionToExecute) {
            failureReason = 'Execution state reached but no approved action found';
            await advance('ESCALATED', failureReason);
            break;
          }

          actionsAttempted.push(actionToExecute);
          
          const fullData = await this.prisma.recoveryCase.findUnique({
            where: { id: caseId },
            include: { payment: true }
          });

          const toolInput = {
            caseId,
            paymentId: fullData!.paymentId,
            customerId: fullData!.payment!.customerId,
            actionType: actionToExecute,
            attemptNumber: fullData!.attemptCount + 1, // Basic attempt increment
            amountPaise: fullData!.amountAtRisk
          };

          try {
            // Static mapping constraint
            let toolResult;
            if (actionToExecute === 'RETRY_PAYMENT') toolResult = await this.toolExecutor.retryPayment(toolInput);
            else if (actionToExecute === 'SEND_PAYMENT_LINK') toolResult = await this.toolExecutor.generatePaymentLink(toolInput);
            else if (actionToExecute === 'NOTIFY_CUSTOMER') toolResult = await this.toolExecutor.notifyCustomer(toolInput);
            else if (actionToExecute === 'ESCALATE_TO_HUMAN') toolResult = await this.toolExecutor.escalateToHuman(toolInput);
            else throw new Error(`Unmapped tool execution attempt: ${actionToExecute}`);

            // Important: we update the case attemptCount here strictly to ensure attempt increments
            await this.prisma.recoveryCase.update({
              where: { id: caseId },
              data: { attemptCount: { increment: 1 } }
            });

            // Store result for verification phase
            _latestToolResult = toolResult;

            await advance('VERIFYING', `Tool ${actionToExecute} executed`);
          } catch (error: any) {
            failureReason = `Tool execution failed: ${error.message}`;
            // If the tool crashes severely, we escalate
            await advance('ESCALATED', failureReason);
          }
          break;
        }

        case 'VERIFYING': {
          let toolResult = _latestToolResult;
          
          if (!toolResult) {
            // Asynchronous resumption: durably load the exact RecoveryAttempt
            // that triggered this waiting state.
            const resumedAttempt = await this.prisma.recoveryAttempt.findUnique({
              where: {
                caseId_attemptNumber: {
                  caseId,
                  attemptNumber: cCase.attemptCount
                }
              }
            });
            if (resumedAttempt && resumedAttempt.actionOutput) {
              toolResult = JSON.parse(resumedAttempt.actionOutput);
            }
          }

          if (!toolResult) {
             failureReason = 'Verifier boundary reached with no tool result and no durable attempt found';
             await advance('ESCALATED', failureReason);
             break;
          }

          try {
            const verifyResult = await this.verifier.verify(caseId, toolResult);
            if (verifyResult.outcome === 'RECOVERED') {
              await advance('RECOVERED', 'Verification confirmed recovery', { amountRecovered: verifyResult.amountRecovered });
            } else if (verifyResult.outcome === 'RETRY') {
              await advance('RETRY_PENDING', 'Verification requires retry');
            } else if (verifyResult.outcome === 'WAITING') {
              await advance('WAITING_FOR_CUSTOMER', 'Verification is waiting for customer action');
            } else {
              await advance('ESCALATED', 'Verification requested escalation');
            }
          } catch (e: any) {
             failureReason = `Verifier crashed: ${e.message}`;
             await advance('ESCALATED', failureReason);
          }
          break;
        }

        case 'RETRY_PENDING': {
          // A retry clears the fallback stack so a fresh strategy can be reasoned/policies evaluated?
          // The prompt says: "RETRY_PENDING -> STRATEGY_PENDING. The next strategy must again pass through Reasoner/policy..."
          // Since we already reasoned, do we just re-evaluate the primary action?
          // For now, retry just loops back to strategy pending with the remaining alternatives
          await advance('STRATEGY_PENDING', 'Cycling retry back to strategy formulation');
          break;
        }

        default:
          failureReason = `Unknown state: ${currentState}`;
          break; // Force break
      }
      
      // Safety check: if state didn't change (e.g., state service rejected the transition), break loop
      if (currentState === cCase.status) {
         break;
      }
      cCase.status = currentState;
    }

    return {
      caseId,
      initialState,
      finalState: currentState,
      actionsAttempted,
      policyDecisions,
      reasonerSuccess,
      recoveryResult: currentState === 'RECOVERED' ? 'SUCCESS' : (currentState === 'ESCALATED' ? 'ESCALATED' : (currentState === 'WAITING_FOR_CUSTOMER' ? 'WAITING' : 'UNKNOWN')),
      escalationStatus: currentState === 'ESCALATED',
      failureReason,
      executionSummary: {
        durationMs: Date.now() - startTime,
        transitions
      }
    };
  }
}
