# FlowGuard — 端到端水路（Source ➔ Branch ➔ Sink）开发与验收准则

在修改或扩展代码仓库时，严禁仅凭局部文件视野“盲人摸象”式改代码。必须围绕**本次任务的完整因果接线目标（入口触发 `Source` ➔ 注册分流 `Branch` ➔ 状态与协议传递 ➔ 业务消费 `Sink` ↕ 对称恢复）**建立可核验证据：

## 1. 动工前：用带证据透视与共享接入清单代替盲目 `grep`
- **改逻辑先查水路（`flow_trace`）**：修改跨函数或跨文件逻辑前，优先调用 `flow_trace` 获取目标符号的 **`evidencedRelations`（源码行号、传参、置信度与多候选集）**。严格区分 **`siblingBranchesToCheck`（需要同步核查的条件分支/注册挂载/多态同族）** 与 **`sequentialStepsInCaller`（同一调用方内的顺序步骤）**；若关系标记为 `AMBIGUOUS`，必须回到源码核实具体目标。
- **接新功能先建契约清单（`flow_blueprint`）**：新增特性、配置项或跨端协议时，先调用 `flow_blueprint`（传入参考模块 `reference`，并尽量指定 `targetSymbol`、`targetField`、`consumerTarget`），生成与 `flow_verify` 共享的可追踪接入清单（`wiringPlan`）。若清单包含 `ambiguitiesToConfirm`（如是否要求跨重启持久化），应结合需求明确后再施工。

## 2. 交卷前：基于三层证据与图差异执行三态验收（`flow_verify`）
- **区分“结构可达”与“目标数据真正生效”**：
  - **L1 结构接通**：入口、工厂注册、多态/跨平台兄弟分支与跨语言协议对端均已连通（注意：在应用工程中仅添加 `export` **不构成**已接入真实入口的证据）。
  - **L2 数据生效**：新增参数或配置字段必须真正传入目标业务计算函数消费（禁止只写入配置或只接入 `Save` 序列化，而核心过滤计算仍读旧常量；持久化字段必须满足 `Save ⇄ Load` 双向恢复）。
  - **L3 行为生效**：静态分析无法替代线程同步、资源生命周期与运行期行为验证；尽可能补充测试或通过 `runTestsCommand` 闭环运行期证据。
- **诚实对待三态结论与死代码分级**：
  - 对 `VIOLATED`（明确违反契约）必须补齐真实缺失连接，**严禁添加无实际效果的形式化假调用、空 `catch {}` 或 `#[allow(dead_code)]` 掩盖告警**。
  - 对 `INCONCLUSIVE`（动态插件、单向外部事件或缺少运行期测试导致证据不足）应如实向用户说明待确认边界，不要把“未发现静态报错”夸大为“端到端行为已验证完成”。
  - 清理死代码时区分证据强度：`NO_STATIC_CALLER_EVIDENCE` 仅表示未发现静态引用，不是安全删除证明。核对 `analysisScope` / `uncertainty`、动态或外部调用契约并运行测试后，再决定保留、接入或删除；保护 `reservedContracts`。
