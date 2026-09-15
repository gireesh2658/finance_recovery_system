# System Architecture

## End-to-End Flow
The agent is designed as a deterministic state machine wrapping an untrusted reasoning core.

1. **Trigger**: An asynchronous event or scheduled job creates a `RecoveryCase` from a failed `Payment`.
2. **Orchestrator (`processCase`)**: The heart of the system. It manages the deterministic loop.
3. **Reasoner Service**: Extracts sanitized data (stripping PII), combines it with the system SOP, and asks the LLM to recommend an action.
4. **Policy Engine**: A strictly deterministic, fail-closed rules engine that validates the LLM's recommendation against amount limits, retry exhaustion, cooldowns, and the authoritative Standard Operating Procedure (SOP).
5. **Tool Executor**: Only allowed actions pass to the Executor. The tool interacts with external systems (simulated payment gateway, notification services).
6. **Verifier**: A deterministic boundary that checks the external truth (the authoritative Payment state in the DB) to confirm whether the tool's execution resulted in actual financial recovery.
7. **Resume Lifecycle (`resumeWaitingCase`)**: If the case entered `WAITING_FOR_CUSTOMER` (e.g., after a payment link was sent), a webhook ingestion point uses an atomic Compare-And-Swap (CAS) to resume the case precisely once and hand it back to the Verifier.

## The LLM Trust Boundary
The LLM is completely **UNTRUSTED**.
- **No Direct DB Access**: The LLM only returns structured JSON, forced via Zod schema (`safeParse`).
- **No Direct Execution**: The LLM cannot invoke a tool directly. It only outputs a `recommendedAction`.
- **Policy Subjugation**: The LLM is strictly subservient to the `PolicyEngine`. If the LLM hallucinates an invalid action, or recommends a valid action that violates the SOP, the `PolicyEngine` blocks it (`POLICY_DENIED`) and escalates the case.
- **No Fake Recoveries**: The LLM cannot declare a case `RECOVERED`. Only the `OutcomeVerifier`, reading the actual authoritative database Payment record, can declare financial success.

## WAITING_FOR_CUSTOMER Lifecycle
Not all recoveries are synchronous. Sending a payment link or notifying a customer requires them to take action.
1. The Tool Executor sends the link.
2. The Verifier checks the immediate payment status. Since the customer hasn't paid yet, the Verifier returns `WAITING`.
3. The Orchestrator sets the case to `WAITING_FOR_CUSTOMER` and pauses execution.
4. Later, when the customer pays, the external gateway sends a webhook.
5. `resumeWaitingCase` receives this event, performs an atomic `updateMany` (where status is WAITING -> VERIFYING) to guarantee exactly-once ownership at the application boundary, and resumes the Orchestrator at the `VERIFYING` state.

*Note: The core asynchronous lifecycle is implemented and validated through a deterministic simulator; production webhook ingestion and reconciliation infrastructure remain future work.*

## Application-Level Idempotency
- **Attempts**: Prisma unique constraints (`@@unique([caseId, attemptNumber])`) prevent double-execution of tools for the same recovery attempt phase.
- **Resumes**: The `updateMany` CAS logic prevents concurrent webhook events from double-resuming a case.

## Failure & Crash Limitations (Production Gaps)
The system is built for a demo environment and has the following documented limitations for production:
- **Orphaned VERIFYING States**: If the Node process crashes between `WAITING` and `VERIFYING`, or during tool execution, the case becomes stuck. A cron-based stale-state sweeper is required for production.
- **Webhook Reconciliation Gap**: If the Gateway commits a `SUCCESS` but the webhook ingestion crashes before resuming the case, the case remains `WAITING`. A reconciliation cron is required.
- **Gateway-Level Idempotency**: While application idempotency is robust, idempotency keys (UUIDs) must be explicitly passed down to the third-party Payment Gateway API to handle network timeouts gracefully.
