import { describe, it, expect, vi } from 'vitest';
import { AgentOrchestrator } from './index';
import { resumeWaitingCase } from './resume';

describe('STEP 45A: Orchestrator State-Isolation Regression Gate', () => {
  it('prevents cross-case state leak during sequential synchronous execution', async () => {
    // 1. Setup mocks that simulate two distinct cases
    const verifySpy = vi.fn().mockResolvedValue({
      outcome: 'RECOVERED',
      verified: true,
      reason: 'test',
      paymentStatus: 'SUCCESS',
      amountRecovered: 1000,
      metadata: {}
    });

    const mockPrisma = {
      recoveryCase: {
        findUnique: vi.fn().mockImplementation(({ where }) => {
          return Promise.resolve({
            id: where.id,
            status: 'DETECTED',
            attemptCount: 0,
            amountAtRisk: 1000,
            paymentId: `pay_${where.id}`,
            payment: {
              id: `pay_${where.id}`,
              amount: 1000,
              currency: 'INR',
              method: 'CARD',
              status: 'FAILED',
              failureCode: 'BANK_DECLINED',
              failureReason: 'declined',
              customerId: 'cust_1',
              customer: { riskTier: 'LOW', totalPayments: 10, failedPayments: 1 }
            }
          });
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      policy: { findMany: vi.fn().mockResolvedValue([{ ruleType: 'STANDARD_OPERATING_PROCEDURE', conditions: '{}', isActive: true, priority: 100 }]) },
      recoveryAttempt: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
      auditEvent: { count: vi.fn().mockResolvedValue(0), create: vi.fn() },
      $transaction: vi.fn().mockImplementation(async (cb: any) => await cb(mockPrisma))
    };

    const mockState = { requestTransition: vi.fn().mockImplementation(async (_c, _from, to) => ({ success: true, nextState: to })) };
    const mockReasoner = { executeReasoning: vi.fn().mockResolvedValue({ success: true, data: { recommendedAction: 'SEND_PAYMENT_LINK', alternativeActions: [] } }) };
    const mockTool = { 
      generatePaymentLink: vi.fn().mockImplementation(async (input) => ({
        success: true, actionType: 'SEND_PAYMENT_LINK', caseId: input.caseId, paymentId: input.paymentId, outcome: 'WAITING'
      })) 
    };

    const orchestrator = new AgentOrchestrator(
      mockPrisma as any, mockState as any, mockReasoner as any, mockTool as any, { verify: verifySpy } as any
    );

    // 2. Process Case A
    await orchestrator.processCase('case_A');
    expect(verifySpy).toHaveBeenNthCalledWith(1, 'case_A', expect.objectContaining({ paymentId: 'pay_case_A' }));

    // 3. Process Case B
    await orchestrator.processCase('case_B');
    expect(verifySpy).toHaveBeenNthCalledWith(2, 'case_B', expect.objectContaining({ paymentId: 'pay_case_B' }));

    // 4. Process Case C (repeated case test)
    await orchestrator.processCase('case_C');
    expect(verifySpy).toHaveBeenNthCalledWith(3, 'case_C', expect.objectContaining({ paymentId: 'pay_case_C' }));
  });

  it('prevents cross-case state leak during asynchronous resume (OLD FAILURE PATTERN)', async () => {
    // We simulate processCase(A) -> leaves behind tool result A (in old design)
    // Then resumeWaitingCase(B) -> must use tool result B from DB.
    
    const verifySpy = vi.fn().mockResolvedValue({ outcome: 'RECOVERED', verified: true, reason: 'test', paymentStatus: 'SUCCESS', amountRecovered: 1000, metadata: {} });

    const mockPrisma = {
      recoveryCase: {
        findUnique: vi.fn().mockImplementation(({ where }) => {
          // If searching by paymentId for resume
          if (where.paymentId) {
            return Promise.resolve({
              id: 'case_B', status: 'VERIFYING', attemptCount: 1, paymentId: 'pay_B'
            });
          }
          const id = where.id;
          return Promise.resolve({
            id,
            status: id === 'case_B' ? 'VERIFYING' : 'DETECTED',
            attemptCount: id === 'case_B' ? 1 : 0,
            amountAtRisk: 1000,
            paymentId: `pay_${id}`,
            payment: { 
              id: `pay_${id}`, 
              status: 'SUCCESS',
              amount: 1000,
              currency: 'INR',
              method: 'CARD',
              failureCode: 'BANK_DECLINED',
              failureReason: 'declined',
              customerId: 'cust_1',
              customer: { riskTier: 'LOW', totalPayments: 10, failedPayments: 1 }
            }
          });
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      policy: { findMany: vi.fn().mockResolvedValue([{ ruleType: 'STANDARD_OPERATING_PROCEDURE', conditions: '{}', isActive: true, priority: 100 }]) },
      recoveryAttempt: {
        findUnique: vi.fn().mockImplementation(({ where }) => {
          // Returning Case B's durable state
          if (where.caseId_attemptNumber.caseId === 'case_B') {
            return Promise.resolve({
              actionOutput: JSON.stringify({
                success: true, actionType: 'SEND_PAYMENT_LINK', caseId: 'case_B', paymentId: 'pay_case_B', outcome: 'WAITING'
              })
            });
          }
          return Promise.resolve(null);
        }),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn()
      },
      auditEvent: { count: vi.fn().mockResolvedValue(0), create: vi.fn() },
      $transaction: vi.fn().mockImplementation(async (cb: any) => await cb(mockPrisma))
    };

    const mockState = { requestTransition: vi.fn().mockImplementation(async (_c, _from, to) => ({ success: true, nextState: to })) };
    const mockReasoner = { executeReasoning: vi.fn().mockResolvedValue({ success: true, data: { recommendedAction: 'SEND_PAYMENT_LINK', alternativeActions: [] } }) };
    const mockTool = { 
      generatePaymentLink: vi.fn().mockImplementation(async (input) => ({
        success: true, actionType: 'SEND_PAYMENT_LINK', caseId: input.caseId, paymentId: input.paymentId, outcome: 'WAITING'
      })) 
    };

    const orchestrator = new AgentOrchestrator(
      mockPrisma as any, mockState as any, mockReasoner as any, mockTool as any, { verify: verifySpy } as any
    );

    // 1. Process synchronous Case A
    await orchestrator.processCase('case_A');
    expect(verifySpy).toHaveBeenNthCalledWith(1, 'case_A', expect.objectContaining({ paymentId: 'pay_case_A' }));
    
    // Clear mocks to ensure resume path works independently
    mockReasoner.executeReasoning.mockClear();
    mockTool.generatePaymentLink.mockClear();

    // 2. Resume Waiting Case B
    const resumeRes = await resumeWaitingCase(mockPrisma as any, orchestrator, 'pay_B', 'evt_1', 'SUCCESS');
    
    expect(resumeRes.resumed).toBe(true);
    
    // 3. Verify Case B's OutcomeVerifier receives PAYMENT_B and NOT PAYMENT_A
    expect(verifySpy).toHaveBeenNthCalledWith(2, 'case_B', expect.objectContaining({ paymentId: 'pay_case_B' }));

    // 4. Verify resume remains LLM-free and tool-free
    expect(mockReasoner.executeReasoning).not.toHaveBeenCalled();
    expect(mockTool.generatePaymentLink).not.toHaveBeenCalled();
  });

  it('verifies that if Case A fails, it cannot contaminate Case B', async () => {
    const verifySpy = vi.fn().mockResolvedValue({ outcome: 'RECOVERED', verified: true, reason: 'test', paymentStatus: 'SUCCESS', amountRecovered: 1000, metadata: {} });

    const mockPrisma = {
      recoveryCase: {
        findUnique: vi.fn().mockImplementation(({ where }) => {
          return Promise.resolve({
            id: where.id,
            status: 'DETECTED',
            attemptCount: 0,
            amountAtRisk: 1000,
            paymentId: `pay_${where.id}`,
            payment: { 
              id: `pay_${where.id}`, 
              status: 'FAILED',
              amount: 1000,
              currency: 'INR',
              method: 'CARD',
              failureCode: 'BANK_DECLINED',
              failureReason: 'declined',
              customerId: 'cust_1',
              customer: { riskTier: 'LOW', totalPayments: 10, failedPayments: 1 }
            }
          });
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      policy: { findMany: vi.fn().mockResolvedValue([{ ruleType: 'STANDARD_OPERATING_PROCEDURE', conditions: '{}', isActive: true, priority: 100 }]) },
      recoveryAttempt: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
      auditEvent: { count: vi.fn().mockResolvedValue(0), create: vi.fn() }
    };

    const mockState = { requestTransition: vi.fn().mockImplementation(async (_c, _from, to) => ({ success: true, nextState: to })) };
    const mockReasoner = { 
      executeReasoning: vi.fn()
        .mockResolvedValueOnce({ success: false, error: "Case A LLM Failed" })
        .mockResolvedValueOnce({ success: true, data: { recommendedAction: 'SEND_PAYMENT_LINK', alternativeActions: [] } }) 
    };
    const mockTool = { 
      generatePaymentLink: vi.fn().mockImplementation(async (input) => ({
        success: true, actionType: 'SEND_PAYMENT_LINK', caseId: input.caseId, paymentId: input.paymentId, outcome: 'WAITING'
      })) 
    };

    const orchestrator = new AgentOrchestrator(
      mockPrisma as any, mockState as any, mockReasoner as any, mockTool as any, { verify: verifySpy } as any
    );

    // Case A fails during reasoning
    await orchestrator.processCase('case_A');

    // Case B should succeed normally and have its own state
    await orchestrator.processCase('case_B');
    expect(verifySpy).toHaveBeenNthCalledWith(1, 'case_B', expect.objectContaining({ paymentId: 'pay_case_B' }));
  });
});
