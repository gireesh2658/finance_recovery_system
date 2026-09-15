import { describe, it, expect } from 'vitest';
import { evaluateActionPolicy } from './engine';
import type { PolicyEvaluationContext } from './types';

// Mock current timestamp to a fixed value
const CURRENT_TIME = 1693483200000; // arbitrary fixed time

// Base active policies corresponding to our seeded policies
const basePolicies = [
  {
    id: '1',
    name: 'global_max_retries',
    description: 'Max 3 retries',
    ruleType: 'MAX_RETRIES',
    conditions: JSON.stringify({ maxRetries: 3 }),
    isActive: true,
    priority: 100,
    createdAt: new Date(),
  },
  {
    id: '2',
    name: 'network_timeout_allowed_actions',
    description: 'Only allow RETRY or ESCALATE for NETWORK_TIMEOUT',
    ruleType: 'ALLOWED_ACTIONS',
    conditions: JSON.stringify({ failureCode: 'NETWORK_TIMEOUT', allowedActions: ['RETRY_PAYMENT', 'ESCALATE_TO_HUMAN'] }),
    isActive: true,
    priority: 90,
    createdAt: new Date(),
  },
  {
    id: '3',
    name: 'insufficient_funds_cooldown',
    description: 'Cooldown for NSF',
    ruleType: 'COOLDOWN',
    conditions: JSON.stringify({ failureCode: 'INSUFFICIENT_FUNDS', hours: 24 }),
    isActive: true,
    priority: 80,
    createdAt: new Date(),
  },
  {
    id: '4',
    name: 'high_value_escalation',
    description: 'Escalate > 50000 INR',
    ruleType: 'AMOUNT_LIMIT',
    conditions: JSON.stringify({ maxAmountPaise: 5000000, exceedAction: 'ESCALATE_TO_HUMAN' }),
    isActive: true,
    priority: 110,
    createdAt: new Date(),
  }
];

function createMockContext(overrides: Partial<PolicyEvaluationContext> = {}): PolicyEvaluationContext {
  return {
    requestedAction: 'RETRY_PAYMENT',
    caseState: {
      status: 'DETECTED',
      finalOutcome: 'PENDING',
      amountAtRisk: 100000, // 1000 INR
      attemptCount: 0,
      nextRetryAfter: null,
    },
    paymentInfo: {
      amount: 100000,
      failureCode: 'GENERIC_ERROR',
      status: 'FAILED',
    },
    customerInfo: {
      riskTier: 'MEDIUM',
    },
    policies: [...basePolicies],
    currentTimestampMs: CURRENT_TIME,
    ...overrides,
  };
}

