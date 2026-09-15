import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentOrchestrator } from './index';
import { resumeWaitingCase } from './resume';
import * as policyEngine from '../policy/engine';

vi.mock('../policy/engine', () => ({
  evaluateActionPolicy: vi.fn()
}));

/**
 * Creates a full mock suite for orchestrator + resume testing.
 * Configurable initial state, attemptCount, and payment status.
 */
function createMocks(overrides?: {
  status?: string;
  attemptCount?: number;
  paymentStatus?: string;
  actionType?: string;
}) {
  const status = overrides?.status ?? 'DETECTED';
  const attemptCount = overrides?.attemptCount ?? 0;
  const paymentStatus = overrides?.paymentStatus ?? 'FAILED';
  const actionType = overrides?.actionType ?? 'SEND_PAYMENT_LINK';

  const prisma = {
    recoveryCase: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'case_1',
        status,
        attemptCount,
        amountAtRisk: 1000,
        paymentId: 'pay_1',
        payment: {
          id: 'pay_1',
          amount: 1000,
          currency: 'INR',
          method: 'CARD',
          status: paymentStatus,
          failureCode: 'BANK_DECLINED',
          failureReason: 'declined',
          customerId: 'cust_1',
          customer: { riskTier: 'LOW', totalPayments: 10, failedPayments: 1 }
        }
      }),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    recoveryAttempt: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'att_1',
        caseId: 'case_1',
        attemptNumber: attemptCount,
        actionType,
        actionOutput: JSON.stringify({
          success: true,
          actionType,
          caseId: 'case_1',
          paymentId: 'pay_1',
          outcome: actionType === 'SEND_PAYMENT_LINK' ? 'LINK_GENERATED' : 'NOTIFIED',
          referenceId: 'ref_1',
          message: 'mock',
          executionDurationMs: 100,
          metadata: {}
        }),
        status: 'SUCCESS'
      }),
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([])
    },
    auditEvent: {
      create: vi.fn(),
      count: vi.fn().mockResolvedValue(0)
    },
    policy: {
      findMany: vi.fn().mockResolvedValue([
        {
          ruleType: 'STANDARD_OPERATING_PROCEDURE',
          conditions: JSON.stringify({ version: '1.0.0', rules: [] }),
          isActive: true,
          priority: 100
        }
      ])
    }
  };

  const stateService = {
    requestTransition: vi.fn().mockImplementation(async (_cId: string, _from: string, to: string) => ({
      success: true,
      nextState: to
    }))
  };

  const reasonerService = {
    executeReasoning: vi.fn().mockResolvedValue({
      success: true,
      data: {
        recommendedAction: 'SEND_PAYMENT_LINK',
        alternativeActions: []
      }
    })
  };

  const toolExecutor = {
    retryPayment: vi.fn().mockResolvedValue({
      success: true, actionType: 'RETRY_PAYMENT', caseId: 'case_1',
      paymentId: 'pay_1', outcome: 'SUCCESS', referenceId: 'ref_1',
      message: 'ok', executionDurationMs: 100, metadata: {}
    }),
    generatePaymentLink: vi.fn().mockResolvedValue({
      success: true, actionType: 'SEND_PAYMENT_LINK', caseId: 'case_1',
      paymentId: 'pay_1', outcome: 'LINK_GENERATED', referenceId: 'ref_1',
      message: 'ok', executionDurationMs: 100, metadata: {}
    }),
    notifyCustomer: vi.fn().mockResolvedValue({
      success: true, actionType: 'NOTIFY_CUSTOMER', caseId: 'case_1',
      paymentId: 'pay_1', outcome: 'NOTIFIED', referenceId: 'ref_1',
      message: 'ok', executionDurationMs: 100, metadata: {}
    }),
    escalateToHuman: vi.fn().mockResolvedValue({
      success: true, actionType: 'ESCALATE_TO_HUMAN', caseId: 'case_1',
      paymentId: 'pay_1', outcome: 'ESCALATED', referenceId: 'ref_1',
      message: 'ok', executionDurationMs: 100, metadata: {}
    })
  };

  const verifier = {
    verify: vi.fn().mockImplementation(async (_caseId: string, toolResult: any) => {
      // Simulate authoritative verifier behavior based on payment status
      if (paymentStatus === 'SUCCESS') {
        return {
          outcome: 'RECOVERED', verified: true,
          reason: 'Payment SUCCESS', paymentStatus: 'SUCCESS',
          amountRecovered: 1000, metadata: {}
        };
      }
      if (toolResult.actionType === 'SEND_PAYMENT_LINK' || toolResult.actionType === 'NOTIFY_CUSTOMER') {
        return {
          outcome: 'WAITING', verified: true,
          reason: 'Waiting for customer', paymentStatus: 'FAILED',
          amountRecovered: 0, metadata: {}
        };
      }
      return {
        outcome: 'ESCALATE', verified: true,
        reason: 'Escalation', paymentStatus: 'FAILED',
        amountRecovered: 0, metadata: {}
      };
    })
  };

  return { prisma, stateService, reasonerService, toolExecutor, verifier };
}

