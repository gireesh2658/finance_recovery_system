import {
  type RecoveryCaseStatus,
  type StateTransitionContext,
  type TransitionResult,
  RecoveryCaseStatusEnum
} from './types';

// Hard limits for safety
const MAX_TRANSITIONS = 20;
const MAX_STRATEGY_ATTEMPTS = 3;

// Terminal states where automated actions must cease
export const TERMINAL_STATES: Set<RecoveryCaseStatus> = new Set(['RECOVERED', 'ESCALATED', 'CLOSED']);

// The deterministic map of valid state transitions
const VALID_TRANSITIONS: Record<RecoveryCaseStatus, Set<RecoveryCaseStatus>> = {
  DETECTED: new Set(['DIAGNOSING']),
  DIAGNOSING: new Set(['DIAGNOSED', 'ESCALATED']),
  DIAGNOSED: new Set(['STRATEGY_PENDING']),
  STRATEGY_PENDING: new Set(['POLICY_CHECK']),
  POLICY_CHECK: new Set(['ACTION_APPROVED', 'POLICY_DENIED']),
  POLICY_DENIED: new Set(['STRATEGY_PENDING', 'ESCALATED']),
  ACTION_APPROVED: new Set(['EXECUTING']),
  EXECUTING: new Set(['VERIFYING']),
  VERIFYING: new Set(['RECOVERED', 'RETRY_PENDING', 'ESCALATED', 'WAITING_FOR_CUSTOMER']),
  WAITING_FOR_CUSTOMER: new Set(['VERIFYING']),
  RETRY_PENDING: new Set(['STRATEGY_PENDING']),
  RECOVERED: new Set(['CLOSED']),
  ESCALATED: new Set(['CLOSED']),
  CLOSED: new Set(), // Completely terminal
};

/**
 * Pure transition guard. Returns a structured TransitionResult.
 * Does NOT mutate state. Does NOT execute actions.
 */
export function transition(context: StateTransitionContext): TransitionResult {
  const { fromState, toState, transitionCount, strategyAttemptCount } = context;

  // 1. Validate the enums
  if (!RecoveryCaseStatusEnum.safeParse(fromState).success || !RecoveryCaseStatusEnum.safeParse(toState).success) {
    return {
      success: false,
      nextState: fromState,
      reason: `Invalid state requested: ${fromState} -> ${toState}`,
      isTerminal: TERMINAL_STATES.has(fromState),
    };
  }

  // 2. Closed cases cannot transition anywhere
  // 3. Safety Boundary: Transition Limit
  if (transitionCount >= MAX_TRANSITIONS) {
    if (fromState === 'ESCALATED') {
         return {
           success: false,
           nextState: fromState,
           reason: 'Hard transition limit reached and case is already terminal.',
           isTerminal: true,
         };
       } else {
      // Force escalation
      return {
        success: true,
        nextState: 'ESCALATED', // Safe escalation behavior
        reason: `Hard transition limit of ${MAX_TRANSITIONS} exceeded. Forcing escalation.`,
        isTerminal: true,
      };
    }
  }

  // 4. Safety Boundary: Alternative Strategy Limit
  // If moving into STRATEGY_PENDING, we check if we exhausted attempts
  if (toState === 'STRATEGY_PENDING' && strategyAttemptCount >= MAX_STRATEGY_ATTEMPTS) {
    return {
      success: true,
      nextState: 'ESCALATED',
      reason: `Alternative strategy limit of ${MAX_STRATEGY_ATTEMPTS} exhausted. Forcing escalation.`,
      isTerminal: true,
    };
  }

  // 5. Evaluate the defined transition map
  const allowedNextStates = VALID_TRANSITIONS[fromState];
  if (!allowedNextStates || !allowedNextStates.has(toState)) {
    return {
      success: false,
      nextState: fromState,
      reason: `Invalid transition: ${fromState} -> ${toState} is not permitted by the state machine.`,
      isTerminal: TERMINAL_STATES.has(fromState),
    };
  }

  // 6. Transition is mathematically valid
  return {
    success: true,
    nextState: toState,
    reason: context.reason || `Transitioned to ${toState}`,
    isTerminal: TERMINAL_STATES.has(toState),
  };
}

/**
 * Boolean wrapper for simpler checks
 */
export function canTransition(fromState: RecoveryCaseStatus, toState: RecoveryCaseStatus): boolean {
  return transition({
    caseId: 'dummy',
    fromState,
    toState,
    transitionCount: 0,
    strategyAttemptCount: 0
  }).success;
}
