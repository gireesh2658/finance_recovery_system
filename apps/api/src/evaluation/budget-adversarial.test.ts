import { describe, it, expect } from 'vitest';
import { EvaluationBudgetTracker } from './budget';
import type { LLMBudgetTracker, RequestKind } from './types';

/**
 * Adversarial budget tests — verifies safety invariants under hostile conditions.
 * No live API calls. No database mutations. Deterministic mocks only.
 */

// A mock provider that simulates Gemini's behavior with the budget tracker
function createMockProvider(behavior: 'succeed' | 'fail_429' | 'fail_network' | 'fail_timeout') {
  return {
    async reason(context: { caseId: string }, tracker?: LLMBudgetTracker) {
      const maxAttempts = 2;
      let lastError: string | undefined;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const kind: RequestKind = attempt === 0 ? 'INITIAL' : 'RETRY';

        if (tracker) {
          const res = tracker.tryConsumeRequest(context.caseId, kind);
          if (!res.allowed) {
            if (lastError) throw new Error(lastError); // Preserve original error
            throw new Error(`BUDGET_EXHAUSTED_BEFORE_REQUEST: ${res.blockReason}`);
          }
        }

        // Simulate provider behavior
        if (behavior === 'succeed') {
          return { diagnosisCode: 'OK' };
        }

        // All failure types:
        const errorMap = {
          'fail_429': 'PROVIDER_RATE_LIMIT_TRANSIENT: Rate limit exceeded',
          'fail_network': 'PROVIDER_NETWORK_FAILURE_TRANSIENT',
          'fail_timeout': 'PROVIDER_TIMEOUT'
        };

        const error = errorMap[behavior];
        
        // Timeout is non-retryable
        if (behavior === 'fail_timeout') {
          throw new Error(error);
        }
        
        // Transient errors: store and continue to retry attempt
        lastError = error;
      }

      throw new Error(lastError!);
    }
  };
}

