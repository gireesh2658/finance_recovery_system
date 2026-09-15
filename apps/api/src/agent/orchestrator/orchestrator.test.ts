import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentOrchestrator } from './index';
import type { PrismaClient } from '@prisma/client';
import type { StateMachineService } from '../state/service';
import type { ReasonerService } from '../reasoner/service';
import type { RecoveryToolExecutor } from '../tools';
import type { VerifierBoundary } from './types';
import * as policyEngine from '../policy/engine';

// Mock the policy engine completely since it's a pure function import
vi.mock('../policy/engine', () => ({
  evaluateActionPolicy: vi.fn()
}));

function createMocks() {
  const prisma = {
    recoveryCase: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'case_1',
        status: 'DETECTED',
        attemptCount: 0,
        amountAtRisk: 1000,
        paymentId: 'pay_1',
        payment: {
          amount: 1000,
          currency: 'INR',
          paymentMethod: 'CARD',
          failureCode: 'NETWORK_TIMEOUT',
          failureReason: 'timeout',
          customer: { riskTier: 'LOW', totalPayments: 10, failedPayments: 1 }
        }
      }),
      update: vi.fn(),
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
  } as unknown as PrismaClient;

  // State machine perfectly allows transitions requested
  const stateService = {
    requestTransition: vi.fn().mockImplementation(async (_cId, _from, to) => ({
      success: true,
      nextState: to
    }))
  } as unknown as StateMachineService;

  const reasonerService = {
    executeReasoning: vi.fn().mockResolvedValue({
      success: true,
      data: {
        recommendedAction: 'RETRY_PAYMENT',
        alternativeActions: ['SEND_PAYMENT_LINK']
      }
    })
  } as unknown as ReasonerService;

  const toolExecutor = {
    retryPayment: vi.fn().mockResolvedValue({ success: true, outcome: 'SUCCESS' }),
    generatePaymentLink: vi.fn().mockResolvedValue({ success: true, outcome: 'LINK_GENERATED' }),
  } as unknown as RecoveryToolExecutor;

  const verifier = {
    verify: vi.fn().mockResolvedValue({
      outcome: 'RECOVERED',
      verified: true,
      reason: 'mocked',
      paymentStatus: 'SUCCESS',
      amountRecovered: 1000,
      metadata: {}
    })
  } as unknown as VerifierBoundary;

  return { prisma, stateService, reasonerService, toolExecutor, verifier };
}

