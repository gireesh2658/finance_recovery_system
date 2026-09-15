import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { RecoveryToolExecutor } from './index';
import type { ToolInput } from './types';

const prisma = new PrismaClient();

describe('Adversarial Concurrency & Crash-Safety Audit', () => {
  let caseId: string;
  let paymentId: string;
  let customerId: string;

  beforeAll(async () => {
    // Clean up
    await prisma.auditEvent.deleteMany({});
    await prisma.agentDecision.deleteMany({});
    await prisma.recoveryAttempt.deleteMany({});
    await prisma.recoveryCase.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.customer.deleteMany({});

    // Seed test data
    const customer = await prisma.customer.create({
      data: {
        externalId: 'ext_cust_adv_' + Date.now(),
        name: 'Adversarial Test',
        email: 'adv@test.com',
        phone: '1234567890'
      }
    });
    customerId = customer.id;

    const payment = await prisma.payment.create({
      data: {
        externalId: 'ext_pay_adv_' + Date.now(),
        customerId: customerId,
        amount: 2000,
        currency: 'INR',
        method: 'CARD',
        status: 'FAILED',
        failureCode: 'NETWORK_TIMEOUT',
        attemptedAt: new Date(),
      }
    });
    paymentId = payment.id;

    const rCase = await prisma.recoveryCase.create({
      data: {
        paymentId: paymentId,
        customerId: customerId,
        amountAtRisk: 2000,
        status: 'EXECUTING',
      }
    });
    caseId = rCase.id;
  });

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({});
    await prisma.agentDecision.deleteMany({});
    await prisma.recoveryAttempt.deleteMany({});
    await prisma.recoveryCase.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.customer.deleteMany({});
    await prisma.$disconnect();
  });

  it('2. CONCURRENCY: Two simultaneous requests should have one owner', async () => {
    const input: ToolInput = {
      caseId,
      paymentId,
      customerId,
      actionType: 'RETRY_PAYMENT',
      attemptNumber: 1, // BOTH requests claim attempt 1
      amountPaise: 2000
    };

    let gatewayCalls = 0;
    
    class TestExecutor extends RecoveryToolExecutor {
      public async testExecuteIdempotent(input: ToolInput) {
        return (this as any).executeIdempotent(input, async (attemptId: string) => {
          gatewayCalls++;
          await new Promise(resolve => setTimeout(resolve, 500));
          return {
            result: {
              success: true,
              actionType: 'RETRY_PAYMENT',
              caseId: input.caseId,
              paymentId: input.paymentId,
              outcome: 'SUCCESS',
              referenceId: `txn_sim_${input.paymentId}_${attemptId}`,
              message: 'ok',
              executionDurationMs: 150,
              metadata: {}
            },
            paymentStatusUpdate: 'SUCCESS'
          };
        });
      }
    }

    const executorA = new TestExecutor(prisma);
    const executorB = new TestExecutor(prisma);

    let aError: any;
    let bError: any;
    let aResult: any;
    let bResult: any;

    await Promise.all([
      executorA.testExecuteIdempotent(input).then(r => aResult = r).catch(e => aError = e),
      executorB.testExecuteIdempotent(input).then(r => bResult = r).catch(e => bError = e),
    ]);

    const attempts = await prisma.recoveryAttempt.findMany({ where: { caseId } });
    expect(attempts.length).toBe(1);
    expect(gatewayCalls).toBe(1);

    const successes = [aResult, bResult].filter(x => x !== undefined).length;
    const errors = [aError, bError].filter(x => x !== undefined).length;

    expect(successes).toBe(1);
    expect(errors).toBe(1);
  });

  it('3. SAME IDEMPOTENCY KEY TEST & 5. CRASH AFTER SUCCESS', async () => {
    // Seed test data for this specific test
    const customer = await prisma.customer.create({
      data: {
        externalId: 'ext_cust_adv_2_' + Date.now(),
        name: 'Adversarial Test 2',
        email: 'adv2@test.com',
        phone: '1234567890'
      }
    });
    
    const payment = await prisma.payment.create({
      data: {
        externalId: 'ext_pay_adv_2_' + Date.now(),
        customerId: customer.id,
        amount: 2000,
        currency: 'INR',
        method: 'CARD',
        status: 'FAILED',
        failureCode: 'NETWORK_TIMEOUT',
        attemptedAt: new Date(),
      }
    });
    
    const rCase = await prisma.recoveryCase.create({
      data: {
        paymentId: payment.id,
        customerId: customer.id,
        amountAtRisk: 2000,
        status: 'EXECUTING',
      }
    });

    const input: ToolInput = {
      caseId: rCase.id,
      paymentId: payment.id,
      customerId: customer.id,
      actionType: 'RETRY_PAYMENT',
      attemptNumber: 2, // New attempt for this test
      amountPaise: 2000
    };

    let attemptIdA = '';
    let attemptIdB = '';

    // STATEFUL GATEWAY HARNESS
    const gatewayState = new Map<string, number>();

    const statefulGatewayCharge = (idempotencyKey: string) => {
      const existing = gatewayState.get(idempotencyKey) || 0;
      if (existing === 0) {
        gatewayState.set(idempotencyKey, 1);
        return { isNewCharge: true, totalCharges: 1 };
      } else {
        return { isNewCharge: false, totalCharges: existing };
      }
    };

    // Create an executor that stalls forever to simulate a crash during external gateway
    class CrashingExecutor extends RecoveryToolExecutor {
      public async testExecuteIdempotent(input: ToolInput) {
        return (this as any).executeIdempotent(input, async (attemptId: string) => {
          attemptIdA = attemptId;
          const idempotencyKey = `txn_sim_${input.paymentId}_${attemptId}`;
          statefulGatewayCharge(idempotencyKey);
          // Crash simulation: throw after gateway "succeeds" but before DB finalization
          throw new Error('CRASH_DURING_EXECUTION');
        });
      }
    }

    const executorA = new CrashingExecutor(prisma);
    await expect(executorA.testExecuteIdempotent(input)).rejects.toThrow('CRASH_DURING_EXECUTION');

    // Verify first charge went through in the gateway
    expect(Array.from(gatewayState.values()).reduce((a, b) => a + b, 0)).toBe(1);

    // Make the attempt "stale" by manually hacking createdAt
    await prisma.recoveryAttempt.updateMany({
      where: { caseId: input.caseId, attemptNumber: 2 },
      data: { createdAt: new Date(Date.now() - 15 * 60 * 1000) } // 15 mins ago
    });

    // Now Worker B wakes up and processes the stale attempt
    class RecoveringExecutor extends RecoveryToolExecutor {
      public async testExecuteIdempotent(input: ToolInput) {
        return (this as any).executeIdempotent(input, async (attemptId: string) => {
          attemptIdB = attemptId;
          const idempotencyKey = `txn_sim_${input.paymentId}_${attemptId}`;
          const chargeResult = statefulGatewayCharge(idempotencyKey);
          
          return {
            result: {
              success: true,
              actionType: 'RETRY_PAYMENT',
              caseId: input.caseId,
              paymentId: input.paymentId,
              outcome: 'SUCCESS',
              referenceId: idempotencyKey,
              message: chargeResult.isNewCharge ? 'New Charge' : 'Already CHARGED',
              executionDurationMs: 10,
              metadata: {}
            },
            paymentStatusUpdate: 'SUCCESS'
          };
        });
      }
    }

    const executorB = new RecoveringExecutor(prisma);
    await executorB.testExecuteIdempotent(input);

    // CRITICAL: Proof that Worker B uses exactly the same Attempt ID
    expect(attemptIdA).toBe(attemptIdB);
    expect(attemptIdA).toBeTruthy();

    // Verify exactly ONE financial effect across both workers
    const totalCharges = Array.from(gatewayState.values()).reduce((a, b) => a + b, 0);
    expect(totalCharges).toBe(1);

    // Verify DB states finalized exactly once
    const finalAttempt = await prisma.recoveryAttempt.findFirst({ where: { caseId: input.caseId, attemptNumber: 2 } });
    expect(finalAttempt?.status).toBe('SUCCESS');

    const finalPayment = await prisma.payment.findUnique({ where: { id: input.paymentId } });
    expect(finalPayment?.status).toBe('SUCCESS');
  });
});
