<div align="center">

<img src="./assets/banner.svg" alt="FlowGuard Banner" width="100%" />

<br />

[![Release](https://img.shields.io/badge/release-v0.1.0-38bdf8?style=flat-square&logo=github)](https://github.com/senran-N/flow-guard/releases/tag/v0.1.0)
[![Torture Suite](https://img.shields.io/badge/Torture%20%26%20Fuzz%20Suite-36%2F36%20Passing-34d399?style=flat-square&logo=node.js)](./test/torture-suite.mjs)
[![MCP Protocol](https://img.shields.io/badge/MCP-2024--11--05-818cf8?style=flat-square)](https://modelcontextprotocol.io)
[![Languages](https://img.shields.io/badge/Polyglot-25%20Extensions%20%7C%2010%2B%20Langs-34d399?style=flat-square)](#polyglot--cross-boundary-bridge-matrix)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0%20(Pure%20Node%20ESM)-22d3ee?style=flat-square)](./package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b?style=flat-square)](./LICENSE)

**End-to-End Causality Flow (`Source ➔ Branch ➔ Sink`) Architecture Vision, Polyglot Bridge Linker & Incremental Flow Verifier MCP Engine for AI Coding Agents**

[**简体中文**](./README.md) · [**English**](./README.en.md) · [**Quick Start**](#quick-start--installation) · [**MCP Tools**](#the-4-core-mcp-tools) · [**Benchmarks**](#real-world-benchmarks-17-repos--19125-symbols)

</div>

---

## Why FlowGuard?

When operating in large polyglot codebases, AI coding agents relying solely on `grep` and local file reads frequently fall into three structural traps:

| AI Coding Pitfall | Typical Failure Mode | FlowGuard Solution |
| :--- | :--- | :--- |
| **1. Half-Wired Code (Broken Flow)** | Code written in isolation is wired to a superficial caller without reaching a true input `Source` or a side-effect `Sink` (persistence, network emit, UI state), or writes to state that is never read (`Write-Only Dead State`). | **`flow_blueprint` + `flow_verify`**: Generates a 4-station wiring checklist before coding and runs a 9-dimension causality flow audit before completion. |
| **2. Missed Parallel Branches** | Updating one branch or frontend call while forgetting sibling branches under the same router (`Branch`), polymorphic peers, or cross-language IPC/RPC counterparts. | **`flow_trace`**: Computes the **transitive `blastRadius`**, sibling branches, polymorphic peers, and 6-channel cross-language bridges in a single call. |
| **3. Dead Code vs. Reserved Contracts** | Leaving orphaned dead functions after refactoring—or conversely, mistakenly deleting framework lifecycle hooks, interface implementations, or `#[cfg]` conditional targets as "dead code". | **`reservedContracts` Immunity**: Strictly separates **reserved architectural contracts & polymorphic alignment parameters** from genuine **unwired dead pipes (`unwiredOrDeadPipes`)** and local `dataFlowBreaks`. |

---

## 5-Layer Causality Engine Architecture

```mermaid
flowchart LR
  subgraph L1["1. Fault-Tolerant Lexer (lexer.mjs)"]
    A1["25 Source Extensions"]
    A2["String Interpolation Preserver (Template / f-string / Raw)"]
    A3["Balanced JSX / Generics / Nested Parens"]
  end

  subgraph L2["2. Symbol & Boundary Extractor (file-parser.mjs)"]
    B1["Functions / Classes / Interfaces / State Fields"]
    B2["Line-Accurate (offsetToLine) Boundary Probes"]
    B3["Dead Local Vars & Ignored Return Detection"]
  end

  subgraph L3["3. 6-Channel Polyglot Bridge Linker (bridge-linker.mjs)"]
    C1["TAURI_IPC (Rust command ⇄ Frontend invoke)"]
    C2["RPC_SERVICE (ConnectRPC / gRPC)"]
    C3["EVENT_BUS (emit ⇄ listen Custom Topics)"]
    C4["ELECTRON_IPC / HTTP_REST / CONFIG"]
  end

  subgraph L4["4. Causality Graph & Arch Vision (graph-builder + arch-vision)"]
    D1["3-Tier Topology (Entry ➔ Orchestration ➔ Sink)"]
    D2["Forward & Reverse BFS Transitive Reachability"]
    D3["Top 8 Backbone Spines & Centrality Hubs"]
  end

  subgraph L5["5. 9-Dimension Flow Verifier (flow-verifier.mjs)"]
    E1["Broken Flows / Dead Pipes / Write-Only States"]
    E2["Reserved Contracts (reservedContracts) Immunity"]
    E3["Symmetric Lifecycle Pair (Save/Load) Checks"]
  end

  L1 --> L2 --> L3 --> L4 --> L5
```

---

## The 4 Core MCP Tools

FlowGuard exposes 4 high-signal tools over the standard Model Context Protocol (`stdio` JSON-RPC 2.0, zero external dependencies):

1. **`flow_overview`** — **Global Architecture Vision**: Maps the repository into `ENTRY_SURFACE`, `ORCHESTRATION_ROUTING`, and `INFRA_SINK` domains, extracts the Top 8 end-to-end `backbonePipelines`, ranks `architecturalHubs`, inventories `extensionAndReserveCatalog`, and identifies Single Source of Truth (`stateOwnership`) writers.
2. **`flow_trace`** — **Pre-Edit Impact & Causality Tracer**: Given any function, class, file, or state field, returns its `blastRadius`, per-parameter consumption matrix (`parameterFlowMatrix`), upstream sources, downstream sinks, sibling branches, polymorphic peers, and AST-similar reusable functions.
3. **`flow_blueprint`** — **4-Station Wiring Blueprint**: Given a reference module, generates an actionable checklist covering (1) Container/Registry mounting, (2) Upstream dispatcher routing, (3) Symmetric lifecycle pairs (`Save/Load`, `Send/Receive`), and (4) Downstream sinks.
4. **`flow_verify`** — **9-Dimension Incremental Flow Verifier**: Audits broken cross-language bridges, sandbox reverse-dependency leaks, local data-flow breaks, unwired dead pipes, reserved contracts, write-only dead states, asymmetric lifecycles, structural clones, and error-swallowing anti-patterns.

---

## Polyglot & Cross-Boundary Bridge Matrix

- **25 File Extensions across 10+ Language Families**:
  - **TypeScript / JavaScript / Frontend**: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.vue`, `.svelte`
  - **Rust**: `.rs` (`#[tauri::command]`, `#[command]`, `#[specta::specta]`, raw strings `r#"..."#`, macro interpolation)
  - **Go**: `.go` (receiver methods, `interface` contracts, auto-filtering generated `*.pb.go` / `*.connect.go`)
  - **Python**: `.py` (decorators, indentation block bounds, `f"""..."""` multiline f-strings)
  - **C#**: `.cs` (`$@"..."` interpolated verbatim strings, Unity/Harmony hooks)
  - **Java / Kotlin / Dart**: `.java`, `.kt`, `.dart`
  - **Swift**: `.swift` (`extension`, `init`, external/internal labels, `\(ident)` interpolation)
  - **PHP**: `.php` (PHP 8 promoted constructor properties, `#[Route]` / `Route::get`, `$this->field` state tracking, `{$this->field}` interpolation)
  - **Ruby**: `.rb` (`def ... rescue ... end` block scoping, `@ivar` state tracking, `#{ident}` interpolation)
  - **C / C++**: `.c`, `.cpp`, `.cc`, `.h`, `.hpp`
- **6 Cross-Language Bridge Channels**: `TAURI_IPC`, `RPC_SERVICE` (ConnectRPC/gRPC), `EVENT_BUS_BRIDGE`, `ELECTRON_IPC`, `HTTP_REST_API` (including dynamic route parameter normalization `/api/memos/${id}` ⇄ `/api/memos/{id}`), and `SHARED_CONFIG_BRIDGE` / `ENV_VAR_BRIDGE`.

---

## Real-World Benchmarks (17 Repos · 19,125 Symbols)

| Category | Repositories | Stack | Symbols | Source Reachability | Bridges Linked | Scan Time |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| **Full-Stack Production** | **clash-verge-rev** | Rust + TS/React (Tauri) | 1,750 | **97.4%** | `313` | ~420 ms |
| **Full-Stack Production** | **usememos/memos** | Go + TS/React (ConnectRPC) | 2,135 | **99.5%** | `110` | ~480 ms |
| **Full-Stack Production** | **Flotsam Launcher** | C# + Rust + Vue 3 (Tauri) | 1,093 | **98.9%** | `31` | ~260 ms |
| **Open-Source Libraries (14)** | `ripgrep`, `fd`, `zod`, `pinia`, `fastapi`, `httpx`, `gin`, `cobra`, `Polly`, `serilog`, `gson`, `retrofit`, `fmt`, `axum` | Rust / TS / Python / Go / C# / Java / C++ | 14,147 | **99.7% – 100%** | Full export & trait coverage | 40 – 310 ms |
| **Adversarial Torture & Contract Suite** | **`test/torture-suite.mjs`** | 10-Lang Torture + 8 Fault Mutations + Hook/MCP Contracts | 36 Assertions | **100% Precision & Recall** | All channels + lifecycle hooks | **< 1 s** |

---

## Quick Start & Installation

### 1. Antigravity / Gemini Plugin

```bash
git clone https://github.com/senran-N/flow-guard.git ~/.gemini/config/plugins/flow-guard
```

### 2. Claude Code / Cursor / Windsurf / Any MCP Client

```json
{
  "mcpServers": {
    "flow-guard": {
      "command": "node",
      "args": ["/path/to/flow-guard/src/server.mjs"]
    }
  }
}
```

### 3. Standalone CLI & Self-Verification

```bash
node src/server.mjs --cli overview /path/to/your-repo
node src/server.mjs --cli trace /path/to/your-repo TargetSymbol
node src/server.mjs --cli blueprint /path/to/your-repo ReferenceSymbol
node src/server.mjs --cli verify /path/to/your-repo

# Run the 10-language adversarial torture, mutation fuzzing & contract suite (36 assertions)
npm test
npm run verify:self
```

---

## License

Released under the [MIT License](./LICENSE). Copyright © 2026 [senran-N](https://github.com/senran-N).
