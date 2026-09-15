import type { RecoveryCaseStatus } from '../state/types';
import type { ActionType } from '../policy/types';
import type { ToolResult } from '../tools/types';

export interface OrchestratorResult {
  caseId: string;
  initialState: RecoveryCaseStatus;
  finalState: RecoveryCaseStatus;
  actionsAttempted: ActionType[];
  policyDecisions: Array<{ action: string; allowed: boolean; reason: string }>;
  reasonerSuccess: boolean;
  recoveryResult?: 'SUCCESS' | 'FAILED' | 'ESCALATED' | 'WAITING' | 'UNKNOWN';
  escalationStatus: boolean;
  failureReason?: string;
  executionSummary: {
    durationMs: number;
    transitions: number;
  };
}

export interface VerifierOutput {
  outcome: 'RECOVERED' | 'RETRY' | 'ESCALATE' | 'WAITING';
  verified: boolean;
  reason: string;
  paymentStatus: string;
  amountRecovered: number;
  referenceInformation?: string;
  metadata: Record<string, any>;
}

export interface VerifierBoundary {
  /**
   * Deterministic placeholder for future verification layer.
   * Examines the tool execution result and actual DB state to determine the business outcome.
   */
  verify(caseId: string, toolResult: ToolResult): Promise<VerifierOutput>;
}
