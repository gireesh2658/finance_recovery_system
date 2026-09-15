# AI-Assisted Payment Recovery Agent

**AI-assisted payment recovery agent with policy-governed action selection, guarded tool execution, application-level idempotent financial mutation, asynchronous customer-response handling, and controlled evaluation.**

## The Problem
When a customer's payment fails, businesses lose revenue. While some failures can be instantly retried (e.g., a momentary network glitch), others require customer intervention (e.g., expired card, insufficient funds). Traditional systems use rigid retry schedules that often result in lost customers or banned merchant accounts due to high retry failure rates. 

## The Solution
This project implements a highly defensive, AI-driven autonomous agent that intelligently orchestrates the payment recovery lifecycle. Rather than blindly retrying, it analyzes the failure context and customer profile to decide the best recovery action. 

Crucially, **the AI is treated as completely untrusted**. The system's primary innovation is its deterministic architectural boundary: The AI's recommendations are constrained by an application-owned SOP and enforced by a deterministic Policy Engine, enforcing strict financial safety, idempotency, and state machine isolation.

## Core Architecture
- **Orchestrator**: The deterministic state-machine core.
- **Reasoner Service**: The untrusted LLM that receives sanitized data and recommends an action based on an authoritative Standard Operating Procedure (SOP).
- **Policy Engine**: The strict, fail-closed rules engine that blocks hallucinations and unsafe actions.
- **Tool Executor**: Safely executes API requests to a simulated payment gateway.
- **Outcome Verifier**: Independently determines financial recovery from the authoritative database Payment state, not merely from a tool's reported success flag.

See [Architecture Documentation](docs/architecture.md) for full details.

## Setup Instructions

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment**
   Ensure your `.env` file is set up with your AI provider credentials.
   ```
   AI_PROVIDER=OPENROUTER
   OPENROUTER_API_KEY=your_key_here
   DATABASE_URL="file:./dev.db"
   ```

3. **Initialize Database**
   ```bash
   npx prisma generate
   npx prisma db push
   ```

## Run Instructions

**Start the API server:**
```bash
npm run dev
```

**Run the Test Suite:**
```bash
npx vitest run
```
*(Current status: 231 tests: 227 passed, 4 failed due to the documented SQLite parallel teardown issue).*

**Run the 58-Case Benchmark:**
```bash
npx tsx src/evaluation/run-eval.ts
```

**Run the 100-Case Unseen Benchmark:**
```bash
npx tsx src/evaluation/unseen/run-unseen-eval.ts
```

## Evaluation & Results
The system was evaluated using rigorous, deterministic benchmarks to prove policy-conformance and financial safety, avoiding "ML generalization" hand-waving.
- **100% Policy Accuracy** across both the 58-case baseline and the 100-case unseen benchmark.
- **Strict Isolation**: Cross-case state leakage identified during testing was removed and covered by isolation tests.

See [Evaluation Methodology](docs/evaluation.md) for a deep dive into the metrics.

## Documentation
- [Architecture & Trust Boundaries](docs/architecture.md)
- [Evaluation & Metrics](docs/evaluation.md)
- [Demonstration Script](docs/demo_script.md)
- [Viva & Technical Defense](docs/viva.md)

## Current Limitations & Production Gaps
This project is currently packaged for demonstration and architectural review. The following gaps exist before a live production deployment:
1. **No Production Webhook**: Asynchronous customer responses are currently validated via a deterministic simulator. Real HTTP webhooks need to be wired.
2. **Crash Windows**: Cases stuck in `VERIFYING` or `WAITING_FOR_CUSTOMER` during a Node process crash require a cron-based stale-state sweeper to be implemented.
3. **Gateway-Level Idempotency**: Application-level idempotency is strictly enforced via Prisma, but standard UUID idempotency keys must be passed down to the third-party gateway to gracefully handle network timeouts.
4. **Database**: Currently using SQLite for ease of setup. A migration to PostgreSQL is required for native Enum types and better parallel test-runner execution.
