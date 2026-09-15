import { describe, it, expect, vi } from 'vitest';
import { RecoveryToolExecutor } from './index';
import type { PrismaClient } from '@prisma/client';
import type { ToolInput } from './types';

function createMockPrismaTx(overrides: any = {}) {
  return {
    payment: {
      findUnique: vi.fn().mockResolvedValue(
        'payment' in overrides ? overrides.payment : {
          id: 'pay_1',
          amount: 1000,
          failureCode: 'NETWORK_TIMEOUT',
          status: 'FAILED',
          recoveryCase: {
            id: 'case_1',
            status: 'ACTION_APPROVED'
          }
        }
      ),
      update: vi.fn().mockResolvedValue({}),
    },
    recoveryAttempt: {
      findUnique: vi.fn().mockImplementation((args: any) => {
        if (args.where && args.where.id === 'attempt_1') {
          return { id: 'attempt_1', status: 'EXECUTING', createdAt: new Date() };
        }
        if (overrides.existingAttempt && args.where && args.where.id === overrides.existingAttempt.id) {
           return overrides.existingAttempt;
        }
        return overrides.existingAttempt || null;
      }),
      findMany: vi.fn().mockResolvedValue(overrides.activeAttempts || []),
      create: vi.fn().mockResolvedValue(overrides.createdAttempt || { id: 'attempt_1', status: 'EXECUTING', createdAt: new Date() }),
      update: vi.fn().mockResolvedValue({}),
    },
    auditEvent: {
      create: vi.fn().mockResolvedValue({}),
    }
  };
}

