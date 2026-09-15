import { describe, it, expect, vi } from 'vitest';
import { StateMachineService } from './service';
import type { PrismaClient } from '@prisma/client';

describe('StateMachineService (Orchestrator)', () => {

  it('W. stale-state transition -> rejected', async () => {
    
    // Create a mock Prisma Client
    const mockPrisma = {
      $transaction: async (callback: any) => {
        const tx = {
          recoveryCase: {
            // DB says it's already DIAGNOSING
            findUnique: vi.fn().mockResolvedValue({ id: 'case1', status: 'DIAGNOSING' }),
            updateMany: vi.fn(),
          },
          auditEvent: {
            count: vi.fn().mockResolvedValue(1),
            create: vi.fn(),
          }
        };
        return callback(tx);
      }
    } as unknown as PrismaClient;

    const service = new StateMachineService(mockPrisma);

    // We think it's DETECTED and want to move to DIAGNOSING, but DB is already DIAGNOSING
    const result = await service.requestTransition('case1', 'DETECTED', 'DIAGNOSING');
    
    expect(result.success).toBe(false);
    expect(result.reason).toContain('Stale state rejection');
    expect(result.nextState).toBe('DIAGNOSING'); // Should echo back the actual DB state
  });

  it('X. amountRecovered cannot be negative', async () => {
    let capturedError: Error | undefined;
    const mockPrisma = {
      $transaction: async (cb: any) => {
        try {
          await cb({
            recoveryCase: { findUnique: vi.fn().mockResolvedValue({ id: 'case1', status: 'VERIFYING', amountRecovered: 0, paymentId: 'pay_1' }), updateMany: vi.fn() },
            payment: { findUnique: vi.fn().mockResolvedValue({ id: 'pay_1', status: 'SUCCESS', amount: 1000 }) },
            auditEvent: { count: vi.fn().mockResolvedValue(1), create: vi.fn() }
          });
        } catch (e) {
          capturedError = e as Error;
        }
      }
    } as unknown as PrismaClient;

    const service = new StateMachineService(mockPrisma);
    await service.requestTransition('case1', 'VERIFYING', 'RECOVERED', 'Testing', { amountRecovered: -100 });
    
    expect(capturedError?.message).toContain('negative');
  });

  it('Y. amountRecovered cannot be double credited', async () => {
    let capturedError: Error | undefined;
    const mockPrisma = {
      $transaction: async (cb: any) => {
        try {
          await cb({
            recoveryCase: { findUnique: vi.fn().mockResolvedValue({ id: 'case1', status: 'VERIFYING', amountRecovered: 500, paymentId: 'pay_1' }), updateMany: vi.fn() },
            payment: { findUnique: vi.fn().mockResolvedValue({ id: 'pay_1', status: 'SUCCESS', amount: 1000 }) },
            auditEvent: { count: vi.fn().mockResolvedValue(1), create: vi.fn() }
          });
        } catch (e) {
          capturedError = e as Error;
        }
      }
    } as unknown as PrismaClient;

    const service = new StateMachineService(mockPrisma);
    await service.requestTransition('case1', 'VERIFYING', 'RECOVERED', 'Testing', { amountRecovered: 500 });
    
    expect(capturedError?.message).toContain('double credit');
  });

  it('Z. amountRecovered cannot exceed payment amount', async () => {
    let capturedError: Error | undefined;
    const mockPrisma = {
      $transaction: async (cb: any) => {
        try {
          await cb({
            recoveryCase: { findUnique: vi.fn().mockResolvedValue({ id: 'case1', status: 'VERIFYING', amountRecovered: 0, paymentId: 'pay_1' }), updateMany: vi.fn() },
            payment: { findUnique: vi.fn().mockResolvedValue({ id: 'pay_1', status: 'SUCCESS', amount: 1000 }) },
            auditEvent: { count: vi.fn().mockResolvedValue(1), create: vi.fn() }
          });
        } catch (e) {
          capturedError = e as Error;
        }
      }
    } as unknown as PrismaClient;

    const service = new StateMachineService(mockPrisma);
    await service.requestTransition('case1', 'VERIFYING', 'RECOVERED', 'Testing', { amountRecovered: 2000 });
    
    expect(capturedError?.message).toContain('exceeds payment amount');
  });

  it('AA. successful state transition with valid amountRecovered', async () => {
    const updateManyMock = vi.fn().mockResolvedValue({ count: 1 });
    const mockPrisma = {
      $transaction: async (cb: any) => {
          return await cb({
            recoveryCase: { findUnique: vi.fn().mockResolvedValue({ id: 'case1', status: 'VERIFYING', amountRecovered: 0, paymentId: 'pay_1' }), updateMany: updateManyMock },
            payment: { findUnique: vi.fn().mockResolvedValue({ id: 'pay_1', status: 'SUCCESS', amount: 1000 }) },
            auditEvent: { count: vi.fn().mockResolvedValue(1), create: vi.fn() }
          });
      }
    } as unknown as PrismaClient;

    const service = new StateMachineService(mockPrisma);
    const result = await service.requestTransition('case1', 'VERIFYING', 'RECOVERED', 'Testing', { amountRecovered: 1000 });
    
    expect(result.success).toBe(true);
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ amountRecovered: 1000 })
    }));
  });

});
