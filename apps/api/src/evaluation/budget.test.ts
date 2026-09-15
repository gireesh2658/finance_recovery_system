import { describe, it, expect } from 'vitest';
import { EvaluationBudgetTracker } from './budget';

describe('EvaluationBudgetTracker — Atomic Contract', () => {

  // A. Initial request consumes one unit
  it('A. initial request consumes exactly one budget unit', () => {
    const tracker = new EvaluationBudgetTracker(58, 1);
    const result = tracker.tryConsumeRequest('case_1', 'INITIAL');

    expect(result.allowed).toBe(true);
    expect(tracker.getGlobalCallsUsed()).toBe(1);
    expect(tracker.getCaseCalls('case_1')).toBe(1);
    expect(tracker.getInitialRequests()).toBe(1);
    expect(tracker.getRetryRequests()).toBe(0);
  });

  // B. Successful request consumes one unit and stops (no extra consumption)
  it('B. single successful request leaves budget at exactly 1 used', () => {
    const tracker = new EvaluationBudgetTracker(58, 1);
    tracker.tryConsumeRequest('case_1', 'INITIAL');
    
    expect(tracker.getGlobalCallsUsed()).toBe(1);
    expect(tracker.getRemainingGlobalBudget()).toBe(57);
  });

  // E. Retry budget rejection does NOT create another HTTP request
  it('E. retry blocked by per-case budget consumes nothing', () => {
    const tracker = new EvaluationBudgetTracker(58, 1);
    tracker.tryConsumeRequest('case_1', 'INITIAL'); // Consumes the 1 per-case slot

    const retryResult = tracker.tryConsumeRequest('case_1', 'RETRY');
    
    expect(retryResult.allowed).toBe(false);
    expect(retryResult.blockReason).toBe('CASE_BUDGET');
    expect(tracker.getGlobalCallsUsed()).toBe(1); // Still 1 — retry consumed nothing
    expect(tracker.getCaseCalls('case_1')).toBe(1); // Still 1
  });

  // G. Global budget is never exceeded
  it('G. global budget cannot be exceeded', () => {
    const tracker = new EvaluationBudgetTracker(2, 1);
    tracker.tryConsumeRequest('case_1', 'INITIAL');
    tracker.tryConsumeRequest('case_2', 'INITIAL');

    const result = tracker.tryConsumeRequest('case_3', 'INITIAL');
    
    expect(result.allowed).toBe(false);
    expect(result.blockReason).toBe('GLOBAL_BUDGET');
    expect(tracker.getGlobalCallsUsed()).toBe(2);
  });

  // H. Per-case budget is never exceeded
  it('H. per-case budget cannot be exceeded', () => {
    const tracker = new EvaluationBudgetTracker(58, 1);
    tracker.tryConsumeRequest('case_1', 'INITIAL');

    const result = tracker.tryConsumeRequest('case_1', 'RETRY');
    
    expect(result.allowed).toBe(false);
    expect(result.blockReason).toBe('CASE_BUDGET');
  });

  // I. Global budget reaches exactly zero at the final allowed request
  it('I. global budget reaches exactly zero on final request', () => {
    const tracker = new EvaluationBudgetTracker(3, 1);
    tracker.tryConsumeRequest('case_1', 'INITIAL');
    tracker.tryConsumeRequest('case_2', 'INITIAL');
    tracker.tryConsumeRequest('case_3', 'INITIAL');
    
    expect(tracker.getRemainingGlobalBudget()).toBe(0);
    expect(tracker.isExhausted()).toBe(true);
  });

  // J. Next request is rejected before reaching the provider
  it('J. request after global exhaustion is rejected without consuming', () => {
    const tracker = new EvaluationBudgetTracker(1, 1);
    tracker.tryConsumeRequest('case_1', 'INITIAL');

    const result = tracker.tryConsumeRequest('case_2', 'INITIAL');
    
    expect(result.allowed).toBe(false);
    expect(result.blockReason).toBe('GLOBAL_BUDGET');
    expect(tracker.getGlobalCallsUsed()).toBe(1); // Not incremented
  });

  // K. Retry blocked by CASE_BUDGET is distinguishable from GLOBAL_BUDGET
  it('K. CASE_BUDGET vs GLOBAL_BUDGET are distinguishable', () => {
    // Case budget block
    const tracker1 = new EvaluationBudgetTracker(58, 1);
    tracker1.tryConsumeRequest('case_1', 'INITIAL');
    const caseBlock = tracker1.tryConsumeRequest('case_1', 'RETRY');
    
    expect(caseBlock.blockReason).toBe('CASE_BUDGET');

    // Global budget block
    const tracker2 = new EvaluationBudgetTracker(1, 2); // 2 per case, but only 1 global
    tracker2.tryConsumeRequest('case_1', 'INITIAL');
    const globalBlock = tracker2.tryConsumeRequest('case_1', 'RETRY');
    
    expect(globalBlock.blockReason).toBe('GLOBAL_BUDGET');
  });

  // O. Metrics do not double-count
  it('O. retry accounting metrics are precise and non-overlapping', () => {
    const tracker = new EvaluationBudgetTracker(58, 2); // Allow 2 per case for this test
    
    // Case 1: initial success
    tracker.tryConsumeRequest('case_1', 'INITIAL');
    
    // Case 2: initial + retry (both allowed)
    tracker.tryConsumeRequest('case_2', 'INITIAL');
    tracker.tryConsumeRequest('case_2', 'RETRY');
    
    // Case 3: initial + retry blocked by case budget
    const tracker2 = new EvaluationBudgetTracker(58, 1);
    tracker2.tryConsumeRequest('case_3', 'INITIAL');
    tracker2.tryConsumeRequest('case_3', 'RETRY'); // blocked

    expect(tracker.getInitialRequests()).toBe(2);
    expect(tracker.getRetryRequests()).toBe(1);
    expect(tracker.getGlobalCallsUsed()).toBe(3);
    
    expect(tracker2.getRetriesEligible()).toBe(1); // retry was attempted to be consumed
    expect(tracker2.getRetriesBlocked()).toBe(1);
    expect(tracker2.getRetriesBlockedByCaseBudget()).toBe(1);
    expect(tracker2.getRetriesBlockedByGlobalBudget()).toBe(0);
  });

  // Global budget can never become negative
  it('global budget never goes negative', () => {
    const tracker = new EvaluationBudgetTracker(1, 1);
    tracker.tryConsumeRequest('case_1', 'INITIAL');
    tracker.tryConsumeRequest('case_2', 'INITIAL'); // blocked
    tracker.tryConsumeRequest('case_3', 'INITIAL'); // blocked
    
    expect(tracker.getRemainingGlobalBudget()).toBe(0);
    expect(tracker.getGlobalCallsUsed()).toBe(1);
  });

  // With maxPerCase=2, a retry is allowed if global budget permits
  it('retry is allowed when both case and global budget permit', () => {
    const tracker = new EvaluationBudgetTracker(10, 2);
    tracker.tryConsumeRequest('case_1', 'INITIAL');
    const retry = tracker.tryConsumeRequest('case_1', 'RETRY');
    
    expect(retry.allowed).toBe(true);
    expect(tracker.getGlobalCallsUsed()).toBe(2);
    expect(tracker.getCaseCalls('case_1')).toBe(2);
    expect(tracker.getRetryRequests()).toBe(1);
  });

  // Retry blocked when case allows but global is exhausted
  it('retry blocked by global even when case budget allows', () => {
    const tracker = new EvaluationBudgetTracker(1, 2); // 2 per case, but only 1 global
    tracker.tryConsumeRequest('case_1', 'INITIAL');
    
    const retry = tracker.tryConsumeRequest('case_1', 'RETRY');
    expect(retry.allowed).toBe(false);
    expect(retry.blockReason).toBe('GLOBAL_BUDGET');
    expect(tracker.getRetriesBlockedByGlobalBudget()).toBe(1);
  });
});
