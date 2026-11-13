# FlowGuard phase15：入口证据修复

源码 SHA-256：`90db1fc6a98bf70426f6aaf9b387b4b13ef21d687db514671962c78e168f177c`。

修复 Rust 多行链式方法遗漏：有唯一具体工厂返回类型时建立类型调用边；类型未知、同一行混合调用、复杂绑定及宏生成方法保留候选，不按名称建立执行边。Serde 跨模块属性按 Rust 导入作用域解析；CodeMirror WidgetType 与 Homebrew Formula 回调记录宿主候选，均不作为运行时根或已执行证明。

全量扫描缺少任务上下文时，无静态引用导出改为 INCONCLUSIVE，保留名称、位置及审查建议。显式蓝图目标与 Git 新增功能/删除连接的检查仍保留违反结论。

三套完整测试均通过：**147 项场景断言 + 164 个 Node 测试**。新增 8 个测试包括具体返回类型、未知接收者、跨模块同名隔离、属性移除、伪造框架、字符串、同一行混合链及删除调用对照。部分旧测试改用显式目标验证阻断语义，未将明确断连改为通过。Windows/Linux 实际 npm 包入口通过官方 MCP SDK 1.32.2 / 2.4.0 的完整 stdio 流程，包内全部源码哈希与冻结版一致。

六仓各扫描两次，**12 次完成、0 超时、6 仓完整报告各自一致**；原仓库提交与工作树均未改变。

| 仓库 | VIOLATED | INCONCLUSIVE |
| --- | --- | --- |
| axum | 0 | 1167 |
| clash-verge-rev | 0 | 638 |
| fd | 0 | 128 |
| pot-desktop | 0 | 46 |
| ripgrep | 0 | 1607 |
| SwitchHosts | 0 | 312 |

原 14 条残余全部逐项匹配为 INCONCLUSIVE：6 条调用/属性引用、3 条宿主回调、5 条未发现外部引用。具体返回类型修复由独立对照覆盖；真实 Clash 的宏生成 singleton 接收者和 ripgrep 字段包装链仍未获得完整类型证明。**违反数归零包含判定策略变化，不代表准确率提高或所有功能通过。**

完整 Pot 源码副本的两对连接删除对照：直接调用 control 的显式目标 SATISFIED，回调 control 为 INCONCLUSIVE；删除连接后的两个显式目标均 VIOLATED。全量无任务上下文的 defect 为 INCONCLUSIVE；直接调用删除的增量为 VIOLATED；回调删除的增量仍 INCONCLUSIVE。未运行 Tauri 程序。初次对照因旧脚本要求全量无目标也必须失败而停止，旧证据保留；更新脚本的全量期望后，新目录重跑且显式目标的失败断言保持不变。

适用于辅助审查及明确目标验收。尚不支持任意宏展开、完整 Rust 类型推导、动态宿主执行或任意项目自动门禁。其余 33 仓和 Bruno/llama.cpp 性能本轮未复测。详见 [结构化证据](summary.json)；本地完整证据位于 `D:/Myproject/flowguard-validation/2026-11-12-hardening`。
