# 真实仓库验证

phase11 使用 `node benchmark/phase11-report.mjs` 汇总本机冻结扫描、三平台运行记录、蓝图回归和实际打包程序的 MCP 集成结果。它要求全部证据存在并核验源码哈希、原仓库状态及已记录测试结果。当前交付用法见 [使用与验收](../OPERATIONS.md)，完整结果见 [phase11 报告](results/2026-11-13-phase11/REPORT.md)。大仓库超时保留为失败，不计入完成率。

2026-11-11 基线扫描使用 33 个既有仓库和 3 个新克隆仓库。冻结版本结果见 [基线报告](./results/2026-11-11/REPORT.md)，完整原始证据保存在本机 `D:/Myproject/flowguard-validation/2026-11-11-v020/`。该报告描述修复前的明确源码哈希，不代表后续版本表现。

验证分开统计：两次独立进程是否完成、完整报告是否一致、已知故障是否出现相关诊断、是否得到目标相关阻断、合法修改是否被误判。单元测试通过、仓库正常编译、或同一仓库有任意 VIOLATED 均不等同于正确检出特定故障。

脚本需要 Node 24（行为探针使用内置 TypeScript 类型擦除）、Git、tar、Python 3 和 Go。被测引擎的正常运行仍不要求 Python、Go 或 Node 24。默认模式不安装被测项目依赖、不运行被测项目脚本；行为探针只执行选中的真实函数。输出目录应在引擎及语料仓库外。

```powershell
node benchmark/real-world-scan.mjs D:/Myproject/crack D:/Myproject/flowguard-validation/new-run 2

# 把 p-limit、click、chi 放到 new-run/holdouts，版本固定到 manifest 中的提交。
node benchmark/real-world-scan.mjs D:/Myproject/flowguard-validation/new-run/holdouts D:/Myproject/flowguard-validation/new-run/holdout-scans 2
node benchmark/real-world-mutations.mjs D:/Myproject/crack D:/Myproject/flowguard-validation/new-run
node benchmark/real-world-plans.mjs D:/Myproject/flowguard-validation/new-run explicit-plans-complete
```

`real-world-cases.mjs` 定义 12 对现有源码改动和独立行为预期。变异脚本要求原仓库干净，通过 `git archive` 复制已跟踪文件，创建单独基线，保存 patch、行为输出、全量与增量报告，最后恢复副本。已有变异输出目录不会被覆盖。显式蓝图脚本复用完全相同的 patch，并在改动前生成蓝图。

`real-world-review.mjs` 是这次冻结版本的源码审阅标注，不能自动充当未来版本的真值：先检查各仓库提交与对应告警仍然一致，再更新审阅。它选取每个有告警仓库的第一条 VIOLATED，属于系统抽样，不能计算全局精确率。

`real-world-report.mjs` 汇总本轮结果，检查引擎源码哈希未变及原仓库、变异副本均未留下修改。其文字结论针对本轮案例，应随新一轮证据更新。冻结目录中的 `engine-snapshot` 保存被测源码，`benchmark-snapshot` 保存执行脚本；修复前后必须使用不同输出目录。

后续扫描脚本会先把引擎复制到输出目录的 `engine-snapshot`，所有工作进程使用该副本，避免扫描期间开发改动污染结果。单轮扫描的重复一致性为 `null`；至少两轮才能报告一致性。

2026-11-12 改进复测的汇总脚本是 `hardening-report.mjs`，它核对当前源码与三组冻结扫描哈希一致，并检查原仓库提交和工作树。`new-holdout-cases.mjs` 在新克隆的 yocto-queue、packaging、httprouter 副本中执行三对案例；可选第三、四参数指定新的案例输出名与冻结扫描目录名。新案例的行为探针及完整 JSON 结果独立保存，不作为引擎内置通过条件。

```powershell
node benchmark/new-holdout-cases.mjs D:/Myproject/flowguard-validation/2026-11-12-hardening new-holdout-cases-phase3 phase3-new-holdouts
node benchmark/hardening-report.mjs D:/Myproject/flowguard-validation/2026-11-12-hardening D:/Myproject/flowguard-validation/2026-11-11-v020 benchmark/results/2026-11-12
```

后续轮次可用第五参数选择阶段、第六参数记录已验证的测试用例数。阶段名需与三组扫描目录、变异及蓝图目录的后缀一致；使用新目录，不覆盖已封存报告。phase5 增加缓存、包边界、JSX 和 Alembic 修复，源码核查同时保存尚未识别的动态组件反例。

```powershell
node benchmark/framework-source-audit.mjs D:/Myproject/flowguard-validation/2026-11-12-hardening D:/Myproject/crack phase5
node benchmark/hardening-report.mjs D:/Myproject/flowguard-validation/2026-11-12-hardening D:/Myproject/flowguard-validation/2026-11-11-v020 benchmark/results/2026-11-12-phase5 phase5 66
```

再次运行先前留出案例属于回归验证，不构成新的独立准确率样本。源码核查中的 8 个检查也不是新增的 Node 测试用例。

phase7 增加 Kotlin 回调、动态 JSX 候选路径、计时器消费与括号实参回归；该阶段源码核查 9 项，Node 测试 71 个，另有 142 项断言。Bruno 计时器行为案例在隔离副本中执行真实 CookiesStore，替换计时器及 Electron 等依赖，覆盖延迟写入合并与立即写入，不代表磁盘集成测试。

```powershell
node benchmark/timer-behavior-case.mjs D:/Myproject/flowguard-validation/2026-11-12-hardening D:/Myproject/crack phase7
node benchmark/hardening-report.mjs D:/Myproject/flowguard-validation/2026-11-12-hardening D:/Myproject/flowguard-validation/2026-11-11-v020 benchmark/results/2026-11-12-phase7 phase7 71
```

性能候选还需独立交替运行。先完成其他扫描，再执行以下命令；不要同时启动其他 FlowGuard 扫描或测试。脚本验证冻结引擎文件哈希和原仓库提交，按 A/B/B/A 顺序串行运行，每次保留原 120 秒上限，比较完整报告哈希。即便结果等价，也必须根据耗时和内存决定是否保留候选实现。

```powershell
node benchmark/compare-frozen-performance.mjs D:/Myproject/flowguard-validation/2026-11-12-hardening D:/Myproject/crack/llama.cpp phase7 phase8 performance-phase8
```

全量任务并发为 2，超时为 120 秒，哈希比较包含完整报告和图计数，不包含计时；RSS 是结束时采样而非峰值。故障注入不依赖任何“现有开源代码一定没有 bug”的假设。所有数字都应报告分母，超时、异常与未定结果不得计为通过。

phase9 增加 Rust 模块路径/循环导入、工具脚本引用与顶层调用验证；测试增加到 76 个，真实源码核查增加到 14 项。真实 pot-desktop 断连案例与合成 rustc 行为探针分别记录，不混合分母。后者需要本机 rustc 及其链接器；引擎运行不依赖 Rust 工具链。

```powershell
node benchmark/entry-source-cases.mjs D:/Myproject/flowguard-validation/2026-11-12-hardening D:/Myproject/crack phase9
node benchmark/rust-module-probe.mjs D:/Myproject/flowguard-validation/2026-11-12-hardening phase9
node benchmark/framework-source-audit.mjs D:/Myproject/flowguard-validation/2026-11-12-hardening D:/Myproject/crack phase9
node benchmark/hardening-report.mjs D:/Myproject/flowguard-validation/2026-11-12-hardening D:/Myproject/flowguard-validation/2026-11-11-v020 benchmark/results/2026-11-12-phase9 phase9 76
```
