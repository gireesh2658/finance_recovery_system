import { PrismaClient } from '@prisma/client';
import { transition } from './machine';
import type { RecoveryCaseStatus, TransitionResult } from './types';

export class StateMachineService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Securely requests a state transition.
   * Protects against stale state, handles concurrency optimistically, 
   * enforces limits, and persists the audit trail transactionally.
   */
  async requestTransition(
    caseId: string,
    expectedCurrentState: RecoveryCaseStatus,
    requestedNextState: RecoveryCaseStatus,
    reason: string = 'Automated transition',
    payload?: { amountRecovered?: number }
  ): Promise<TransitionResult> {
    
    // Begin a transaction to ensure audit event and state update are atomic
    return await this.prisma.$transaction(async (tx) => {
      // 1. Fetch current case with an explicit status lock to prevent stale updates
      const currentCase = await tx.recoveryCase.findUnique({
        where: { id: caseId }
      });

      if (!currentCase) {
        throw new Error(`Recovery case ${caseId} not found.`);
      }

      // Concurrency / Stale State check
      if (currentCase.status !== expectedCurrentState) {
        return {
          success: false,
          nextState: currentCase.status as RecoveryCaseStatus,
          reason: `Stale state rejection: expected ${expectedCurrentState} but DB is currently ${currentCase.status}.`,
          isTerminal: ['RECOVERED', 'ESCALATED', 'CLOSED'].includes(currentCase.status)
        };
      }

      // 2. Derive limits from Audit Events
      // Count total transitions (events marking state changes)
      const transitionCount = await tx.auditEvent.count({
        where: { caseId, eventType: 'STATE_TRANSITION' }
      });

      // Count strategy attempts (how many times we entered STRATEGY_PENDING)
      const strategyAttemptCount = await tx.auditEvent.count({
        where: { 
          caseId, 
          eventType: 'STATE_TRANSITION',
          details: { contains: '"nextState":"STRATEGY_PENDING"' } // Simple JSON check for SQLite MVP
        }
      });

      // 3. Pure Evaluation
      const result = transition({
        caseId,
        fromState: currentCase.status as RecoveryCaseStatus,
        toState: requestedNextState,
        transitionCount,
        strategyAttemptCount,
        reason
      });

      // 4. Persistence
      if (result.success) {
        let finalAmountRecovered = currentCase.amountRecovered;

        // Atomically validate and persist amountRecovered when transitioning to RECOVERED
        if (result.nextState === 'RECOVERED') {
          if (payload?.amountRecovered !== undefined) {
             if (payload.amountRecovered < 0) throw new Error("Amount recovered cannot be negative.");
             if (currentCase.amountRecovered > 0) throw new Error("Cannot double credit amountRecovered.");
             
             const payment = await tx.payment.findUnique({ where: { id: currentCase.paymentId } });
             if (!payment) throw new Error("Missing payment for recovery case.");
             if (payment.status !== 'SUCCESS') throw new Error("Cannot transition to RECOVERED when Payment is not SUCCESS.");
             if (payload.amountRecovered > payment.amount) {
               throw new Error(`Amount recovered (${payload.amountRecovered}) exceeds payment amount (${payment.amount}).`);
             }
             
             finalAmountRecovered = payload.amountRecovered;
          }
        }

        // We use optimistic locking implicitly by updating WHERE id = caseId AND status = expectedCurrentState
        const updated = await tx.recoveryCase.updateMany({
          where: { 
            id: caseId,
            status: expectedCurrentState // The stale check
          },
          data: { 
            status: result.nextState,
            amountRecovered: finalAmountRecovered,
            updatedAt: new Date()
          }
        });

        if (updated.count === 0) {
          // Another process changed it between our read and write
          throw new Error('Concurrency exception: Case state changed during transaction.');
        }

        // 5. Audit Trail
        await tx.auditEvent.create({
          data: {
            caseId,
            eventType: 'STATE_TRANSITION',
            actor: 'AGENT_ENGINE',
            details: JSON.stringify({
              previousState: expectedCurrentState,
              nextState: result.nextState,
              reason: result.reason,
              amountRecovered: finalAmountRecovered
            }),
          }
        });
      }

      return result;
    });
  }
}
