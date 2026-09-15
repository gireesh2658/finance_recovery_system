# STEP 52 — COMPLETE END-TO-END SYSTEM EXECUTION TRACE

All claims in this document are derived from inspecting actual source code files. Where documentation and code disagree, code wins.

---

## PART 1 — SYSTEM ENTRY POINTS

There is **NO HTTP API endpoint** for submitting a payment-recovery case. The Express app (`src/app.ts`) registers only one route: `/api/v1/health` (a health check).

The system currently has **three actual entry points**:

| Entry Point | File | Function | Purpose |
|---|---|---|---|
| Seed Script | `src/seed/index.ts` | `main()` | Creates Customers, Payments, RecoveryCases, Policies, and GroundTruth in the database |
| Evaluation Runner | `src/evaluation/run-real-eval.ts` | `runRealLLMEvaluation()` | Iterates ground-truth cases and calls `orchestrator.processCase()` sequentially |
| Ad-hoc Script | Any script (e.g. `scratch/test-case.ts`) | Directly calls `orchestrator.processCase(caseId)` | Manual testing |

**How does a user start processing?**

1. Run `npx tsx src/seed/index.ts` to seed the database with 30 customers, 224 payments, 58 recovery cases, and policies including the SOP.
2. Run `npx tsx src/evaluation/run-real-eval.ts` to process all 58 cases through the orchestrator.
3. Alternatively, write a script that creates a Customer + Payment + RecoveryCase in the database, then calls `orchestrator.processCase(caseId)`.

There is **NO** user-facing form, CLI argument parser, or HTTP POST endpoint that accepts a payment failure as input. Input goes into the database first, then `processCase(caseId)` is called with the database record's primary key.

---

## PART 2 — ACTUAL INPUT MODEL

The system does **not** accept a flat input object from a user. It reads pre-existing database records. The following must exist **before** `processCase()` is called:

| Field | Type | Source | Required | Example |
|---|---|---|---|---|
| `Customer.id` | String (CUID) | Created by seed or script | Yes | `cmtzdt...` |
| `Customer.riskTier` | String | Seed/script | Yes | `LOW` |
| `Customer.totalPayments` | Int | Seed/script | Yes | `5` |
| `Customer.failedPayments` | Int | Seed/script | Yes | `1` |
| `Payment.id` | String (CUID) | Created by seed or script | Yes | `cmtzdt...` |
| `Payment.amount` | Int (paise) | Seed/script | Yes | `300000` |
| `Payment.status` | String | Must be `FAILED` | Yes | `FAILED` |
| `Payment.failureCode` | String | Seed/script | Yes | `GATEWAY_ERROR` |
| `RecoveryCase.id` | String (CUID) | Created by seed or script | Yes | `cmtzdt...` |
| `RecoveryCase.status` | String | Must be `DETECTED` | Yes | `DETECTED` |
| `RecoveryCase.attemptCount` | Int | Default 0 | Yes | `0` |
| `Policy (SOP)` | Record | Created by seed | Yes | SOP with `ruleType: STANDARD_OPERATING_PROCEDURE` |

The **only runtime input** to `processCase()` is a single string: `caseId`.

---

## PART 3 — "HOW DOES THE USER ACTUALLY GIVE INPUT?"

**If you are sitting at the terminal right now:**

```bash
# Step 1: Seed the database (creates customers, payments, cases, policies)
cd apps/api
npx tsx src/seed/index.ts

# Step 2: Run the evaluation (processes all 58 cases sequentially)
npx tsx src/evaluation/run-real-eval.ts
```

**If you want to test a single custom case:**

Write a TypeScript script that:
1. Creates a `Customer` record via `prisma.customer.create()`
2. Creates a `Payment` record via `prisma.payment.create()` with `status: 'FAILED'`
3. Creates a `RecoveryCase` record via `prisma.recoveryCase.create()` with `status: 'DETECTED'`
4. Instantiates the Orchestrator with its dependencies
5. Calls `orchestrator.processCase(recoveryCase.id)`

There is **no HTTP API** that accepts `{ failureCode: "GATEWAY_ERROR", amount: 3000 }`. The system is a headless worker, not a web service.

---

## PART 4 — DATABASE CREATION / INPUT PERSISTENCE

### Schema Relationships (from `prisma/schema.prisma`)

```
Customer (1) ──→ (N) Payment
Customer (1) ──→ (N) RecoveryCase
Payment  (1) ──→ (1) RecoveryCase     [via paymentId, @unique]
RecoveryCase (1) ──→ (N) RecoveryAttempt
RecoveryCase (1) ──→ (N) AgentDecision
RecoveryCase (1) ──→ (N) AuditEvent
RecoveryAttempt (1) ──→ (N) AuditEvent
```

### Records that must exist BEFORE `processCase()`:
- `Customer`
- `Payment` (status = `FAILED`)
- `RecoveryCase` (status = `DETECTED`)
- `Policy` records (at least one with `ruleType: STANDARD_OPERATING_PROCEDURE`)

### Records CREATED during `processCase()`:
- `AgentDecision` — by `ReasonerService.executeReasoning()` (stores LLM input/output)
- `RecoveryAttempt` — by `RecoveryToolExecutor.executeIdempotent()` (tool execution record)
- `AuditEvent` — by `StateMachineService.requestTransition()` and `OutcomeVerifier.verify()` and `RecoveryToolExecutor`

### Records UPDATED during `processCase()`:
- `RecoveryCase.status` — by `StateMachineService.requestTransition()`
- `RecoveryCase.attemptCount` — incremented by Orchestrator after tool execution
- `RecoveryCase.amountRecovered` — set during RECOVERED transition
- `Payment.status` — changed from `FAILED` to `SUCCESS` by tool finalization transaction (only for successful RETRY_PAYMENT)

---

## PART 5 — RECOVERY CASE START

