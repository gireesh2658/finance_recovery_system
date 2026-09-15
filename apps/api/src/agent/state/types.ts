import { z } from 'zod';

export const RecoveryCaseStatusEnum = z.enum([
  'DETECTED',
  'DIAGNOSING',
  'DIAGNOSED',
  'STRATEGY_PENDING',
  'POLICY_CHECK',
  'POLICY_DENIED',
  'ACTION_APPROVED',
  'EXECUTING',
  'VERIFYING',
  'RETRY_PENDING',
  'RECOVERED',
  'ESCALATED',
  'WAITING_FOR_CUSTOMER',
  'CLOSED',
]);
export type RecoveryCaseStatus = z.infer<typeof RecoveryCaseStatusEnum>;

export interface StateTransitionContext {
  caseId: string;
  fromState: RecoveryCaseStatus;
  toState: RecoveryCaseStatus;
  transitionCount: number; // Total transitions so far
  strategyAttemptCount: number; // Number of times strategy was attempted
  reason?: string;
}

export interface TransitionResult {
  success: boolean;
  nextState: RecoveryCaseStatus;
  reason: string;
  isTerminal: boolean;
}

export interface TransitionEvent {
  caseId: string;
  previousState: RecoveryCaseStatus;
  nextState: RecoveryCaseStatus;
  reason: string;
  actor: string;
  timestamp: number;
}
