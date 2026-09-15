import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentEvaluationHarness } from './evaluator';
import { BaselineEvaluationProvider } from './baseline-provider';
import type { PrismaClient } from '@prisma/client';
import fs from 'fs';

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn()
  }
}));

// Mock the AgentOrchestrator rather than running the full DB simulator to isolate evaluator logic
vi.mock('../agent/orchestrator', () => {
  return {
    AgentOrchestrator: class {
      processCase = vi.fn().mockResolvedValue({
        finalState: 'RECOVERED',
        policyDecisions: [{ action: 'RETRY_PAYMENT', allowed: true, reason: 'ok' }],
        executionSummary: { durationMs: 100 }
      });
    }
  };
});

function createMockPrisma() {
  return {
    recoveryCase: {
      findUnique: vi.fn().mockImplementation(async ({ where }) => {
        return {
          id: where.id,
          status: 'PENDING',
          payment: { amount: 1000 }
        };
      }),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(),
    },
    payment: {
      updateMany: vi.fn()
    },
    auditEvent: { deleteMany: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    recoveryAttempt: { deleteMany: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    agentDecision: { deleteMany: vi.fn() }
  } as unknown as PrismaClient;
}

describe('Agent Evaluation Harness', () => {
  const fakeGroundTruth = [
    { caseId: 'case_1', paymentId: 'pay_1', failureCode: 'NETWORK_TIMEOUT', expectedAction: 'RETRY_PAYMENT', amount: 1000 },
    { caseId: 'case_2', paymentId: 'pay_2', failureCode: 'BANK_DECLINED', expectedAction: 'NOTIFY_CUSTOMER', amount: 2000 }
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(fakeGroundTruth));
  });

  it('A/D/G. Perfect recommendations and financial aggregation', async () => {
    const prisma = createMockPrisma();
    (prisma.recoveryCase.findUnique as any).mockImplementation(async ({ where }: any) => ({
      id: where.id,
      status: where.id === 'case_1' ? 'RECOVERED' : 'ESCALATED',
      payment: { amount: 1000 }
    }));
    
    const provider = new BaselineEvaluationProvider();
    
    // We mocked the orchestrator to return RETRY_PAYMENT allowed for all.
    // For case 1 this is correct. For case 2 it's incorrect. Let's manipulate the mock for this test
    const harness = new AgentEvaluationHarness(prisma, provider, 'BASELINE');
    
    // Override the mock orchestrator just for this test
    (harness as any).orchestrator.processCase = vi.fn().mockImplementation(async (caseId) => {
      if (caseId === 'case_1') {
        return {
          finalState: 'RECOVERED',
          policyDecisions: [{ action: 'RETRY_PAYMENT', allowed: true }],
          executionSummary: { durationMs: 100 }
        };
      }
      return {
        finalState: 'ESCALATED',
        policyDecisions: [{ action: 'NOTIFY_CUSTOMER', allowed: true }], // Correct for case 2
        executionSummary: { durationMs: 100 }
      };
    });

    const result = await harness.runEvaluation('fake_path.json');

    expect(result.metrics.totalCases).toBe(2);
    expect(result.metrics.recommendationAccuracy).toBe(1.0); // Both recommended correctly
    expect(result.metrics.totalRevenueAtRisk).toBe(3000);
    expect(result.metrics.totalRevenueRecovered).toBe(1000); // Only case 1 recovered
    expect(result.metrics.recoveryRate).toBeCloseTo(0.333, 2);
  });

  it('B. Deliberately incorrect recommendation', async () => {
    const prisma = createMockPrisma();
    const provider = new BaselineEvaluationProvider();
    const harness = new AgentEvaluationHarness(prisma, provider, 'BASELINE');
    
    (harness as any).orchestrator.processCase = vi.fn().mockResolvedValue({
      finalState: 'ESCALATED',
      policyDecisions: [{ action: 'ESCALATE_TO_HUMAN', allowed: true }], // Incorrect for both
      executionSummary: { durationMs: 100 }
    });

    const result = await harness.runEvaluation('fake_path.json');
    expect(result.metrics.recommendationAccuracy).toBe(0);
    expect(result.metrics.correctRecommendations).toBe(0);
  });

  it('C. Policy-denied recommendation', async () => {
    const prisma = createMockPrisma();
    const provider = new BaselineEvaluationProvider();
    const harness = new AgentEvaluationHarness(prisma, provider, 'BASELINE');
    
    (harness as any).orchestrator.processCase = vi.fn().mockResolvedValue({
      finalState: 'ESCALATED',
      policyDecisions: [{ action: 'RETRY_PAYMENT', allowed: false }], // Denied
      executionSummary: { durationMs: 100 }
    });

    const result = await harness.runEvaluation('fake_path.json');
    expect(result.metrics.policyComplianceRate).toBe(0); // 0 out of 2
    expect(result.metrics.policyDeniedRecommendations).toBe(2);
  });

  it('L. Recommendation correctness is NOT confused with recovery success', async () => {
    const prisma = createMockPrisma();
    (prisma.recoveryCase.findUnique as any).mockImplementation(async ({ where }: any) => ({
      id: where.id,
      status: 'ESCALATED',
      payment: { amount: 1000 }
    }));
    
    const provider = new BaselineEvaluationProvider();
    const harness = new AgentEvaluationHarness(prisma, provider, 'BASELINE');
    
    // Agent recommends CORRECTLY, but action fails (escalated)
    (harness as any).orchestrator.processCase = vi.fn().mockImplementation(async (caseId) => {
      const expected = caseId === 'case_1' ? 'RETRY_PAYMENT' : 'NOTIFY_CUSTOMER';
      return {
        finalState: 'ESCALATED', // Failed to recover
        policyDecisions: [{ action: expected, allowed: true }], // Correct recommendation
        executionSummary: { durationMs: 100 }
      };
    });

    const result = await harness.runEvaluation('fake_path.json');
    expect(result.metrics.recommendationAccuracy).toBe(1.0); // Brilliant AI
    expect(result.metrics.recoveryRate).toBe(0); // But execution failed
  });

  it('H. Failure-code breakdown', async () => {
    const prisma = createMockPrisma();
    const provider = new BaselineEvaluationProvider();
    const harness = new AgentEvaluationHarness(prisma, provider, 'BASELINE');
    
    (harness as any).orchestrator.processCase = vi.fn().mockResolvedValue({
      finalState: 'RECOVERED',
      policyDecisions: [{ action: 'RETRY_PAYMENT', allowed: true }],
      executionSummary: { durationMs: 100 }
    });

    const result = await harness.runEvaluation('fake_path.json');
    
    expect(result.metrics.byFailureCode['NETWORK_TIMEOUT']).toBeDefined();
    expect(result.metrics.byFailureCode['NETWORK_TIMEOUT'].cases).toBe(1);
    expect(result.metrics.byFailureCode['NETWORK_TIMEOUT'].correctRecommendations).toBe(1);
    
    expect(result.metrics.byFailureCode['BANK_DECLINED']).toBeDefined();
    expect(result.metrics.byFailureCode['BANK_DECLINED'].cases).toBe(1);
    // Incorrect recommendation (RETRY != NOTIFY)
    expect(result.metrics.byFailureCode['BANK_DECLINED'].correctRecommendations).toBe(0); 
  });
});
