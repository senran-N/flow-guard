# Changelog

All notable changes to **FlowGuard** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **CI Matrix & 36-Assertion Adversarial Torture, Fuzzing & Contract Suite (`.github/workflows/ci.yml`, `test/torture-suite.mjs`)**:
  - Multi-OS GitHub Actions CI (`ubuntu`, `windows`, `macos` × Node `18, 20, 22`) and 36 zero-dependency assertions covering 10 languages, 8 fault-injection mutations, and Hook/MCP protocol contracts.
