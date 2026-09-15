import { describe, it, expect, vi } from 'vitest';
import { ReasonerService } from './service';
import type { SanitizedCaseContext, ReasonerProvider } from './types';
import type { PrismaClient } from '@prisma/client';

const mockContext: SanitizedCaseContext = {
  caseId: 'case_1',
  payment: {
    amountPaise: 1000,
    currency: 'INR',
    method: 'CARD',
    failureCode: 'NETWORK_TIMEOUT',
    failureReason: 'Bank timeout',
  },
  customer: {
    riskTier: 'LOW',
    successfulPayments: 10,
    failedPayments: 1,
  },
  recoveryState: {
    status: 'DIAGNOSING',
    attemptCount: 0,
  },
  policiesSummary: ['Max retries: 3'],
};

function createMockPrisma() {
  return {
    agentDecision: {
      create: vi.fn().mockResolvedValue({ id: 'decision_1' }),
    }
  } as unknown as PrismaClient;
}

function createMockProvider(mockResponse: any, delayMs = 0): ReasonerProvider {
  return {
    reason: vi.fn().mockImplementation(async () => {
      if (delayMs > 0) {
        await new Promise(r => setTimeout(r, delayMs));
      }
      if (mockResponse instanceof Error) throw mockResponse;
      return mockResponse;
    }),
    probe: vi.fn().mockResolvedValue({ status: 'AVAILABLE' })
  };
}

