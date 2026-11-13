# AI upgrade scope and initial estimate

Assessment date: 2026-11-13. Planned work: bounded tactical proof, MCTS with chance
outcomes, independent evaluation, then progressive local sampling. The React/Vite
UI and pure rules engine remain in place. No neural-network training or hosted API.

Initial engineering estimate: 2–4 hours and roughly 40k–100k assistant tokens
including delegated work and debugging; not measured usage or a billing quote.
The user subsequently requested lower reasoning effort and reduced token use.

Observed host: AMD Ryzen 7 8845H, 16 logical processors, about 31 GiB reported RAM,
about 7 GiB free during inspection. CPU-only implementation is feasible.
GPU capabilities are not required for this phase.

Pre-integration search benchmark: 48 iterations, depth 8, no rollout and a proxy
prior/heuristic leaf evaluator took 31–44 ms; 96 took 56–58 ms. These are search
timings, not completed game simulations or predictive-quality results.
Naively nesting this search at every move in every rollout scales badly.
Use bounded budgets and progressive focus-first analysis; record actual final
benchmarks before claiming an improvement.

Acceptance:
1. Existing rule and replay checks remain valid.
2. Bounded search never calls a truncated branch a proof.
3. Chance outcomes are sampled; hidden future order is never used to choose actions.
4. Search visits and heuristic cutoffs are not mislabeled as completed wins.
5. Compare against the frozen original policy, using paired seeds and independent
   tactical fixtures; report sample size, speed and limitations.
6. Keep a conservative fallback if a candidate does not improve the measured task.
