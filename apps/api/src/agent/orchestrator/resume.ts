import { PrismaClient } from '@prisma/client';
import { AgentOrchestrator } from './index';

export interface ResumeResult {
  resumed: boolean;
  reason: string;
  orchestratorResult?: any;
}

/**
 * Safely resumes a waiting recovery case.
 * 
 * Enforces atomic state transitions to guarantee exactly-once execution.
 * Only resumes if the authoritative external event indicates a SUCCESS payment.
 */
export async function resumeWaitingCase(
  prisma: PrismaClient,
  orchestrator: AgentOrchestrator,
  paymentId: string,
  eventId: string, // audit/correlation identifier
  paymentStatus: string // The trigger payload status
): Promise<ResumeResult> {
  // 1. Success-focused resume.
  // Prevent WAITING -> VERIFYING -> WAITING event churn loop.
  if (paymentStatus !== 'SUCCESS') {
    return {
      resumed: false,
      reason: `Event ${eventId} ignored. Payment status is ${paymentStatus}, not SUCCESS. Case remains in WAITING_FOR_CUSTOMER to avoid event churn.`,
    };
  }

  // 2. Atomic state transition: grab ownership of the resume
  const updateResult = await prisma.recoveryCase.updateMany({
    where: {
      paymentId,
      status: 'WAITING_FOR_CUSTOMER'
    },
    data: {
      status: 'VERIFYING'
    }
  });

  // 3. Exactly-one owner validation
  if (updateResult.count === 0) {
    return {
      resumed: false,
      reason: `Event ${eventId} ignored. Case is not in WAITING_FOR_CUSTOMER state or does not exist. It may have been resumed concurrently or is already terminal.`
    };
  }

  // At this point, we exclusively own the resume. The case is now VERIFYING.
  
  // Find the caseId for the orchestrator
  const cCase = await prisma.recoveryCase.findUnique({
    where: { paymentId }
  });

  if (!cCase) {
    // Should never happen due to the updateMany above, but required for type safety
    throw new Error('Case disappeared after atomic update');
  }

  // 4. Run the orchestrator.
  // Because the state is VERIFYING, processCase will start there,
  // load the authoritative Payment from DB via OutcomeVerifier,
  // and transition to RECOVERED (since the trusted ingestion path should have updated the DB).
  // No LLM requests will be made.
  try {
    const orchestratorResult = await orchestrator.processCase(cCase.id);
    return {
      resumed: true,
      reason: `Successfully resumed case for event ${eventId}.`,
      orchestratorResult
    };
  } catch (error: any) {
    // If the orchestrator fails spectacularly, return the error but ownership was already consumed.
    return {
      resumed: true,
      reason: `Resumed case but orchestrator threw: ${error.message}`
    };
  }
}
