# Evaluation Methodology & Results

This project employs a rigorous, multi-stage evaluation framework to prove architectural correctness and policy compliance.

## The Journey
- **Step 35**: Baseline Qwen performance: ~39.7% action accuracy.
- **Step 40**: SOP introduced and controlled 58-case benchmark reached 100% policy conformance.
- **Step 41–44**: Recovery lifecycle and asynchronous `WAITING_FOR_CUSTOMER` architecture developed.
- **Step 45**: First async benchmark exposed real cross-case state leakage (stale `_latestToolResult`).
- **Step 45A**: Isolation regression fixed and tested.
- **Step 45B**: Valid async benchmark: 30/58 cases recovered.
- **Step 45C**: Scoring and metrics forensic validation.
- **Step 46A–46C**: Unseen 100-case dataset generated and benchmarked: 100% policy conformance, 42% final simulated recovery.
- **Step 47**: Final security and correctness audit.

## Metric Definitions
It is critical to interpret the metrics correctly:

1. **Policy Conformance (Action Accuracy)**: The percentage of cases where the system executed the *exact* action prescribed by the Standard Operating Procedure (SOP) for the given failure scenario. **This is not general ML intelligence.** It proves that the architectural bounds (Reasoner + PolicyEngine) reliably constrain the LLM to follow the business rules.
2. **Financial Recovery Rate**: The percentage of funds recovered out of the total amount at risk. **This relies heavily on synthetic simulation.** It demonstrates that the accounting is correct (no double counting) and that the asynchronous lifecycle works, but it does not represent real-world customer conversion rates.
3. **Case Recovery Rate**: The percentage of cases that successfully resolved to `RECOVERED`. Like the financial metric, this is a validation of the state machine, not a real-world conversion promise.

## 58-Case Benchmark Results (Step 45)
- **Total Cases**: 58
- **Policy Conformance**: 100% (58/58 actions correct)
- **Total Cases Recovered**: 30 (51.72%)
- **Financial Recovery Rate**: 48.5% (₹62,751.62 / ₹129,411.34)
- **Finding**: Async state machine properly processed 11 asynchronous customer recoveries without cross-case leakage.

## 100-Case Unseen Benchmark Results (Step 46C)
To prove that the policy-conformance was not simply overfit to the original 58 cases, the system was evaluated against 100 newly generated, deterministic synthetic cases using the exact same SOP.
- **Total Cases**: 100
- **Policy Conformance**: 100% (100/100 actions correct)
- **Total Cases Recovered**: 42 (42.0%)
- **Financial Recovery Rate**: 38.3% (₹139,508.37 / ₹363,817.66)
- **Finding**: The system consistently adhered to the SOP across diverse risk tiers, exact amount bounds, and new failure codes without a single unauthorized execution.

## Simulation vs Real World
- **Synchronous Actions**: `RETRY_PAYMENT` executes immediately via the Tool Executor.
- **Asynchronous Actions**: `NOTIFY_CUSTOMER` and `SEND_PAYMENT_LINK` rely on the `CustomerBehaviorSimulator` script. This simulator runs *after* the agent pauses in `WAITING_FOR_CUSTOMER`. It deterministically decides if a customer "clicks and pays" based on their risk tier and the payment amount. 
- **The Caveat**: We do not claim 42% of real customers would pay. We only claim that the system successfully processes the 42% that the simulator synthetically approved.
