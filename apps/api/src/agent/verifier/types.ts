import type { ToolResult } from '../tools/types';

export type VerifierOutcome = 'RECOVERED' | 'RETRY' | 'ESCALATE' | 'WAITING';

export interface VerifierOutput {
  outcome: VerifierOutcome;
  verified: boolean;
  reason: string;
  paymentStatus: string;
  amountRecovered: number; // Integer paise
  referenceInformation?: string;
  metadata: Record<string, any>;
}

export interface VerifierBoundary {
  /**
   * Deterministically verifies the actual business outcome of a tool execution
   * by inspecting authoritative persisted state (the Payment database record).
   */
  verify(caseId: string, toolResult: ToolResult): Promise<VerifierOutput>;
}
