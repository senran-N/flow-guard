# Contributing to FlowGuard

Thank you for your interest in contributing to **FlowGuard**!

## Core Engineering Principles

1. **Zero External Dependencies**: FlowGuard is written in pure Node.js ESM (`>=18.0.0`) so it can run out-of-the-box in any AI agent environment without native compilation or `node_modules` bloat.
2. **End-to-End Causality (`Source ➔ Branch ➔ Sink`)**: Every new parser rule, bridge linker, or verifier dimension must be wired end-to-end from token extraction to MCP tool output.
3. **Zero False Positives on Real Repositories**: Any new static check in `src/flow-verifier.mjs` must respect `reservedContracts` (polymorphic peers, framework hooks, conditional compilation) and pass the adversarial torture suite.

## Verification Checklist Before Submitting a PR

Run both commands locally and ensure they pass with `0` errors:

```bash
# 1. Run the 10-language adversarial torture, mutation fuzzing & contract suite (50 assertions)
npm test

# 2. Run FlowGuard self-verification on its own repository (must report PASS with 0 issues)
npm run verify:self
```
