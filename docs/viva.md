# Viva & Defense Material

This document prepares the presenter for architectural questions during a project viva or technical defense.

## 1. Why is the LLM Untrusted?
**Question**: Why don't you just let the LLM directly execute the API calls if it's smart enough to read the SOP?
**Answer**: LLMs are probabilistic text generators, not deterministic logic engines. They are prone to hallucination, prompt injection, and catastrophic failure modes. In a financial system, taking a non-deterministic guess on whether to charge a customer's credit card is unacceptable. By treating the LLM as an untrusted reasoning core, we leverage its ability to understand unstructured context, while enforcing strict bounds on its execution.

## 2. Why does the PolicyEngine exist?
**Question**: If you pass the SOP to the LLM, isn't that enough?
**Answer**: No. Passing the SOP to the LLM is merely giving it *advice*. The `PolicyEngine` is the *enforcer*. If the LLM makes a mistake, the Policy Engine guarantees that the action is blocked. The Policy Engine runs deterministic, hardcoded rules (e.g., `amount <= 5000`) that prevent failures due to a hallucination. 

## 3. Why use Zod?
**Question**: Why not just parse the JSON output directly from the LLM?
**Answer**: LLMs often wrap JSON in markdown blocks (e.g., ` ```json `), omit required fields, or use incorrect types. Zod enforces a strict schema at the edge of the trust boundary. If the LLM returns `{"action": 123}` instead of `{"action": "RETRY_PAYMENT"}`, Zod immediately throws an error, allowing the system to safely escalate the case rather than crashing downstream components with undefined behavior.

## 4. Why does the OutcomeVerifier exist?
**Question**: If the Tool Executor successfully ran the API, why do you need a Verifier?
**Answer**: A successful API call (e.g., sending an email) does not mean the customer paid. Furthermore, relying on a tool's internal `success: true` flag is dangerous (e.g., a mock might return true, or a gateway timeout might return false even if the charge succeeded). The Verifier completely ignores the tool's opinion and exclusively checks the authoritative database `Payment.status`. This prevents artificial inflation of recovery metrics.

## 5. Why is Idempotency needed?
**Question**: What happens if two webhook events arrive at the exact same time?
**Answer**: In a distributed system, external webhooks can be fired multiple times for the same event. Without idempotency, we might double-charge a customer or double-count a recovery. We solved application-level idempotency by using a unique database constraint (`@@unique([caseId, attemptNumber])`) and an atomic Compare-And-Swap (CAS) update in `resumeWaitingCase` (`updateMany { status: 'VERIFYING' } where { status: 'WAITING' }`). The atomic CAS ensures that only one concurrent caller can successfully acquire the WAITING → VERIFYING transition at the application/database boundary. Third-party gateway idempotency remains a future integration requirement.

## 6. Why is WAITING_FOR_CUSTOMER non-terminal?
**Question**: Why not just close the case when you send the email?
**Answer**: Because the business goal is financial recovery, not just sending emails. By keeping the case in `WAITING_FOR_CUSTOMER`, we retain the state necessary to resume the exact workflow phase when the customer pays. This allows us to accurately track the outcome of asynchronous outreach.

## 7. What happens during crashes?
**Question**: Are there any scenarios where a case gets permanently stuck?
**Answer**: Yes, this is a documented limitation of the current implementation. If the Node process crashes after a case transitions to `VERIFYING` but before it finishes, it becomes orphaned. In a real production environment, we would implement a cron-based sweeper to locate cases stuck in `VERIFYING` for more than 15 minutes and automatically reset or escalate them.

## 8. Does 100% Policy Accuracy mean the LLM is perfectly intelligent?
**Question**: Your 100-case unseen benchmark got 100% policy accuracy. Does this prove the LLM will always make the right decision?
**Answer**: Absolutely not. It proves **Policy Conformance**, not general ML intelligence. It proves that the *system architecture* (specifically the SOP structure and Policy Engine boundaries) successfully constrains the LLM for this specific domain logic. It does not mean the LLM is universally accurate or immune to failure.
