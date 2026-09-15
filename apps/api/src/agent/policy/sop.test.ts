import { describe, test, expect, beforeAll, afterAll, beforeEach, vi, Mocked } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AgentOrchestrator } from '../orchestrator/index';
import { StateMachineService } from '../state/service';
import { ReasonerService } from '../reasoner/service';
import { RecoveryToolExecutor } from '../tools';
import { ReasonerProvider, SanitizedCaseContext } from '../reasoner/types';

describe('SOP Architectural Injection', () => {
  let prisma: PrismaClient;
  let orchestrator: AgentOrchestrator;
  let mockProvider: Mocked<ReasonerProvider>;

  beforeAll(async () => {
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.agentDecision.deleteMany();
    await prisma.auditEvent.deleteMany();
    await prisma.recoveryAttempt.deleteMany();
    await prisma.recoveryCase.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.policy.deleteMany();

    mockProvider = {
      reason: vi.fn().mockResolvedValue({
        diagnosisCode: 'TEST',
        diagnosisSummary: 'Test',
        diagnosisConfidence: 0.9,
        recommendedAction: 'NOTIFY_CUSTOMER',
        recommendationConfidence: 0.9,
        recommendationReason: 'Test',
        alternativeActions: [],
        escalationRecommendation: false
      }),
      probe: vi.fn().mockResolvedValue({ status: 'AVAILABLE' })
    };

    const reasonerService = new ReasonerService(prisma, mockProvider);
    const stateService = new StateMachineService(prisma);
    const toolExecutor = new RecoveryToolExecutor(prisma);
    
    const verifier = {
      verifyOutcome: vi.fn().mockResolvedValue({ status: 'ESCALATED', verifiedAmount: 0 }),
      verify: vi.fn().mockResolvedValue({ success: false }) // Added to satisfy VerifierBoundary
    } as any;

    orchestrator = new AgentOrchestrator(prisma, stateService, reasonerService, toolExecutor, verifier);
  });

  async function createTestCase() {
    const customer = await prisma.customer.create({
      data: { externalId: 'cust_sop_test_' + Date.now(), name: 'Test', email: 'test@example.com' }
    });
    const payment = await prisma.payment.create({
      data: { externalId: 'pay_sop_test_' + Date.now(), customerId: customer.id, amount: 1000, method: 'CARD', attemptedAt: new Date() }
    });
    const recoveryCase = await prisma.recoveryCase.create({
      data: { paymentId: payment.id, customerId: customer.id, status: 'DETECTED', amountAtRisk: 1000 }
    });
    return recoveryCase.id;
  }

  test('Escalates safely when 0 active SOPs exist', async () => {
    const caseId = await createTestCase();
    await orchestrator.processCase(caseId);

    const updatedCase = await prisma.recoveryCase.findUnique({ where: { id: caseId } });
    expect(updatedCase?.status).toBe('ESCALATED');
    
    const audit = await prisma.auditEvent.findFirst({
      where: { caseId, eventType: 'STATE_TRANSITION' },
      orderBy: { createdAt: 'desc' }
    });
    expect(audit).toBeDefined();
    expect(audit?.details).toContain('Escalating due to missing SOP');
  });

  test('Escalates safely when >1 active SOPs exist', async () => {
    await prisma.policy.create({
      data: { name: 'sop1', description: 'desc', ruleType: 'STANDARD_OPERATING_PROCEDURE', conditions: '{}', isActive: true, priority: 100 }
    });
    await prisma.policy.create({
      data: { name: 'sop2', description: 'desc', ruleType: 'STANDARD_OPERATING_PROCEDURE', conditions: '{}', isActive: true, priority: 200 }
    });

    const caseId = await createTestCase();
    await orchestrator.processCase(caseId);

    const updatedCase = await prisma.recoveryCase.findUnique({ where: { id: caseId } });
    expect(updatedCase?.status).toBe('ESCALATED');
    
    const audit = await prisma.auditEvent.findFirst({
      where: { caseId, eventType: 'STATE_TRANSITION' },
      orderBy: { createdAt: 'desc' }
    });
    expect(audit).toBeDefined();
    expect(audit?.details).toContain('Escalating due to multiple active SOPs');
  });

  test('Escalates safely when SOP is malformed JSON', async () => {
    await prisma.policy.create({
      data: { name: 'sop_malformed', description: 'desc', ruleType: 'STANDARD_OPERATING_PROCEDURE', conditions: 'INVALID_JSON', isActive: true, priority: 100 }
    });

    const caseId = await createTestCase();
    await orchestrator.processCase(caseId);

    const updatedCase = await prisma.recoveryCase.findUnique({ where: { id: caseId } });
    expect(updatedCase?.status).toBe('ESCALATED');
  });

  test('Injects SOP properly into context when exactly 1 exists', async () => {
    const validSOP = {
      policyVersion: '1.0.0',
      rules: [{ failureCategory: 'TEST', guidance: 'Do this', appropriateActions: ['NOTIFY_CUSTOMER'] }]
    };

    await prisma.policy.create({
      data: { name: 'sop_valid', description: 'desc', ruleType: 'STANDARD_OPERATING_PROCEDURE', conditions: JSON.stringify(validSOP), isActive: true, priority: 100 }
    });

    const caseId = await createTestCase();
    await orchestrator.processCase(caseId);

    // Verify reasoner was called
    expect(mockProvider.reason).toHaveBeenCalledTimes(1);
    
    const calledContext = mockProvider.reason.mock.calls[0][0] as SanitizedCaseContext;
    expect(calledContext.standardOperatingProcedures).toBeDefined();
    expect(calledContext.standardOperatingProcedures?.policyVersion).toBe('1.0.0');
    
    // Verify groundTruth is NOT in the context
    const contextString = JSON.stringify(calledContext);
    expect(contextString).not.toContain('groundTruth');
    expect(contextString).not.toContain('expectedAction');
  });
});
