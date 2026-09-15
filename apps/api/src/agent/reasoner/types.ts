import { z } from 'zod';
import { SupportedActionsEnum } from '../policy/types';
import type { LLMBudgetTracker } from '../../evaluation/types';

export const ReasonerOutputSchema = z.object({
  diagnosisCode: z.string().min(1),
  diagnosisSummary: z.string().min(1),
  diagnosisConfidence: z.number().min(0.0).max(1.0),
  
  recommendedAction: SupportedActionsEnum,
  recommendationConfidence: z.number().min(0.0).max(1.0),
  recommendationReason: z.string().min(1),
  
  alternativeActions: z.array(SupportedActionsEnum).max(3).default([]),
  escalationRecommendation: z.boolean().default(false)
});

export type ReasonerOutput = z.infer<typeof ReasonerOutputSchema>;

export interface SanitizedCaseContext {
  caseId: string;
  payment: {
    amountPaise: number;
    currency: string;
    method: string;
    failureCode: string;
    failureReason: string;
  };
  customer: {
    riskTier: string;
    successfulPayments: number;
    failedPayments: number;
  };
  recoveryState: {
    status: string;
    attemptCount: number;
  };
  policiesSummary: string[];
  standardOperatingProcedures?: {
    policyVersion: string;
    rules: Array<{
      failureCategory: string;
      guidance: string;
      appropriateActions: z.infer<typeof SupportedActionsEnum>[];
    }>;
  };
}

export type ProviderProbeResult =
  | { status: 'AVAILABLE' }
  | { status: 'AUTHENTICATION_FAILURE'; error: string }
  | { status: 'RATE_LIMIT_OR_QUOTA_EXHAUSTED'; error: string }
  | { status: 'NETWORK_FAILURE'; error: string }
  | { status: 'TIMEOUT'; error: string }
  | { status: 'MALFORMED_PROVIDER_RESPONSE'; error: string }
  | { status: 'UNKNOWN_PROVIDER_FAILURE'; error: string };

export interface ReasonerProvider {
  /**
   * Executes the AI reasoning step.
   * Throws an error on timeout, provider failure, or invalid response.
   * Must return raw JSON/object that will be validated against ReasonerOutputSchema.
   */
  reason(context: SanitizedCaseContext, tracker?: LLMBudgetTracker): Promise<unknown>;

  /**
   * Preflight probe to determine if the provider is currently capable of accepting traffic.
   * Performs exactly ONE minimal HTTP request.
   * Does not consume evaluation budget, does not retry.
   */
  probe(): Promise<ProviderProbeResult>;
}

export interface ReasonerResult {
  success: boolean;
  data?: ReasonerOutput;
  error?: string;
  model: string;
  promptVersion: string;
  latencyMs: number;
}
