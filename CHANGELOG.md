# Changelog

## Unreleased — hierarchical architecture views

- Add directed task paths to flow_trace, separating executable calls/protocols from relationship paths, with explicit candidate, depth, path-count and work-budget limits.
- Add scoped state-owner queries, explicit business module configuration, nearest package manifests, and JS/TS/Vue/Svelte import dependencies with unresolved endpoints.
- Add historical architecture comparison using isolated Git archive source/configuration; expose static dependency topology and high-confidence versus candidate-only impact.
- Add independent edge/evidence/candidate pagination, off-page endpoint records and graph version validation. Bound candidate previews after real-repository output review.
- Validate paths/SCCs against an independent 40-graph closure oracle; retain real-source deletion controls and versioned seven-repository repeat scans.

- Share a versioned architecture projection across overview and trace, with module/file/symbol nodes, stable IDs, drill-down arguments, typed relations, original resolution confidence and source evidence.
- Add focus, depth, direction, node/edge bounds and pagination through both CLI and MCP. Report omitted nodes, edges and evidence explicitly; preserve ambiguous candidates and static-analysis boundaries.
- Render Mermaid from the returned graph rather than fixed source/branch/sink file previews. Include coverage when syncing AGENTS.md, and retain existing overview/trace summary fields.
- Add parser-to-query, traversal, pagination, state/protocol, CLI and stdio MCP regression coverage.

## 2026-11-13 Rust nominal types and callback regressions

- Follow concrete generic arguments, named fields, supported standard-library wrappers and simple local declarative macro factory signatures. Preserve cfg, scope, ambiguity and shadowing boundaries.
- Distinguish direct callback invocation in a resolved local receiver from registration-only exposure. Snapshot candidate registration facts and report loss of the last production connection in incremental checks.
- The real Pot tray callback deletion now fails incremental validation; compiler-backed controls and final-source evidence are recorded in the phase16 report.

## 2026-11-13 Residual entry evidence

- Capture Rust chained method continuations across lines; follow concrete factory return types when unambiguous, and preserve unresolved receiver candidates without creating executable edges.
- Record scoped Serde attribute references and CodeMirror/Homebrew host callbacks as candidate evidence, never runtime roots.
- Full-workspace unused-export diagnostics are advisory without an explicit task requirement. Explicit entry contracts and Git change checks retain failure behavior for missing connections.
- Validation and remaining limits are recorded in the phase15 report.

## 2026-11-13 Rust module zones

- Classify Rust source membership from actual Cargo bin/lib targets and exact module paths. A test filename alone no longer overrides a proven production module. Test directories, attached test attributes, test-only module ancestry and file inner attributes retain their boundaries.
- Share module path candidates with call resolution, including nested inline paths and custom crate roots. Recompute classifications without mutating parse-cache facts.
- Ignore cfg_attr lint/documentation/Windows subsystem settings when deciding compilation selection. Keep code-selecting or unresolved attributes inconclusive.
- 147 scenario assertions and 156 Node tests; final-source validation is recorded in the phase13 report.

## 2026-11-13 Rust call hardening

- Resolve qualified Rust `Type::new()` calls and preserve complete member receivers, including calls sharing the enclosing method name.
- Resolve function-item arguments through their actual module paths or import aliases. Keep callback exposure as candidate evidence; imports, generic type arguments and unresolved calls no longer use name-only edges.
- Report uncertain Rust callback/conditional test-zone references as inconclusive. Direct production-to-test calls remain violations.
- 147 scenario assertions and 145 Node tests; versioned evidence and compiler controls are recorded in the phase12 report.

## 2026-11-13 hardening

- Resolve inherited TS/JS path configurations, including multiple bases and installed config packages. Invalidate cached graphs when inherited configurations change or missing configurations appear; config-only Git edits trigger a full workspace check.
- Resolve local Cargo path dependencies, renamed crates, public re-exports/globs and sibling bin-to-lib imports with visibility checks. Add concrete receiver types and simple zero-argument method chains. Preserve explicit uncertainty for cfg, macros and unresolved receiver types.
- Connect Vue template events as candidates and FastAPI decorator dependencies through exact imports. Restrict React Email template entries to configured directories and reject shadowed router/dependency bindings.
- Index cross-file state readers and stream clone aggregation while preserving exact counts and preview order. Versioned performance and real-repository results are recorded separately in the phase11 report.
- Local suite now contains 147 scenario assertions and 140 Node tests.

