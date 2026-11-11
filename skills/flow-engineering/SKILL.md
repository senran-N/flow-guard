---
name: flow-engineering
description: 端到端水路（Source ➔ Branch ➔ Sink）透视、共享接线蓝图闭环、跨语言协议对齐与基于图差异的三态验收标准作业流程（SOP）。当需要接入新模块、新增配置/协议链路、排查改A漏B或清理死代码时激活此技能。
---

# Flow Engineering — 端到端任务接线与三态验收指南

本技能配合 `flow-guard` MCP Server（`flow_overview`、`flow_trace`、`flow_blueprint`、`flow_verify`），帮助你在局部改代码时始终围绕**“本次任务应该接成什么样，以及最后有什么证据证明接好了”**完成闭环。

---

## 核心心智模型：四大漏接根因与三层验收证据

AI 编程最常见的四类结构性失误：
1. **写了却没接上**：函数或类已实现（甚至加了 `export`），但没有任何真实运行入口触发，或计算结果无下游消费者。
2. **改了一处漏了关联处**：同族多态实现、另一平台分支、跨语言协议载荷对端、状态读取方或 `Save ⇄ Load` 恢复端未同步修改。
3. **接通了错误路径**：生产入口误调 `sandbox/test` 实验实现，或新配置虽已写入并保存，核心计算仍读旧常量。
4. **修复破坏了架构契约**：误删预留扩展钩子/条件编译签名，或用空 `catch {}`、形式化假调用掩盖断流。

FlowGuard 按三层证据逐级核验：
- **`L1_STRUCTURAL`（结构接通）**：入口可达性（区分 `application` 真实入口与 `library` 包公开 API）、工厂注册、多态/平台分支、跨语言桥接对端是否存在。
- **`L2_DATA_FLOW`（数据接通）**：本次新增参数、跨端载荷字段或状态字段是否真正传递到目标计算消费者（而非停留在只写状态或仅被 `Save` 序列化读取），返回值是否被有效承接，`Save ⇄ Load` 字段读写是否对称。
- **`L3_BEHAVIORAL`（行为生效）**：是否有测试或运行探针验证输入改变后输出按预期变化（线程同步、共享内存时序、原生句柄生命周期需结合现有测试与运行探针确认）。

---

## 标准作业流程（SOP）

### 第一步：动工前查带证据关系（`flow_trace`）
调用 `flow_trace({ workspaceRoot, target })`，重点阅读：
- **`evidencedRelations`**：查看每条入边/出边的类型（`CONTAINS` / `SEQ_CALL` / `BRANCH_DISPATCH` / `REGISTRATION` / `STATE_RW` / `IMPLEMENTS` / `PROTOCOL_BRIDGE`）、源码行号、实参列表与解析置信度（遇到 `AMBIGUOUS` 候选集先回源码核实）。
- **`siblingBranchesToCheck` vs `sequentialStepsInCaller`**：只对真正的条件分支、工厂注册与多态同族检查并列同步需求，不要把同一函数内的顺序步骤误判为并列实现。

### 第二步：围绕同一份接入清单施工（`flow_blueprint`）
接入新功能、新配置或新实现类前，调用：
```json
{
  "reference": "DetectorConfig",
  "targetSymbol": "setDetectionThreshold",
  "targetField": "detectionThreshold",
  "consumerTarget": "applyFilter",
  "requirePersistence": "required"
}
```
- 工具将自动生成并持久化 `wiringPlan`（包含每站的接入位置、原因、期望建立的关系、验收方式及 `ambiguitiesToConfirm`）。
- 按清单逐站打通：**入口触发 ➔ 工厂/路由挂载 ➔ 跨端协议载荷对齐 ➔ 目标业务消费计算 ↕ 对称保存与恢复**。

### 第三步：基于图差异与三态结论交卷（`flow_verify`）
完成修改后调用 `flow_verify({ workspaceRoot, baseRef, runTestsCommand })`：
- 若任务跨越多次 Git 提交，传入 `baseRef`（如任务起点 commit SHA 或 `HEAD~N`）以对比完整任务前后的水路图差异（含 `impactedUntouchedFiles` 未修改文件波及检查）。
- 逐项核对 `wiringReport`：
  - **`SATISFIED`（满足）**：已找到所需连接与数据消费证据。
  - **`VIOLATED`（违反）**：存在漏注册、协议字段未消费、过滤仍用旧常量、重启未恢复或应用新增导出未接入口等明确冲突，必须按 `remediation` 补齐真实关系（严禁造假调用消警）。
  - **`INCONCLUSIVE`（待确认）**：存在外部插件动态订阅、反射加载或缺少运行期测试覆盖，交卷时须向用户如实说明待确认项。
- 清理死代码时：仅直接删除 `CONFIRMED_SAFE_TO_DELETE` 的内部废管；对 `NO_STATIC_CALLER_EVIDENCE` 与 `reservedContracts` 保持审慎核实。
