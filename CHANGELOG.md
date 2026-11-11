# Changelog

All notable changes to **FlowGuard** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
