# Demonstration Script

This script outlines the scenarios to demonstrate the core capabilities and defensive architecture of the AI Revenue Recovery Agent.

## Setup Requirements
1. The application must be running (`npm run dev`).
2. The SQLite database must be freshly seeded with the initial demo cases.
3. Keep the terminal output visible to show the deterministic state machine transitions.

## Scenario 1: A Normal Successful Recovery
**Goal**: Show the happy path for an immediate synchronous recovery.
**Action**: 
- Trigger a case with `GATEWAY_ERROR` or `NETWORK_TIMEOUT` within the retry limit.
**Expected Flow**:
1. Orchestrator moves case to `DIAGNOSING`.
2. Reasoner recommends `RETRY_PAYMENT`.
3. Policy Engine verifies the amount and failure code, returning `ACTION_APPROVED`.
4. Tool Executor simulates the gateway charge.
5. Verifier checks the DB, sees `SUCCESS`, and moves case to `RECOVERED`.

## Scenario 2: The Asynchronous Lifecycle
**Goal**: Demonstrate how the system pauses for customer interaction without blocking or hallucinating success.
**Action**:
- Trigger a case where the failure reason is `BANK_DECLINED`.
**Expected Flow**:
1. Reasoner recommends `NOTIFY_CUSTOMER`.
2. Policy Engine approves.
3. Tool Executor sends the notification.
4. Verifier checks the DB, sees the payment is still `FAILED`, and returns `WAITING`.
5. Orchestrator pauses the case in `WAITING_FOR_CUSTOMER`.
6. **Manual Trigger**: Run the simulation script to emulate the customer acting on the notification and paying.
7. The webhook ingestion `resumeWaitingCase` fires, atomic CAS moves the state to `VERIFYING`.
8. Verifier sees `SUCCESS` and finalizes the case to `RECOVERED`.

## Scenario 3: Unsafe Recommendation Blocked
**Goal**: Prove the LLM Trust Boundary is secure against hallucination or prompt injection.
**Action**:
- Trigger a case where the amount is ₹6,000 (above the ₹5,000 automated limit).
**Expected Flow**:
1. The LLM (unaware of the strict mathematical amount limit in the engine) might recommend `RETRY_PAYMENT`.
2. The `PolicyEngine` evaluates the recommendation.
3. The `AMOUNT_LIMIT` policy catches the ₹6,000 value.
4. The Policy Engine returns `POLICY_DENIED`.
5. The Orchestrator safely routes the case to `ESCALATED`, completely preventing the unauthorized tool execution.

## Scenario 4: Provider Failure
**Goal**: Demonstrate system resilience when the LLM API is down or times out.
**Action**:
- Temporarily change the `.env` API key to an invalid string, or simulate a network timeout.
**Expected Flow**:
1. Orchestrator requests reasoning.
2. The API call fails or times out.
3. The `try-catch` boundary in `ReasonerService` catches the error.
4. An `AgentDecision` audit trace is written with `confidence: 0` and the exact error message.
5. The Orchestrator safely moves the case directly to `ESCALATED`.
6. The system does not crash; the next case begins processing normally.