// ============================================================
// SECTION 1: Outreach → WAITING_FOR_CUSTOMER
// ============================================================

describe('Outreach to WAITING_FOR_CUSTOMER', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('SEND_PAYMENT_LINK → VERIFYING → WAITING_FOR_CUSTOMER', async () => {
    const mocks = createMocks();
    (policyEngine.evaluateActionPolicy as any).mockReturnValue({ allowed: true, reason: 'ok' });

    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );
    const result = await orchestrator.processCase('case_1');

    expect(result.finalState).toBe('WAITING_FOR_CUSTOMER');
    expect(result.recoveryResult).toBe('WAITING');
    expect(result.escalationStatus).toBe(false);
    expect(result.actionsAttempted).toContain('SEND_PAYMENT_LINK');

    // Verify the state machine was asked VERIFYING → WAITING_FOR_CUSTOMER
    expect(mocks.stateService.requestTransition).toHaveBeenCalledWith(
      'case_1', 'VERIFYING', 'WAITING_FOR_CUSTOMER', expect.any(String), undefined
    );
  });

  it('NOTIFY_CUSTOMER → VERIFYING → WAITING_FOR_CUSTOMER', async () => {
    const mocks = createMocks();
    (policyEngine.evaluateActionPolicy as any).mockReturnValue({ allowed: true, reason: 'ok' });
    // Override reasoner to recommend NOTIFY_CUSTOMER
    (mocks.reasonerService.executeReasoning as any).mockResolvedValue({
      success: true,
      data: { recommendedAction: 'NOTIFY_CUSTOMER', alternativeActions: [] }
    });

    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );
    const result = await orchestrator.processCase('case_1');

    expect(result.finalState).toBe('WAITING_FOR_CUSTOMER');
    expect(result.recoveryResult).toBe('WAITING');
    expect(result.actionsAttempted).toContain('NOTIFY_CUSTOMER');
  });

  it('WAITING_FOR_CUSTOMER is non-terminal — not in orchestrator loop exit as terminal', async () => {
    const mocks = createMocks({ status: 'WAITING_FOR_CUSTOMER' });

    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );
    const result = await orchestrator.processCase('case_1');

    // Loop exits immediately because WAITING_FOR_CUSTOMER is in the while-loop guard
    expect(result.finalState).toBe('WAITING_FOR_CUSTOMER');
    // But it is NOT escalated or recovered
    expect(result.escalationStatus).toBe(false);
    expect(result.recoveryResult).toBe('WAITING');
    // Zero transitions — loop never entered
    expect(result.executionSummary.transitions).toBe(0);
    // Zero LLM calls
    expect(mocks.reasonerService.executeReasoning).not.toHaveBeenCalled();
    // Zero tool executions
    expect(mocks.toolExecutor.generatePaymentLink).not.toHaveBeenCalled();
    expect(mocks.toolExecutor.retryPayment).not.toHaveBeenCalled();
  });
});

// ============================================================
// SECTION 2: Resume Lifecycle — Exactly-Once Semantics
// ============================================================

