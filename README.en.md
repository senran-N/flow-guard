<div align="center">

<img src="./assets/banner.svg" alt="FlowGuard Banner" width="100%" />

<br />

[![Release](https://img.shields.io/badge/release-v0.2.0-38bdf8?style=flat-square&logo=github)](https://github.com/senran-N/flow-guard/releases/tag/v0.2.0)
[![Assertions](https://img.shields.io/badge/Assertions-142%2F142%20Passing%20(69%20Torture%20%2B%2073%20Task)-34d399?style=flat-square&logo=node.js)](./test/task-benchmark-suite.mjs)
[![MCP Protocol](https://img.shields.io/badge/MCP-2024--11--05-818cf8?style=flat-square)](https://modelcontextprotocol.io)
[![Languages](https://img.shields.io/badge/Polyglot-27%20Extensions%20%7C%2011%2B%20Langs-34d399?style=flat-square)](#polyglot--cross-boundary-bridge-matrix)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0%20(Pure%20Node%20ESM)-22d3ee?style=flat-square)](./package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b?style=flat-square)](./LICENSE)

**Shared Wiring Contracts (`Blueprint ⇄ Verify`), Typed Evidenced Causality Graphs & Graph-Diff (`G_base ➔ G_curr`) Verification MCP Engine for AI Coding Agents**

[**简体中文**](./README.md) · [**English**](./README.en.md) · [**Quick Start**](#quick-start--installation) · [**MCP Tools**](#the-4-core-mcp-tools) · [**Capability Boundaries**](#capability-boundaries--static-vs-runtime-scope) · [**Benchmarks**](#real-world--task-benchmarks)

</div>

---

## Why FlowGuard?

FlowGuard helps AI coding agents maintain end-to-end visibility over **inputs, dispatch branches, state mutations, and downstream consumers** while editing local files—answering both **"what connections this task must establish"** and **"what concrete evidence proves they are wired"**:

| Core AI Wiring Problem | Typical Failure Mode | FlowGuard v0.2.0 Mechanism |
| :--- | :--- | :--- |
| **1. Implemented, Never Wired** | Exporting `newlyAddedFeature()` in an application without connecting any real runtime entry (`Source`), or computing results with no downstream consumer. | **Context-Aware Entry + Shared Wiring Plan**: Separates `library` mode (public exports are valid external contracts) from `application` mode (new exports require `reachableFromRuntimeSource` evidence or surface in `unwiredExports`). |
| **2. Updated Here, Missed Counterpart** | Adding a strategy without factory registration, updating frontend payload fields while the backend still reads legacy keys, saving config without `Load` recovery, or breaking untouched files by deleting a state reader/writer. | **Typed Evidenced Edges + `G_base ➔ G_curr` Graph Diff**: Separates `BRANCH_DISPATCH` siblings from `SEQ_CALL` sequential steps, and expands verification along graph edges to `impactedUntouchedFiles`. |
| **3. Control-Reachable, Data Ineffective** | Writing a new threshold to config & disk while `applyFilter()` still reads hardcoded `DEFAULT_THRESHOLD`, or routing production code into `sandbox/` experiments. | **3-Tier Evidence (`L1_STRUCTURAL` / `L2_DATA_FLOW` / `L3_BEHAVIORAL`)**: Verifies target fields actually flow into `consumerTarget` and blocks reverse `prod -> sandbox` dependencies. |
| **4. Broken Contracts or Band-Aids** | Deleting polymorphic hooks/`#[cfg]` targets as "dead code", or silencing warnings via dummy calls, empty `catch {}`, or `#[allow(dead_code)]`. | **Tri-State Verdicts (`SATISFIED / VIOLATED / INCONCLUSIVE`)**: Grades dead code into `CONFIRMED_SAFE_TO_DELETE` vs `NO_STATIC_CALLER_EVIDENCE` and marks dynamic/external consumers `INCONCLUSIVE`. |

---

## 6-Layer Architecture (v0.2.0)

```mermaid
flowchart LR
  subgraph L1["1. Fault-Tolerant Lexer (lexer.mjs)"]
    A1["27 Source Extensions"]
    A2["Balanced Interpolation & Parens"]
  end

  subgraph L2["2. Call-Site & Data Probes (file-parser.mjs)"]
    B1["Passed Args / Return Flow / Branch Context"]
    B2["State R/W & Constant Fallback Probes"]
    B3["IPC / REST / WebView2 / Shared Memory"]
  end

  subgraph L3["3. 8-Channel Bridge Linker (bridge-linker.mjs)"]
    C1["TAURI / ELECTRON / WEBVIEW2_IPC"]
    C2["SHARED_MEMORY_IPC / EVENT_BUS"]
    C3["RPC / HTTP_REST / CONFIG + Payload Keys"]
  end

  subgraph L4["4. Typed Causality Graph (graph-builder.mjs)"]
    D1["7 Typed Edge Kinds + Line & Confidence"]
    D2["Application vs Library Dual Reachability"]
    D3["Field-Level Save ⇄ Load Symmetry"]
  end

  subgraph L5["5. Graph-Diff Engine (graph-diff.mjs)"]
    E1["SessionStart Snapshot or --base Git Ref"]
    E2["New vs Pre-Existing Broken Bridges"]
    E3["Expanded Scope (impactedUntouchedFiles)"]
  end

  subgraph L6["6. Tri-State Contract Verifier (wiring-contract + flow-verifier)"]
    F1["Shared flow_blueprint ⇄ flow_verify Plan"]
    F2["L1 Structural / L2 Data-Flow / L3 Behavioral"]
    F3["SATISFIED / VIOLATED / INCONCLUSIVE Report"]
  end

  L1 --> L2 --> L3 --> L4 --> L5 --> L6
```

---

## The 4 Core MCP Tools

FlowGuard exposes 4 cohesive tools over Model Context Protocol (`stdio` JSON-RPC 2.0, zero external dependencies):

1. **`flow_overview`** — **Global Architecture Vision**: Profiles `workspaceProfile` (`application` / `library` / `hybrid`), maps `ENTRY_SURFACE`, `ORCHESTRATION_ROUTING`, and `INFRA_SINK` domains, extracts Top 8 `backbonePipelines` and `architecturalHubs`, and inventories `stateOwnership` (SSOT) + `extensionAndReserveCatalog`.
2. **`flow_trace`** — **Evidenced Relation & Impact Tracer**: Classifies edges into `CONTAINS`, `SEQ_CALL`, `BRANCH_DISPATCH`, `REGISTRATION`, `STATE_RW`, `IMPLEMENTS`, and `PROTOCOL_BRIDGE` with `file:line`, `passedArgs`, `returnFlow`, and `confidence` (retaining `candidates` on `AMBIGUOUS` matches). Strictly separates `siblingBranchesToCheck` from `sequentialStepsInCaller`, and finds reusable code via normalized lexical shingle Jaccard similarity (`LEXICAL_SHINGLE_JACCARD`).
3. **`flow_blueprint`** — **Shared Task Wiring Plan Generator**: Given a reference module (plus optional `targetSymbol`, `targetField`, `consumerTarget`, `requirePersistence`), generates a 4-station checklist and persists an active `wiringPlan` (`obligations` + `ambiguitiesToConfirm`) consumed directly by `flow_verify`.
4. **`flow_verify`** — **Graph-Diff & Tri-State Contract Verifier**: Evaluates the active `wiringPlan` and `G_base ➔ G_curr` diff (against `SessionStart` snapshot or `baseRef` / `--base <git-ref>`), leading with `SATISFIED / VIOLATED / INCONCLUSIVE` obligation counts, L1/L2/L3 evidence tiers (with optional `runTestsCommand`), `impactedUntouchedFiles`, and evidence-graded dead-code classification (`CONFIRMED_SAFE_TO_DELETE` vs `NO_STATIC_CALLER_EVIDENCE`).

---

## Capability Boundaries & Static vs. Runtime Scope

- **Lexical, Import & Convention Inference**: Call edges and cross-language bridges are inferred from fault-tolerant lexical analysis, import/re-export resolution, receiver hints, and naming conventions. Under complex overloading, dynamic reflection, or multi-service identically named RPC methods, FlowGuard marks edges `AMBIGUOUS` with `candidates` and reports `INCONCLUSIVE` rather than guessing.
- **Normalized Lexical Shingle Similarity**: `LEXICAL_SHINGLE_JACCARD` compares normalized token/character shingles after stripping comments and literals—useful for surfacing likely clones and reusable helpers, not formal AST semantic equivalence.
- **Complementary to Runtime Tests & Probes**: In systems involving C++/CUDA kernels, thread synchronization, native resource/shared-memory lifetimes, or numerical accuracy, static L1/L2 checks verify structural and field-level wiring while **L3 behavioral correctness still requires unit/integration tests and runtime probes** (linkable via `runTestsCommand`).
- **Smart Hook Policy**: The `Stop` hook blocks strictly on **newly introduced `VIOLATED` contracts/breaks**—never on `INCONCLUSIVE` items or `preExistingBrokenBridges`—and supports `FLOWGUARD_MODE=advisory`.

---

## Polyglot & Cross-Boundary Bridge Matrix

- **27 Extensions across 11+ Language Families**: TypeScript/JS/Vue/Svelte (including Svelte 5 Runes), Rust, Go, Python, C#, Java/Kotlin/Dart, Swift, PHP, Ruby, and C/C++/CUDA (`.c`, `.cpp`, `.cc`, `.h`, `.hpp`, `.cu`, `.cuh`).
- **8 Cross-Language / Cross-Process Bridge Channels**:
  1. `TAURI_IPC` (`invoke` ⇄ `#[tauri::command]` + payload field checks)
  2. `ELECTRON_IPC` (`ipcRenderer` ⇄ `ipcMain`)
  3. `WEBVIEW2_IPC` (`window.chrome.webview` ⇄ C++/C# `WebMessageReceived / PostWebMessageAsJson`)
  4. `SHARED_MEMORY_IPC` (Win32 `CreateFileMapping` / POSIX `shm_open` ⇄ Python `mmap / shared_memory`)
  5. `RPC_SERVICE` (ConnectRPC / gRPC with service-prefix disambiguation & candidate retention)
  6. `EVENT_BUS_BRIDGE` (`emit` / Socket.io `ws:*` ⇄ `listen` / `on`)
  7. `HTTP_REST_API` (method-aware dynamic routes + request payload field checks)
  8. `SHARED_CONFIG_BRIDGE` / `ENV_VAR_BRIDGE`

---

## Real-World & Task Benchmarks

- **Real-Task Incomplete-Wiring Benchmark (`test/task-benchmark-suite.mjs`, 73 assertions)**:
  - **8 Incomplete-Wiring Tasks (`8 / 8 = 100%` Recall)**: Unwired exported app feature, config threshold saved while filter still reads legacy constant, unregistered strategy mode, frontend-backend payload field drift, save without load recovery, missed Linux platform branch, writer deletion stranding untouched reader, and reader deletion turning untouched writer into dead state.
  - **6 Legal Counterexamples (`0 / 6 = 0%` False Violations)**: Public library exports, `#[cfg]` platform-specific implementations, one-way events / dynamic plugins (`INCONCLUSIVE`), write-only telemetry sinks, C++/CUDA + WebView2 + Shared Memory closed loop, and pre-existing broken bridges isolated from clean diffs.
- **Adversarial Torture Suite (`test/torture-suite.mjs`, 69 assertions)** & **33 Open-Source Repositories (130,981 symbols across `llama.cpp`, `clash-verge-rev`, `memos`, `axum`, `BepInEx`, `bits-ui`, etc.)**: `142 / 142` automated assertions passing in ~2.5s.

---

## Quick Start & Installation

```bash
# Antigravity / Gemini Plugin
git clone https://github.com/senran-N/flow-guard.git ~/.gemini/config/plugins/flow-guard

# CLI Usage
node src/server.mjs --cli overview /path/to/your-repo
node src/server.mjs --cli trace /path/to/your-repo TargetSymbol
node src/server.mjs --cli blueprint /path/to/your-repo ReferenceSymbol --target NewSymbol --field threshold --consumer applyFilter --persist
node src/server.mjs --cli verify /path/to/your-repo --base HEAD~1
node src/server.mjs --cli verify /path/to/your-repo --full

# Run 142 assertions (69 torture + 73 task benchmark) & self-verification
npm test
npm run verify:self
```

---

## License

Released under the [MIT License](./LICENSE). Copyright © 2026 [senran-N](https://github.com/senran-N).