- 三态门禁修复：INCONCLUSIVE 默认退出 3，显式兼容开关只影响退出码。
- 补齐 MCP 异常消息、分片、参数校验与真实 SDK 集成验证。
- 支持 JS/TS paths/baseUrl、React 生命周期候选路径及 Cargo 自定义入口；修复 Rust 重导出和 run 名称入口误判。
- Windows Node 18/24、Linux Node 22 完整测试通过：142 项断言及 102 个测试。性能候选因跨仓库结果不一致撤回，大仓库性能仍待解决。

All notable changes to **FlowGuard** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Treat `INCONCLUSIVE` as its own default verification status instead of reporting `PASS`. CLI now exits `3` for an inconclusive report; explicit `--allow-inconclusive` / JSON boolean `allowInconclusive: true` retains only the previous advisory exit-`0` behavior while the JSON report remains `INCONCLUSIVE`, without masking violations or execution errors.
- Resolve Rust free-function calls through declared modules, scoped use trees, aliases and re-exports. Handle cyclic imports without unbounded expansion and inspect path attributes without a backtracking regular expression.
- Preserve JS/TS top-level call sites alongside local declarations. Report test/tool-only consumers as inconclusive while keeping explicit production-entry contracts strict.
- Keep Kotlin anonymous, named and companion objects in their own scopes; retain external callback arguments as possible entry paths. Resolve JVM base contracts through qualified imports, aliases and packages.
- Follow JSX namespace re-exports and local component aliases; report runtime component selection as inconclusive instead of proving every candidate reachable.
- Recognize timer cancellation as consumption of its handle, and keep persistence-only heuristics inconclusive when no explicit business-consumption contract exists.
- Unwrap complete grouping parentheses around call arguments without treating comma expressions or arithmetic as direct argument references.
- Prevent prototype property names such as `toString` and `__proto__` from corrupting import aliases and crashing blueprint evidence collection.
- Separate generic constraints and qualified base types, retain nested function/impl scope, and count reserved argument slots without inventing trailing-comma parameters.
- Require actual interface or abstract declarations for sibling method obligations; recognize callable properties and default implementations. Restrict inferred factory obligations to shared registries and keep public library alternatives uncertain.
- Stop ordinary same-file calls from triggering callback signature exemptions, restoring detection of a dropped Click helper input.
- Infer JS/TS monorepo, Go package and Python distribution boundaries separately from application code. Resolve unique unqualified Go package calls and retain uncertain library paths.
- Compare only mutually exclusive conditional branches and their overload sets. Parse inline bodies and multiline generic class members; resolve same-named base contracts within their file/import scope.
- Put bridge, sandbox, anti-pattern and data-flow diagnostics into the same obligation counts and headline. Uncontracted unused inputs remain inconclusive instead of silently producing a satisfied verdict.
- Index same-file references and use an exact Jaccard prefix join for clone detection; preserve source coverage and verify indexed results against exhaustive comparisons.
- Advance persisted state to schema 2 so older graph snapshots are diagnosed rather than silently reused.
- Share ambiguous-call candidate labels across edges, reducing repeated allocations. Replace the short graph-cache TTL with source/configuration content and directory-entry validation, preventing duplicate graph construction after long verification runs.
- Recognize Ruby gem, Dart package and Gradle library/application boundaries. Keep JavaExec code-generation tasks from turning a library into an application; exclude Dart callback fields from abstract-method declarations.
- Resolve JSX component references through actual default, named and namespace imports, including JSX in JavaScript files and top-level rendering. Recognize Alembic upgrade/downgrade hooks only in configured revision directories with revision metadata.
- Separate structural membership/inheritance from runtime call reachability, retaining ambiguous paths as possible evidence. A caller without a runtime source no longer satisfies explicit entry contracts.
- Reject invalid explicit Git baselines and report the actual baseline commit. Session baselines use source hashes to detect existing-file changes, additions, and deletions, including non-Git workspaces and changes with preserved timestamps.
- Isolate plans, baselines, and Stop state by workspace/session/task; publish atomically and diagnose expired, branch-mismatched, corrupt, or legacy state. Remove global last-workspace fallback.
- Replace automatic safe-to-delete labels with missing-reference evidence, scope, uncertainty, and review instructions.
- Distinguish test failures from launch errors, timeout, and output overflow; persist per-run evidence and terminate the test process tree on timeout/overflow.
- Preserve argument positions, literal placeholders, repeated arguments, and multiple call sites when checking L2 target consumption. Match the target argument to a parameter actually referenced by the consumer, rather than any non-unused parameter. Ambiguous bindings remain `INCONCLUSIVE`.
- Keep L3 `INCONCLUSIVE` when test code exists but has not been run. Explicit test commands also run without an active blueprint; failed commands yield `VIOLATED` / `ISSUES_FOUND`.
- Parse documented blueprint CLI flags and reject unknown options or missing values. Verification exits 1 on violations, 2 on CLI errors, and 0 when no explicit violation is found (including inconclusive reports). Add `--run-tests` and `--project-mode` options.

