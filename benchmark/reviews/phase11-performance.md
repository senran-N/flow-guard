# Phase 11 performance review

Date: 2026-11-13 (Asia/Shanghai)

## Decision

Do not claim the isolated phase10 3b state-reader-index candidate as accepted. It met the llama.cpp run criterion but did not meet the two-run Bruno criterion. The stream clone collector remains independently semantically tested, but was not used as an explanation for the Bruno result and was not bundled into the 3b candidate measurement.

## Frozen candidates

| Engine | Source hash | Changed source files |
| --- | --- | --- |
| Phase10 frozen | `0323942c1d88f42755fa890cf5917262e0ca0868fee841bc84800e64203790b5` | none |
| 3b state reader index | `0435cbfc257da9341f2e5882aa84a8ff0c55da8cb94ff5aae43a3b31575799ea` | `graph-builder.mjs` (`2a189c...071d9` -> `0e12b6...c6e5d`) |
| Stream clone collector | `86370843ef994d432536f8d8e02c9ec5236321a1911aaf44aee97ffe9ec7e642` | `flow-verifier.mjs`, `similarity-index.mjs` |

The 3b candidate replaces repeated scans of all production files for every state writer with an ordered `memberRead -> files` index. It also constructs each production file's import stems, file calls, directory, stem, and resolved-import set once. The connection predicates and source-file iteration order remain unchanged.

## Actual measurements

Evidence root: `D:\Myproject\flowguard-validation\2026-11-12-hardening`.

| Candidate / workspace | Run 1 | Run 2 | Semantic report |
| --- | --- | --- | --- |
| 3b / llama.cpp | 98,161 ms elapsed; 90,030 ms verify; 1,661 MiB RSS | 98,632 ms elapsed; 91,622 ms verify; 1,660 MiB RSS | Both complete and hash `9598cc02b040e2b19b8286c0c667ef3b0985373a1446821782378c8030ddda02` |
| 3b / Bruno | timeout at 121,072 ms | 110,023 ms elapsed; 101,995 ms verify; 705 MiB RSS | First run has no report; second hash `19180fedbcba4f90cabb2939661dbaea947b5fd39cd9a7e116caf4a681d98790` |

Sources: `performance-state-index-llama/results.json` and `performance-state-index-bruno/results.json`. The latter reports `completed: false` and `deterministic: null`, so it fails the required two complete Bruno runs and cannot establish cross-run report equivalence.

The frozen llama baseline had previously timed out at 120,562 ms (`phase10-frozen-llama-once`); that is useful context but not a completed paired baseline run. It must not be used to claim a quantified speedup.

## Small semantic-equivalence tests actually run

1. 3b test: a temporary workspace with a `Store.value` writer, an imported cross-file reader, and an unconnected same-field peer was checked by running the phase10 frozen verifier and the 3b candidate with `fullScan: true, ignoreSavedPlan: true`.
   - Entire serialized reports were byte-identical.
   - SHA-256: `393d40789413bb24fbbbff087e85cef2dfe3731fb7e850dc7688aa5fedcdb311`.
   - Both graphs selected only `src/view.mjs:view` as the `Store.value` reader.

2. Stream clone test: a temporary workspace with 12 identical functions was checked by running the phase10 frozen verifier and the stream candidate with the same options.
   - Entire serialized reports were byte-identical.
   - SHA-256: `f2e41d8019c3b1d085581368f39fdca0abff6710589b4c0c4e7cc5a66640ddd7`.
   - Exact clone count was 66; both reports retained the same lexicographically ordered 10-item preview.

3. Local regression command actually run: `node --test test/real-world-regression.test.mjs`.
   - 36 tests passed, including the clone-pair report fixture.

## Phase11 current-source stage profile

`phase11-bruno-stage-profile/phases.jsonl` completed successfully (exit code 0) in about 41.4 seconds for the current working source tree. Milestones: scoped call-edge resolution at 37,773 ms, cross-boundary bridges at 39,467 ms, state ownership at 39,489 ms, clone stage at 40,225 ms, wiring contracts at 41,341 ms, done at 41,408 ms. The terminal report has 367 structural clone pairs.

This is a useful current-source diagnostic only: it includes other current functional changes and is neither an isolated 3b/stream A/B run nor a two-run semantic-hash comparison. It therefore does not overturn the phase10 3b rejection criterion.

## Limits and retained evidence

The older Bruno parse trace (`profiles/bruno.jsonl`) recorded 3,152 parsed files, 67,759 ms wall time, 29,082 ms summed per-file parse time, and RSS rising from 54 to 489 MiB. It supports parser/lexer/build work as a material residual cost, but is not a phase10 CPU profile and does not prove causation for the current timeout.

No additional performance candidate should be accepted without two complete runs below 120 seconds on both target repositories and matching full semantic report hashes per repository.

## Final integrated revision

The final revision additionally caches import resolution within one graph build. It also fixes Rust candidate classification; those functional changes are not part of the isolated phase10 candidates. Final source hash: `b24554b5d7546c8973b1750e81f8f78f616198eda59fae1188e050f0d31d23bc`.

The first integrated revision (`c3eb8c7d61c715e5e66b6b20aedd0e59a7ed6c2647ee24a7a6b241e7c8b367bd`) completed Bruno twice but timed out twice on llama.cpp. Evidence remains under performance-phase11-final-{bruno,llama}; it is not the accepted final revision. Final measurements are under performance-phase11-final2-{bruno,llama} and collected in the phase11 report. No speedup percentage or isolated causal claim is made.