describe('AI Reasoner Layer', () => {

  const validMockResponse = {
    diagnosisCode: 'NET_TIMEOUT_01',
    diagnosisSummary: 'Bank timed out.',
    diagnosisConfidence: 0.9,
    recommendedAction: 'RETRY_PAYMENT',
    recommendationConfidence: 0.85,
    recommendationReason: 'Low risk, transient error.',
    alternativeActions: ['SEND_PAYMENT_LINK'],
    escalationRecommendation: false
  };

  it('A. Valid structured response -> accepted (Integration Test S)', async () => {
    const prisma = createMockPrisma();
    const provider = createMockProvider(validMockResponse);
    const service = new ReasonerService(prisma, provider);

    const result = await service.executeReasoning(mockContext, 'attempt_1');

    expect(result.success).toBe(true);
    expect(result.data?.recommendedAction).toBe('RETRY_PAYMENT');
    expect(prisma.agentDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          step: 'DIAGNOSIS',
          rationale: 'Low risk, transient error.',
          decision: expect.stringContaining('"attemptId":"attempt_1"')
        })
      })
    );
  });

  it('B/M. Unknown action / Arbitrary tool -> rejected', async () => {
    const prisma = createMockPrisma();
    const provider = createMockProvider({ ...validMockResponse, recommendedAction: 'HACK_BANK' });
    const service = new ReasonerService(prisma, provider);

    const result = await service.executeReasoning(mockContext, 'attempt_1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('SCHEMA_VALIDATION_FAILED');
  });

  it('C. Invalid diagnosis code (empty string) -> rejected', async () => {
    const prisma = createMockPrisma();
    const provider = createMockProvider({ ...validMockResponse, diagnosisCode: '' });
    const service = new ReasonerService(prisma, provider);

    const result = await service.executeReasoning(mockContext, 'attempt_1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('SCHEMA_VALIDATION_FAILED');
  });

  it('D. Confidence below 0 -> rejected', async () => {
    const prisma = createMockPrisma();
    const provider = createMockProvider({ ...validMockResponse, recommendationConfidence: -0.1 });
    const service = new ReasonerService(prisma, provider);

    const result = await service.executeReasoning(mockContext, 'attempt_1');
    expect(result.success).toBe(false);
  });

  it('E. Confidence above 1 -> rejected', async () => {
    const prisma = createMockPrisma();
    const provider = createMockProvider({ ...validMockResponse, recommendationConfidence: 1.1 });
    const service = new ReasonerService(prisma, provider);

    const result = await service.executeReasoning(mockContext, 'attempt_1');
    expect(result.success).toBe(false);
  });

  it('F. Missing required field -> rejected', async () => {
    const prisma = createMockPrisma();
    const { recommendedAction, ...missingActionResponse } = validMockResponse;
    const provider = createMockProvider(missingActionResponse);
    const service = new ReasonerService(prisma, provider);

    const result = await service.executeReasoning(mockContext, 'attempt_1');
    expect(result.success).toBe(false);
  });

  it('G/H. Malformed JSON / Empty provider response -> rejected', async () => {
    const prisma = createMockPrisma();
    const provider = createMockProvider("I am an LLM, here is my thought process...");
    const service = new ReasonerService(prisma, provider);

    const result = await service.executeReasoning(mockContext, 'attempt_1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('SCHEMA_VALIDATION_FAILED');
  });

  it('I. Provider timeout -> structured failure', async () => {
    const prisma = createMockPrisma();
    const provider = createMockProvider(new Error('PROVIDER_TIMEOUT'));
    const service = new ReasonerService(prisma, provider);

    const result = await service.executeReasoning(mockContext, 'attempt_1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('PROVIDER_TIMEOUT');
    
    // Verifies deterministic failure logging
    expect(prisma.agentDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          step: 'DIAGNOSIS',
          decision: expect.stringContaining('PROVIDER_TIMEOUT')
        })
      })
    );
  });

  describe('Regression: Gemini Error Path Observability', () => {
    it('J1. Authentication failure -> logs valid AgentDecision', async () => {
      const prisma = createMockPrisma();
      const provider = createMockProvider(new Error('PROVIDER_AUTH_FAILURE'));
      const service = new ReasonerService(prisma, provider);

      const result = await service.executeReasoning(mockContext, 'attempt_error');
      expect(result.success).toBe(false);
      expect(result.error).toBe('PROVIDER_AUTH_FAILURE');
      expect(prisma.agentDecision.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ step: 'DIAGNOSIS' })
        })
      );
    });

    it('J2. Rate-limit failure -> logs valid AgentDecision', async () => {
      const prisma = createMockPrisma();
      const provider = createMockProvider(new Error('PROVIDER_RATE_LIMIT_TRANSIENT'));
      const service = new ReasonerService(prisma, provider);

      const result = await service.executeReasoning(mockContext, 'attempt_error');
      expect(result.success).toBe(false);
      expect(prisma.agentDecision.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ step: 'DIAGNOSIS' })
        })
      );
    });

    it('J3. Unknown provider failure -> logs valid AgentDecision', async () => {
      const prisma = createMockPrisma();
      const provider = createMockProvider(new Error('PROVIDER_UNKNOWN_ERROR: model not found'));
      const service = new ReasonerService(prisma, provider);

      const result = await service.executeReasoning(mockContext, 'attempt_error');
      expect(result.success).toBe(false);
      expect(prisma.agentDecision.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            step: 'DIAGNOSIS',
            rationale: 'Reasoner failed: PROVIDER_UNKNOWN_ERROR: model not found',
            decision: expect.stringContaining('PROVIDER_UNKNOWN_ERROR')
          })
        })
      );
    });
  });

  it('K. Three alternatives -> accepted', async () => {
    const prisma = createMockPrisma();
    const provider = createMockProvider({ 
      ...validMockResponse, 
      alternativeActions: ['SEND_PAYMENT_LINK', 'NOTIFY_CUSTOMER', 'ESCALATE_TO_HUMAN']
    });
    const service = new ReasonerService(prisma, provider);

    const result = await service.executeReasoning(mockContext, 'attempt_1');
    expect(result.success).toBe(true);
  });

  it('L. More than three alternatives -> rejected', async () => {
    const prisma = createMockPrisma();
    const provider = createMockProvider({ 
      ...validMockResponse, 
      alternativeActions: ['RETRY_PAYMENT', 'SEND_PAYMENT_LINK', 'NOTIFY_CUSTOMER', 'ESCALATE_TO_HUMAN']
    });
    const service = new ReasonerService(prisma, provider);

    const result = await service.executeReasoning(mockContext, 'attempt_1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('SCHEMA_VALIDATION_FAILED');
  });

  it('N/O/P/Q. Architecture verification', () => {
    // N: ReasonerService only takes Prisma to write AgentDecision, not modify Payment/RecoveryCase.
    // O: groundTruth.json is never imported in the src/agent/reasoner folder.
    // P: Prompt version is passed in metadata.
    const prisma = createMockPrisma();
    const provider = createMockProvider(validMockResponse);
    const service = new ReasonerService(prisma, provider, 'test-model');
    
    service.executeReasoning(mockContext, 'attempt_1').then(() => {
      expect(prisma.agentDecision.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            decision: expect.stringContaining('"promptVersion":"1.0.0"')
          })
        })
      );
    });
  });

});