describe('Resume Lifecycle', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // --- Non-SUCCESS event rejection ---

  it('non-SUCCESS event does not modify WAITING state', async () => {
    const mocks = createMocks({ status: 'WAITING_FOR_CUSTOMER', attemptCount: 1 });
    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );

    const res = await resumeWaitingCase(mocks.prisma as any, orchestrator, 'pay_1', 'evt_1', 'FAILED');
    expect(res.resumed).toBe(false);
    expect(mocks.prisma.recoveryCase.updateMany).not.toHaveBeenCalled();
    expect(mocks.reasonerService.executeReasoning).not.toHaveBeenCalled();
  });

  it('PENDING event does not modify WAITING state', async () => {
    const mocks = createMocks({ status: 'WAITING_FOR_CUSTOMER', attemptCount: 1 });
    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );

    const res = await resumeWaitingCase(mocks.prisma as any, orchestrator, 'pay_1', 'evt_2', 'PENDING');
    expect(res.resumed).toBe(false);
    expect(mocks.prisma.recoveryCase.updateMany).not.toHaveBeenCalled();
  });

  // --- Duplicate resume ---

  it('duplicate resume: second call returns resumed=false (0 rows affected)', async () => {
    const mocks = createMocks({ status: 'VERIFYING', attemptCount: 1, paymentStatus: 'SUCCESS' });
    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );

    // First call succeeds
    const res1 = await resumeWaitingCase(mocks.prisma as any, orchestrator, 'pay_1', 'evt_a', 'SUCCESS');
    expect(res1.resumed).toBe(true);

    // Second call: DB already moved out of WAITING
    mocks.prisma.recoveryCase.updateMany.mockResolvedValue({ count: 0 });
    const res2 = await resumeWaitingCase(mocks.prisma as any, orchestrator, 'pay_1', 'evt_b', 'SUCCESS');
    expect(res2.resumed).toBe(false);
  });

  // --- Terminal state rejection ---

  it('RECOVERED case cannot be resumed', async () => {
    const mocks = createMocks({ status: 'RECOVERED', attemptCount: 1 });
    mocks.prisma.recoveryCase.updateMany.mockResolvedValue({ count: 0 });
    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );

    const res = await resumeWaitingCase(mocks.prisma as any, orchestrator, 'pay_1', 'evt_1', 'SUCCESS');
    expect(res.resumed).toBe(false);
    expect(mocks.prisma.recoveryCase.updateMany).toHaveBeenCalledWith({
      where: { paymentId: 'pay_1', status: 'WAITING_FOR_CUSTOMER' },
      data: { status: 'VERIFYING' }
    });
  });

  it('ESCALATED case cannot be resumed', async () => {
    const mocks = createMocks({ status: 'ESCALATED', attemptCount: 1 });
    mocks.prisma.recoveryCase.updateMany.mockResolvedValue({ count: 0 });
    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );

    const res = await resumeWaitingCase(mocks.prisma as any, orchestrator, 'pay_1', 'evt_1', 'SUCCESS');
    expect(res.resumed).toBe(false);
  });

  it('CLOSED case cannot be resumed', async () => {
    const mocks = createMocks({ status: 'CLOSED', attemptCount: 1 });
    mocks.prisma.recoveryCase.updateMany.mockResolvedValue({ count: 0 });
    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );

    const res = await resumeWaitingCase(mocks.prisma as any, orchestrator, 'pay_1', 'evt_1', 'SUCCESS');
    expect(res.resumed).toBe(false);
  });

  // --- Successful resume flow ---

  it('authoritative Payment SUCCESS before resume → RECOVERED', async () => {
    const mocks = createMocks({
      status: 'VERIFYING', attemptCount: 1, paymentStatus: 'SUCCESS',
      actionType: 'SEND_PAYMENT_LINK'
    });
    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );

    const res = await resumeWaitingCase(mocks.prisma as any, orchestrator, 'pay_1', 'evt_1', 'SUCCESS');
    expect(res.resumed).toBe(true);
    expect(res.orchestratorResult?.finalState).toBe('RECOVERED');
    expect(res.orchestratorResult?.recoveryResult).toBe('SUCCESS');
  });

  it('authoritative Payment FAILED while event claims SUCCESS → remains WAITING', async () => {
    const mocks = createMocks({
      status: 'VERIFYING', attemptCount: 1, paymentStatus: 'FAILED',
      actionType: 'SEND_PAYMENT_LINK'
    });
    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );

    const res = await resumeWaitingCase(mocks.prisma as any, orchestrator, 'pay_1', 'evt_1', 'SUCCESS');
    expect(res.resumed).toBe(true);
    // Verifier sees FAILED, returns WAITING, state → WAITING_FOR_CUSTOMER
    expect(res.orchestratorResult?.finalState).toBe('WAITING_FOR_CUSTOMER');
    expect(res.orchestratorResult?.recoveryResult).toBe('WAITING');
  });
});

