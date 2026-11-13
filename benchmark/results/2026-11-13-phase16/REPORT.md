# Phase16：Rust 类型与回调断连修复

源码 SHA-256：`bd0f86cc5584a809da5b465731c01f6ddac8ad5758e4414c0a578c1a7613ccdf`。仅下列最终源码证据计入交付；其他预览目录不计入。

修复了命名字段、具体泛型参数替换、支持的标准库包装类型与受限声明宏工厂签名。宏签名来自实际定义和调用，不按 singleton 名称假设；遵守导入、crate、模块作用域、cfg 和重复候选边界。真实 Clash 的 CoreManager.get_clash_logs、Sysopt.refresh_guard、SilentUpdater.install_update 均有确定类型调用边及运行入口可达路径。ripgrep 的 LineBuffer.set_binary_detection 有来自 Searcher 字段包装链的确定调用边；这不证明整个 ripgrep 的运行行为。

回调注册与执行分开建模：接收函数可解析且同步直接调用参数时，记录静态调用边；存储、条件分支、遮蔽、未轮询 async future 和未知外部宿主保持候选。快照保存回调注册候选，删除最后生产连接时生成明确结构断连；保留替代注册、迁移调用和无关格式修改不报此类断连。Serde/CodeMirror 等已记录框架候选的移除也参与增量比较。

**三套完整测试：147 项场景断言 + 173 个 Node 测试全部通过**（Windows Node 18.20.8 / 24.14.0、WSL Linux Node 22.23.3）。本轮新增 9 个测试，覆盖泛型/字段/包装类型、宏定义变更和 cfg 边界、注册删除及替代连接、直接回调/仅存储/条件调用/遮蔽/async future，另覆盖 CodeMirror 注册移除。

**Rust 编译执行对照 6/6**：使用上游原样 singleton 宏、泛型字段 RefCell、泛型工厂与委托、删除调用、直接回调、仅存储回调；实际计数与分析器可达性一致。编译器：`rustc 1.97.1 (8bab26f4f 2026-07-14)`。这是小程序执行证据，不是完整工程构建。

**完整真实源码副本 5 对控制/断连测试**：

| 案例 | 控制的显式目标 | 删除连接后的显式目标 | 删除后的增量 |
| --- | --- | --- | --- |
| Pot start_server | SATISFIED | VIOLATED | VIOLATED |
| Pot tray_event_handler | INCONCLUSIVE（仅注册） | VIOLATED | VIOLATED |
| Clash CoreManager.get_clash_logs | SATISFIED | VIOLATED | VIOLATED |
| Clash Sysopt.refresh_guard | SATISFIED | VIOLATED | VIOLATED |
| Clash SilentUpdater.install_update | SATISFIED | VIOLATED | VIOLATED |

原先托盘注册删除的增量漏报已在完整 Pot 源码副本复测消除。控制注册仍保持待确认，不将其升级为已执行。没有运行 Tauri 桌面程序。

六个原仓库各两次扫描：**12 次完成、0 超时、各仓报告一致**；原仓库提交及工作树未改变。

| 仓库 | VIOLATED | INCONCLUSIVE |
| --- | --- | --- |
| axum | 0 | 1156 |
| clash-verge-rev | 0 | 614 |
| fd | 0 | 129 |
| pot-desktop | 0 | 46 |
| ripgrep | 0 | 1589 |
| SwitchHosts | 0 | 313 |

实际 npm 包源码与冻结版逐文件哈希一致；官方 MCP SDK 1.32.2 / 2.4.0 在 Windows/Linux 均通过打包入口的 stdio 流程。

边界仍然存在：上述实现不是完整 Rust 编译器，不支持任意过程宏、trait 动态分派、任意类型别名或 cfg 选择；外部宿主是否触发回调需要该项目的实际行为测试。因此不能把“1、2 对任意项目完全解决”作为交付承诺。旧保存快照若缺少新回调字段，升级后应重新建立基线；Git 基线由当前引擎重建。其余 33 仓、大仓性能和独立准确率未在本轮验证。

[结构化证据](summary.json)。完整本地证据：`D:/Myproject/flowguard-validation/2026-11-12-hardening`。
