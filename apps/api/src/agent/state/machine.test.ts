import { describe, it, expect } from 'vitest';
import { transition } from './machine';
import type { RecoveryCaseStatus, StateTransitionContext } from './types';

function mockContext(from: string, to: string, tCount = 0, sCount = 0): StateTransitionContext {
  return {
    caseId: 'test-case',
    fromState: from as RecoveryCaseStatus,
    toState: to as RecoveryCaseStatus,
    transitionCount: tCount,
    strategyAttemptCount: sCount
  };
}

describe('Deterministic Agent State Machine', () => {

  it('A. DETECTED → DIAGNOSING', () => {
    expect(transition(mockContext('DETECTED', 'DIAGNOSING')).success).toBe(true);
  });

  it('B. DIAGNOSING → DIAGNOSED', () => {
    expect(transition(mockContext('DIAGNOSING', 'DIAGNOSED')).success).toBe(true);
  });

  it('C. DIAGNOSED → STRATEGY_PENDING', () => {
    expect(transition(mockContext('DIAGNOSED', 'STRATEGY_PENDING')).success).toBe(true);
  });

  it('D. STRATEGY_PENDING → POLICY_CHECK', () => {
    expect(transition(mockContext('STRATEGY_PENDING', 'POLICY_CHECK')).success).toBe(true);
  });

  it('E. POLICY_CHECK → ACTION_APPROVED', () => {
    expect(transition(mockContext('POLICY_CHECK', 'ACTION_APPROVED')).success).toBe(true);
  });

  it('F. POLICY_CHECK → POLICY_DENIED', () => {
    expect(transition(mockContext('POLICY_CHECK', 'POLICY_DENIED')).success).toBe(true);
  });

  it('G. POLICY_DENIED → STRATEGY_PENDING', () => {
    expect(transition(mockContext('POLICY_DENIED', 'STRATEGY_PENDING')).success).toBe(true);
  });

  it('H. POLICY_DENIED → ESCALATED', () => {
    expect(transition(mockContext('POLICY_DENIED', 'ESCALATED')).success).toBe(true);
  });

  it('I. ACTION_APPROVED → EXECUTING', () => {
    expect(transition(mockContext('ACTION_APPROVED', 'EXECUTING')).success).toBe(true);
  });

  it('J. EXECUTING → VERIFYING', () => {
    expect(transition(mockContext('EXECUTING', 'VERIFYING')).success).toBe(true);
  });

  it('K. VERIFYING → RECOVERED', () => {
    expect(transition(mockContext('VERIFYING', 'RECOVERED')).success).toBe(true);
  });

  it('L. VERIFYING → RETRY_PENDING', () => {
    expect(transition(mockContext('VERIFYING', 'RETRY_PENDING')).success).toBe(true);
  });

  it('M. VERIFYING → ESCALATED', () => {
    expect(transition(mockContext('VERIFYING', 'ESCALATED')).success).toBe(true);
  });

  it('N. RETRY_PENDING → STRATEGY_PENDING', () => {
    expect(transition(mockContext('RETRY_PENDING', 'STRATEGY_PENDING')).success).toBe(true);
  });

  it('O. RECOVERED → CLOSED', () => {
    expect(transition(mockContext('RECOVERED', 'CLOSED')).success).toBe(true);
  });

  it('P. ESCALATED → CLOSED', () => {
    expect(transition(mockContext('ESCALATED', 'CLOSED')).success).toBe(true);
  });

  it('Q. CLOSED → any state (denied)', () => {
    expect(transition(mockContext('CLOSED', 'DETECTED')).success).toBe(false);
    expect(transition(mockContext('CLOSED', 'RECOVERED')).success).toBe(false);
  });

  it('R. RECOVERED → EXECUTING (denied)', () => {
    expect(transition(mockContext('RECOVERED', 'EXECUTING')).success).toBe(false);
  });

  it('S. CLOSED → EXECUTING (denied)', () => {
    expect(transition(mockContext('CLOSED', 'EXECUTING')).success).toBe(false);
  });

  it('T. DETECTED → EXECUTING (denied)', () => {
    expect(transition(mockContext('DETECTED', 'EXECUTING')).success).toBe(false);
  });

  it('U. transition limit exceeded -> safe escalation behavior', () => {
    // 20 is the hard max
    const result = transition(mockContext('DIAGNOSING', 'DIAGNOSED', 20));
    expect(result.success).toBe(true);
    expect(result.nextState).toBe('ESCALATED');
    expect(result.isTerminal).toBe(true);
  });

  it('V. strategy limit exceeded -> safe escalation behavior', () => {
    // 3 is the max strategies allowed
    // Only triggers when trying to enter STRATEGY_PENDING
    const result = transition(mockContext('DIAGNOSED', 'STRATEGY_PENDING', 5, 3));
    expect(result.success).toBe(true);
    expect(result.nextState).toBe('ESCALATED');
    expect(result.reason).toContain('strategy limit');
  });

  it('X. determinism (same input -> same output)', () => {
    const ctx = mockContext('STRATEGY_PENDING', 'POLICY_CHECK');
    const r1 = transition(ctx);
    const r2 = transition(ctx);
    expect(r1).toEqual(r2);
  });

});