### Tests & Documentation
- Add alternating frozen-engine A/B/B/A performance measurements and complete-report equivalence checks. Retain the rejected phase8 experiment and its timeout/memory evidence; restore the validated phase7 engine.
- Add 35 regressions derived from upstream source failures, bringing the Node test cases to 76 alongside 142 existing assertions. Verify on Windows with Node 18.20.8 and 24.14.0.
- Add two paired disconnect cases in complete pot-desktop source copies and a separately reported compiler-backed Rust behavior fixture; preserve intermediate Axum/ripgrep parser failures.
- Add a paired Bruno timer behavior probe with deterministic timers and explicit dependency substitutes; preserve the intermediate grouping-argument false positive and its passing retest.
- Preserve intermediate hardening scans and add frozen 39-repository retests, 12 original mutation pairs, 10 explicit target contracts and three newly cloned repository pairs. See the dated report for measured results and remaining limitations.
- Add repeatable real-repository scans, paired source mutations with behavior probes, blueprint retests, source review labels, commit/source manifests, and a frozen 36-repository baseline report. Track remaining production-readiness work separately; do not extrapolate fixture scores to arbitrary repositories.
- Add 23 engine-integrity cases covering reachability, baseline handling, state isolation, test execution faults and cache invalidation with preserved timestamps.
- Add 18 regression cases covering argument binding, actual behavioral tests, persisted CLI plans, and exit codes; run them with the existing 142 assertions in CI and add full-workspace self-verification.
- Limit benchmark accuracy claims to checked-in fixtures and identify the missing reproducibility materials for historical repository inspections.

## [0.2.0] - 2026-11-11

### Added
- **Shared Task Wiring Plan (`flow_blueprint` ⇄ `flow_verify`, `src/wiring-contract.mjs`, `src/flow-tools.mjs`, `src/flow-verifier.mjs`)**:
  - `flow_blueprint` now builds and persists a structured `wiringPlan` (`obligations` with target location, reason, expected relation, reference basis, verification method, and `ambiguitiesToConfirm`), accepting `targetSymbol`, `targetField`, `consumerTarget`, and `requirePersistence`.
  - `flow_verify` evaluates both persisted blueprint obligations and auto-inferred delta obligations (`A1`–`A9`), closing the loop between planning and verification.
- **3-Tier Evidence Separation (`L1_STRUCTURAL` ➔ `L2_DATA_FLOW` ➔ `L3_BEHAVIORAL`) & Context-Aware `export` Semantics (`src/graph-builder.mjs`, `src/file-parser.mjs`, `src/wiring-contract.mjs`)**:
  - `inferWorkspaceProfile` distinguishes `application`, `library`, and `hybrid` workspaces with two-tier reachability (`reachableFromRuntimeSource` vs `reachableFromSource`): library exports remain valid external entry points, whereas newly exported symbols in an `application` without runtime entry evidence are flagged as unwired (`unwiredExports`).
  - Field-level `L2_DATA_FLOW` verification checks that newly added config/protocol fields reach their downstream `consumerTarget` (detecting cases where a setting is saved to config while calculation logic still reads a hardcoded `UPPER_CASE` constant, or where frontend/backend IPC/HTTP payload keys drift) and verifies field-level `Save ⇄ Load` persistence symmetry (`fieldLifecycleAsymmetries`).
  - Optional `runTestsCommand` parameter executes behavioral test/probe commands for `L3_BEHAVIORAL` evidence while marking static-only behavioral checks `INCONCLUSIVE`.
