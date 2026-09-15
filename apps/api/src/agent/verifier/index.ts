import type { PrismaClient } from '@prisma/client';
import type { VerifierBoundary, VerifierOutput } from './types';
import type { ToolResult } from '../tools/types';

export class OutcomeVerifier implements VerifierBoundary {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Deterministic Outcome Verifier.
   * Compares the tool execution result with the authoritative persisted database state
   * to determine the actual business outcome. 
   */
  async verify(caseId: string, toolResult: ToolResult): Promise<VerifierOutput> {
    const startTime = Date.now();

    // 1. Validate inputs and load authoritative state
    const recoveryCase = await this.prisma.recoveryCase.findUnique({
      where: { id: caseId },
      include: { payment: true }
    });

    if (!recoveryCase) {
      return this.createFailure('Missing Case', `Case ${caseId} not found in database.`);
    }
    if (!recoveryCase.payment) {
      return this.createFailure('Missing Payment', `No payment associated with case ${caseId}.`);
    }
    if (recoveryCase.payment.id !== toolResult.paymentId) {
      return this.createFailure('Payment Mismatch', `Payment ${toolResult.paymentId} does not belong to case ${caseId}.`);
    }

    const payment = recoveryCase.payment;
    const actionType = toolResult.actionType;

    // Default response structure
    const output: VerifierOutput = {
      outcome: 'ESCALATE', // Fail safe default
      verified: true,
      reason: 'Unverified',
      paymentStatus: payment.status,
      amountRecovered: 0,
      metadata: {
        toolSuccess: toolResult.success,
        actionType,
        latencyMs: 0
      }
    };

    // 2. Core Verification Logic
    switch (actionType) {
      case 'RETRY_PAYMENT':
        if (payment.status === 'SUCCESS') {
          if (!toolResult.success) {
            // Contradiction: Tool says failed, but Payment is SUCCESS.
            // This is an anomaly that requires human review.
            output.outcome = 'ESCALATE';
            output.reason = 'Inconsistency: Tool reported failure but Payment is SUCCESS.';
          } else {
            // Valid recovery
            output.outcome = 'RECOVERED';
            output.reason = 'Payment successfully captured via retry.';
            output.amountRecovered = payment.amount;
          }
        } else if (payment.status === 'FAILED') {
          if (toolResult.success) {
            // Contradiction: Tool says success, but Payment is FAILED.
            // Never report recovery if payment is FAILED.
            output.outcome = 'ESCALATE';
            output.reason = 'Inconsistency: Tool reported success but Payment is FAILED.';
          } else {
            // Valid failure
            output.outcome = 'RETRY'; // Hand back to state machine for next strategy
            output.reason = 'Retry execution failed. Payment remains FAILED.';
          }
        } else {
          // Unknown payment state
          output.outcome = 'ESCALATE';
          output.reason = `Unexpected payment status: ${payment.status}`;
        }
        break;

      case 'SEND_PAYMENT_LINK':
        if (payment.status === 'SUCCESS') {
          // Perhaps they paid it instantly while we were verifying?
          output.outcome = 'RECOVERED';
          output.reason = 'Payment link resulted in successful payment capture.';
          output.amountRecovered = payment.amount;
        } else {
          // Link generated, payment not yet SUCCESS.
          // This goes back to strategy/retry loop waiting for payment or another action.
          output.outcome = 'WAITING';
          output.reason = 'Payment link generated. Payment is still FAILED/PENDING. Waiting for customer.';
        }
        break;

      case 'NOTIFY_CUSTOMER':
        if (payment.status === 'SUCCESS') {
          output.outcome = 'RECOVERED';
          output.reason = 'Payment became SUCCESS after notification.';
          output.amountRecovered = payment.amount;
        } else {
          output.outcome = 'WAITING';
          output.reason = 'Customer notified. Payment is still FAILED/PENDING. Waiting for customer.';
        }
        break;

      case 'ESCALATE_TO_HUMAN':
        // Escalation inherently requires human intervention
        if (payment.status === 'SUCCESS') {
          output.outcome = 'RECOVERED';
          output.reason = 'Payment is SUCCESS despite escalation attempt.';
          output.amountRecovered = payment.amount;
        } else {
          output.outcome = 'ESCALATE';
          output.reason = 'Escalation executed successfully.';
        }
        break;

      default:
        output.outcome = 'ESCALATE';
        output.reason = `Unknown action type verified: ${actionType}`;
        break;
    }

    // 3. Finalize and Audit
    output.metadata.latencyMs = Date.now() - startTime;

    await this.prisma.auditEvent.create({
      data: {
        caseId: caseId,
        eventType: 'VERIFICATION_COMPLETED',
        actor: 'VERIFIER',
        details: JSON.stringify({
          actionVerified: actionType,
          outcome: output.outcome,
          reason: output.reason,
          amountRecovered: output.amountRecovered,
          paymentStatus: output.paymentStatus,
          toolSuccess: toolResult.success
        })
      }
    });

    return output;
  }

  private createFailure(reasonTitle: string, reasonBody: string): VerifierOutput {
    return {
      outcome: 'ESCALATE',
      verified: false,
      reason: `${reasonTitle}: ${reasonBody}`,
      paymentStatus: 'UNKNOWN',
      amountRecovered: 0,
      metadata: {}
    };
  }
}
