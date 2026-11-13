# FlowGuard phase13 Rust 模块分区复测

交付源码 SHA-256：`d045c3b926d18ee3fd896c785251068274ea8c1f413c56d37f01c08f16683265`。本报告仅将同一最终源码的测试、六仓复测和实际打包接入作为交付证据。

已修复：从实际 Cargo bin/lib 根沿 mod 声明判断模块分区，正常源码不会仅因 `_test.rs` 后缀被误分为测试。保留 tests/fixtures 路径、独立测试属性、test-only 模块祖先及文件内部 cfg 的边界。构图从路径基线重算，避免污染解析缓存。模块路径与调用解析共享候选规则，并修正普通源文件和自定义根中的嵌套 path 属性。

仅控制 lint、文档、feature gate 或 Windows 子系统的 cfg_attr 不再被当作代码选择条件。影响 cfg/path 或无法解析的 cfg_attr 继续保守处理。这个分类不选择实际 Cargo features，也不执行宏展开。

Windows Node 18/24、WSL Ubuntu 24.04 Node 22：三套完整测试均通过 **147 项场景断言及 156 个 Node 测试**。新增 11 个测试覆盖模块分区、自定义根、同文件重复 mod、嵌套路径、属性字符串、内部属性、缓存重建及真实测试依赖阻断。

六个真实仓库各扫描两次，共 **12 次完成、0 次超时、6 仓完整报告各自一致**；复核原仓库提交和工作树未改变。采用两个并发工作进程，耗时不用于性能对比。

| 仓库 | 上一版违反数 | 本版违反数 | 本版待确认数 |
| --- | --- | --- | --- |
| axum | 0 | 0 | 1161 |
| clash-verge-rev | 15 | 5 | 633 |
| fd | 2 | 0 | 127 |
| pot-desktop | 0 | 0 | 46 |
| ripgrep | 3 | 2 | 1568 |
| SwitchHosts | 7 | 7 | 304 |

告警数量变化不是准确率。七项真实 Axum 源码核查通过：包含上一轮的调用/候选边与本轮的 `axum_test.rs` 分区修正；该文件由实际 Cargo 库模块树声明，原跨测试区候选误报已消除。Axum 当前仍为 INCONCLUSIVE，不能当作项目验收通过。

独立 Rust 编译执行对照 **5/5**（`rustc 1.97.1 (8bab26f4f 2026-07-14)`）：构造函数、成员委托、回调执行，以及文件名带 test 的普通模块可编译、真实 test-only 模块/函数在普通构建中排除。另以编译器核对两种嵌套 path 规则。模块语义依据 [Rust Reference](https://doc.rust-lang.org/reference/items/modules.html)。这些小程序不代表完整编译器一致性；实际 Axum 未执行完整 Cargo 测试。

完整 pot-desktop 源码副本的两对入口断连案例已复验：直接调用 control 的显式目标为 SATISFIED；回调 control 为 INCONCLUSIVE；删除连接的显式目标均 VIOLATED。全量/增量合法对照无目标误阻断；未运行 Tauri 业务程序。

实际 npm 包的每个源码文件哈希与交付版一致；官方 MCP SDK 1.32.2 与 2.4.0 在 Windows/Linux 均通过打包入口的完整 stdio 流程。自检 PASS、零义务，不代表行为测试已通过。

仍有边界：完整 Rust 类型推导、字段类型链、泛型/宏展开、cfg/feature 选择和任意高阶函数执行语义尚未覆盖。其他仓库的残余违反需逐条审阅。适用于辅助代码审查与明确目标的验收，不能承诺任意项目自动门禁或全局零误报。

本轮未重跑其余 33 个仓库或 Bruno/llama.cpp 性能。历史 39 仓/大仓数据保留在 [phase11 报告](../2026-11-13-phase11/REPORT.md)，上一轮调用修复见 [phase12](../2026-11-13-phase12/REPORT.md)，不归入本版测量。初版因 Windows 子系统属性误判而失败的真实断连回归保留在 entry-source-cases-phase13；最终源码已修正并在 entry-source-cases-phase13-final2 全量重验。原始证据位于 `D:/Myproject/flowguard-validation/2026-11-12-hardening`。
