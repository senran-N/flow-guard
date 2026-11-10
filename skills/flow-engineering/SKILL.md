---
name: flow-engineering
description: 端到端水路（Source ➔ Branch ➔ Sink）透视、沙盒原型向生产迁移、跨语言链路对齐与废管死代码清理的标准作业流程（SOP）。当需要接入新模块、将隔离实验代码合入主项目、排查改A漏B的遗留问题或清理死代码时激活此技能。
---

# Flow Engineering — 端到端水路工程指南

本技能配合 `flow-guard` MCP Server（`flow_overview`、`flow_trace`、`flow_blueprint`、`flow_verify`）与生命周期钩子，帮助你以最少的步骤完成**无断流、无漏改、无死代码**的高质量代码演进。

---

## 核心心智模型：把代码看作「通水水管网」

不要把代码看作静态积木，每一处有效代码都必须处于一条完整的 **Source ➔ Branch ➔ Sink** 水路上：

1. **真实水源（True Source）**：真实世界的触发入口（UI 事件、Tauri/HTTP API 入口、Unity `Awake/Update/OnGUI`、`[HarmonyPatch]`、网络收包、磁盘读档）。
2. **分流阀与跨界桥（Branches & Bridges）**：
   - 模式分流阀（如 `shared` vs `independent`、`Host` vs `Client`）；
   - 跨语言水路桥（如前端 `invoke('cmd')` $\to$ Rust `#[tauri::command] fn cmd`、跨进程共享配置文件如 `mp-session.json`）。
3. **真实终端（True Sink）**：最终产生可观测效果的出口（修改原生引擎组件/Transform、写入网络发送流、落盘保存文件、更新前端响应式 Store）。

---

## 场景一：修改现有业务逻辑（防“改 A 漏 B”）

1. **一键透视水路**：
   调用 `flow_trace({ workspaceRoot, target: "<函数名/类名/字段名>" })`。
2. **核对 3 个关键问题**：
   - **上游水源**：有哪些入口会触发到这里？
   - **同级支流（Sibling Branches）**：上游分流阀是否还分出了其它并列支流（例如改了单船逻辑，同级的 `FleetRuntime` 多船支流是否消费同一结构）？
   - **状态写权限（SSOT）**：你要修改的状态字段，谁是唯一权威写入者（Writer）？切勿在只读消费端私自新建冗余缓存。
3. **检查可复用函数**：
   查看 `flow_trace` 返回的 `reusableCandidates`，优先复用已有工具函数，杜绝复制粘贴造轮子。

---

## 场景二：隔离沙盒实验 ➔ 生产项目完整接入（防“半截接入”）

当你在 `scratch/`、`lab/`、`experiments/` 或测试脚本中验证好了一段新逻辑，准备接入正式生产目录时，严格执行以下 4 步：

1. **提取同类模块施工单**：
   找一个生产区已有的同类功能模块，调用 `flow_blueprint({ workspaceRoot, reference: "<同类模块名>" })`。
2. **按施工单完成 4 站式接线**：
   - **第 1 站（接水源 Source）**：将真实运行时参数（而非实验时的硬编码假参数）传入新模块。
   - **第 2 站（过分流 Branch）**：在所有必要的模式分支（如主/副船、主/客机）中注册路由。
   - **第 3 站（闭环成对接口 Paired Lifecycle）**：若涉及 `Send`，必接 `Receive`；若涉及运行期状态，必接 `Save` 与 `Load`；若涉及 `Create`，必接 `Destroy/Reset`。
   - **第 4 站（落真终端 Sink）**：确保新模块计算出的结果真正写入了原生引擎对象、网络流或 UI 状态（不能停留在只写不读的内部字段里当“哑巴节点”）。
3. **剥离沙盒残留脚手架**：
   彻底删除实验阶段写的 `mock/dummy` 默认值、空 `catch {}` 吞错逻辑，严禁生产区文件反向 `import` 实验区/测试区文件。
4. **执行通水验收**：
   调用 `flow_verify({ workspaceRoot })`，确认无 `BROKEN_FLOW`（断流）与 `WRITE_ONLY_STATE`（只写不读状态）。

---

## 场景三：替换旧逻辑与清理死代码（防“废管堆积”）

1. **新水路接通后，立即调用 `flow_verify({ workspaceRoot })`**：
   查看报告中的 `newlyOrphaned`（本次改动导致断流的旧函数/旧文件）与 `deadPipes`（全仓零水流孤岛）。
2. **果断物理删除**：
   只要 `flow_verify` 标明某旧函数已无任何生产水源可达且无反射/跨语言引用，直接将其从源码中物理删除，严禁留作注释或加 `#[allow(dead_code)]` 保留。