- **Typed & Evidenced Graph Relations + 8-Channel Polyglot Bridges (`src/file-parser.mjs`, `src/bridge-linker.mjs`, `src/graph-builder.mjs`, `src/flow-tools.mjs`)**:
  - Classifies graph relations into `CONTAINS`, `SEQ_CALL`, `BRANCH_DISPATCH`, `REGISTRATION`, `STATE_RW`, `IMPLEMENTS`, and `PROTOCOL_BRIDGE`, recording `file:line`, `passedArgs`, `returnFlow`, `resolution.mode`, and `confidence` (`HIGH | MEDIUM | AMBIGUOUS` with full `candidates` preserved on ambiguous matches).
  - Separates `siblingBranchesToCheck` (conditional dispatch peers) from `sequentialStepsInCaller` (`authenticate -> validate -> save`) in `flow_trace`.
  - Adds `WEBVIEW2_IPC` (`window.chrome.webview` ⇄ C++/C# `WebMessageReceived` / `PostWebMessageAsJson`) and `SHARED_MEMORY_IPC` (Win32 `CreateFileMapping` / POSIX `shm_open` ⇄ Python `mmap` / `shared_memory`), RPC client-prefix disambiguation, and IPC/HTTP payload field extraction.
- **Graph-Diff Incremental Verification (`G_base ➔ G_curr`, `src/graph-diff.mjs`, `src/hook-runner.mjs`, `src/server.mjs`)**:
  - Supports both `SessionStart` baseline snapshots and arbitrary Git references (`baseRef` / `--base <git-ref>`, reconstructed in-memory via `git diff --name-status` + `git show` without touching the working tree).
  - Expands verification scope along dependency edges (`impactedUntouchedFiles`) to catch untouched-file regressions (`newlyWriteOnlyStates`, `newlyWriterlessStateReads`, `newlyOrphanedSymbols`, `newlyBrokenPaths`) while isolating `preExistingBrokenBridges` from `newlyBrokenBridges`.
- **Tri-State Verdicts (`SATISFIED` / `VIOLATED` / `INCONCLUSIVE`), Dead-Code Evidence Grading & Smart `Stop` Hook (`src/flow-verifier.mjs`, `src/hook-runner.mjs`)**:
  - Reports explicit obligation breakdowns (`headlineSummary`) and separates `CONFIRMED_SAFE_TO_DELETE` private dead pipes from `NO_STATIC_CALLER_EVIDENCE` unwired exports, plus write-only telemetry/audit sink exemptions.
  - `Stop` hook blocks strictly on newly introduced `VIOLATED` contracts/breaks (never blocking on `INCONCLUSIVE` or historical broken bridges) and supports `FLOWGUARD_MODE=advisory`.
- **14-Scenario Real-Task Incomplete-Wiring Benchmark Suite (`test/task-benchmark-suite.mjs`)**:
  - Adds 73 end-to-end assertions across 8 realistic incomplete-wiring tasks (`100%` recall) and 6 legal counterexamples (`0%` false violations), bringing total automated assertions to `142` (`69` torture + `73` task benchmark).

### Changed & Fixed
- **Honest Similarity & Capability Labeling (`src/flow-tools.mjs`, `src/fingerprint.mjs`, `README.md`)**: Replaced overstated "AST fingerprint" wording with explicit `LEXICAL_SHINGLE_JACCARD` labeling and documented static vs. runtime verification boundaries.
- **Case-Aware Symmetric Lifecycle Pairs (`src/fingerprint.mjs`)**: Extended `SYMMETRIC_PAIRS` to recognize camelCase and snake_case (`saveConfig`/`loadConfig`, `toJSON`/`fromJSON`, `persist`/`restore`, `save_preferences`/`load_preferences`) in addition to PascalCase.
- **Parser Edge-Case Fixes (`src/file-parser.mjs`, `src/lang-presets.mjs`)**: Fixed C++ file-local `static` function `isPublicApi` classification, bottom-of-file `export { fn }` false self-reference, shorthand object payload extraction (`{ a, b }`), ternary `? "str"` false EventBus emitter matching, and Windows backslash normalization in `SHARED_MEMORY_IPC`.

## [0.1.1] - 2026-11-11

### Fixed & Hardened (33-Repository Real-World Stress-Test Sweep)
- **Ruby `@@class_var` Infinite Loop Fix (`src/lang-presets.mjs`)**: Fixed a P0 non-terminating loop in `stripLeadingAttributesAndAnnotations` when encountering Ruby `@@config` class variables (`sidekiq`), adding strict `lang !== "ruby"` and non-progress loop guards.
- **Svelte 5 Runes & Composite Container State Tracking (`src/file-parser.mjs`, `src/graph-builder.mjs`, `src/fingerprint.mjs`)**:
  - Recognizes `$effect` / `$derived` reactive dependency trackers (`track*`), `.svelte` template member reads (`{#if state.prop}`) and native Svelte 5 `onclick={...}` event attributes, `#private` nested chain reads (`this.#field.sub`), and composite sibling container delegation (`this.root.field = ...`) while preserving strict SSOT isolation (`bits-ui`).
  - Classifies `.storybook` / `stories` directories and `.stories.*` files as `sandbox` zone.
- **Unity / Harmony IL Weaving & Advanced C# Semantics (`src/lexer.mjs`, `src/lang-presets.mjs`, `src/file-parser.mjs`, `src/flow-verifier.mjs`)**:
  - Quote-aware balanced `{...}` expression scanning (`scanBalancedBraceExpr`) for C# `$"{string.Join(", ", items)}"` and Python `f"{fn('a')}"` interpolations, plus `{{` literal escape handling (`BepInEx`).
  - Supports `unsafe` C# class/struct/constructor modifiers, event/delegate callback signatures (`+= Handler`, `(object sender, EventArgs e)`), and `[HarmonyFinalizer]` / `[HarmonyReversePatch]` / `OnEnable` / `OnDisable` entry hooks.
- **C++ / CUDA Systems Scale & `ctx_http` ⇄ Svelte REST Bridges (`src/lexer.mjs`, `src/lang-presets.mjs`, `src/file-parser.mjs`)**:
  - Parenthesized brace enclosure guard (`: pimpl(new impl{}) {`) preventing C++ constructor body truncation (`llama.cpp`).
  - Tracks C++ non-`const` lvalue reference out-parameters (`T & out`), C# `ref`/`out`, PHP `&$param`, Win32/POSIX/C11 atomic intrinsics (`Interlocked*`, `__atomic_*`, `atomic_fetch_*`), and CUDA runtime side-effects (`cudaMemcpy*`, `cudaStreamSynchronize`).
  - Connects C++ `cpp-httplib` / `ctx_http` routes (`svr.Get`, `ctx_http.post`) to frontend dynamic base-URL fetches (`` fetch(`${base}/props`) ``), and recognizes Python `@*.register*` dynamic plugin decorators.
- **Dedicated Dart Language Support & Polyglot Lexer Precision (`src/lang-presets.mjs`, `src/lexer.mjs`, `src/file-parser.mjs`, `src/graph-builder.mjs`)**:
  - Dedicated `dart` family (`{required T x}` / `[T? y]` parameter groups, `this.field` / `super.field` promoted constructors, `package:` import resolution, and `"""` triple-quoted strings).
  - Full expression token preservation inside `${...}`, `#{...}`, and Swift `\(... )` string interpolations; C++ multi-brace member initializer chains (`: types_{...}, named_args_{}`); Swift bodyless `protocol` bounds, implicit returns, and `T.Type = T.self` metatype parameters; Ruby paren-less `def`, `attr_reader` / `attr_accessor`, block-mutating `.delete_if { ... }`, and implicit returns before `end`/`rescue`/`else`.
- **Zero-Noise Control/Data-Flow & Side-Effect Precision (`src/file-parser.mjs`, `src/flow-verifier.mjs`)**:
  - `$`-aware identifier boundaries (`makeIdentRegex`) supporting JS/TS `$id`/`$`/`$tooltip` alongside PHP `$var` and Kotlin/Dart `"$tag"`.
  - Nested closure body stripping (`stripNestedClosureBodies`) so inner `.map(() => { return x; })` returns never leak `hasReturnValue = true` to outer throwing/void functions (`uptime-kuma`).
  - Optional-chaining (`?.`) member calls, non-local `Object.assign` / property / reactive `.value` alias mutations, callback parameter invocations, `[` subscript continuations, and call-graph-scoped (`outEdges` + `sameLangFamily`) `IGNORED_PURE_CALL` verification.
- **Inline `#[cfg(test)]` & Multiplatform Zone Isolation (`src/fingerprint.mjs`, `src/graph-builder.mjs`, `src/bridge-linker.mjs`)**:
  - Prevents `prod` Rust modules and cross-boundary bridges from linking to inline `#[cfg(test)] mod tests` symbols (`axum`, `SwitchHosts`) while preserving `prod -> sandbox/test` file leak detection.
  - Classifies KMP `*Test` source sets, `test-dts` / `.test-d.ts`, `mockwebserver*`, `*-testing-support`, `docs_src/`, and `example_*` accurately.
- **Expanded Full-Stack Bridges & Dispatch Contract Reconciliation (`src/file-parser.mjs`, `src/bridge-linker.mjs`, `src/graph-builder.mjs`)**:
  - Parameterized `#[tauri::command(async)]`, Socket.io `socket.emit` ⇄ `socket.on` (`ws:*`), Vue Options API `methods: {}`, Laravel `routes/api.php`, FastAPI `APIRouter(prefix=...)` + OpenAPI SDK `{ url: "/api/v1/..." }` sub-router mount matching, plus `CALLBACK_DISPATCH_SIGNATURE`, `DELEGATE_OR_CALLBACK_SIGNATURE`, and `INTERFACE_CONTRACT_SIGNATURE` protection.

### Added & Improved
- **Transitive Barrel Re-Export & Import Alias Resolution (`src/file-parser.mjs`, `src/graph-builder.mjs`)**: Multi-hop resolution across JS/TS/Vue `export * from` / `export { a } from`, Rust `pub mod` / `pub use`, Python `__init__.py`, and `import { orig as alias }` bindings.
- **Container-Scoped & ES2022 `#private` State Ownership SSOT (`src/file-parser.mjs`, `src/graph-builder.mjs`, `src/flow-tools.mjs`)**: Isolates `Container.field` and `#private` fields per class/hierarchy while reconciling cross-file public `.prop` reads; recognizes ES2022 `#private` arrow methods and TypeScript multi-property object return types (`: Promise<{ a: T; b: U }> {`).
- **Vue / Svelte SFC `<script>` Isolation (`src/file-parser.mjs`)**: Whitespace-masks `<template>` and `<style>` blocks with 1:1 line/byte offset preservation while wiring `@click` / `v-on:` / `on:` / `onclick={...}` handlers as UI `Source`s.
- **HTTP Method-Aware Multi-Handler REST Bridges (`src/file-parser.mjs`, `src/bridge-linker.mjs`)**: Distinguishes `GET` / `POST` / `PUT` / `DELETE` / `PATCH` on identical dynamic routes and binds decorator/attribute routes (`@app.delete`, `#[get]`, `[HttpGet]`, `@GetMapping`, `#[Route]`) directly to their target handlers.
- **Non-Source Git Diff Guard & Explicit `fullScan` (`src/flow-verifier.mjs`, `src/server.mjs`)**: Introduces `scanMode` (`INCREMENTAL_GIT_DIFF` / `NON_SOURCE_DIFF_ONLY` / `FULL_WORKSPACE`) and `fullScan` / `--full` CLI flag so doc-only diffs never trigger accidental full-repo scans.
- **Per-File AST Snapshot Cache (`src/graph-builder.mjs`)**: Stat-keyed `(size, mtimeMs)` per-file snapshot cache (`16x` faster warm `forceRebuild` verification on 1,200-symbol repositories).
- **69-Assertion Adversarial Torture, Fuzzing & Contract Suite (`test/torture-suite.mjs`)**: Expanded from 50 to 69 zero-dependency assertions across 10+ language families, Svelte 5 Runes, Unity/Harmony C#, C++/CUDA, and MCP/Hook contracts.

## [0.1.0] - 2026-11-11

### Added
- **End-to-End Causality Graph & Architecture Vision Engine (`src/graph-builder.mjs`, `src/arch-vision.mjs`, `src/flow-tools.mjs`)**:
  - 3-tier architecture domain classification (`ENTRY_SURFACE`, `ORCHESTRATION_ROUTING`, `INFRA_SINK`), Top-8 `backbonePipelines` spine extraction, centrality-ranked `architecturalHubs`, transitive `blastRadius` analyzer, per-parameter `parameterFlowMatrix`, and 4-station `flow_blueprint` checklist.
  - Stat-validated `(size, mtimeMs)` workspace graph cache for sub-second read-only queries with forced rebuild freshness on verification.
- **Fault-Tolerant 10+ Language Lexer & Parser (`src/lexer.mjs`, `src/file-parser.mjs`, `src/lang-presets.mjs`)**:
  - Support for 25 file extensions across TypeScript/JS/Vue/Svelte, Rust, Go, Python, C#, Java/Kotlin/Dart, Swift, PHP, Ruby, and C/C++.
  - Lexer-state `commentlessCode` stream (immune to `"src/*"` ... `"*/dist"` glob strings) and universal string interpolation preservation across JS templates, Python multiline `f"""..."""`, Rust `r#"..."#`, C# `$@"..."`, Swift `\(ident)`, PHP `{$this->field}`, and Ruby `#{@ivar}`.
  - Local variable & receiver provenance tracking (`localVars` / `qc.isLocal`) eliminating false-positive mutations on local loop counters (`i++`) and local collection accumulators (`set.add`, `arr.push`).
- **6-Channel Cross-Language Bridge Linker (`src/bridge-linker.mjs`)**:
  - Line-accurate (`offsetToLine`) symbol attribution across `TAURI_IPC`, `RPC_SERVICE` (ConnectRPC/gRPC), `EVENT_BUS_BRIDGE`, `ELECTRON_IPC`, `HTTP_REST_API` (including dynamic route normalization `/api/memos/${id}` ⇄ `/api/memos/{memo_id}`), and `SHARED_CONFIG_BRIDGE` / `ENV_VAR_BRIDGE`.
- **9-Dimension Incremental Flow Verifier & Lifecycle Hooks (`src/flow-verifier.mjs`, `src/hook-runner.mjs`, `src/server.mjs`)**:
  - Strict separation between protected `reservedContracts` (polymorphic interface alignment, lifecycle hooks, `#[cfg]` conditional targets) and genuine `dataFlowBreaks` / `unwiredOrDeadPipes`.
  - Portable MCP Server (`stdio` JSON-RPC 2.0 + `rootUri` handshake + CLI mode) and aligned `SessionStart` / `Stop` hooks with `PLUGIN_DATA` persistence and SHA-1 state deduplication.
- **CI Matrix & 40-Assertion Adversarial Torture, Fuzzing & Contract Suite (`.github/workflows/ci.yml`, `test/torture-suite.mjs`)**:
  - Multi-OS GitHub Actions CI (`ubuntu`, `windows`, `macos` × Node `18, 20, 22`) and 40 zero-dependency assertions covering 10 languages, TypeScript/PHP promoted constructor properties, assertion guards, eval harness zoning, 8 fault-injection mutations, and Hook/MCP protocol contracts.
# Rust semantic and native runtime validation (2026-11-13)

- Add opt-in rust-analyzer call hierarchy and macro expansion evidence for full current-checkout verification, with explicit Cargo features/target and bounded process-tree cleanup.
- Map exact compiler references into the graph; preserve dynamic trait implementations as candidates and generated declarations without unique source locations as inconclusive.
- Add reproducible Windows SwitchHosts native WebView2 IPC, CodeMirror widget and Rust listener controls plus recompiled registration-deletion controls.
- Exclude generated `build-tauri` bundles from source scans.