describe('Central Agent Orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('A/S. Normal successful flow (Integration Style)', async () => {
    const mocks = createMocks();
    (policyEngine.evaluateActionPolicy as any).mockReturnValue({ allowed: true, reason: 'ok' });
    
    const orchestrator = new AgentOrchestrator(
      mocks.prisma, mocks.stateService, mocks.reasonerService, mocks.toolExecutor, mocks.verifier
    );

    const result = await orchestrator.processCase('case_1');

    expect(result.finalState).toBe('RECOVERED');
    expect(result.actionsAttempted).toEqual(['RETRY_PAYMENT']);
    expect(result.policyDecisions.length).toBe(1);
    expect(result.policyDecisions[0].allowed).toBe(true);
    
    // Check strict transitions sequence via state machine
    const transitions = mocks.stateService.requestTransition as any;
    expect(transitions).toHaveBeenCalledWith('case_1', 'DETECTED', 'DIAGNOSING', expect.any(String), undefined);
    expect(transitions).toHaveBeenCalledWith('case_1', 'DIAGNOSING', 'DIAGNOSED', expect.any(String), undefined);
    expect(transitions).toHaveBeenCalledWith('case_1', 'DIAGNOSED', 'STRATEGY_PENDING', expect.any(String), undefined);
    expect(transitions).toHaveBeenCalledWith('case_1', 'STRATEGY_PENDING', 'POLICY_CHECK', expect.any(String), undefined);
    expect(transitions).toHaveBeenCalledWith('case_1', 'POLICY_CHECK', 'ACTION_APPROVED', expect.any(String), undefined);
    expect(transitions).toHaveBeenCalledWith('case_1', 'ACTION_APPROVED', 'EXECUTING', expect.any(String), undefined);
    expect(transitions).toHaveBeenCalledWith('case_1', 'EXECUTING', 'VERIFYING', expect.any(String), undefined);
    expect(transitions).toHaveBeenCalledWith('case_1', 'VERIFYING', 'RECOVERED', expect.any(String), { amountRecovered: 1000 });
  });

  it('B/C. Policy denial & Alternative strategy fallback', async () => {
    const mocks = createMocks();
    
    // Mock policy: deny first, allow second
    (policyEngine.evaluateActionPolicy as any)
      .mockReturnValueOnce({ allowed: false, reason: 'no' })
      .mockReturnValueOnce({ allowed: true, reason: 'ok' });
    
    const orchestrator = new AgentOrchestrator(
      mocks.prisma, mocks.stateService, mocks.reasonerService, mocks.toolExecutor, mocks.verifier
    );

    const result = await orchestrator.processCase('case_1');

    expect(result.finalState).toBe('RECOVERED');
    expect(result.actionsAttempted).toEqual(['SEND_PAYMENT_LINK']); // Primary was denied
    
    const transitions = mocks.stateService.requestTransition as any;
    expect(transitions).toHaveBeenCalledWith('case_1', 'POLICY_CHECK', 'POLICY_DENIED', expect.any(String), undefined);
    expect(transitions).toHaveBeenCalledWith('case_1', 'POLICY_DENIED', 'STRATEGY_PENDING', expect.any(String), undefined);
  });

  it('D. All alternatives denied -> ESCALATED', async () => {
    const mocks = createMocks();
    // Deny all policies
    (policyEngine.evaluateActionPolicy as any).mockReturnValue({ allowed: false, reason: 'no' });
    
    const orchestrator = new AgentOrchestrator(
      mocks.prisma, mocks.stateService, mocks.reasonerService, mocks.toolExecutor, mocks.verifier
    );

    const result = await orchestrator.processCase('case_1');

    expect(result.finalState).toBe('ESCALATED');
    expect(result.actionsAttempted.length).toBe(0); // No tool ran
  });

  it('H. Reasoner failure -> safe escalation', async () => {
    const mocks = createMocks();
    // Reasoner throws/fails
    (mocks.reasonerService.executeReasoning as any).mockResolvedValue({ success: false, error: 'TIMEOUT' });
    
    const orchestrator = new AgentOrchestrator(
      mocks.prisma, mocks.stateService, mocks.reasonerService, mocks.toolExecutor, mocks.verifier
    );

    const result = await orchestrator.processCase('case_1');

    expect(result.finalState).toBe('ESCALATED');
    expect(result.failureReason).toContain('Reasoner failed');
  });

  it('J. Tool failure -> safe escalation', async () => {
    const mocks = createMocks();
    (policyEngine.evaluateActionPolicy as any).mockReturnValue({ allowed: true, reason: 'ok' });
    
    // Tool crashes
    (mocks.toolExecutor.retryPayment as any).mockRejectedValue(new Error('Internal Simulator Crash'));
    
    const orchestrator = new AgentOrchestrator(
      mocks.prisma, mocks.stateService, mocks.reasonerService, mocks.toolExecutor, mocks.verifier
    );

    const result = await orchestrator.processCase('case_1');

    expect(result.finalState).toBe('ESCALATED');
    expect(result.failureReason).toContain('Tool execution failed');
  });

  it('K. Terminal case -> no execution', async () => {
    const mocks = createMocks();
    // DB starts at RECOVERED
    (mocks.prisma.recoveryCase.findUnique as any).mockResolvedValue({ status: 'RECOVERED' });
    
    const orchestrator = new AgentOrchestrator(
      mocks.prisma, mocks.stateService, mocks.reasonerService, mocks.toolExecutor, mocks.verifier
    );

    const result = await orchestrator.processCase('case_1');

    expect(result.finalState).toBe('RECOVERED');
    expect(result.executionSummary.transitions).toBe(0);
  });

  it('N. Policy engine failure -> fail closed', async () => {
    const mocks = createMocks();
    // Policy engine crashes
    (policyEngine.evaluateActionPolicy as any).mockImplementation(() => { throw new Error('DB Crash'); });
    
    const orchestrator = new AgentOrchestrator(
      mocks.prisma, mocks.stateService, mocks.reasonerService, mocks.toolExecutor, mocks.verifier
    );

    const result = await orchestrator.processCase('case_1');

    expect(result.finalState).toBe('ESCALATED');
    expect(result.failureReason).toContain('Policy Engine Error');
  });

});