describe('Recovery Action Tool Layer', () => {

  const baseInput: ToolInput = {
    caseId: 'case_1',
    paymentId: 'pay_1',
    customerId: 'cust_1',
    actionType: 'RETRY_PAYMENT',
    attemptNumber: 1,
    amountPaise: 1000,
  };

  describe('retryPayment', () => {
    it('A/B. valid successful retry (NETWORK_TIMEOUT) -> deterministic SUCCESS and payment mutation', async () => {
      const mockTx = createMockPrismaTx();
      const mockPrisma = { payment: mockTx.payment, recoveryAttempt: mockTx.recoveryAttempt, auditEvent: mockTx.auditEvent, $transaction: async (cb: any) => cb(mockTx) } as unknown as PrismaClient;
      const executor = new RecoveryToolExecutor(mockPrisma);

      const result = await executor.retryPayment(baseInput);

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('SUCCESS');
      expect(mockTx.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay_1' },
        data: { status: 'SUCCESS' }
      });
    });

    it('C. failed retry (INSUFFICIENT_FUNDS) -> payment remains FAILED', async () => {
      const mockTx = createMockPrismaTx({
        payment: {
          id: 'pay_1', amount: 1000, failureCode: 'INSUFFICIENT_FUNDS', status: 'FAILED',
          recoveryCase: { id: 'case_1', status: 'ACTION_APPROVED' }
        }
      });
      const mockPrisma = { payment: mockTx.payment, recoveryAttempt: mockTx.recoveryAttempt, auditEvent: mockTx.auditEvent, $transaction: async (cb: any) => cb(mockTx) } as unknown as PrismaClient;
      const executor = new RecoveryToolExecutor(mockPrisma);

      const result = await executor.retryPayment(baseInput);

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('FAILED');
      expect(mockTx.payment.update).not.toHaveBeenCalled(); // No mutation on failure
    });

    it('D. amount mismatch -> throws error', async () => {
      const mockTx = createMockPrismaTx();
      const mockPrisma = { payment: mockTx.payment, recoveryAttempt: mockTx.recoveryAttempt, auditEvent: mockTx.auditEvent, $transaction: async (cb: any) => cb(mockTx) } as unknown as PrismaClient;
      const executor = new RecoveryToolExecutor(mockPrisma);

      await expect(executor.retryPayment({ ...baseInput, amountPaise: 9999 }))
        .rejects.toThrow(/Amount mismatch/);
    });

    it('E. repeated same attempt -> idempotent behavior returns existing output', async () => {
      const mockTx = createMockPrismaTx({
        existingAttempt: {
          id: 'attempt_1',
          status: 'SUCCESS',
          actionOutput: JSON.stringify({ success: true, outcome: 'SUCCESS', message: 'Cached result' })
        }
      });
      const mockPrisma = { payment: mockTx.payment, recoveryAttempt: mockTx.recoveryAttempt, auditEvent: mockTx.auditEvent, $transaction: async (cb: any) => cb(mockTx) } as unknown as PrismaClient;
      const executor = new RecoveryToolExecutor(mockPrisma);

      const result = await executor.retryPayment(baseInput);

      expect(result.message).toBe('Cached result');
      // Verify core logic was bypassed
      expect(mockTx.recoveryAttempt.create).not.toHaveBeenCalled();
    });

    it('F. missing payment -> structured error', async () => {
      const mockTx = createMockPrismaTx({ payment: null });
      const mockPrisma = { payment: mockTx.payment, recoveryAttempt: mockTx.recoveryAttempt, auditEvent: mockTx.auditEvent, $transaction: async (cb: any) => cb(mockTx) } as unknown as PrismaClient;
      const executor = new RecoveryToolExecutor(mockPrisma);

      await expect(executor.retryPayment(baseInput))
        .rejects.toThrow(/Payment pay_1 not found/);
    });

    it('G. terminal case -> rejected', async () => {
      const mockTx = createMockPrismaTx({
        payment: {
          id: 'pay_1', amount: 1000, failureCode: 'NETWORK_TIMEOUT', status: 'FAILED',
          recoveryCase: { id: 'case_1', status: 'RECOVERED' } // Terminal
        }
      });
      const mockPrisma = { payment: mockTx.payment, recoveryAttempt: mockTx.recoveryAttempt, auditEvent: mockTx.auditEvent, $transaction: async (cb: any) => cb(mockTx) } as unknown as PrismaClient;
      const executor = new RecoveryToolExecutor(mockPrisma);

      await expect(executor.retryPayment(baseInput))
        .rejects.toThrow(/Case is in terminal state RECOVERED/);
    });
  });

  describe('generatePaymentLink', () => {
    it('H/I/J. generates deterministic reference, preserves amount, no success mutation', async () => {
      const mockTx = createMockPrismaTx();
      const mockPrisma = { payment: mockTx.payment, recoveryAttempt: mockTx.recoveryAttempt, auditEvent: mockTx.auditEvent, $transaction: async (cb: any) => cb(mockTx) } as unknown as PrismaClient;
      const executor = new RecoveryToolExecutor(mockPrisma);

      const result = await executor.generatePaymentLink({ ...baseInput, actionType: 'SEND_PAYMENT_LINK' });

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('LINK_GENERATED');
      expect(result.referenceId).toMatch(/plink_sim_pay_1_attempt_1/);
      expect(mockTx.payment.update).not.toHaveBeenCalled(); // No mutation
    });
  });

  describe('notifyCustomer', () => {
    it('L/M. valid notification, no real comms', async () => {
      const mockTx = createMockPrismaTx();
      const mockPrisma = { payment: mockTx.payment, recoveryAttempt: mockTx.recoveryAttempt, auditEvent: mockTx.auditEvent, $transaction: async (cb: any) => cb(mockTx) } as unknown as PrismaClient;
      const executor = new RecoveryToolExecutor(mockPrisma);

      const result = await executor.notifyCustomer({ ...baseInput, actionType: 'NOTIFY_CUSTOMER' });

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('NOTIFIED');
      expect(result.metadata.channel).toBe('EMAIL');
    });
  });

  describe('escalateToHuman', () => {
    it('O/P/Q. creates ref, does not close case', async () => {
      const mockTx = createMockPrismaTx();
      const mockPrisma = { payment: mockTx.payment, recoveryAttempt: mockTx.recoveryAttempt, auditEvent: mockTx.auditEvent, $transaction: async (cb: any) => cb(mockTx) } as unknown as PrismaClient;
      const executor = new RecoveryToolExecutor(mockPrisma);

      const result = await executor.escalateToHuman({ ...baseInput, actionType: 'ESCALATE_TO_HUMAN' });

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('ESCALATED');
      expect(result.referenceId).toBe('ticket_sim_case_1_attempt_1');
      // Verifying state mutation did NOT happen here
      expect(mockTx.payment.update).not.toHaveBeenCalled();
    });
  });

  describe('Cross-tool constraints', () => {
    it('T. invalid action -> rejected', async () => {
      const mockPrisma = {} as PrismaClient;
      const executor = new RecoveryToolExecutor(mockPrisma);

      // Attempting to call retryPayment with wrong action type in input
      await expect(executor.retryPayment({ ...baseInput, actionType: 'ESCALATE_TO_HUMAN' }))
        .rejects.toThrow(/Invalid action type/);
    });
  });

});
