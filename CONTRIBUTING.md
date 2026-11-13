# Contributing to FlowGuard

Thank you for your interest in contributing to **FlowGuard**!

## Core Engineering Principles

1. **Zero External Dependencies**: FlowGuard is written in pure Node.js ESM (`>=18.0.0`) so it runs out-of-the-box in any AI agent environment without native compilation or `node_modules` bloat.
2. **End-to-End Evidenced Causality (`Blueprint ⇄ Graph-Diff ⇄ Verify`)**: Every new parser probe, typed relation edge, bridge linker, or contract obligation must carry source `file:line` evidence and be wired end-to-end from extraction to MCP output.
3. **Honest Tri-State Precision (`SATISFIED` / `VIOLATED` / `INCONCLUSIVE`)**: Static checks in `src/flow-verifier.mjs` and `src/wiring-contract.mjs` must respect `reservedContracts` (polymorphic peers, framework hooks, conditional compilation, library exports, telemetry sinks) and report `INCONCLUSIVE` rather than false `VIOLATED` verdicts when dynamic or runtime-only semantics prevent static certainty.

## Verification Checklist Before Submitting a PR

Run all verification commands locally and ensure they pass with `0` errors:

```bash
# 1. Run 142 existing assertions and 102 verification/engine/real-world regression cases
npm test

# 2. Run FlowGuard incremental & full self-verification on its own repository (must report PASS / SATISFIED)
npm run verify:self
node src/server.mjs --cli verify . --full
```

Verification CLI exits 1 for violations or failed behavioral tests, and 2 for argument/execution errors. `INCONCLUSIVE` remains non-blocking (exit 0); inspect the JSON verdict when full behavioral evidence is required.
