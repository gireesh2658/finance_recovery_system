import { PrismaClient } from '@prisma/client';
import type { ToolInput, ToolResult } from './types';

// Deterministic mock duration
const SIMULATED_DURATION = 150; 

export class RecoveryToolExecutor {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Idempotent wrapper for executing any tool.
   * Splits reservation and finalization into separate transactions to survive process crashes.
   */
  private async executeIdempotent(
    input: ToolInput, 
    executorLogic: (attemptId: string) => Promise<{ result: ToolResult; paymentStatusUpdate?: string }>
  ): Promise<ToolResult> {
    
    // ==========================================
    // 1. RESERVATION TRANSACTION
    // ==========================================
    let attemptId: string;
    let executeExternal = true;
    let cachedResult: ToolResult | null = null;

    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id: input.paymentId },
        include: { recoveryCase: true }
      });

      if (!payment) throw new Error(`Payment ${input.paymentId} not found`);
      if (!payment.recoveryCase || payment.recoveryCase.id !== input.caseId) {
        throw new Error(`Invalid case ${input.caseId} for payment ${input.paymentId}`);
      }
      if (payment.amount !== input.amountPaise) {
        throw new Error(`Amount mismatch. Expected ${payment.amount}, got ${input.amountPaise}.`);
      }

      const terminalStates = ['RECOVERED', 'ESCALATED', 'CLOSED'];
      if (terminalStates.includes(payment.recoveryCase.status)) {
        throw new Error(`Cannot execute tool: Case is in terminal state ${payment.recoveryCase.status}`);
      }

      // Financial Idempotency invariant: Never execute financial effect if payment is already SUCCESS
      if (input.actionType === 'RETRY_PAYMENT' && payment.status === 'SUCCESS') {
        throw new Error(`Idempotency violation: Payment is already SUCCESS. Cannot retry payment.`);
      }

      const existingAttempt = await tx.recoveryAttempt.findUnique({
        where: {
          caseId_attemptNumber: {
            caseId: input.caseId,
            attemptNumber: input.attemptNumber
          }
        }
      });

      if (existingAttempt) {
        if (existingAttempt.status === 'SUCCESS' || existingAttempt.status === 'FAILED') {
          executeExternal = false;
          cachedResult = JSON.parse(existingAttempt.actionOutput!) as ToolResult;
          return;
        }

        // It is EXECUTING. Check for stale execution.
        const staleThreshold = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes
        if (existingAttempt.createdAt > staleThreshold) {
          throw new Error(`Concurrent execution blocked: Attempt ${input.attemptNumber} is actively EXECUTING.`);
        }
        
        // It is STALE. We resume ownership and will re-execute the external call using the same ID.
        attemptId = existingAttempt.id;
      } else {
        const attempt = await tx.recoveryAttempt.create({
          data: {
            caseId: input.caseId,
            attemptNumber: input.attemptNumber,
            actionType: input.actionType,
            actionInput: JSON.stringify(input),
            status: 'EXECUTING',
            policyCheckPassed: true,
          }
        });
        attemptId = attempt.id;
      }
    });

    if (!executeExternal && cachedResult) {
      return cachedResult;
    }

    // ==========================================
    // 2. EXTERNAL EXECUTION (Unbound from DB TX)
    // ==========================================
    // If the process crashes here, the database retains the EXECUTING attempt.
    // A future run will see it as STALE and resume using the exact same attemptId as the idempotency key.
    const { result, paymentStatusUpdate } = await executorLogic(attemptId!);

    // ==========================================
    // 3. FINALIZATION TRANSACTION
    // ==========================================
    await this.prisma.$transaction(async (tx) => {
      // Re-verify the attempt hasn't been modified unexpectedly
      const currentAttempt = await tx.recoveryAttempt.findUnique({ where: { id: attemptId } });
      if (!currentAttempt || currentAttempt.status !== 'EXECUTING') {
        throw new Error(`Finalization aborted: Attempt ${attemptId} is no longer EXECUTING.`);
      }

      // If the tool successfully captured funds, update the payment atomically
      if (paymentStatusUpdate) {
        const currentPayment = await tx.payment.findUnique({ where: { id: input.paymentId } });
        if (currentPayment?.status !== 'SUCCESS') {
          await tx.payment.update({
            where: { id: input.paymentId },
            data: { status: paymentStatusUpdate }
          });
        }
      }

      await tx.recoveryAttempt.update({
        where: { id: attemptId },
        data: {
          status: result.success ? 'SUCCESS' : 'FAILED',
          actionOutput: JSON.stringify(result),
          executionDurationMs: result.executionDurationMs,
        }
      });

      await tx.auditEvent.create({
        data: {
          caseId: input.caseId,
          attemptId: attemptId,
          eventType: 'TOOL_EXECUTED',
          actor: 'AGENT_ENGINE',
          details: JSON.stringify({
            action: input.actionType,
            success: result.success,
            outcome: result.outcome,
          })
        }
      });
    });

    return result;
  }

  /**
   * 1. retryPayment
   */
  async retryPayment(input: ToolInput): Promise<ToolResult> {
    if (input.actionType !== 'RETRY_PAYMENT') throw new Error('Invalid action type');

    return this.executeIdempotent(input, async (attemptId) => {
      const payment = await this.prisma.payment.findUnique({ where: { id: input.paymentId } });
      const failureCode = payment!.failureCode;

      let isSuccess = false;
      let outcome = 'FAILED';
      let message = 'Retry declined by simulated bank.';
      let paymentStatusUpdate: string | undefined = undefined;

      if (failureCode === 'NETWORK_TIMEOUT' || failureCode === 'GATEWAY_ERROR') {
        isSuccess = true;
      } else if (failureCode === 'INSUFFICIENT_FUNDS') {
        isSuccess = false;
        message = 'Simulated response: Insufficient funds remain.';
      } else {
        isSuccess = false;
      }

      if (isSuccess) {
        outcome = 'SUCCESS';
        message = 'Retry successful. Payment captured.';
        paymentStatusUpdate = 'SUCCESS';
      }

      return {
        result: {
          success: isSuccess,
          actionType: 'RETRY_PAYMENT',
          caseId: input.caseId,
          paymentId: input.paymentId,
          outcome,
          referenceId: `txn_sim_${input.paymentId}_${attemptId}`, // Deterministic external ID
          message,
          executionDurationMs: SIMULATED_DURATION,
          metadata: { simulated: true, originalFailure: failureCode }
        },
        paymentStatusUpdate
      };
    });
  }

  /**
   * 2. generatePaymentLink
   */
  async generatePaymentLink(input: ToolInput): Promise<ToolResult> {
    if (input.actionType !== 'SEND_PAYMENT_LINK') throw new Error('Invalid action type');

    return this.executeIdempotent(input, async (attemptId) => {
      return {
        result: {
          success: true,
          actionType: 'SEND_PAYMENT_LINK',
          caseId: input.caseId,
          paymentId: input.paymentId,
          outcome: 'LINK_GENERATED',
          referenceId: `plink_sim_${input.paymentId}_${attemptId}`,
          message: 'Payment link generated successfully.',
          executionDurationMs: SIMULATED_DURATION,
          metadata: { linkUrl: `https://sim.pay/link/${input.paymentId}` }
        }
      };
    });
  }

  /**
   * 3. notifyCustomer
   */
  async notifyCustomer(input: ToolInput): Promise<ToolResult> {
    if (input.actionType !== 'NOTIFY_CUSTOMER') throw new Error('Invalid action type');

    return this.executeIdempotent(input, async (attemptId) => {
      return {
        result: {
          success: true,
          actionType: 'NOTIFY_CUSTOMER',
          caseId: input.caseId,
          paymentId: input.paymentId,
          outcome: 'NOTIFIED',
          referenceId: `msg_sim_${input.customerId}_${attemptId}`,
          message: 'Customer simulated notification sent.',
          executionDurationMs: SIMULATED_DURATION,
          metadata: { channel: 'EMAIL' }
        }
      };
    });
  }

  /**
   * 4. escalateToHuman
   */
  async escalateToHuman(input: ToolInput): Promise<ToolResult> {
    if (input.actionType !== 'ESCALATE_TO_HUMAN') throw new Error('Invalid action type');

    return this.executeIdempotent(input, async (attemptId) => {
      return {
        result: {
          success: true,
          actionType: 'ESCALATE_TO_HUMAN',
          caseId: input.caseId,
          paymentId: input.paymentId,
          outcome: 'ESCALATED',
          referenceId: `ticket_sim_${input.caseId}_${attemptId}`,
          message: 'Case escalated to human review queue.',
          executionDurationMs: SIMULATED_DURATION,
          metadata: { queue: 'TIER_2_SUPPORT' }
        }
      };
    });
  }
}