**File**: [orchestrator/index.ts](file:///c:/Users/giree/Desktop/Razor%20pay/apps/api/src/agent/orchestrator/index.ts)
**Function**: `processCase()`
**Line 43**: `let cCase = await this.prisma.recoveryCase.findUnique({ where: { id: caseId } });`
**Line 46**: `let currentState = cCase.status as RecoveryCaseStatus;` → reads `DETECTED`

**Line 82-84**: The `switch` statement enters `case 'DETECTED'`:
```typescript
case 'DETECTED': {
  await advance('DIAGNOSING', 'Beginning diagnosis phase');
  break;
}
```

The `advance()` helper (Line 56-71) calls `this.stateService.requestTransition(caseId, 'DETECTED', 'DIAGNOSING', ...)`.

**File**: [state/service.ts](file:///c:/Users/giree/Desktop/Razor%20pay/apps/api/src/agent/state/service.ts)
Inside a `prisma.$transaction`:
1. Reads current case from DB
2. Verifies `currentCase.status === 'DETECTED'` (stale check)
3. Calls pure `transition()` function from `machine.ts` which checks `VALID_TRANSITIONS['DETECTED']` contains `'DIAGNOSING'` → YES
4. Executes `updateMany({ where: { id: caseId, status: 'DETECTED' }, data: { status: 'DIAGNOSING' } })`
5. Creates `AuditEvent` with `eventType: 'STATE_TRANSITION'`

If transition fails (stale state, invalid transition), `advance()` returns `false` and `currentState` is updated to whatever the DB actually says.

---

## PART 6 — ORCHESTRATOR FLOW

The entire `processCase()` is a `while` loop (Line 74) that runs until the state is terminal (`RECOVERED`, `ESCALATED`, `CLOSED`, `WAITING_FOR_CUSTOMER`) or the circuit breaker fires at 25 transitions.

| Step | State | Code Action | DB Effect |
|---|---|---|---|
| 1 | `DETECTED` | `advance('DIAGNOSING')` | `RecoveryCase.status → DIAGNOSING`, `AuditEvent` created |
| 2 | `DIAGNOSING` | Load SOP from `Policy` table. Build `SanitizedCaseContext`. Call `reasonerService.executeReasoning()`. | `AgentDecision` created |
| 3 | `DIAGNOSED` | `advance('STRATEGY_PENDING')` | Status updated, AuditEvent |
| 4 | `STRATEGY_PENDING` | `advance('POLICY_CHECK')` | Status updated, AuditEvent |
| 5 | `POLICY_CHECK` | Pop action from `fallbackAlternatives`. Call `evaluateActionPolicy()`. | None (pure function) |
| 6 | `ACTION_APPROVED` | `advance('EXECUTING')` | Status updated, AuditEvent |
| 7 | `EXECUTING` | Pop action. Build `ToolInput`. Call appropriate tool method. Increment `attemptCount`. | `RecoveryAttempt` created, `Payment.status` may change, AuditEvent |
| 8 | `VERIFYING` | Call `verifier.verify()`. | `AuditEvent` created by verifier |
| 9 | `RECOVERED` | Loop exits (terminal state) | `RecoveryCase.amountRecovered` set |

---

## PART 7 — SANITIZED CASE CONTEXT

**File**: [orchestrator/index.ts](file:///c:/Users/giree/Desktop/Razor%20pay/apps/api/src/agent/orchestrator/index.ts), Lines 122-142

The exact object constructed and sent to the LLM:

```typescript
const context: SanitizedCaseContext = {
  caseId,                                          // String
  payment: {
    amountPaise: fullData.payment.amount,           // Int (paise)
    currency: fullData.payment.currency,            // "INR"
    method: fullData.payment.method,                // "CARD"
    failureCode: fullData.payment.failureCode,      // "GATEWAY_ERROR"
    failureReason: fullData.payment.failureReason,  // "Gateway timeout"
  },
  customer: {
    riskTier: fullData.payment.customer.riskTier,                                    // "LOW"
    successfulPayments: fullData.payment.customer.totalPayments - failedPayments,     // 4
    failedPayments: fullData.payment.customer.failedPayments,                         // 1
  },
  recoveryState: {
    status: currentState,       // "DIAGNOSING"
    attemptCount: fullData.attemptCount,  // 0
  },
  policiesSummary: ['Active policies applied deterministically by Engine.'],
  standardOperatingProcedures: parsedSOP,  // The full SOP JSON from the Policy table
};
```

**What is intentionally EXCLUDED:**
- Customer name, email, phone (PII stripped)
- Customer ID
- Payment ID
- Ground truth / expected action
- Other cases' data

**What IS included:**
- The complete SOP rules (from the database `Policy` record)
- Numeric payment data
- Risk tier
- Payment history counts

---

## PART 8 — SOP

**File**: [orchestrator/index.ts](file:///c:/Users/giree/Desktop/Razor%20pay/apps/api/src/agent/orchestrator/index.ts), Lines 89-113

The SOP is loaded from the database:
```typescript
const sopPolicies = await this.prisma.policy.findMany({
  where: { ruleType: 'STANDARD_OPERATING_PROCEDURE', isActive: true },
  orderBy: { priority: 'desc' }
});
```

**Guards:**
- 0 SOPs found → ESCALATE (Line 94-98)
- More than 1 active SOPs found → ESCALATE (Line 100-104)
- Malformed JSON → ESCALATE (Line 106-113)

The SOP is **database-driven** and **application-owned**. It is seeded by `src/seed/index.ts` as a `Policy` record with `ruleType: 'STANDARD_OPERATING_PROCEDURE'`.

The actual SOP content (from [seed/index.ts](file:///c:/Users/giree/Desktop/Razor%20pay/apps/api/src/seed/index.ts) Lines 86-125):

| Failure Category | Guidance | Appropriate Actions |
|---|---|---|
| `INSUFFICIENT_FUNDS` | Notify customer | `NOTIFY_CUSTOMER` |
| `BANK_DECLINED` | Notify customer | `NOTIFY_CUSTOMER` |
| `INVALID_PAYMENT_METHOD` | Send payment link | `SEND_PAYMENT_LINK` |
| `CARD_EXPIRED` | Send payment link | `SEND_PAYMENT_LINK` |
| `GATEWAY_ERROR` | Retry if policy permits | `RETRY_PAYMENT` |
| `NETWORK_TIMEOUT` | Retry if policy permits | `RETRY_PAYMENT` |
| `REPEATED_FAILURE` | Escalate to human | `ESCALATE_TO_HUMAN` |

The SOP is passed to the LLM inside `SanitizedCaseContext.standardOperatingProcedures`. The LLM reads this to make its recommendation. The LLM does **not** enforce it — the PolicyEngine does.

---

## PART 9 — PROMPT CONSTRUCTION

**File**: [openrouter-provider.ts](file:///c:/Users/giree/Desktop/Razor%20pay/apps/api/src/agent/reasoner/openrouter-provider.ts), Lines 83-88

The LLM receives exactly **two messages**:

```
messages: [
  { role: 'system', content: SYSTEM_PROMPT },     ← static, from prompt.ts
  { role: 'user',   content: JSON.stringify(context, null, 2) }  ← dynamic SanitizedCaseContext
]
```

**SYSTEM_PROMPT** (from [prompt.ts](file:///c:/Users/giree/Desktop/Razor%20pay/apps/api/src/agent/reasoner/prompt.ts)):
- Tells the LLM it is a revenue-recovery analyst
- Tells it: "RECOMMENDATION ≠ AUTHORIZATION"
- Tells it to follow the SOP in the context
- Tells it to output strict JSON matching the schema
- Tells it to never invent payment results

**USER MESSAGE** = the full `SanitizedCaseContext` as pretty-printed JSON, including:
- Payment data (amount, failureCode, method)
- Customer data (riskTier, payment history)
- Recovery state (status, attemptCount)
- The complete SOP rules

---

## PART 10 — LLM REQUEST

**File**: [openrouter-provider.ts](file:///c:/Users/giree/Desktop/Razor%20pay/apps/api/src/agent/reasoner/openrouter-provider.ts), Lines 83-93

```typescript
const response = await this.client.chat.completions.create({
  model: this.model,              // e.g. "zhipu/glm-z1-9b:free"
  messages: [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(context, null, 2) }
  ],
  temperature: 0.1,               // Near-deterministic
  response_format: { type: 'json_object' }  // Forces JSON output
}, {
  signal: controller.signal       // AbortController for timeout
});
```

| Parameter | Value |
|---|---|
| Provider | OpenRouter (OpenAI-compatible SDK) |
| Base URL | `https://openrouter.ai/api/v1` (default, configurable via env) |
| Model | From `OPENROUTER_MODEL` env var |
| Temperature | `0.1` |
| Response Format | `json_object` |
| Timeout | `AI_TIMEOUT_MS` env var, default 30000ms |
| Retry | 1 initial + 1 retry (only for transient/rate-limit errors) |
| Auth | Bearer token from `OPENROUTER_API_KEY` env var |

---

## PART 11 — ONE CASE AT A TIME

**A. Within ONE case:** The LLM receives the ENTIRE case context in ONE request. One HTTP call produces one JSON response.

**B. Across MULTIPLE cases:** Each case gets a **completely separate, independent** LLM request. There is NO batching, NO conversation memory, NO shared session.

**Evidence** — [evaluator.ts](file:///c:/Users/giree/Desktop/Razor%20pay/apps/api/src/evaluation/evaluator.ts) Lines 84-94:
```typescript
for (const gt of groundTruth) {
  const orchResult = await this.orchestrator.processCase(gt.caseId, tracker);
  initialCaseResults[gt.caseId] = orchResult;
}
```

This is a sequential `for` loop. Each `processCase()` creates an entirely new `OpenAI.chat.completions.create()` call. The LLM does not know about any previous case. There is no conversational context carried forward.

---

## PART 12 — LLM RESPONSE

**Expected Schema** — [reasoner/types.ts](file:///c:/Users/giree/Desktop/Razor%20pay/apps/api/src/agent/reasoner/types.ts) Lines 5-16:

```typescript
const ReasonerOutputSchema = z.object({
  diagnosisCode:            z.string().min(1),         // e.g. "GATEWAY_ERROR"
  diagnosisSummary:         z.string().min(1),         // e.g. "Transient gateway failure"
  diagnosisConfidence:      z.number().min(0).max(1),  // e.g. 0.95
  recommendedAction:        SupportedActionsEnum,      // "RETRY_PAYMENT" | "SEND_PAYMENT_LINK" | "NOTIFY_CUSTOMER" | "ESCALATE_TO_HUMAN"
  recommendationConfidence: z.number().min(0).max(1),  // e.g. 0.92
  recommendationReason:     z.string().min(1),         // e.g. "SOP permits retry for gateway errors"
  alternativeActions:       z.array(SupportedActionsEnum).max(3).default([]),
  escalationRecommendation: z.boolean().default(false)
});
```

**Validation Chain:**
```
LLM raw text string
   ↓
JSON.parse(messageContent)          ← openrouter-provider.ts Line 103
   ↓
returned to ReasonerService
   ↓
ReasonerOutputSchema.safeParse()    ← service.ts Line 41
   ↓
If parse fails → throw Error → case ESCALATED
If parse succeeds → ReasonerOutput object
```

---

## PART 13 — WHAT HAPPENS IF THE LLM OUTPUT IS WRONG?

| Malicious/Invalid Output | Where it stops | Result |
|---|---|---|
| Malformed JSON (not valid JSON) | `JSON.parse()` in `openrouter-provider.ts` Line 103 | Throws `SyntaxError` → `ReasonerService` catches → `reasonerSuccess = false` → case **ESCALATED** |
| Missing required field (e.g. no `diagnosisCode`) | `ReasonerOutputSchema.safeParse()` in `service.ts` Line 41 | Returns `{ success: false }` → throws `SCHEMA_VALIDATION_FAILED` → case **ESCALATED** |
| Invalid action (e.g. `"DELETE_CUSTOMER"`) | `SupportedActionsEnum` Zod check | `safeParse` fails → case **ESCALATED** |
| Invalid confidence (e.g. `1.5`) | `z.number().max(1.0)` | `safeParse` fails → case **ESCALATED** |
| Valid but unauthorized action (e.g. `RETRY_PAYMENT` for `INSUFFICIENT_FUNDS`) | `evaluateActionPolicy()` in `engine.ts` | PolicyEngine **denies** it → tries alternatives → may **ESCALATE** |
| Fabricated recovery claim | LLM output has no path to mutate DB. Only `OutcomeVerifier` reads `Payment.status` from DB. | No effect. |

---

## PART 14 — REASONER RESULT

**File**: [reasoner/service.ts](file:///c:/Users/giree/Desktop/Razor%20pay/apps/api/src/agent/reasoner/service.ts)

`executeReasoning()` returns a `ReasonerResult`:

```typescript
interface ReasonerResult {
  success: boolean;
  data?: ReasonerOutput;  // Only present if success === true
  error?: string;         // Only present if success === false
  model: string;
  promptVersion: string;
  latencyMs: number;
}
```

**Success path** (Lines 72-78): Returns `{ success: true, data: validOutput, ... }`.
**Failure path** (Lines 108-114): Returns `{ success: false, error: errorMessage, ... }`.

In BOTH cases, an `AgentDecision` record is persisted to the database containing:
- The full input context
- The LLM's output (or the error)
- The rationale
- The confidence
- The model name
- The latency

---

## PART 15 — ACTION SELECTION

**File**: [orchestrator/index.ts](file:///c:/Users/giree/Desktop/Razor%20pay/apps/api/src/agent/orchestrator/index.ts), Lines 148-152

```typescript
reasonerResult = aiResult.data;
fallbackAlternatives = [reasonerResult.recommendedAction, ...reasonerResult.alternativeActions];
fallbackAlternatives = [...new Set(fallbackAlternatives)]; // deduplicate
```

The action stack is built from the LLM's response: primary action first, then alternatives. They are tried **one at a time** against the PolicyEngine. The first one that passes gets executed.

The **LLM recommends**. The **SOP guides** the LLM. The **PolicyEngine decides** whether the action is allowed.

---

## PART 16 — POLICY ENGINE

**File**: [policy/engine.ts](file:///c:/Users/giree/Desktop/Razor%20pay/apps/api/src/agent/policy/engine.ts)

The PolicyEngine evaluates **safety policies** (NOT the SOP). The SOP is only seen by the LLM. The PolicyEngine enforces hard limits:

| Policy | Rule Type | What It Does |
|---|---|---|
| `global_max_retries` | `MAX_RETRIES` | Blocks `RETRY_PAYMENT` if `attemptCount >= 3` |
| `network_timeout_allowed_actions` | `ALLOWED_ACTIONS` | For `NETWORK_TIMEOUT`, only allows `RETRY_PAYMENT` and `ESCALATE_TO_HUMAN` |
| `insufficient_funds_cooldown` | `COOLDOWN` | Blocks retry for `INSUFFICIENT_FUNDS` if cooldown hasn't elapsed |
| `high_value_escalation` | `AMOUNT_LIMIT` | If `amount > 50,000 INR`, forces `ESCALATE_TO_HUMAN` |

**SOP vs PolicyEngine distinction:**
- **SOP** = "What SHOULD the LLM recommend?" (business guidance, sent to LLM in the prompt)
- **PolicyEngine** = "Is this recommendation ALLOWED?" (safety guardrails, runs deterministically in application code)

---

## PART 17 — RECOVERY ATTEMPT

**File**: [tools/index.ts](file:///c:/Users/giree/Desktop/Razor%20pay/apps/api/src/agent/tools/index.ts), `executeIdempotent()`

**Reservation Transaction** (Lines 30-91):
1. Reads `Payment` from DB, validates it belongs to the case
2. Checks terminal states → throws if case is already RECOVERED/ESCALATED/CLOSED
3. Checks `Payment.status === 'SUCCESS'` for RETRY_PAYMENT → throws (prevents double-charge)
4. Looks up existing `RecoveryAttempt` by `(caseId, attemptNumber)`:
   - If found with status `SUCCESS`/`FAILED` → returns cached result (idempotent)
   - If found with status `EXECUTING` and age < 5 min → throws (concurrent block)
   - If found with status `EXECUTING` and age > 5 min → reuses same `attemptId` (stale recovery)
   - If not found → creates new `RecoveryAttempt` with status `EXECUTING`

**External Execution** (Line 102): Calls the tool logic OUTSIDE the transaction.

**Finalization Transaction** (Lines 107-147): Updates attempt status, updates `Payment.status` if applicable, creates `AuditEvent`.

---

## PART 18 — TOOL EXECUTION

| Action | File/Function | External Effect | Payment Mutation | Verifier Outcome |
|---|---|---|---|---|
| `RETRY_PAYMENT` | `retryPayment()` | Simulated bank retry. Succeeds for `GATEWAY_ERROR` and `NETWORK_TIMEOUT`. Fails for others. | YES → `Payment.status = 'SUCCESS'` if simulated success | `RECOVERED` |
| `SEND_PAYMENT_LINK` | `generatePaymentLink()` | Simulated link generation. Always succeeds. | NO | `WAITING` |
| `NOTIFY_CUSTOMER` | `notifyCustomer()` | Simulated notification. Always succeeds. | NO | `WAITING` |
| `ESCALATE_TO_HUMAN` | `escalateToHuman()` | Simulated ticket creation. Always succeeds. | NO | `ESCALATE` |

---

## PART 19 — PAYMENT MUTATION

The **only** place `Payment.status` changes from `FAILED` to `SUCCESS` in production code:

**File**: [tools/index.ts](file:///c:/Users/giree/Desktop/Razor%20pay/apps/api/src/agent/tools/index.ts), Lines 115-122 (Finalization Transaction):

```typescript
if (paymentStatusUpdate) {
  const currentPayment = await tx.payment.findUnique({ where: { id: input.paymentId } });
  if (currentPayment?.status !== 'SUCCESS') {  // Guard: only mutate if not already SUCCESS
    await tx.payment.update({
      where: { id: input.paymentId },
      data: { status: paymentStatusUpdate }
    });
  }
}
```

This happens **AFTER** the external tool execution, inside the Finalization Transaction. The `paymentStatusUpdate` string is set to `'SUCCESS'` only by `retryPayment()` when the simulated bank succeeds.

---

## PART 20 — OUTCOME VERIFIER

**File**: [verifier/index.ts](file:///c:/Users/giree/Desktop/Razor%20pay/apps/api/src/agent/verifier/index.ts)

The Verifier reads `Payment.status` from the **database** (not from the tool result), then compares:

| Tool Result | Payment.status (DB) | Verifier Outcome |
|---|---|---|
| `success: true` | `SUCCESS` | `RECOVERED` (valid) |
| `success: true` | `FAILED` | `ESCALATE` (contradiction — tool lied) |
| `success: false` | `SUCCESS` | `ESCALATE` (contradiction — anomaly) |
| `success: false` | `FAILED` | `RETRY` (legitimate failure) |

For `SEND_PAYMENT_LINK` and `NOTIFY_CUSTOMER`, if `Payment.status` is still `FAILED`, the outcome is `WAITING` (customer hasn't acted yet).

---

## PART 21 — FINAL STATE

For the GATEWAY_ERROR dry-run:
- Verifier returns `outcome: 'RECOVERED'`
- Orchestrator calls `advance('RECOVERED', ..., { amountRecovered: payment.amount })`
- `StateMachineService` updates `RecoveryCase.status = 'RECOVERED'` and `amountRecovered = 300000`
- Loop exits because `RECOVERED` is in the terminal set

---

## PART 22 — FINAL OUTPUT

**`processCase()` returns** (Lines 356-370):

```typescript
{
  caseId: string,
  initialState: 'DETECTED',
  finalState: 'RECOVERED',
  actionsAttempted: ['RETRY_PAYMENT'],
  policyDecisions: [{ action: 'RETRY_PAYMENT', allowed: true, reason: 'All applicable policies passed.' }],
  reasonerSuccess: true,
  recoveryResult: 'SUCCESS',
  escalationStatus: false,
  failureReason: undefined,
  executionSummary: { durationMs: number, transitions: number }
}
```

**`reasonerResult` is NOT in this return value.** The `OrchestratorResult` type (in `types.ts`) does not include it. The LLM's diagnosis, confidence, and reasoning are stored only in the `AgentDecision` database table. This is why `result.reasonerResult` prints `undefined` in any caller script.

---

## PART 23 — DATABASE AUDIT TRAIL

After processing one GATEWAY_ERROR case, these records exist:

| Table | Count | Contains |
|---|---|---|
| `AgentDecision` | 1 | LLM input context, diagnosis code, confidence, recommended action, rationale, model name, latency |
| `RecoveryAttempt` | 1 | `attemptNumber: 1`, `actionType: RETRY_PAYMENT`, `status: SUCCESS`, `actionOutput: {...}` |
| `AuditEvent` | ~9 | One per state transition + tool execution + verification |
| `RecoveryCase` | 1 (updated) | `status: RECOVERED`, `amountRecovered: 300000`, `attemptCount: 1` |
| `Payment` | 1 (updated) | `status: SUCCESS` |

To find the LLM reasoning after the fact:
```sql
SELECT rationale, confidence, decision FROM AgentDecision WHERE caseId = '...'
```

---

## PART 24 — COMPLETE DRY RUN

### STEP 0 — INPUT
Customer: riskTier=LOW, totalPayments=5, failedPayments=1
Payment: amount=300000 paise (₹3,000), status=FAILED, failureCode=GATEWAY_ERROR
RecoveryCase: status=DETECTED, attemptCount=0

### STEP 1 — DATABASE
Records exist: Customer, Payment, RecoveryCase, 5 Policy records (including SOP).

### STEP 2 — DETECTED
`processCase()` loads case. `currentState = 'DETECTED'`.

### STEP 3 — DIAGNOSING
`advance('DIAGNOSING')` → `StateMachineService` validates DETECTED→DIAGNOSING is legal → `updateMany` → AuditEvent.

### STEP 4 — BUILD CONTEXT
```json
{
  "caseId": "...",
  "payment": { "amountPaise": 300000, "currency": "INR", "method": "CARD", "failureCode": "GATEWAY_ERROR", "failureReason": "Gateway timeout" },
  "customer": { "riskTier": "LOW", "successfulPayments": 4, "failedPayments": 1 },
  "recoveryState": { "status": "DIAGNOSING", "attemptCount": 0 },
  "policiesSummary": ["Active policies applied deterministically by Engine."],
  "standardOperatingProcedures": { "policyVersion": "1.0.0", "rules": [{"failureCategory":"GATEWAY_ERROR","guidance":"Retry may be appropriate...","appropriateActions":["RETRY_PAYMENT"]}, ...] }
}
```

### STEP 5 — LOAD SOP
Loaded from DB: `Policy.ruleType = 'STANDARD_OPERATING_PROCEDURE'`. Contains the GATEWAY_ERROR rule: `appropriateActions: ['RETRY_PAYMENT']`.

### STEP 6 — BUILD PROMPT
System message = `SYSTEM_PROMPT` (static). User message = `JSON.stringify(context)` (the object above).

### STEP 7 — LLM REQUEST
One HTTP POST to OpenRouter with `temperature: 0.1`, `response_format: { type: 'json_object' }`.

### STEP 8 — LLM RESPONSE (realistic example)
```json
{
  "diagnosisCode": "GATEWAY_ERROR",
  "diagnosisSummary": "Transient gateway failure. SOP permits automated retry.",
  "diagnosisConfidence": 0.95,
  "recommendedAction": "RETRY_PAYMENT",
  "recommendationConfidence": 0.92,
  "recommendationReason": "Per SOP rule for GATEWAY_ERROR, retry is the appropriate first action.",
  "alternativeActions": ["ESCALATE_TO_HUMAN"],
  "escalationRecommendation": false
}
```

### STEP 9 — PARSE + ZOD
`JSON.parse()` → success. `ReasonerOutputSchema.safeParse()` → success. `AgentDecision` record created.

### STEP 10 — ACTION
`fallbackAlternatives = ['RETRY_PAYMENT', 'ESCALATE_TO_HUMAN']`. Primary: `RETRY_PAYMENT`.

### STEP 11 — POLICY
PolicyEngine evaluates `RETRY_PAYMENT`:
- `AMOUNT_LIMIT`: 300000 <= 5000000 → PASS
- `MAX_RETRIES`: attemptCount 0 < 3 → PASS
- `ALLOWED_ACTIONS` for GATEWAY_ERROR: no specific constraint rule → PASS
- `COOLDOWN`: not INSUFFICIENT_FUNDS → N/A

Result: `{ allowed: true, reason: 'All applicable policies passed.' }`

### STEP 12 — ATTEMPT
`RecoveryAttempt` created: `{ caseId, attemptNumber: 1, actionType: 'RETRY_PAYMENT', status: 'EXECUTING' }`.

### STEP 13 — EXECUTION
`retryPayment()`: reads `failureCode = 'GATEWAY_ERROR'` → `isSuccess = true` → `paymentStatusUpdate = 'SUCCESS'`.

### STEP 14 — PAYMENT
Finalization transaction: `Payment.status` updated from `FAILED` to `SUCCESS`. `RecoveryAttempt.status` updated to `SUCCESS`.

### STEP 15 — VERIFICATION
`OutcomeVerifier.verify()`: reads `Payment.status` from DB = `SUCCESS`. Tool said success. No contradiction. → `outcome: 'RECOVERED'`, `amountRecovered: 300000`.

### STEP 16 — FINAL STATE
`advance('RECOVERED', ..., { amountRecovered: 300000 })` → `RecoveryCase.status = 'RECOVERED'`, `amountRecovered = 300000`.

### STEP 17 — RETURN VALUE
```typescript
{
  caseId: "...",
  initialState: "DETECTED",
  finalState: "RECOVERED",
  actionsAttempted: ["RETRY_PAYMENT"],
  policyDecisions: [{ action: "RETRY_PAYMENT", allowed: true, reason: "All applicable policies passed." }],
  reasonerSuccess: true,
  recoveryResult: "SUCCESS",
  escalationStatus: false,
  failureReason: undefined,
  executionSummary: { durationMs: ~14872, transitions: 8 }
}
```

### STEP 18 — DATABASE AFTER
- `Payment.status` = `SUCCESS`
- `RecoveryCase.status` = `RECOVERED`
- `RecoveryCase.amountRecovered` = `300000`
- `RecoveryCase.attemptCount` = `1`
- 1 `AgentDecision` record (contains full LLM reasoning)
- 1 `RecoveryAttempt` record (status: SUCCESS)
- ~9 `AuditEvent` records

---

## PART 25 — TIMELINE

```
T0    processCase(caseId) called
T1    RecoveryCase loaded from DB (status: DETECTED)
T2    DETECTED → DIAGNOSING (state transition + audit)
T3    SOP loaded from Policy table
T4    SanitizedCaseContext constructed (PII stripped)
T5    LLM HTTP request sent to OpenRouter
T6    LLM response received (~10-15 seconds)
T7    JSON.parse() + Zod validation
T8    AgentDecision persisted to DB
T9    DIAGNOSING → DIAGNOSED (state transition)
T10   DIAGNOSED → STRATEGY_PENDING (state transition)
T11   STRATEGY_PENDING → POLICY_CHECK (state transition)
T12   PolicyEngine evaluates RETRY_PAYMENT → ALLOWED
T13   POLICY_CHECK → ACTION_APPROVED (state transition)
T14   ACTION_APPROVED → EXECUTING (state transition)
T15   RecoveryAttempt reserved (Reservation Transaction)
T16   retryPayment() executes (simulated gateway)
T17   Payment.status FAILED → SUCCESS (Finalization Transaction)
T18   RecoveryAttempt.status → SUCCESS
T19   attemptCount incremented
T20   EXECUTING → VERIFYING (state transition)
T21   OutcomeVerifier reads Payment from DB (status: SUCCESS)
T22   Verifier outcome: RECOVERED
T23   VERIFYING → RECOVERED (state transition, amountRecovered set)
T24   Loop exits
T25   OrchestratorResult returned to caller
```

---

## PART 26 — DATA FLOW DIAGRAM

```
SCRIPT / EVALUATOR
        │
        │ processCase(caseId)
        ▼
┌─────────────────────┐
│   ORCHESTRATOR      │ ◄── while loop until terminal state
│   (index.ts)        │
└────────┬────────────┘
         │
         │ reads RecoveryCase
         ▼
┌─────────────────────┐
│   STATE MACHINE     │ ◄── DETECTED → DIAGNOSING
│   (service.ts)      │     uses $transaction + updateMany CAS
└────────┬────────────┘
         │
         │ loads SOP from Policy table
         │ builds SanitizedCaseContext
         ▼
┌─────────────────────┐
│   REASONER SERVICE  │
│   (service.ts)      │
│         │           │
│         ▼           │
│   ┌─────────────┐   │
│   │  PROVIDER   │   │ ◄── HTTP POST to OpenRouter
│   │ (openrouter) │  │     system + user messages
│   └──────┬──────┘   │
│          │          │
│          ▼          │
│   JSON.parse()      │
│   Zod safeParse()   │
│   AgentDecision     │ ◄── persisted to DB
│   created           │
└────────┬────────────┘
         │
         │ ReasonerResult { recommendedAction, alternatives }
         ▼
┌─────────────────────┐
│   POLICY ENGINE     │ ◄── evaluates RETRY_PAYMENT against
│   (engine.ts)       │     MAX_RETRIES, AMOUNT_LIMIT, etc.
│   Pure function     │     NO DB mutation
└────────┬────────────┘
         │
         │ PolicyDecision { allowed: true }
         ▼
┌─────────────────────┐
│   TOOL EXECUTOR     │
│   (tools/index.ts)  │
│         │           │
│   Reservation TX    │ ◄── creates RecoveryAttempt (EXECUTING)
│         │           │
│   Simulated Tool    │ ◄── retryPayment() / etc.
│         │           │
│   Finalization TX   │ ◄── Payment.status → SUCCESS
│                     │     RecoveryAttempt → SUCCESS
└────────┬────────────┘
         │
         │ ToolResult
         ▼
┌─────────────────────┐
│   OUTCOME VERIFIER  │ ◄── reads Payment.status from DB
│   (verifier/        │     compares with ToolResult
│    index.ts)        │     creates AuditEvent
└────────┬────────────┘
         │
         │ VerifierOutput { outcome: 'RECOVERED' }
         ▼
┌─────────────────────┐
│   STATE MACHINE     │ ◄── VERIFYING → RECOVERED
│   (service.ts)      │     sets amountRecovered
└────────┬────────────┘
         │
         ▼
   OrchestratorResult returned to caller
```

---

## PART 27 — "WHO DECIDES WHAT?"

| Responsibility | Component | File |
|---|---|---|
| Diagnoses the failure | **LLM** (via ReasonerService) | `reasoner/service.ts` + `openrouter-provider.ts` |
| Recommends the action | **LLM** | (same) |
| Defines the business rules | **SOP** (database Policy record) | `seed/index.ts` creates it |
| Determines if the action is allowed | **PolicyEngine** | `policy/engine.ts` |
| Executes the action | **ToolExecutor** | `tools/index.ts` |
| Mutates Payment status | **ToolExecutor** (Finalization TX) | `tools/index.ts` Line 118 |
| Determines if recovery actually happened | **OutcomeVerifier** | `verifier/index.ts` |
| Determines the final state | **StateMachineService** | `state/service.ts` + `state/machine.ts` |

---

## PART 28 — "WHO KNOWS WHAT?"

| Component | Knows | Does NOT know |
|---|---|---|
| **LLM** | Payment amount, failureCode, method, riskTier, payment history, SOP rules, recovery state | Customer name/email/phone, Payment ID, other cases, ground truth |
| **PolicyEngine** | Requested action, case state, payment amount, failureCode, attempt count, all active policies, current time | LLM reasoning, diagnosis, confidence |
| **ToolExecutor** | caseId, paymentId, actionType, attemptNumber, amount | LLM reasoning, policy decision, why this action was chosen |
| **OutcomeVerifier** | caseId, toolResult, Payment.status from DB | LLM reasoning, policy decision, what action was taken |
| **Orchestrator** | Everything above (coordinates all) | N/A |
| **Simulator** | Cases in WAITING_FOR_CUSTOMER, customer riskTier, payment amount | LLM reasoning, policy decisions |
| **GroundTruth** | Known by evaluation harness ONLY for scoring. Never sent to LLM, PolicyEngine, or Tools. | N/A |

---

## PART 29 — ONE CASE VS 100 CASES

**58-case evaluation** ([evaluator.ts](file:///c:/Users/giree/Desktop/Razor%20pay/apps/api/src/evaluation/evaluator.ts)):
1. Load `groundTruth.json` (58 entries)
2. Sequential `for` loop: call `processCase()` for each case
3. Each `processCase()` makes exactly ONE LLM request (budget: 1 per case)
4. After all 58 cases: run `CustomerBehaviorSimulator` for async recovery of WAITING cases
5. Re-fetch final states and score against ground truth

**100-case unseen evaluation**: Same logic but uses `dev_unseen.db` and `groundTruth_unseen.json`.

- Cases are processed **sequentially** (not parallel)
- Each case gets a **separate** LLM request
- Cases do **NOT** share LLM context or conversation
- The LLM does **NOT** remember the previous case
- Budget tracker enforces max 1 LLM call per case globally

---

## PART 30 — ASYNCHRONOUS PATH

For `SEND_PAYMENT_LINK` and `NOTIFY_CUSTOMER`:
1. Tool executes → Payment remains `FAILED` → Verifier returns `WAITING`
2. Orchestrator transitions to `WAITING_FOR_CUSTOMER` → loop exits
3. **Simulator** ([simulator.ts](file:///c:/Users/giree/Desktop/Razor%20pay/apps/api/src/evaluation/simulator.ts)) runs after Phase 1
4. For each `WAITING_FOR_CUSTOMER` case with `Payment.status = 'FAILED'`:
   - Checks `simulateCustomerSuccess(riskTier, amount)`: returns `true` if `riskTier === 'LOW' && amount <= 500000`
   - If yes: atomically updates `Payment.status → SUCCESS`, then calls `resumeWaitingCase()`
5. `resumeWaitingCase()` uses `updateMany({ where: { paymentId, status: 'WAITING_FOR_CUSTOMER' }, data: { status: 'VERIFYING' } })` for CAS ownership
6. Calls `processCase()` again — this time starting at `VERIFYING`, reads Payment (now SUCCESS), Verifier returns `RECOVERED`

A real webhook endpoint does not exist yet. The simulator fills this role for benchmarking.

---

## PART 31 — WHAT THE USER SEES

The **caller** of `processCase()` receives an `OrchestratorResult` object containing:
- Final state (RECOVERED/ESCALATED/WAITING)
- Actions attempted
- Policy decisions
- Whether the reasoner succeeded
- Duration

The caller does **NOT** receive:
- The LLM's diagnosis text
- The LLM's confidence scores
- The LLM's reasoning
- The raw LLM response

Those are stored in `AgentDecision` in the database. To see them, query:
```sql
SELECT decision, rationale, confidence FROM AgentDecision WHERE caseId = '...'
```

---

## PART 32 — "LEARN THIS FOR VIVA"

1. **What is the input?** A `RecoveryCase` ID pointing to a pre-existing record in the database with an associated failed Payment.
2. **Where does it enter?** `AgentOrchestrator.processCase(caseId)`.
3. **Where is it stored?** SQLite via Prisma (Customer, Payment, RecoveryCase tables).
4. **How does the orchestrator start?** It loads the RecoveryCase from the DB and enters a `while` loop that drives the state machine.
5. **What does the LLM receive?** A sanitized JSON object with payment details, customer risk tier, payment history (no PII), and the complete SOP rules.
6. **Does the LLM process one case or all cases?** ONE case per LLM request. No batching, no memory between cases.
7. **What does the LLM return?** A JSON object with: diagnosis code, summary, confidence, recommended action, recommendation confidence, reason, alternative actions, and escalation flag.
8. **How is its response validated?** `JSON.parse()` first, then Zod schema validation (`ReasonerOutputSchema.safeParse()`). If either fails, the case is escalated.
9. **What is the SOP?** A database-stored Policy record containing business rules mapping each failure code to appropriate recovery actions. It is sent to the LLM as context, NOT enforced by the LLM.
10. **What does PolicyEngine do?** It deterministically checks safety limits (max retries, amount caps, cooldowns, allowed actions per failure code). It can block any LLM recommendation.
11. **What does ToolExecutor do?** It executes the approved action using a two-phase transaction pattern: reserve attempt, execute externally, finalize result.
12. **What is RecoveryAttempt?** A database record tracking each execution attempt with a `@@unique([caseId, attemptNumber])` constraint for idempotency.
13. **Where does money actually change?** In the Finalization Transaction of `executeIdempotent()`, `Payment.status` is updated from `FAILED` to `SUCCESS`. Currently simulated, not connected to a real payment gateway.
14. **What does OutcomeVerifier do?** It ignores what the tool claims and reads `Payment.status` directly from the database to determine if recovery actually happened.
15. **What is the final output?** An `OrchestratorResult` with final state, actions attempted, and policy decisions. The LLM reasoning is NOT in this return value — it is in the `AgentDecision` DB table.
16. **Where is the LLM reasoning stored?** In the `AgentDecision` table: `decision` (JSON), `rationale` (text), `confidence` (float).
17. **What happens for WAITING_FOR_CUSTOMER?** The orchestrator loop exits. An external event (simulated by `CustomerBehaviorSimulator`, or a future webhook) must update `Payment.status` to `SUCCESS` and call `resumeWaitingCase()`.
18. **Synchronous vs asynchronous?** Synchronous: `RETRY_PAYMENT` → immediate SUCCESS/FAIL → Verifier → terminal state in one `processCase()` call. Asynchronous: `SEND_PAYMENT_LINK`/`NOTIFY_CUSTOMER` → WAITING → external event → `resumeWaitingCase()` → second `processCase()` call → RECOVERED.

---

## COMMON MISCONCEPTIONS

| Statement | TRUE or FALSE | Why |
|---|---|---|
| "The user directly sends the case to the LLM." | **FALSE** | The user inserts data into the database. The Orchestrator reads it, sanitizes it, and sends it to the LLM. |
| "The LLM directly changes the payment." | **FALSE** | The LLM outputs a JSON recommendation. The ToolExecutor (after PolicyEngine approval) is the only component that mutates `Payment.status`. |
| "The LLM decides whether an action is safe." | **FALSE** | The PolicyEngine decides. The LLM only recommends. |
| "The SOP is the same thing as the PolicyEngine." | **FALSE** | The SOP is business guidance sent to the LLM. The PolicyEngine is a deterministic code guard that runs independently. |
| "The PolicyEngine chooses the business strategy." | **FALSE** | The LLM chooses the strategy (guided by SOP). The PolicyEngine only approves or blocks it. |
| "The tool decides whether recovery succeeded." | **FALSE** | The OutcomeVerifier decides by reading `Payment.status` from the database. |
| "The LLM receives all 100 cases at once." | **FALSE** | Each case gets a completely separate, independent LLM request. |
| "The LLM remembers the previous case." | **FALSE** | No conversation history. Each request is stateless. |
| "The LLM directly accesses the database." | **FALSE** | The LLM has no database connection. It receives a sanitized JSON context. |
| "Payment becomes SUCCESS because the LLM said SUCCESS." | **FALSE** | Payment becomes SUCCESS because `retryPayment()` simulated a successful bank response AND the Finalization Transaction updated the DB. |
| "Every action produces a financial mutation." | **FALSE** | Only `RETRY_PAYMENT` (when successful) mutates `Payment.status`. `SEND_PAYMENT_LINK`, `NOTIFY_CUSTOMER`, and `ESCALATE_TO_HUMAN` do not. |
| "processCase() returns the complete LLM response." | **FALSE** | It returns `OrchestratorResult` which does NOT include the LLM diagnosis/confidence/reasoning. Those are in `AgentDecision` in the DB. |
| "reasonerResult === undefined means the LLM failed." | **FALSE** | It means the `OrchestratorResult` type does not include this field. The LLM succeeded (as indicated by `reasonerSuccess: true`). Its output is stored in the database, not in the return value. |

---

## "THINGS THIS SYSTEM DOES NOT CURRENTLY DO"

1. **No HTTP API for submitting cases.** Cases must be inserted into the DB manually or via seed scripts.
2. **No real payment gateway integration.** All tool executions are simulated with deterministic outcomes.
3. **No real webhook endpoint.** Async recovery is simulated by `CustomerBehaviorSimulator`.
4. **No cron sweeper.** Cases stuck in `DIAGNOSING` or `VERIFYING` after a crash remain orphaned until manually addressed.
5. **No multi-worker concurrency testing.** SQLite file-level locking prevents meaningful production-scale concurrency validation.
6. **No gateway-level idempotency.** The `referenceId` is generated locally but never sent to an external gateway as an idempotency key header.
7. **No user authentication or authorization.** The Express server has no auth middleware.
8. **The LLM reasoning is not surfaced to callers.** It exists only in the `AgentDecision` database table.
