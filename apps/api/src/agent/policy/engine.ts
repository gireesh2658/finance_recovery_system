import {
  SupportedActionsEnum,
  type PolicyEvaluationContext,
  type PolicyDecision,
  type MaxRetriesCondition,
  type AllowedActionsCondition,
  type CooldownCondition,
  type AmountLimitCondition
} from './types';

function createDeny(action: string, reason: string, escalation: boolean = false, contextDetails: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    allowed: false,
    action,
    reason,
    requiredEscalation: escalation,
    evaluatedPolicies: contextDetails.evaluatedPolicies || [],
    passedPolicies: contextDetails.passedPolicies || [],
    failedPolicies: contextDetails.failedPolicies || [],
  };
}

export function evaluateActionPolicy(context: PolicyEvaluationContext): PolicyDecision {
  const { requestedAction, caseState, paymentInfo, policies, currentTimestampMs } = context;
  const evaluatedPolicies: string[] = [];
  const passedPolicies: string[] = [];
  const failedPolicies: string[] = [];

  const updateDecision = (policyName: string, passed: boolean) => {
    evaluatedPolicies.push(policyName);
    if (passed) passedPolicies.push(policyName);
    else failedPolicies.push(policyName);
  };

  // 1. Validate action
  const parsedAction = SupportedActionsEnum.safeParse(requestedAction);
  if (!parsedAction.success) {
    return createDeny(requestedAction, 'Unknown or unsupported action requested.', false);
  }
  const validAction = parsedAction.data;

  // 2. Validate case state
  const terminalStates = ['RECOVERED', 'ESCALATED', 'ABANDONED', 'CLOSED'];
  if (terminalStates.includes(caseState.status) || terminalStates.includes(caseState.finalOutcome)) {
    return createDeny(validAction, `Case is already in a terminal state: ${caseState.status} / ${caseState.finalOutcome}.`, false);
  }

  // Filter and sort policies by priority (descending)
  const activePolicies = policies
    .filter(p => p.isActive)
    .sort((a, b) => b.priority - a.priority);

  try {
    for (const policy of activePolicies) {
      let passed = true;
      let denyReason = '';
      let escalate = false;

      // Safely parse conditions
      let conditions: any;
      try {
        conditions = JSON.parse(policy.conditions);
      } catch (e) {
        // Fail-closed behavior on corrupted policy
        return createDeny(validAction, `Malformed policy configuration in ${policy.name}.`, true, { evaluatedPolicies, passedPolicies, failedPolicies });
      }

      switch (policy.ruleType) {
        case 'AMOUNT_LIMIT': {
          const limitCond = conditions as AmountLimitCondition;
          if (paymentInfo.amount > limitCond.maxAmountPaise) {
            if (validAction !== limitCond.exceedAction && limitCond.exceedAction === 'ESCALATE_TO_HUMAN') {
              passed = false;
              denyReason = `Payment amount exceeds safe automated recovery limit. Escalation required.`;
              escalate = true;
            }
          }
          break;
        }

        case 'ALLOWED_ACTIONS': {
          const allowedCond = conditions as AllowedActionsCondition;
          if (paymentInfo.failureCode === allowedCond.failureCode) {
            if (!allowedCond.allowedActions.includes(validAction)) {
              passed = false;
              denyReason = `Action ${validAction} is not permitted for failure code ${allowedCond.failureCode}.`;
            }
          }
          break;
        }

        case 'MAX_RETRIES': {
          const retryCond = conditions as MaxRetriesCondition;
          // Only applies to RETRY_PAYMENT
          if (validAction === 'RETRY_PAYMENT') {
            if (caseState.attemptCount < 0) {
              passed = false;
              denyReason = `Invalid negative attempt count state.`;
            } else if (caseState.attemptCount >= retryCond.maxRetries) {
              passed = false;
              denyReason = `Global maximum retries (${retryCond.maxRetries}) reached.`;
              escalate = true;
            }
          }
          break;
        }

        case 'COOLDOWN': {
          const cooldownCond = conditions as CooldownCondition;
          if (validAction === 'RETRY_PAYMENT' && paymentInfo.failureCode === cooldownCond.failureCode) {
            if (caseState.nextRetryAfter && currentTimestampMs < new Date(caseState.nextRetryAfter).getTime()) {
              passed = false;
              denyReason = `Cooldown period has not elapsed. Next retry allowed after ${new Date(caseState.nextRetryAfter).toISOString()}.`;
            }
          }
          break;
        }

        // TIME_WINDOW could be added here later
      }

      updateDecision(policy.name, passed);

      if (!passed) {
        return createDeny(validAction, denyReason, escalate, {
          evaluatedPolicies, passedPolicies, failedPolicies
        });
      }
    }
  } catch (error) {
    // Fail-closed on unforeseen errors
    return createDeny(validAction, `Unexpected error evaluating policies: ${(error as Error).message}`, true, {
      evaluatedPolicies, passedPolicies, failedPolicies
    });
  }

  // 9. Return Final Decision
  // If we reach here, all active policies passed or were non-applicable
  return {
    allowed: true,
    action: validAction,
    reason: 'All applicable policies passed.',
    requiredEscalation: validAction === 'ESCALATE_TO_HUMAN',
    evaluatedPolicies,
    passedPolicies,
    failedPolicies,
  };
}
