import type { LLMBudgetTracker, RequestKind, RequestBudgetResult } from './types';

export class EvaluationBudgetTracker implements LLMBudgetTracker {
  public readonly globalBudget: number;
  private readonly maxPerCase: number;
  private callsUsed: number = 0;
  private caseUsage: Map<string, number> = new Map();

  // Accounting counters
  private _initialRequests: number = 0;
  private _retryRequests: number = 0;
  private _retriesEligible: number = 0;
  private _retriesBlocked: number = 0;
  private _retriesBlockedByCaseBudget: number = 0;
  private _retriesBlockedByGlobalBudget: number = 0;

  constructor(globalBudget: number, maxPerCase: number = 1) {
    this.globalBudget = globalBudget;
    this.maxPerCase = maxPerCase;
  }

  /**
   * Atomic reservation + consumption boundary.
   * 
   * Checks global and per-case budgets atomically.
   * If allowed: increments both counters and returns { allowed: true }.
   * If blocked: increments nothing and returns { allowed: false, blockReason }.
   * 
   * A retry request (kind='RETRY') that is blocked still counts toward
   * retriesEligible/retriesBlocked accounting, but does NOT consume budget.
   */
  tryConsumeRequest(caseId: string, kind: RequestKind): RequestBudgetResult {
    // For RETRY kind, always record that a retry was eligible (the provider decided to retry)
    if (kind === 'RETRY') {
      this._retriesEligible++;
    }

    // Check per-case budget first (more specific constraint)
    const currentCaseUsage = this.caseUsage.get(caseId) || 0;
    if (currentCaseUsage >= this.maxPerCase) {
      if (kind === 'RETRY') {
        this._retriesBlocked++;
        this._retriesBlockedByCaseBudget++;
      }
      return { allowed: false, blockReason: 'CASE_BUDGET' };
    }

    // Check global budget
    if (this.callsUsed >= this.globalBudget) {
      if (kind === 'RETRY') {
        this._retriesBlocked++;
        this._retriesBlockedByGlobalBudget++;
      }
      return { allowed: false, blockReason: 'GLOBAL_BUDGET' };
    }

    // Both budgets allow — consume atomically
    this.callsUsed++;
    this.caseUsage.set(caseId, currentCaseUsage + 1);

    if (kind === 'INITIAL') {
      this._initialRequests++;
    } else {
      this._retryRequests++;
    }

    return { allowed: true };
  }

  getGlobalCallsUsed(): number {
    return this.callsUsed;
  }

  getRemainingGlobalBudget(): number {
    return Math.max(0, this.globalBudget - this.callsUsed);
  }

  isExhausted(): boolean {
    return this.callsUsed >= this.globalBudget;
  }

  getCaseCalls(caseId: string): number {
    return this.caseUsage.get(caseId) || 0;
  }

  // Accounting getters
  getInitialRequests(): number { return this._initialRequests; }
  getRetryRequests(): number { return this._retryRequests; }
  getRetriesEligible(): number { return this._retriesEligible; }
  getRetriesBlocked(): number { return this._retriesBlocked; }
  getRetriesBlockedByCaseBudget(): number { return this._retriesBlockedByCaseBudget; }
  getRetriesBlockedByGlobalBudget(): number { return this._retriesBlockedByGlobalBudget; }
}