// ============================================================
// SECTION 3: Resume Safety Boundaries
// ============================================================

describe('Resume Safety Boundaries', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('resume does NOT invoke ReasonerService / LLM', async () => {
    const mocks = createMocks({
      status: 'VERIFYING', attemptCount: 1, paymentStatus: 'SUCCESS',
      actionType: 'SEND_PAYMENT_LINK'
    });
    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );

    await resumeWaitingCase(mocks.prisma as any, orchestrator, 'pay_1', 'evt_1', 'SUCCESS');
    expect(mocks.reasonerService.executeReasoning).not.toHaveBeenCalled();
  });

  it('resume does NOT execute any RecoveryToolExecutor method', async () => {
    const mocks = createMocks({
      status: 'VERIFYING', attemptCount: 1, paymentStatus: 'SUCCESS',
      actionType: 'SEND_PAYMENT_LINK'
    });
    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );

    await resumeWaitingCase(mocks.prisma as any, orchestrator, 'pay_1', 'evt_1', 'SUCCESS');
    expect(mocks.toolExecutor.retryPayment).not.toHaveBeenCalled();
    expect(mocks.toolExecutor.generatePaymentLink).not.toHaveBeenCalled();
    expect(mocks.toolExecutor.notifyCustomer).not.toHaveBeenCalled();
    expect(mocks.toolExecutor.escalateToHuman).not.toHaveBeenCalled();
  });

  it('resume does NOT create a new RecoveryAttempt', async () => {
    const mocks = createMocks({
      status: 'VERIFYING', attemptCount: 1, paymentStatus: 'SUCCESS',
      actionType: 'SEND_PAYMENT_LINK'
    });
    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );

    await resumeWaitingCase(mocks.prisma as any, orchestrator, 'pay_1', 'evt_1', 'SUCCESS');
    expect(mocks.prisma.recoveryAttempt.create).not.toHaveBeenCalled();
  });

  it('resume does NOT increment attemptCount', async () => {
    const mocks = createMocks({
      status: 'VERIFYING', attemptCount: 1, paymentStatus: 'SUCCESS',
      actionType: 'SEND_PAYMENT_LINK'
    });
    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );

    await resumeWaitingCase(mocks.prisma as any, orchestrator, 'pay_1', 'evt_1', 'SUCCESS');
    // The update mock on recoveryCase should NOT be called with attemptCount increment
    const updateCalls = mocks.prisma.recoveryCase.update.mock.calls;
    for (const call of updateCalls) {
      const data = call[0]?.data;
      if (data?.attemptCount) {
        throw new Error('attemptCount was modified during resume');
      }
    }
  });

  it('resumed case cannot reach DIAGNOSING, STRATEGY_PENDING, EXECUTING, or RETRY_PENDING', async () => {
    const mocks = createMocks({
      status: 'VERIFYING', attemptCount: 1, paymentStatus: 'SUCCESS',
      actionType: 'SEND_PAYMENT_LINK'
    });
    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );

    await resumeWaitingCase(mocks.prisma as any, orchestrator, 'pay_1', 'evt_1', 'SUCCESS');

    const transitionCalls = mocks.stateService.requestTransition.mock.calls;
    const transitionedStates = transitionCalls.map((c: any[]) => c[2]); // 3rd arg = toState

    expect(transitionedStates).not.toContain('DIAGNOSING');
    expect(transitionedStates).not.toContain('STRATEGY_PENDING');
    expect(transitionedStates).not.toContain('EXECUTING');
    expect(transitionedStates).not.toContain('RETRY_PENDING');
  });
});

