# 使用与验收

当前适用于辅助代码审查，以及对明确目标执行结构、数据消费和行为测试验收。大仓库性能、动态调用和部分语言解析仍有限制；验收结论仅覆盖报告中的义务和实际执行的测试。

需要 Node.js 18 或以上。项目运行不需安装第三方依赖。

```powershell
# 审查指定项目
node src/server.mjs --cli verify D:/path/to/project --full

# 为本次改动建立明确目标（将名称替换成实际函数/字段）
node src/server.mjs --cli blueprint D:/path/to/project ReferenceModule --target targetFunction --field targetField --consumer consumerFunction --session review --task change1

# 修改后执行该项目实际的行为测试
node src/server.mjs --cli verify D:/path/to/project --session review --task change1 --run-tests "npm test"
```

退出码：`0` 满足；`1` 明确违反或行为测试失败；`2` 参数、执行或超时故障；`3` 证据不足，需要人工确认。自动化流程应保留完整 JSON。显式使用 `--allow-inconclusive` 可在辅助审查时让待确认结果退出 `0`，JSON 状态仍是 `INCONCLUSIVE`。未运行的行为测试不能当作已通过。

MCP stdio 启动方式：`node <本插件绝对路径>/src/server.mjs`。四个工具都应传入目标 `workspaceRoot`；蓝图与验收使用相同 `sessionId/taskId`，避免沿用其他任务状态。

```powershell
npm test
# 可选：验证真实 MCP SDK 客户端；此测试需要 Node 20+
npm ci --prefix benchmark/mcp-client --ignore-scripts --no-audit --no-fund
npm run test:mcp-sdk
```

实测记录与边界见 [phase17 报告](benchmark/results/2026-11-13-phase17/REPORT.md)。不提供全局准确率承诺。

Rust 可跟踪具体泛型参数、命名字段、受支持的标准库包装类型和简单声明宏生成的零参数工厂返回签名。只在能够解析到实际类型与声明时建立确定调用边；不等同于完整 Rust 类型检查或通用宏展开。原有回调注册被删除且未找到替代连接时，增量检查报告注册断连；仅注册回调仍不表示回调执行。仓内可解析接收函数直接调用回调参数时，可记录静态调用证据。

升级后请重新保存会话基线，以记录新增的回调候选字段。旧保存快照缺少这些字段时无法追溯原注册；基于 Git 的增量会使用当前引擎重建历史源码。

全量扫描中仅因导出函数未找到静态调用方的结果为 INCONCLUSIVE，需要确认业务接入要求。明确蓝图目标仍会检查实际入口连通性，删除已建立的调用可导致 VIOLATED。Serde 属性和 CodeMirror/Homebrew 回调只提供候选依据，不能证明业务执行；Rust 未知接收者也不会按方法名创建确定调用边。新增函数的 Git 变更检查仍保留其接入要求。

仅修改 TS/JS 别名配置或继承配置时，会全量重新检查当前工作区；缺失、循环或无效继承保持 INCONCLUSIVE。Rust 的宏展开、未选定 cfg/feature 和未解析接收者也会明确保留待确认。Vue 模板事件只作为注册证据，不作为已经触发的证明。

可选 Rust 编译语义补充需要本机 `rust-analyzer`、Cargo 和对应工具链。它会读取当前 checkout，补充复杂类型别名、过程宏返回类型和所选 feature/target 的调用证据。普通扫描仍不执行项目代码；只有显式传入 `--rust-build-scripts` 时才允许 Cargo 运行构建脚本和过程宏。该模式限全量当前源码，不支持 `--base` 和增量历史图，也不会写入会话基线。

```powershell
node src/server.mjs --cli verify D:/path/to/rust-project --full --rust-semantic --rust-features feature_a,feature_b --rust-semantic-timeout 180000
# 可信项目需要过程宏时，追加 --rust-build-scripts
```

JSON 的 `rustSemantics` 包含工具版本、Cargo 配置、源码哈希、原始调用层级、宏展开预览和映射结果。动态 trait 的实现只建立候选边，不能证明运行时选中了哪一个实现；无法唯一映射的宏生成声明仍为 INCONCLUSIVE。宏展开预览上限 512 处，生产函数查询上限 2000 个，超出会明示限制；首次生成 Cargo.lock 导致输入变化时应重新执行。工具缺失或超时会产生执行错误，不能作为通过。

真实 Windows Tauri/WebView2 宿主的可复现验证：`node benchmark/phase17-native-runtime.mjs D:/Myproject/crack/SwitchHosts D:/path/to/new-evidence`。脚本针对记录的上游提交复制源码，以独立数据目录启动桌面程序，验证真实 IPC、CodeMirror 回调和 Rust 监听器，并重新编译删除注册的反例。它会安装依赖并构建，不修改原仓库；测试前后核对系统 hosts 哈希。此证据只覆盖实际触发的路径，不能推及所有回调。
