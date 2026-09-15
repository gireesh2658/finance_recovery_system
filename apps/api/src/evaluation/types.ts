import type { RecoveryCaseStatus } from '../agent/state/types';
import type { ActionType } from '../agent/policy/types';

export interface GroundTruthEntry {
  caseId: string;
  paymentId: string;
  customerId: string;
  failureCode: string;
  expectedAction: ActionType;
  amount: number;
}

export interface CaseEvaluationResult {
  caseId: string;
  paymentId: string;
  failureCode: string;
  amountAtRisk: number;
  expectedAction: ActionType;
  
  agentRecommendedAction: ActionType;
  policyAllowed: boolean;
  actualOutcome: RecoveryCaseStatus;
  amountRecovered: number;
  
  recommendationCorrect: boolean;
  policyCompliant: boolean;
  recoverySuccessful: boolean;
  escalationRequired: boolean;
  
  failureReason?: string;
  providerFailure: boolean;
  llmCallsUsed: number;
  executionDuration: number;
  fallbackUsed: boolean;

  safety: {
    unauthorizedExecutions: number;
    policyBypasses: number;
    terminalStateViolations: number;
    duplicateFinancialEffects: number;
    fabricatedRecoveries: number;
    totalSafetyViolations: number;
  };
}

// -------------------------------------------------------
// Budget / Request Accounting Types
// -------------------------------------------------------

export type RequestKind = 'INITIAL' | 'RETRY';
export type RetryBlockReason = 'GLOBAL_BUDGET' | 'CASE_BUDGET';

export interface RequestBudgetResult {
  allowed: boolean;
  blockReason?: RetryBlockReason;
}

export interface LLMBudgetTracker {
  /**
   * Atomically attempt to consume one request unit.
   * If budget is available: consumes it, returns { allowed: true }.
   * If budget is exhausted: consumes nothing, returns { allowed: false, blockReason }.
   * This is the ONLY authorization boundary — no separate check/consume split.
   */
  tryConsumeRequest(caseId: string, kind: RequestKind): RequestBudgetResult;

  getGlobalCallsUsed(): number;
  getRemainingGlobalBudget(): number;
  isExhausted(): boolean;
  getCaseCalls(caseId: string): number;

  // Accounting getters for evaluation metrics
  getInitialRequests(): number;
  getRetryRequests(): number;
  getRetriesEligible(): number;
  getRetriesBlocked(): number;
  getRetriesBlockedByCaseBudget(): number;
  getRetriesBlockedByGlobalBudget(): number;
}

// -------------------------------------------------------
// Evaluation Metrics
// -------------------------------------------------------

export interface AgentEvaluationMetrics {
  totalCases: number;
  
  // Recommendation metrics
  correctRecommendations: number;
  incorrectRecommendations: number;
  successfulLLMRecommendations: number;
  fallbackDecisions: number;
  recommendationAccuracy: number; // 0-1
  
  // Policy metrics
  policyAllowedRecommendations: number;
  policyDeniedRecommendations: number;
  policyComplianceRate: number; // 0-1
  
  // Initial Synchronous Recovery metrics (Phase 1)
  initialRecovered: number;
  initialWaiting: number;
  initialEscalated: number;
  
  // Asynchronous Simulation metrics (Phase 2 & 3)
  simulatedWaitingCases: number;
  customerEligibleCases: number;
  simulatedCustomerSuccesses: number;
  customerNonResponses: number;
  resumeAttempts: number;
  resumeAccepted: number;
  resumeRejected: number;
  recoveredAfterAsyncResume: number;
  stillWaiting: number;

  // Final Recovery metrics
  finalRecovered: number;
  finalEscalated: number;
  
  totalRevenueAtRisk: number;
  totalRevenueRecovered: number;
  recoveryRate: number; // 0-1
  successfulRecoveries: number;
  failedRecoveries: number;
  escalations: number;
  unresolvedCases: number;
  
  // Safety metrics
  unauthorizedExecutions: number;
  policyBypasses: number;
  terminalStateViolations: number;
  duplicateFinancialEffects: number;
  fabricatedRecoveries: number;
  totalSafetyViolations: number;
  
  // Failure Code Breakdown
  byFailureCode: Record<string, {
    cases: number;
    correctRecommendations: number;
    recoveryRate: number; // 0-1
    revenueRecovered: number;
    escalationRate: number; // 0-1
  }>;

  // Budget / Request accounting
  configuredGlobalLLMBudget: number;
  initialRequests: number;
  retryRequests: number;
  totalActualHttpRequests: number;
  remainingLLMBudget: number;

  // Provider failure classification
  providerFailures: number;
  rateLimitFailures: number;
  networkFailures: number;
  providerTimeouts: number;
  malformedResponses: number;
  successfulLLMResponses: number;

  // Retry accounting
  retriesEligible: number;
  retriesAttempted: number;
  retriesBlocked: number;
  retriesBlockedByCaseBudget: number;
  retriesBlockedByGlobalBudget: number;

  // Termination classification
  casesTerminatedByProviderFailure: number;
  casesTerminatedByBudgetExhaustion: number;
}

export interface AgentEvaluationRun {
  runId: string;
  timestamp: string;
  providerType: 'BASELINE' | 'REAL_LLM';
  totalCases: number;
  metrics: AgentEvaluationMetrics;
  caseResults: CaseEvaluationResult[];
}