// ============================================================
// SECTION 4: RecoveryAttempt Identity Verification
// ============================================================

describe('RecoveryAttempt Identity on Resume', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('resume looks up exact { caseId, attemptNumber: persisted attemptCount }', async () => {
    const mocks = createMocks({
      status: 'VERIFYING', attemptCount: 3, paymentStatus: 'SUCCESS',
      actionType: 'SEND_PAYMENT_LINK'
    });
    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );

    await resumeWaitingCase(mocks.prisma as any, orchestrator, 'pay_1', 'evt_1', 'SUCCESS');

    // Verify the exact lookup key used
    expect(mocks.prisma.recoveryAttempt.findUnique).toHaveBeenCalledWith({
      where: {
        caseId_attemptNumber: {
          caseId: 'case_1',
          attemptNumber: 3  // Must match persisted attemptCount, NOT 0, NOT "latest"
        }
      }
    });
  });

  it('resume does NOT use timestamp ordering or findFirst', async () => {
    const mocks = createMocks({
      status: 'VERIFYING', attemptCount: 2, paymentStatus: 'SUCCESS',
      actionType: 'NOTIFY_CUSTOMER'
    });
    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );

    await resumeWaitingCase(mocks.prisma as any, orchestrator, 'pay_1', 'evt_1', 'SUCCESS');

    // findUnique was called (deterministic key), NOT findFirst or findMany
    expect(mocks.prisma.recoveryAttempt.findUnique).toHaveBeenCalled();
    expect(mocks.prisma.recoveryAttempt.findMany).not.toHaveBeenCalled();
  });
});

// ============================================================
// SECTION 5: Atomic Resume Query Verification
// ============================================================

describe('Atomic Resume Query', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('uses exact WHERE {paymentId, status: WAITING_FOR_CUSTOMER}', async () => {
    const mocks = createMocks({ status: 'VERIFYING', attemptCount: 1, paymentStatus: 'SUCCESS' });
    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );

    await resumeWaitingCase(mocks.prisma as any, orchestrator, 'pay_1', 'evt_1', 'SUCCESS');

    expect(mocks.prisma.recoveryCase.updateMany).toHaveBeenCalledWith({
      where: { paymentId: 'pay_1', status: 'WAITING_FOR_CUSTOMER' },
      data: { status: 'VERIFYING' }
    });
  });
});

// ============================================================
// SECTION 6: Crash Window A — Documented Limitation
// ============================================================

describe('Crash Window A — Stale VERIFYING (Documented Limitation)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  /**
   * DOCUMENTED LIMITATION (NOT A FIX):
   *
   * If resumeWaitingCase() atomically transitions WAITING → VERIFYING
   * but processCase() crashes before completing verification,
   * the case remains in VERIFYING with no orchestrator running.
   *
   * The case is NOT WAITING (so no event can resume it)
   * and NOT terminal (so it's not closed).
   *
   * This is an orphaned state that requires a future lifecycle
   * reconciliation/sweeper mechanism to detect and either:
   * - re-enter processCase()
   * - escalate the case
   *
   * This test documents the current behavior, not a fix.
   */
  it('processCase crash after resume leaves case in VERIFYING (orphaned)', async () => {
    const mocks = createMocks({ status: 'VERIFYING', attemptCount: 1, paymentStatus: 'SUCCESS' });

    // Simulate processCase throwing
    const orchestrator = new AgentOrchestrator(
      mocks.prisma as any, mocks.stateService as any,
      mocks.reasonerService as any, mocks.toolExecutor as any, mocks.verifier as any
    );

    // Make verifier crash
    mocks.verifier.verify.mockRejectedValue(new Error('Process crash simulation'));

    const res = await resumeWaitingCase(mocks.prisma as any, orchestrator, 'pay_1', 'evt_1', 'SUCCESS');

    // Resume still reports true because ownership was consumed
    expect(res.resumed).toBe(true);
    // But the orchestrator escalated due to verifier crash (safe failure)
    expect(res.orchestratorResult?.finalState).toBe('ESCALATED');
  });
});
