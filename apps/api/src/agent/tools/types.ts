
import type { ActionType } from '../policy/types';

export interface ToolInput {
  caseId: string;
  paymentId: string;
  customerId: string;
  actionType: ActionType;
  attemptNumber: number; // Important for idempotency
  amountPaise: number;
}

export interface ToolResult {
  success: boolean;
  actionType: ActionType;
  caseId: string;
  paymentId: string;
  outcome: string; // 'SUCCESS' | 'FAILED' | 'ESCALATED' | 'LINK_GENERATED' | 'NOTIFIED'
  referenceId?: string;
  message: string;
  executionDurationMs: number;
  metadata: Record<string, any>; // Deterministic metadata for audit
}
