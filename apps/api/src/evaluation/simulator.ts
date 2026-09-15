import { PrismaClient } from '@prisma/client';
import { AgentOrchestrator } from '../agent/orchestrator';
import { resumeWaitingCase } from '../agent/orchestrator/resume';

export const POLICY_VERSION = 'customer_behavior_v1';

export interface SimulationResult {
  policyVersion: string;
  totalEligible: number;
  customerSuccesses: number;
  customerNonResponses: number;
  resumeAttempts: number;
  resumeAccepted: number;
  resumeRejected: number;
  recoveredAfterAsyncResume: number;
  stillWaiting: number;
  caseDetails: {
    caseId: string;
    paymentId: string;
    riskTier: string;
    amount: number;
    success: boolean;
    resumed: boolean;
  }[];
}

export class CustomerBehaviorSimulator {
  private prisma: PrismaClient;
  private orchestrator: AgentOrchestrator;

  constructor(prisma: PrismaClient, orchestrator: AgentOrchestrator) {
    this.prisma = prisma;
    this.orchestrator = orchestrator;
  }

  /**
   * Deterministic simulation policy: customer_behavior_v1
   * Customer pays if: riskTier === 'LOW' AND amount <= 500000
   * 
   * This is a benchmark assumption, NOT historical reality.
   */
  private simulateCustomerSuccess(riskTier: string, amountPaise: number): boolean {
    return riskTier === 'LOW' && amountPaise <= 500000;
  }

  public async runSimulation(): Promise<SimulationResult> {
    const result: SimulationResult = {
      policyVersion: POLICY_VERSION,
      totalEligible: 0,
      customerSuccesses: 0,
      customerNonResponses: 0,
      resumeAttempts: 0,
      resumeAccepted: 0,
      resumeRejected: 0,
      recoveredAfterAsyncResume: 0,
      stillWaiting: 0,
      caseDetails: []
    };

    // ELIGIBILITY: Fetch cases that are WAITING_FOR_CUSTOMER and Payment is FAILED
    const eligibleCases = await this.prisma.recoveryCase.findMany({
      where: {
        status: 'WAITING_FOR_CUSTOMER',
        payment: { status: 'FAILED' }
      },
      include: {
        payment: true,
        customer: true
      }
    });

    result.totalEligible = eligibleCases.length;

    for (const cCase of eligibleCases) {
      const willSucceed = this.simulateCustomerSuccess(cCase.customer.riskTier, cCase.payment.amount);
      
      const detail = {
        caseId: cCase.id,
        paymentId: cCase.paymentId,
        riskTier: cCase.customer.riskTier,
        amount: cCase.payment.amount,
        success: willSucceed,
        resumed: false
      };

      if (willSucceed) {
        // PAYMENT MUTATION SAFETY
        // Atomically update Payment only if it is STILL FAILED AND the RecoveryCase is STILL WAITING.
        const updateResult = await this.prisma.payment.updateMany({
          where: {
            id: cCase.paymentId,
            status: 'FAILED',
            recoveryCase: {
              status: 'WAITING_FOR_CUSTOMER'
            }
          },
          data: { status: 'SUCCESS' }
        });
        
        let mutationPerformed = updateResult.count > 0;
        
        if (mutationPerformed) {
          result.customerSuccesses++;

          // ONLY AFTER THE TRANSACTION COMMITS:
          const eventId = `sim_webhook_${POLICY_VERSION}_${cCase.paymentId}`;
          
          result.resumeAttempts++;
          const resumeRes = await resumeWaitingCase(this.prisma, this.orchestrator, cCase.paymentId, eventId, 'SUCCESS');
          
          detail.resumed = resumeRes.resumed;
          
          if (resumeRes.resumed) {
            result.resumeAccepted++;
            
            if (resumeRes.orchestratorResult?.finalState === 'RECOVERED') {
              result.recoveredAfterAsyncResume++;
            } else if (resumeRes.orchestratorResult?.finalState === 'WAITING_FOR_CUSTOMER') {
              result.stillWaiting++;
            }
          } else {
            result.resumeRejected++;
            result.stillWaiting++; // It wasn't resumed, so it's still waiting
          }
        } else {
          // Mutation was not performed (either not WAITING, or already SUCCESS, or another actor updated it)
          // We do NOT resume, and we do NOT count it as a customer success in the simulation metric.
          result.stillWaiting++;
        }
      } else {
        result.customerNonResponses++;
        result.stillWaiting++;
      }
      
      result.caseDetails.push(detail);
    }

    return result;
  }
}
