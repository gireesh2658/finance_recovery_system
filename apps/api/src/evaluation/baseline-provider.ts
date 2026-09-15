import type { ReasonerProvider, SanitizedCaseContext } from '../agent/reasoner/types';
import type { ActionType } from '../agent/policy/types';

export class BaselineEvaluationProvider implements ReasonerProvider {
  // We can force specific cases to return specific actions to test metrics
  private forcedCaseActions: Record<string, ActionType>;
  
  // We can map failure codes to deterministic fallback actions
  private failureCodeMapping: Record<string, ActionType>;

  constructor(
    forcedCaseActions: Record<string, ActionType> = {},
    failureCodeMapping: Record<string, ActionType> = {}
  ) {
    this.forcedCaseActions = forcedCaseActions;
    this.failureCodeMapping = failureCodeMapping;
  }

  async reason(context: SanitizedCaseContext): Promise<unknown> {
    let recommendedAction: ActionType = 'ESCALATE_TO_HUMAN';

    if (this.forcedCaseActions[context.caseId]) {
      recommendedAction = this.forcedCaseActions[context.caseId];
    } else if (this.failureCodeMapping[context.payment.failureCode]) {
      recommendedAction = this.failureCodeMapping[context.payment.failureCode];
    } else {
      // Default dummy logic if no mapping is provided
      if (context.payment.failureCode === 'INSUFFICIENT_FUNDS') recommendedAction = 'NOTIFY_CUSTOMER';
      else if (context.payment.failureCode === 'BANK_DECLINED') recommendedAction = 'NOTIFY_CUSTOMER';
      else if (context.payment.failureCode === 'NETWORK_TIMEOUT') recommendedAction = 'RETRY_PAYMENT';
      else if (context.payment.failureCode === 'GATEWAY_ERROR') recommendedAction = 'RETRY_PAYMENT';
      else if (context.payment.failureCode === 'INVALID_PAYMENT_METHOD') recommendedAction = 'SEND_PAYMENT_LINK';
      else if (context.payment.failureCode === 'CARD_EXPIRED') recommendedAction = 'SEND_PAYMENT_LINK';
      else if (context.payment.failureCode === 'REPEATED_FAILURE') recommendedAction = 'ESCALATE_TO_HUMAN';
    }

    return {
      diagnosisCode: 'BASELINE_DIAG',
      diagnosisSummary: 'Deterministic baseline evaluation provider',
      diagnosisConfidence: 1.0,
      recommendedAction,
      recommendationConfidence: 1.0,
      recommendationReason: 'Baseline deterministic logic',
      alternativeActions: ['ESCALATE_TO_HUMAN'], // Safe bounded alternative
      escalationRecommendation: recommendedAction === 'ESCALATE_TO_HUMAN'
    };
  }

  async probe(): Promise<import('../agent/reasoner/types').ProviderProbeResult> {
    return { status: 'AVAILABLE' };
  }
}
