<div align="center">

<img src="./assets/banner.svg" alt="FlowGuard Banner" width="100%" />

<br />

[![Release](https://img.shields.io/badge/release-v0.2.0-38bdf8?style=flat-square&logo=github)](https://github.com/senran-N/flow-guard/releases/tag/v0.2.0)
[![Torture & Task Suites](https://img.shields.io/badge/Assertions-142%2F142%20Passing%20(69%20Torture%20%2B%2073%20Task)-34d399?style=flat-square&logo=node.js)](./test/task-benchmark-suite.mjs)
[![MCP Protocol](https://img.shields.io/badge/MCP-2024--11--05-818cf8?style=flat-square)](https://modelcontextprotocol.io)
[![Languages](https://img.shields.io/badge/Polyglot-27%20Extensions%20%7C%2011%2B%20Langs-34d399?style=flat-square)](#-%E5%A4%9A%E8%AF%AD%E8%A8%80%E4%B8%8E%E8%B7%A8%E8%BE%B9%E7%95%8C%E6%A1%A5%E6%8E%A5%E7%9F%A9%E9%98%B5)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0%20(Pure%20Node%20ESM)-22d3ee?style=flat-square)](./package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b?style=flat-square)](./LICENSE)

**面向 AI 编码智能体（Coding Agents）的端到端接线规划（`Blueprint ⇄ Verify`）、有类型因果关系图与增量链路差异（`G_base ➔ G_curr`）核验引擎**

[**简体中文**](./README.md) · [**English**](./README.en.md) · [**快速开始**](#-快速安装与接入) · [**MCP 工具矩阵**](#-四大核心-mcp-工具) · [**能力边界**](#-%E8%83%BD%E5%8A%9B%E8%BE%B9%E7%95%8C%E4%B8%8E%E5%B7%A5%E7%A8%8B%E5%AE%9A%E4%BD%8D) · [**实战基准**](#-实战基准测试)

</div>

---

## 💡 为什么需要 FlowGuard？

FlowGuard 的核心目标，是让 AI 在修改局部代码时仍能把握整个功能的**输入、分流、状态与输出**，明确**“本次任务应该接成什么样，以及凭什么证据判断已经接完整”**，针对性解决四类高频 AI 编码漏接故障：

| 核心工程问题 | 典型故障现场 | FlowGuard v0.2.0 机制 |
| :--- | :--- | :--- |
| **1. 写了却没接上** | 新增实现并加了 `export`，但应用内没有任何真实运行时入口（UI/IPC/路由/定时循环）调用，或计算结果没有真实消费者。 | **场景化入口判定 + 接线契约**：区分 `library`（导出即外部契约）与 `application`（新增导出仍需 `reachableFromRuntimeSource` 真实入口证据），未接入导出单独归入 `unwiredExports`。 |
| **2. 改了一处却漏了关联处** | 新增模式忘记工厂注册、前端协议改了字段后端仍读旧字段、配置能 `Save` 重启却漏了 `Load` 恢复、重构删了读取方导致未改动文件里的写入变成死路。 | **有类型证据边 + `G_base ➔ G_curr` 图差异**：严格区分条件分支（`BRANCH_DISPATCH`）与顺序步骤（`SEQ_CALL`），并沿依赖边扩展检查受波及的未修改文件（`impactedUntouchedFiles`）。 |
| **3. 控制可达但目标数据未生效** | 配置项已写入并落盘，但下游核心过滤函数仍硬编码读取旧常量 `DEFAULT_THRESHOLD`；或生产入口误连了 `sandbox/` 实验实现。 | **三层证据分离（`L1_STRUCTURAL` / `L2_DATA_FLOW` / `L3_BEHAVIORAL`）**：不仅查控制流可达，更追踪目标字段是否真正流向目标消费者（`consumerTarget`），并隔离沙盒反向引用。 |
| **4. 破坏架构契约或用创可贴掩盖** | 把框架钩子、多态签名对齐或平台条件实现当“死代码”误删；或为了消警添加虚假调用、空 `catch {}`、`#[allow(dead_code)]`。 | **三态结论（`SATISFIED / VIOLATED / INCONCLUSIVE`）+ 死代码证据分级**：区分 `CONFIRMED_SAFE_TO_DELETE`（私有零水流废管）与 `NO_STATIC_CALLER_EVIDENCE`（待确认导出），动态/外部消费者诚实标记为 `INCONCLUSIVE`。 |

---

## 🏗️ 引擎六层架构（v0.2.0）

```mermaid
flowchart LR
  subgraph L1["1. 容错词法层 (lexer.mjs)"]
    A1["27 种源码后缀扫描"]
    A2["字符串插值与平衡括号定界"]
  end

  subgraph L2["2. 符号与调用点证据提取 (file-parser.mjs)"]
    B1["实参传递 / 返回值流向 / 分支上下文"]
    B2["状态字段读写 & 大写常量引用探针"]
    B3["IPC / REST / WebView2 / 共享内存探针"]
  end

  subgraph L3["3. 八通道跨语言桥接器 (bridge-linker.mjs)"]
    C1["TAURI / ELECTRON / WEBVIEW2_IPC"]
    C2["SHARED_MEMORY_IPC / EVENT_BUS"]
    C3["RPC / HTTP_REST / CONFIG + 载荷字段比对"]
  end

  subgraph L4["4. 有类型因果图 (graph-builder.mjs)"]
    D1["7 类有类型边 + 行号与解析置信度"]
    D2["application vs library 双层可达性闭包"]
    D3["字段级成对生命周期 (Save ⇄ Load) 对齐"]
  end

  subgraph L5["5. 基线图差异 (graph-diff.mjs)"]
    E1["SessionStart 快照或 --base Git 引用重建"]
    E2["新增断链 vs 历史断链隔离"]
    E3["受波及未修改文件 (impactedUntouchedFiles)"]
  end

  subgraph L6["6. 共享契约三态核验 (wiring-contract + flow-verifier)"]
    F1["flow_blueprint ⇄ flow_verify 共享接入清单"]
    F2["L1 结构 / L2 数据流 / L3 行为三层证据"]
    F3["SATISFIED / VIOLATED / INCONCLUSIVE 三态报告"]
  end

  L1 --> L2 --> L3 --> L4 --> L5 --> L6
```

---

## 🧰 四大核心 MCP 工具

FlowGuard 通过标准 Model Context Protocol (`stdio` JSON-RPC 2.0，零外部依赖) 向 AI 智能体暴露 4 个协同工具：

### 1. `flow_overview` — 全局架构视野与主干水路测绘
扫描工作区并输出宏观架构蓝图：
- **`workspaceProfile`**：自动识别工程模式（`application` / `library` / `hybrid`）、包导出入口与动态插件加载特征。
- **`architectureDomains` & `backbonePipelines`**：划分 `ENTRY_SURFACE`、`ORCHESTRATION_ROUTING`、`INFRA_SINK`，提取核心端到端主干水路与高中心度枢纽（`architecturalHubs`）。
- **`stateOwnership` (SSOT) & `extensionAndReserveCatalog`**：全局状态字段唯一写入者/读取者映射与多态扩展契约目录。

### 2. `flow_trace` — 改代码前必调：带证据关系分类与影响面透视
输入任意函数名、类名、文件名或状态字段，返回带源码行号与解析依据的因果链路：
- **7 类有类型关系边（`evidencedRelations`）**：明确区分 `CONTAINS`（成员归属）、`SEQ_CALL`（顺序调用步骤）、`BRANCH_DISPATCH`（条件分支派发）、`REGISTRATION`（工厂/路由注册）、`STATE_RW`（状态读写）、`IMPLEMENTS`（接口实现）与 `PROTOCOL_BRIDGE`（跨进程协议桥接），模糊匹配保留 `AMBIGUOUS` 候选集（`candidates`）。
- **并列支流 vs 顺序职责分离**：将同一父函数下的条件分支兄弟（`siblingBranchesToCheck`）与顺序执行步骤（`sequentialStepsInCaller`，如 `authenticate -> validate -> save`）严格分开，避免误导同步修改。
- **`waterFlowStatus` & `blastRadius`**：区分 `connectedToRuntimeEntry`（真实运行入口可达）与 `connectedToAnySource`，评估传递性影响半径与入参消费矩阵（`parameterFlowMatrix`）。
- **`reusableSimilarSymbols`**：基于**归一化词法 Shingle Jaccard 相似度（`LEXICAL_SHINGLE_JACCARD`）**检索仓内近似实现，提供复用线索。

### 3. `flow_blueprint` — 接新功能前必调：生成与验收共享的任务接入清单
指定参考标杆模块（并可选传入 `targetSymbol`、`targetField`、`consumerTarget`、`requirePersistence`），生成四站式施工单**并持久化共享接线计划（`wiringPlan`）**：
1. **Station 1 — 构造与注册表挂载**（`REGISTRATION`）
2. **Station 2 — 上游真实入口或分流路由**（`L1_STRUCTURAL`）
3. **Station 3 — 成对对称生命周期契约**（`Save ⇄ Load`、`Serialize ⇄ Deserialize`、`Send ⇄ Receive`）
4. **Station 4 — 下游目标消费者生效与终端落点**（`L2_DATA_FLOW`）
- 每项 `obligations` 均记录**位置、原因、期望建立的关系、来源依据与核验方式**；无法静态确定的契约（如外部插件订阅或未指定的持久化要求）单独列入 `ambiguitiesToConfirm`。

### 4. `flow_verify` — 交卷前必调：共享清单 + 图差异三态核验
围绕当前活跃的 `wiringPlan` 与 `G_base ➔ G_curr` 链路差异（支持 `SessionStart` 基线快照或 `baseRef` / `--base <git-ref>`）执行核验：
- **首屏三态结论（`headlineSummary` & `wiringReport`）**：优先汇报 `本次 N 项接入要求：X 项满足 (SATISFIED)，Y 项违反 (VIOLATED)，Z 项待确认 (INCONCLUSIVE)`，杜绝“没报错就等于已接通”。
- **三层证据核验**：
  - **`L1_STRUCTURAL`**：入口可达、工厂注册、跨语言桥接对端、成对生命周期闭合。
  - **`L2_DATA_FLOW`**：目标字段是否从配置/协议真正传入 `consumerTarget`（拦截“配置已存盘但过滤计算仍读旧常量”与“前后端协议字段漂移”）。
  - **`L3_BEHAVIORAL`**：支持可选传入 `runTestsCommand` 执行测试/探针命令获取行为级证据；未执行运行时测试时诚实标记为 `INCONCLUSIVE`。
- **增量链路差异（`flowDiff` & `impactedUntouchedFiles`）**：精准区分本次引入的断链（`newlyBrokenBridges`、`newlyWriteOnlyStates`、`newlyWriterlessStateReads`）与历史遗留问题（`preExistingBrokenBridges`），并覆盖未修改文件中的受波及死路。
- **死代码证据分级**：将 `unwiredOrDeadPipes`（`CONFIRMED_SAFE_TO_DELETE`，模块内私有零调用废管）与 `unwiredExports`（`NO_STATIC_CALLER_EVIDENCE`，缺少静态入口证据的导出符号）严格分开，修复建议指向缺失的业务连接而非诱导添加形式调用。

---

## ⚖️ 能力边界与工程定位

为了让团队与 AI 智能体建立准确预期，FlowGuard 明确划分静态线索核验与运行时验证的边界：

1. **名称、导入与词法结构推断**：调用关系与跨语言桥接主要通过容错词法扫描、显式 `import/re-export` 解析、类型/接收者线索与命名约定推断。遇到复杂函数重载、动态反射派发或多服务同名 RPC 方法时，FlowGuard 会将边置信度标为 `AMBIGUOUS` 并保留 `candidates` 候选集，返回 `INCONCLUSIVE` 供回到源码核实，而非武断选边。
2. **归一化词法相似度而非完整语义 AST**：克隆与复用线索采用 `LEXICAL_SHINGLE_JACCARD`（剥离注释、归一化字面量后的词法 Shingle Jaccard 比较），适合发现结构雷同的疑似重复代码，不等同于编译器级语义等价证明。
3. **静态水路核验与运行时测试互补**：在涉及 C++/CUDA、多线程同步、原生句柄/共享内存资源生命周期、复杂指针别名或数值计算正确性的系统（如实时推理或原生桌面引擎）中，静态结构与字段级数据流只能证明“接线与传递关系已建立”，**`L3_BEHAVIORAL` 行为正确性仍必须结合现有单元测试、集成测试与运行时链路探针（可通过 `runTestsCommand` 联动）共同验证**。
4. **智能体钩子策略**：`Stop` 钩子仅对**本次新增且证据确凿的 `VIOLATED` 契约/断链**进行阻断，绝不因 `INCONCLUSIVE`（动态插件、单向事件等）或历史遗留断链阻断提交；也可通过环境变量 `FLOWGUARD_MODE=advisory` 设为纯提示模式。

---

## 🌐 多语言与跨边界桥接矩阵

### 支持的 27 种源码扩展名（11+ 主流语言家族）
- **TypeScript / JavaScript / 前端框架**：`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.vue`, `.svelte`（含 Svelte 5 Runes 与 Vue SFC）
- **Rust**：`.rs`（支持 `#[tauri::command]`、`#[specta::specta]`、内联 `#[cfg(test)]` 隔离、原始字符串 `r#"..."#`）
- **Go**：`.go`（支持 Receiver 方法、`interface` 契约提取、自动过滤 `*.pb.go` / `*.connect.go` 生成代码）
- **Python**：`.py`（支持 FastAPI `APIRouter`、`@*.register*` 动态插件、`mmap` / `shared_memory` 探针、`f"""..."""` 插值）
- **C#**：`.cs`（支持 `unsafe`、`$@"..."` 插值、`ref`/`out`、WebView2 `CoreWebView2` 宿主桥接与 Unity/Harmony 生命周期）
- **Java / Kotlin / Dart**：`.java`, `.kt`, `.dart`（支持 Spring/Retrofit 注解、KMP 源码集隔离、Dart 构造器属性提升与 `package:` 导入解析）
- **Swift / PHP / Ruby**：`.swift`, `.php`, `.rb`（支持 Swift `extension`/`protocol`、PHP 8 属性提升与 Laravel 路由、Ruby `@ivar`/`@@class_var`）
- **C / C++ / CUDA**：`.c`, `.cpp`, `.cc`, `.h`, `.hpp`, `.cu`, `.cuh`（支持多花括号初始化、非 `const` 引用出参、CUDA/原子原语、`ICoreWebView2`、`CreateFileMapping` / `shm_open` 共享内存与 `cpp-httplib` 路由）

### 自动缝合的 8 类跨语言/跨进程桥接通道
1. **`TAURI_IPC`**：前端 `invoke("cmd", { payload })` ⇄ Rust `#[tauri::command] fn cmd`（含载荷字段对齐校验）
2. **`ELECTRON_IPC`**：`ipcRenderer.invoke/send` ⇄ `ipcMain.handle/on`
3. **`WEBVIEW2_IPC`**：前端 `window.chrome.webview.postMessage / addEventListener("message")` ⇄ C++/C# `WebMessageReceived / PostWebMessageAsJson / PostWebMessageAsString`
4. **`SHARED_MEMORY_IPC`**：C++/Win32 `CreateFileMapping / OpenFileMapping`、POSIX `shm_open` ⇄ Python `mmap(..., tagname=) / shared_memory.SharedMemory` 跨进程命名共享内存段关联
5. **`RPC_SERVICE`**：ConnectRPC / gRPC `client.method()` ⇄ Go / Rust / Java RPC Handler（支持客户端服务名前缀消歧与多候选保留）
6. **`EVENT_BUS_BRIDGE`**：跨进程事件总线 `emit` / Socket.io `ws:*` ⇄ `listen` / `on`
7. **`HTTP_REST_API`**：前端 `fetch/axios("/api/v1/...")` ⇄ 后端参数化路由控制器（方法感知 + 请求体字段比对）
8. **`SHARED_CONFIG_BRIDGE` / `ENV_VAR_BRIDGE`**：跨语言共享配置文件与环境变量读写闭环

---

## 📊 实战基准测试

### 1. 真实开发任务“漏接检测 vs 合法反例”基准套件（`test/task-benchmark-suite.mjs`）
模拟 8 类典型 AI 半截接入故障与 6 类合法工程反例（73 项断言）：
- **8 类真实漏接任务（检出率 `8 / 8 = 100%`）**：应用内新增导出未接入口（`TASK-01`）、阈值已写入配置但过滤计算仍读旧常量（`TASK-02`）、新增策略模式漏挂工厂注册表（`TASK-03`）、前端协议载荷更新后端仍读旧字段（`TASK-04`）、配置可保存但重启漏恢复（`TASK-05`）、Win32 分支已接通但 Linux 平台分支遗漏（`TASK-06`）、重构后旧状态写入被删导致未修改文件读取端悬空（`TASK-07`）、删除唯一读取端导致未修改文件写入端变死水（`TASK-08`）。
- **6 类合法反例（误报率 `0 / 6 = 0%`）**：`library` 包公开导出 API（`LEGAL-01`）、`#[cfg]` 按平台编译实现（`LEGAL-02`）、单向事件/动态插件扩展标为 `INCONCLUSIVE` 不误报 `VIOLATED`（`LEGAL-03`）、只写遥测/审计输出豁免（`LEGAL-04`）、C++/CUDA + WebView2 + 共享内存闭环（`LEGAL-05`）、历史遗留断链与本次干净改动隔离（`LEGAL-06`）。

### 2. 33 个开源生产仓库与对抗性语法酷刑基准（130,981 符号 + 69 项断言）

| 仓库类型 | 代表项目 | 语言栈 | 符号规模 | 水源可达率 | 跨界桥接缝合 | 实战表现 |
| :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| **万级 C++/CUDA 引擎** | **ggml-org/llama.cpp** | C++ / CUDA / Python / Svelte | 29,279 | **99.8%** | `48` 条 (`HTTP_REST` + `ENV_VAR`, 0 断链) | 2.9 万符号仅报 2 条 `IGNORED_PURE_CALL`，命中 `solve_tri.cu` 漏写 `GGML_ASSERT` 真缺陷 |
| **跨进程桌面端全栈** | **clash-verge-rev** / **pot-desktop** / **SwitchHosts** / **bruno** | Rust+TS (Tauri) / Electron+React | 16,660 | **97.4% – 99.6%** | `325` 条 (`TAURI_IPC` / `ELECTRON_IPC`) | 321 条桥接连通，抓出 `bruno` 4 条真实断头 Electron IPC |
| **Web 全栈生产系统** | **usememos/memos** / **koel** / **uptime-kuma** / **fastapi-template** / **pocketbase** | Go / PHP / Python / Node + React / Vue / Svelte | 18,378 | **99.1% – 99.9%** | `193` 条 (`RPC` / `REST` / `Socket.io`, 0 断链) | 方法感知 REST 路由、Laravel/FastAPI 子路由与 Socket.io 自动缝合 |
| **特种语法与多语言核心库 (23 仓)** | `bits-ui`, `BepInEx`, `ripgrep`, `axum`, `zod`, `fastapi`, `gin`, `okhttp`, `Alamofire`, `dio`, `sidekiq`, `fmt`, `jq` 等 | Svelte 5 / C# / Rust / Go / Kotlin / Swift / Dart / Ruby / C | 66,664 | **99.7% – 100%** | 导出 API、多态契约与 Harmony 钩子识别 | 22 仓 `PASS`，抓出 `Dapper` 3 处死局部计算 |
| **对抗性酷刑 + 真实任务套件** | **`torture-suite` + `task-benchmark-suite`** | 11+ 语言极端语法 + 8 类漏接任务 + 6 类合法反例 | **142 项断言** | **100% 召回 & 0 误报** | 8 通道 + 图差异 + 三态契约 | **~ 2.5 s** |

---

## 🚀 快速安装与接入

### 方式一：作为 Antigravity / Gemini 插件安装（推荐）

```bash
git clone https://github.com/senran-N/flow-guard.git ~/.gemini/config/plugins/flow-guard
```

### 方式二：接入 Claude Code / Cursor / Windsurf / 任意 MCP 客户端

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

### 方式三：命令行独立运行（CLI 模式）

```bash
# 1. 全局架构视野与工程模式识别
node src/server.mjs --cli overview /path/to/your-repo

# 2. 单符号有类型关系边、并列分支与影响面透视
node src/server.mjs --cli trace /path/to/your-repo YourFunctionOrClassName

# 3. 生成并保存与 verify 共享的任务接入清单（支持附加目标符号/字段/消费者参数）
node src/server.mjs --cli blueprint /path/to/your-repo ReferenceModule --target NewModule --field threshold --consumer applyFilter --persist

# 4. 基于基线图差异与共享接入清单执行三态核验（支持 --base 指定 Git 基线或 --full 全量扫描）
node src/server.mjs --cli verify /path/to/your-repo --base HEAD~1
node src/server.mjs --cli verify /path/to/your-repo --full
```

---

## 🧪 运行测试与自举校验

```bash
# 运行 69 项对抗性语法酷刑测试 + 73 项真实任务漏接/合法反例基准测试（共 142 项断言）
npm test

# 使用 FlowGuard 对自身代码库执行自举核验
npm run verify:self
```

---

## 📂 仓库目录结构

```text
flow-guard/
├── assets/                        # 仓库横幅与图标资产
├── rules/AGENTS.md                # 面向 AI 智能体的端到端水路开发准则
├── skills/flow-engineering/       # 蓝图规划、链路透视与三态核验标准作业流程 (SOP)
├── src/
│   ├── server.mjs                 # MCP Server (stdio JSON-RPC 2.0) & CLI 入口 (v0.2.0)
│   ├── lexer.mjs                  # 多语言容错词法扫描器（保留全语言字符串插值与平衡括号）
│   ├── lang-presets.mjs           # 27 种源码后缀规则与运行时真实入口启发式配置
│   ├── file-parser.mjs            # 符号提取、实参/返回值/分支探针、WebView2/共享内存/IPC 提取
│   ├── fingerprint.mjs            # 归一化词法 Shingle 指纹、成对生命周期识别与预留契约分类
│   ├── bridge-linker.mjs          # 8 通道跨语言桥接器（含载荷字段对齐与多候选模糊保留）
│   ├── graph-builder.mjs          # 有类型因果图构建、application/library 双层可达性与字段生命周期校验
│   ├── graph-diff.mjs             # G_base ➔ G_curr 图差异计算、Git 基线重建与受波及未修改文件扩展
│   ├── wiring-contract.mjs        # flow_blueprint ⇄ flow_verify 共享接入清单与三层证据三态评估器
│   ├── arch-vision.mjs            # 子系统分层、主干动脉提取、爆炸半径与入参流向矩阵
│   ├── flow-tools.mjs             # flow_overview / flow_trace / flow_blueprint 实现
│   ├── flow-verifier.mjs          # flow_verify 增量图差异、三态契约报告与死代码证据分级引擎
│   └── hook-runner.mjs            # SessionStart 基线快照 & Stop 智能阻断/提示生命周期钩子
├── test/
│   ├── torture-suite.mjs          # 69 项对抗性语法酷刑、故障注入变异与 Hook/MCP 契约测试
│   └── task-benchmark-suite.mjs   # 73 项真实开发任务漏接故障与合法反例端到端基准测试
├── hooks.json                     # 插件生命周期钩子配置
├── mcp_config.json                # MCP Server 启动配置
├── plugin.json                    # 插件清单定义 (v0.2.0)
├── package.json                   # Node.js 包定义与测试脚本
├── CHANGELOG.md                   # 版本演进记录
├── CONTRIBUTING.md                # 贡献指南与自举验收规范
└── LICENSE                        # MIT 开源许可证
```

---

## 📄 开源协议

本项目基于 [MIT License](./LICENSE) 开源。Copyright © 2026 [senran-N](https://github.com/senran-N).
