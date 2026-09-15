import { z } from 'zod';
import type { Policy, RecoveryCase, Payment, Customer } from '@prisma/client';

export const SupportedActionsEnum = z.enum([
  'RETRY_PAYMENT',
  'SEND_PAYMENT_LINK',
  'NOTIFY_CUSTOMER',
  'ESCALATE_TO_HUMAN',
]);
export type ActionType = z.infer<typeof SupportedActionsEnum>;

export interface PolicyEvaluationContext {
  requestedAction: string; // Keep string here to catch invalid actions at runtime
  caseState: Pick<RecoveryCase, 'status' | 'finalOutcome' | 'amountAtRisk' | 'attemptCount' | 'nextRetryAfter'>;
  paymentInfo: Pick<Payment, 'amount' | 'failureCode' | 'status'>;
  customerInfo: Pick<Customer, 'riskTier'>;
  policies: Policy[]; // The raw policies fetched from the DB
  currentTimestampMs: number;
}

export interface PolicyDecision {
  allowed: boolean;
  action: ActionType | string; // Use string so we can echo back invalid requested actions
  reason: string;
  requiredEscalation: boolean;
  evaluatedPolicies: string[];
  passedPolicies: string[];
  failedPolicies: string[];
}

// Parsed conditions for the various rule types
export interface MaxRetriesCondition {
  maxRetries: number;
}
export interface AllowedActionsCondition {
  failureCode: string;
  allowedActions: string[];
}
export interface CooldownCondition {
  failureCode: string;
  hours: number;
}
export interface AmountLimitCondition {
  maxAmountPaise: number;
  exceedAction: string;
}
