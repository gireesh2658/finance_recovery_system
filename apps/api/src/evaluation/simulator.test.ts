import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AgentOrchestrator } from '../agent/orchestrator';
import { CustomerBehaviorSimulator } from './simulator';
import { StateMachineService } from '../agent/state/service';
import { ReasonerService } from '../agent/reasoner/service';
import { RecoveryToolExecutor } from '../agent/tools';
import { OutcomeVerifier } from '../agent/verifier';
import * as resumeModule from '../agent/orchestrator/resume';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

describe('CustomerBehaviorSimulator - 44D Hardening', () => {
  let orchestrator: AgentOrchestrator;
  let simulator: CustomerBehaviorSimulator;

  beforeEach(async () => {
    await prisma.auditEvent.deleteMany();
    await prisma.agentDecision.deleteMany();
    await prisma.recoveryAttempt.deleteMany();
    await prisma.recoveryCase.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.customer.deleteMany();

    const stateService = new StateMachineService(prisma);
    const reasonerService = new ReasonerService(prisma, {} as any, 'mock');
    const toolExecutor = new RecoveryToolExecutor(prisma);
    const verifier = new OutcomeVerifier(prisma);
    orchestrator = new AgentOrchestrator(prisma, stateService, reasonerService, toolExecutor, verifier);
    simulator = new CustomerBehaviorSimulator(prisma, orchestrator);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test 1: WAITING_FOR_CUSTOMER + FAILED + eligible customer
  it('Test 1: Eligible case performs mutation and resumes exactly once', async () => {
    const customer = await prisma.customer.create({ data: { externalId: 'c1', name: 'N', email: 'e', riskTier: 'LOW' }});
    const payment = await prisma.payment.create({ data: { externalId: 'p1', customerId: customer.id, amount: 500000, method: 'CARD', status: 'FAILED', attemptedAt: new Date() }});
    const rCase = await prisma.recoveryCase.create({ data: { paymentId: payment.id, customerId: customer.id, status: 'WAITING_FOR_CUSTOMER', amountAtRisk: 500000, priority: 'LOW', attemptCount: 1 }});
    await prisma.recoveryAttempt.create({ data: { caseId: rCase.id, attemptNumber: 1, actionType: 'SEND_PAYMENT_LINK', actionInput: '{}', actionOutput: JSON.stringify({ success: true, actionType: 'SEND_PAYMENT_LINK', paymentId: payment.id }), status: 'SUCCESS', policyCheckPassed: true }});

    const resumeSpy = vi.spyOn(resumeModule, 'resumeWaitingCase');

    const res = await simulator.runSimulation();
    
    expect(res.customerSuccesses).toBe(1);
    expect(resumeSpy).toHaveBeenCalledTimes(1);

    const finalPayment = await prisma.payment.findUnique({ where: { id: payment.id }});
    expect(finalPayment?.status).toBe('SUCCESS');
  });

  // Test 2: Case is no longer WAITING_FOR_CUSTOMER at mutation boundary
  it('Test 2: No mutation or resume if case is no longer WAITING at mutation boundary', async () => {
    const customer = await prisma.customer.create({ data: { externalId: 'c1', name: 'N', email: 'e', riskTier: 'LOW' }});
    const payment = await prisma.payment.create({ data: { externalId: 'p1', customerId: customer.id, amount: 500000, method: 'CARD', status: 'FAILED', attemptedAt: new Date() }});
    const rCase = await prisma.recoveryCase.create({ data: { paymentId: payment.id, customerId: customer.id, status: 'WAITING_FOR_CUSTOMER', amountAtRisk: 500000, priority: 'LOW' }});

    vi.spyOn(prisma.recoveryCase, 'findMany').mockResolvedValueOnce([
      { ...rCase, status: 'WAITING_FOR_CUSTOMER', payment, customer } as any
    ]);

    await prisma.recoveryCase.update({ where: { id: rCase.id }, data: { status: 'ESCALATED' }});

    const resumeSpy = vi.spyOn(resumeModule, 'resumeWaitingCase');
    const res = await simulator.runSimulation();

    expect(res.customerSuccesses).toBe(0);
    expect(resumeSpy).not.toHaveBeenCalled();

    const finalPayment = await prisma.payment.findUnique({ where: { id: payment.id }});
    expect(finalPayment?.status).toBe('FAILED'); 
  });

  // Test 3: Payment is already SUCCESS
  it('Test 3: No mutation or resume if Payment is already SUCCESS', async () => {
    const customer = await prisma.customer.create({ data: { externalId: 'c1', name: 'N', email: 'e', riskTier: 'LOW' }});
    const payment = await prisma.payment.create({ data: { externalId: 'p1', customerId: customer.id, amount: 500000, method: 'CARD', status: 'SUCCESS', attemptedAt: new Date() }});
    const rCase = await prisma.recoveryCase.create({ data: { paymentId: payment.id, customerId: customer.id, status: 'WAITING_FOR_CUSTOMER', amountAtRisk: 500000, priority: 'LOW' }});

    vi.spyOn(prisma.recoveryCase, 'findMany').mockResolvedValueOnce([
      { ...rCase, status: 'WAITING_FOR_CUSTOMER', payment: { ...payment, status: 'FAILED' }, customer } as any
    ]);

    const resumeSpy = vi.spyOn(resumeModule, 'resumeWaitingCase');
    const res = await simulator.runSimulation();

    expect(res.customerSuccesses).toBe(0);
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  // Test 4: Payment is no longer FAILED at mutation boundary
  it('Test 4: No mutation or resume if Payment is no longer FAILED at mutation boundary', async () => {
    const customer = await prisma.customer.create({ data: { externalId: 'c1', name: 'N', email: 'e', riskTier: 'LOW' }});
    const payment = await prisma.payment.create({ data: { externalId: 'p1', customerId: customer.id, amount: 500000, method: 'CARD', status: 'PENDING', attemptedAt: new Date() }});
    const rCase = await prisma.recoveryCase.create({ data: { paymentId: payment.id, customerId: customer.id, status: 'WAITING_FOR_CUSTOMER', amountAtRisk: 500000, priority: 'LOW' }});

    vi.spyOn(prisma.recoveryCase, 'findMany').mockResolvedValueOnce([
      { ...rCase, status: 'WAITING_FOR_CUSTOMER', payment: { ...payment, status: 'FAILED' }, customer } as any
    ]);

    const resumeSpy = vi.spyOn(resumeModule, 'resumeWaitingCase');
    const res = await simulator.runSimulation();

    expect(res.customerSuccesses).toBe(0);
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  // Test 5: Duplicate simulation attempt
  it('Test 5: Duplicate simulation does not mutate again and does not call resume', async () => {
    const customer = await prisma.customer.create({ data: { externalId: 'c1', name: 'N', email: 'e', riskTier: 'LOW' }});
    const payment = await prisma.payment.create({ data: { externalId: 'p1', customerId: customer.id, amount: 500000, method: 'CARD', status: 'FAILED', attemptedAt: new Date() }});
    const rCase = await prisma.recoveryCase.create({ data: { paymentId: payment.id, customerId: customer.id, status: 'WAITING_FOR_CUSTOMER', amountAtRisk: 500000, priority: 'LOW', attemptCount: 1 }});
    await prisma.recoveryAttempt.create({ data: { caseId: rCase.id, attemptNumber: 1, actionType: 'SEND_PAYMENT_LINK', actionInput: '{}', actionOutput: JSON.stringify({ success: true, actionType: 'SEND_PAYMENT_LINK', paymentId: payment.id }), status: 'SUCCESS', policyCheckPassed: true }});

    const resumeSpy = vi.spyOn(resumeModule, 'resumeWaitingCase');

    await simulator.runSimulation();
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    
    resumeSpy.mockClear();

    const res2 = await simulator.runSimulation();
    expect(res2.customerSuccesses).toBe(0);
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  // Test 6: Concurrent eligibility behavior
  it('Test 6: Only invocation which successfully performs mutation is allowed to resume (SQLite concurrency limit)', async () => {
    const customer = await prisma.customer.create({ data: { externalId: 'c1', name: 'N', email: 'e', riskTier: 'LOW' }});
    const payment = await prisma.payment.create({ data: { externalId: 'p1', customerId: customer.id, amount: 500000, method: 'CARD', status: 'FAILED', attemptedAt: new Date() }});
    const rCase = await prisma.recoveryCase.create({ data: { paymentId: payment.id, customerId: customer.id, status: 'WAITING_FOR_CUSTOMER', amountAtRisk: 500000, priority: 'LOW' }});

    const resumeSpy = vi.spyOn(resumeModule, 'resumeWaitingCase').mockResolvedValue({ resumed: true, reason: 'test', orchestratorResult: null as any } as any);

    vi.spyOn(prisma.recoveryCase, 'findMany').mockResolvedValue([
      { ...rCase, customer, payment } as any,
      { ...rCase, customer, payment } as any 
    ]);

    const res = await simulator.runSimulation();
    
    expect(res.customerSuccesses).toBe(1);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });

  // Test 7: Commit-before-resume
  it('Test 7: resumeWaitingCase is invoked ONLY after transaction/update resolves', async () => {
    const customer = await prisma.customer.create({ data: { externalId: 'c1', name: 'N', email: 'e', riskTier: 'LOW' }});
    const payment = await prisma.payment.create({ data: { externalId: 'p1', customerId: customer.id, amount: 500000, method: 'CARD', status: 'FAILED', attemptedAt: new Date() }});
    await prisma.recoveryCase.create({ data: { paymentId: payment.id, customerId: customer.id, status: 'WAITING_FOR_CUSTOMER', amountAtRisk: 500000, priority: 'LOW' }});

    let updateFinished = false;

    const originalUpdateMany = prisma.payment.updateMany.bind(prisma.payment);
    vi.spyOn(prisma.payment, 'updateMany').mockImplementation((async (arg: any) => {
      const res = await originalUpdateMany(arg);
      updateFinished = true;
      return res;
    }) as any);

    const resumeSpy = vi.spyOn(resumeModule, 'resumeWaitingCase').mockImplementation(async () => {
      expect(updateFinished).toBe(true);
      return { resumed: true, reason: 'test', orchestratorResult: null as any } as any;
    });

    await simulator.runSimulation();
    expect(resumeSpy).toHaveBeenCalled();
  });

  // Test 8: Failure-code independence
  it('Test 8: failureCode does not influence outcome', async () => {
    const customer = await prisma.customer.create({ data: { externalId: 'c1', name: 'N', email: 'e', riskTier: 'LOW' }});
    const p1 = await prisma.payment.create({ data: { externalId: 'p1', customerId: customer.id, amount: 500000, method: 'CARD', status: 'FAILED', failureCode: 'A', attemptedAt: new Date() }});
    await prisma.recoveryCase.create({ data: { paymentId: p1.id, customerId: customer.id, status: 'WAITING_FOR_CUSTOMER', amountAtRisk: 500000, priority: 'LOW' }});
    
    const p2 = await prisma.payment.create({ data: { externalId: 'p2', customerId: customer.id, amount: 500000, method: 'CARD', status: 'FAILED', failureCode: 'B', attemptedAt: new Date() }});
    await prisma.recoveryCase.create({ data: { paymentId: p2.id, customerId: customer.id, status: 'WAITING_FOR_CUSTOMER', amountAtRisk: 500000, priority: 'LOW' }});

    vi.spyOn(resumeModule, 'resumeWaitingCase').mockResolvedValue({ resumed: true, reason: 'test', orchestratorResult: {} as any } as any);

    const res = await simulator.runSimulation();
    expect(res.customerSuccesses).toBe(2);
  });

  // Test 9: Action independence
  it('Test 9: ActionType does not influence outcome', async () => {
    const customer = await prisma.customer.create({ data: { externalId: 'c1', name: 'N', email: 'e', riskTier: 'LOW' }});
    const p1 = await prisma.payment.create({ data: { externalId: 'p1', customerId: customer.id, amount: 500000, method: 'CARD', status: 'FAILED', attemptedAt: new Date() }});
    const rCase1 = await prisma.recoveryCase.create({ data: { paymentId: p1.id, customerId: customer.id, status: 'WAITING_FOR_CUSTOMER', amountAtRisk: 500000, priority: 'LOW', attemptCount: 1 }});
    await prisma.recoveryAttempt.create({ data: { caseId: rCase1.id, attemptNumber: 1, actionType: 'SEND_PAYMENT_LINK', actionInput: '{}', status: 'SUCCESS', policyCheckPassed: true }});

    const p2 = await prisma.payment.create({ data: { externalId: 'p2', customerId: customer.id, amount: 500000, method: 'CARD', status: 'FAILED', attemptedAt: new Date() }});
    const rCase2 = await prisma.recoveryCase.create({ data: { paymentId: p2.id, customerId: customer.id, status: 'WAITING_FOR_CUSTOMER', amountAtRisk: 500000, priority: 'LOW', attemptCount: 1 }});
    await prisma.recoveryAttempt.create({ data: { caseId: rCase2.id, attemptNumber: 1, actionType: 'NOTIFY_CUSTOMER', actionInput: '{}', status: 'SUCCESS', policyCheckPassed: true }});

    vi.spyOn(resumeModule, 'resumeWaitingCase').mockResolvedValue({ resumed: true, reason: 'test', orchestratorResult: null as any } as any);

    const res = await simulator.runSimulation();
    expect(res.customerSuccesses).toBe(2);
  });

  // Test 10: GroundTruth isolation
  it('Test 10: GroundTruth isolation', () => {
    const sourceCode = fs.readFileSync(path.join(__dirname, 'simulator.ts'), 'utf8');
    expect(sourceCode).not.toContain('groundTruth.json');
    expect(sourceCode).not.toContain('expectedAction');
  });
});