describe('Deterministic Policy Engine', () => {

  it('A. Unknown action -> DENY', () => {
    const context = createMockContext({ requestedAction: 'HACK_THE_MAINFRAME' });
    const result = evaluateActionPolicy(context);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Unknown or unsupported action');
  });

  it('B. Retry below maximum -> ALLOW', () => {
    const context = createMockContext({
      caseState: { ...createMockContext().caseState, attemptCount: 2 }
    });
    const result = evaluateActionPolicy(context);
    expect(result.allowed).toBe(true);
    expect(result.action).toBe('RETRY_PAYMENT');
  });

  it('C. Retry at maximum -> DENY', () => {
    const context = createMockContext({
      caseState: { ...createMockContext().caseState, attemptCount: 3 }
    });
    const result = evaluateActionPolicy(context);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Global maximum retries (3) reached');
    expect(result.requiredEscalation).toBe(true);
  });

  it('D. Retry above maximum -> DENY', () => {
    const context = createMockContext({
      caseState: { ...createMockContext().caseState, attemptCount: 5 }
    });
    const result = evaluateActionPolicy(context);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Global maximum retries (3) reached');
  });

  it('E. Network timeout + retry -> ALLOW', () => {
    const context = createMockContext({
      paymentInfo: { ...createMockContext().paymentInfo, failureCode: 'NETWORK_TIMEOUT' },
      requestedAction: 'RETRY_PAYMENT',
    });
    const result = evaluateActionPolicy(context);
    expect(result.allowed).toBe(true);
  });

  it('F. Network timeout + payment link -> DENY', () => {
    const context = createMockContext({
      paymentInfo: { ...createMockContext().paymentInfo, failureCode: 'NETWORK_TIMEOUT' },
      requestedAction: 'SEND_PAYMENT_LINK',
    });
    const result = evaluateActionPolicy(context);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not permitted for failure code NETWORK_TIMEOUT');
  });

  it('G. Network timeout + escalation -> ALLOW', () => {
    const context = createMockContext({
      paymentInfo: { ...createMockContext().paymentInfo, failureCode: 'NETWORK_TIMEOUT' },
      requestedAction: 'ESCALATE_TO_HUMAN',
    });
    const result = evaluateActionPolicy(context);
    expect(result.allowed).toBe(true);
    expect(result.action).toBe('ESCALATE_TO_HUMAN');
  });

  it('H. Insufficient funds + retry before cooldown -> DENY', () => {
    const context = createMockContext({
      paymentInfo: { ...createMockContext().paymentInfo, failureCode: 'INSUFFICIENT_FUNDS' },
      caseState: { ...createMockContext().caseState, nextRetryAfter: new Date(CURRENT_TIME + 3600000) }, // +1 hour
      requestedAction: 'RETRY_PAYMENT',
    });
    const result = evaluateActionPolicy(context);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Cooldown period has not elapsed');
  });

  it('I. Insufficient funds + retry after cooldown -> ALLOW', () => {
    const context = createMockContext({
      paymentInfo: { ...createMockContext().paymentInfo, failureCode: 'INSUFFICIENT_FUNDS' },
      caseState: { ...createMockContext().caseState, nextRetryAfter: new Date(CURRENT_TIME - 3600000) }, // -1 hour
      requestedAction: 'RETRY_PAYMENT',
    });
    const result = evaluateActionPolicy(context);
    expect(result.allowed).toBe(true);
  });

  it('J. High-value payment + automated recovery -> DENY / ESCALATE', () => {
    const context = createMockContext({
      paymentInfo: { ...createMockContext().paymentInfo, amount: 6000000 }, // 60,000 INR
      requestedAction: 'RETRY_PAYMENT',
    });
    const result = evaluateActionPolicy(context);
    expect(result.allowed).toBe(false);
    expect(result.requiredEscalation).toBe(true);
    expect(result.reason).toContain('Escalation required');
  });

  it('K. High-value payment + escalation -> ALLOW', () => {
    const context = createMockContext({
      paymentInfo: { ...createMockContext().paymentInfo, amount: 6000000 },
      requestedAction: 'ESCALATE_TO_HUMAN',
    });
    const result = evaluateActionPolicy(context);
    expect(result.allowed).toBe(true);
    expect(result.action).toBe('ESCALATE_TO_HUMAN');
  });

  it('L. Inactive/missing required policy -> FAIL CLOSED (on malformed)', () => {
    // Injecting a corrupted active policy should fail closed
    const corruptedPolicy = {
      id: '99',
      name: 'corrupted',
      description: 'bad json',
      ruleType: 'MAX_RETRIES',
      conditions: '{ bad_json',
      isActive: true,
      priority: 999,
      createdAt: new Date(),
    };
    const context = createMockContext({
      policies: [...basePolicies, corruptedPolicy]
    });
    const result = evaluateActionPolicy(context);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Malformed policy configuration');
  });

  it('M. Terminal recovery case -> DENY further automated actions', () => {
    const context = createMockContext({
      caseState: { ...createMockContext().caseState, status: 'RECOVERED' },
      requestedAction: 'RETRY_PAYMENT',
    });
    const result = evaluateActionPolicy(context);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Case is already in a terminal state');
  });

  it('N. Invalid attempt count -> DENY', () => {
    const context = createMockContext({
      caseState: { ...createMockContext().caseState, attemptCount: -1 }
    });
    const result = evaluateActionPolicy(context);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Invalid negative attempt count');
  });

  it('O. Determinism: Same input must produce the same result', () => {
    const context = createMockContext();
    const result1 = evaluateActionPolicy(context);
    const result2 = evaluateActionPolicy(context);
    const result3 = evaluateActionPolicy(context);
    
    expect(result1).toEqual(result2);
    expect(result2).toEqual(result3);
  });

});