describe('Adversarial Budget Tests', () => {

  // 1. 58 cases × one request each
  it('1. 58 cases × 1 request each consumes exactly 58 budget units', () => {
    const tracker = new EvaluationBudgetTracker(58, 1);
    
    for (let i = 0; i < 58; i++) {
      const result = tracker.tryConsumeRequest(`case_${i}`, 'INITIAL');
      expect(result.allowed).toBe(true);
    }

    expect(tracker.getGlobalCallsUsed()).toBe(58);
    expect(tracker.getInitialRequests()).toBe(58);
    expect(tracker.getRetryRequests()).toBe(0);
    expect(tracker.getRemainingGlobalBudget()).toBe(0);
    expect(tracker.isExhausted()).toBe(true);
  });

  // 2. 58 cases where every first request fails transiently
  it('2. 58 transient failures with maxPerCase=1 preserves all original errors', async () => {
    const tracker = new EvaluationBudgetTracker(58, 1);
    const provider = createMockProvider('fail_429');
    const errors: string[] = [];

    for (let i = 0; i < 58; i++) {
      try {
        await provider.reason({ caseId: `case_${i}` }, tracker);
      } catch (e: any) {
        errors.push(e.message);
      }
    }

    // Every error should be the ORIGINAL provider error, not BUDGET_EXHAUSTED
    for (const err of errors) {
      expect(err).toContain('RATE_LIMIT_TRANSIENT');
      expect(err).not.toContain('BUDGET_EXHAUSTED');
    }

    // Budget accounting
    expect(tracker.getGlobalCallsUsed()).toBe(58);
    expect(tracker.getInitialRequests()).toBe(58);
    expect(tracker.getRetriesEligible()).toBe(58); // Each case attempted a retry
    expect(tracker.getRetriesBlocked()).toBe(58);
    expect(tracker.getRetriesBlockedByCaseBudget()).toBe(58);
    expect(tracker.getRetryRequests()).toBe(0); // No actual retry HTTP requests
  });

  // 3. Global budget exhausted exactly at request 58
  it('3. global budget exhausts exactly at request 58', () => {
    const tracker = new EvaluationBudgetTracker(58, 1);
    
    for (let i = 0; i < 58; i++) {
      tracker.tryConsumeRequest(`case_${i}`, 'INITIAL');
    }

    expect(tracker.isExhausted()).toBe(true);
    expect(tracker.getRemainingGlobalBudget()).toBe(0);
  });

  // 4. Attempted request #59 must NEVER reach the provider
  it('4. request 59 is rejected and does not reach the provider', () => {
    const tracker = new EvaluationBudgetTracker(58, 1);
    
    for (let i = 0; i < 58; i++) {
      tracker.tryConsumeRequest(`case_${i}`, 'INITIAL');
    }

    const result = tracker.tryConsumeRequest('case_59', 'INITIAL');
    expect(result.allowed).toBe(false);
    expect(result.blockReason).toBe('GLOBAL_BUDGET');
    expect(tracker.getGlobalCallsUsed()).toBe(58); // Not 59
  });

  // 5. Case #59 must not accidentally consume a budget unit
  it('5. blocked request consumes zero budget', () => {
    const tracker = new EvaluationBudgetTracker(58, 1);
    
    for (let i = 0; i < 58; i++) {
      tracker.tryConsumeRequest(`case_${i}`, 'INITIAL');
    }

    const before = tracker.getGlobalCallsUsed();
    tracker.tryConsumeRequest('case_59', 'INITIAL');
    expect(tracker.getGlobalCallsUsed()).toBe(before);
  });

  // 6. A retry when global budget = 0
  it('6. retry with global budget=0 is blocked', () => {
    const tracker = new EvaluationBudgetTracker(1, 2); // 2 per case, 1 global
    tracker.tryConsumeRequest('case_1', 'INITIAL'); // Exhausts global

    const retry = tracker.tryConsumeRequest('case_1', 'RETRY');
    expect(retry.allowed).toBe(false);
    expect(retry.blockReason).toBe('GLOBAL_BUDGET');
  });

  // 7. A retry when per-case budget = 1
  it('7. retry with maxPerCase=1 is blocked by case budget', () => {
    const tracker = new EvaluationBudgetTracker(100, 1);
    tracker.tryConsumeRequest('case_1', 'INITIAL');

    const retry = tracker.tryConsumeRequest('case_1', 'RETRY');
    expect(retry.allowed).toBe(false);
    expect(retry.blockReason).toBe('CASE_BUDGET');
  });

  // 8. A retry when per-case budget allows it but global budget does not
  it('8. retry allowed by case but blocked by global', () => {
    const tracker = new EvaluationBudgetTracker(2, 3); // 3 per case, 2 global
    tracker.tryConsumeRequest('case_1', 'INITIAL');
    tracker.tryConsumeRequest('case_2', 'INITIAL'); // Exhausts global

    const retry = tracker.tryConsumeRequest('case_1', 'RETRY');
    expect(retry.allowed).toBe(false);
    expect(retry.blockReason).toBe('GLOBAL_BUDGET');
    expect(tracker.getRetriesBlockedByGlobalBudget()).toBe(1);
  });

  // 9. Concurrent cases racing for the final global budget unit
  // (Simulated sequentially since JS is single-threaded, but proves atomic boundary)
  it('9. two cases racing for last budget unit — only one wins', () => {
    const tracker = new EvaluationBudgetTracker(1, 1);
    
    const result1 = tracker.tryConsumeRequest('race_a', 'INITIAL');
    const result2 = tracker.tryConsumeRequest('race_b', 'INITIAL');

    expect(result1.allowed).toBe(true);
    expect(result2.allowed).toBe(false);
    expect(result2.blockReason).toBe('GLOBAL_BUDGET');
    expect(tracker.getGlobalCallsUsed()).toBe(1);
  });

  // 10. Provider 429 followed by blocked retry — error preservation
  it('10. 429 followed by blocked retry preserves RATE_LIMIT error', async () => {
    const tracker = new EvaluationBudgetTracker(58, 1);
    const provider = createMockProvider('fail_429');

    let caughtError: string | undefined;
    try {
      await provider.reason({ caseId: 'case_429' }, tracker);
    } catch (e: any) {
      caughtError = e.message;
    }

    expect(caughtError).toContain('RATE_LIMIT_TRANSIENT');
    expect(caughtError).not.toContain('BUDGET_EXHAUSTED');
    expect(tracker.getGlobalCallsUsed()).toBe(1);
    expect(tracker.getRetriesBlocked()).toBe(1);
  });

  // 11. Provider network failure followed by blocked retry — error preservation
  it('11. network failure followed by blocked retry preserves NETWORK error', async () => {
    const tracker = new EvaluationBudgetTracker(58, 1);
    const provider = createMockProvider('fail_network');

    let caughtError: string | undefined;
    try {
      await provider.reason({ caseId: 'case_net' }, tracker);
    } catch (e: any) {
      caughtError = e.message;
    }

    expect(caughtError).toContain('NETWORK_FAILURE_TRANSIENT');
    expect(caughtError).not.toContain('BUDGET_EXHAUSTED');
  });

  // 12. Provider timeout — no retry (timeout is not retryable)
  it('12. timeout does not attempt retry', async () => {
    const tracker = new EvaluationBudgetTracker(58, 2); // Even with 2 per case
    const provider = createMockProvider('fail_timeout');

    let caughtError: string | undefined;
    try {
      await provider.reason({ caseId: 'case_timeout' }, tracker);
    } catch (e: any) {
      caughtError = e.message;
    }

    expect(caughtError).toBe('PROVIDER_TIMEOUT');
    expect(tracker.getGlobalCallsUsed()).toBe(1); // Only initial, no retry
    expect(tracker.getRetriesEligible()).toBe(0); // Timeout isn't retryable
  });

  // Metric non-overlapping: 429 + blocked retry produces correct classification
  it('metric classification for 429 + blocked retry is non-overlapping', async () => {
    const tracker = new EvaluationBudgetTracker(58, 1);
    const provider = createMockProvider('fail_429');

    try {
      await provider.reason({ caseId: 'case_classify' }, tracker);
    } catch { /* expected */ }

    // Exact expected metrics
    expect(tracker.getInitialRequests()).toBe(1);     // 1 actual HTTP request
    expect(tracker.getRetryRequests()).toBe(0);        // 0 actual retry HTTP requests
    expect(tracker.getGlobalCallsUsed()).toBe(1);      // 1 total HTTP request
    expect(tracker.getRetriesEligible()).toBe(1);      // retry was eligible
    expect(tracker.getRetriesBlocked()).toBe(1);       // retry was blocked
    expect(tracker.getRetriesBlockedByCaseBudget()).toBe(1);
    expect(tracker.getRetriesBlockedByGlobalBudget()).toBe(0);
  });
});
