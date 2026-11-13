# FlowGuard 真实仓库验证报告（2026-11-11）

**当前版本适合人工审阅辅助，尚不适合直接用作生产 CI 的自动阻断门禁。** 这是对本次冻结代码的实测结论；单元测试通过不代表真实项目中的准确率已经达标。

## 范围与版本

- 用户目录中的 33 个仓库，加上新克隆的 p-limit、Click、chi，共 36 个仓库；每个仓库使用两个全新 Node 进程重复扫描，共 72 次。
- Node v24.14.0 / win32 x64；默认自动项目模式，无活动蓝图；并发数 2，单个扫描任务上限 120 秒。两次新进程不等于清除了操作系统磁盘缓存。
- 引擎 HEAD：`a9858131e7939a9329cbd04e8e2d350760c1eca6`；包含尚未提交的修复，因此以 src 文件 SHA-256 为准：`4269e4f5a97c37ce57317df790db51fa571fbe35d2f6fe215023c346b31ecb36`。结束时逐文件校验相同，副本保存在 `engine-snapshot/`。
- 每个仓库的完整提交、远程地址、初始状态在两份 manifest.json 中。36 个源仓库最终提交与工作区状态均未改变。故障注入只在归档创建的隔离副本中进行，副本已经恢复。
- 原有 33 个仓库曾用于此前调优；新增 3 个仓库单独标记。案例由本次源码检查后人工选取，不是随机抽样，也不构成独立盲测。

## 扫描稳定性与资源

| 指标 | 实测 |
|---|---|
| 时限内完成 | 33/36 个仓库；66/72 次扫描（91.7%） |
| 重复报告一致性 | 33/33 个已完成仓库，两轮 graph 摘要与完整报告哈希相同 |
| 未完成 | Bruno、llama.cpp、memos 均两次超时；memos 第一次同时出现 JavaScript heap out of memory 日志 |
| 已完成扫描 verify 耗时 | P50 3.00 秒；P95 27.11 秒 |
| 观测到的最大结束时 RSS | 3296 MiB（不是实时峰值测量） |
| 已完成仓库解析规模 | 11860 个文件，83977 个符号；含测试代码 |
| 原始阻断告警总数 | 6670 条；不能当成真实缺陷数 |

120 秒限额覆盖验证和随后为统计而取得图信息的整个工作进程；不据此断言具体哪一步超时。耗时只统计成功完成的验证，超时样本没有被当作快速成功。语言支持按实际解析文件计，不能据此声称跨操作系统或所有语言均已验证。

## 有真值的故障注入与合法对照

在 8 个完整仓库副本中修改真实现有函数/协议，不插入人为的小型项目。12 个故障各有一个配对合法修改。所有原始行为探针先通过；10 个函数故障通过执行抽取的真实函数确认失败，对照通过。其余 2 个 Tauri 案例核对前端调用名、Rust 命令声明与注册表，没有启动桌面应用。这里未宣称执行了这 8 个项目的全部上游测试。

对“检出”的要求是出现与指定函数及形参、或指定桥接契约相符的新诊断；已有告警或同一仓库随便一条 VIOLATED 不算命中。

| 指标 | 全量默认模式 | 增量默认模式 |
|---|---|---|
| 有相关诊断的故障 | 11/12（91.7%） | 11/12（91.7%） |
| 有目标相关阻断的故障 | 2/12（16.7%） | 2/12（16.7%） |
| 合法对照出现新增相关诊断 | 0/12 | 0/12 |

增量模式中 10/12 个已确认故障最终仍为 SATISFIED（其中 9 个有参数断流诊断，1 个漏报）。全量模式的 9/12 个合法对照整体仍为 VIOLATED，原因是原有告警；该数不能当作“合法修改新增误报率”。12 个增量合法对照整体均为 SATISFIED。新增仓库的 3 个故障检出 2 个、默认目标阻断 0 个。

统计口径修正（metricVersion 2）：初版脚本仅检查 wiringReport.obligations 中的目标阻断，漏计了全量 brokenBridges 直接参与最终 blockingCount 的两条桥接故障。本报告从保留的原始 JSON 重算，全量目标阻断应为 2/12；没有重新运行或修改冻结引擎。原始 results.json 保留未覆盖；汇总使用修正口径。该问题也暴露了最终状态与义务清单/标题不一致的产品问题，但不是桥接故障被实际放行。

另外，使用修改前生成的显式 targetSymbol 蓝图复测 10 个函数案例：7/10 个故障得到目标 L2 阻断；Click 的一个故障漏报；Hono 的两个故障及其两个对照均执行异常。10 个合法对照中 4 个整体 VIOLATED、2 个执行异常、4 个 INCONCLUSIVE。不能把执行异常计为成功检出，也不能把合法修改的无关入口告警算成缺陷检出。

| 案例 | 语料 | 真值依据 | 默认相关提示 | 默认目标阻断 | 显式蓝图目标 L2 阻断 |
|---|---|---|---|---|---|
| httpx-encoding-bytes | 原语料 | 真实函数执行 | 是 | 否 | 是 |
| httpx-encoding-str | 原语料 | 真实函数执行 | 是 | 否 | 是 |
| flask-dotenv-default | 原语料 | 真实函数执行 | 是 | 否 | 是 |
| click-posixify-name | 新增仓库 | 真实函数执行 | 否 | 否 | 否 |
| hono-split-path | 原语料 | 真实函数执行 | 是 | 否 | 执行异常 |
| hono-custom-decoder | 原语料 | 真实函数执行 | 是 | 否 | 执行异常 |
| p-limit-concurrency-validation | 新增仓库 | 真实函数执行 | 是 | 否 | 是 |
| gin-accept-header | 原语料 | 真实函数执行 | 是 | 否 | 是 |
| gin-base-path | 原语料 | 真实函数执行 | 是 | 否 | 是 |
| chi-wildcards | 新增仓库 | 真实函数执行 | 是 | 否 | 是 |
| pot-client-channel | 原语料 | 命令契约核对 | 是 | 是 | 未测 |
| pot-command-rename | 原语料 | 命令契约核对 | 是 | 是 | 未测 |

## 人工告警审阅

固定规则：对每个完成扫描且有 VIOLATED 的仓库取第一条，得到 29 条。Codex 逐条阅读声明、调用者及注册/导出代码，28 条标为误报，1 条待确认；没有据此确认新的上游真实缺陷。该规则偏向各仓库排在前面的规则类型，不是告警总体随机样本，**不能推算全局准确率、精确率或误报率**。尚无独立第二审阅者。

`human-review.json` 保存完整告警、源码摘录、行号、文件哈希、判断理由；判断仅针对选中的那一条。

| 仓库 | 告警 | 判断 | 类型 | 源码判断依据 |
|---|---|---|---|---|
| Alamofire | AUTO-1 | 误报 | 错误泛化具体类型调用 | 调用者明确将 request 转为 DataRequest / DataStreamRequest；没有以 Request 契约调用 DownloadRequest.didReceive。 |
| axum | AUTO-1 | 误报 | trait 作用域合并 | 两个 call 分属 Handler<(), S> 和 Service<IncomingStream>，参数数目不同是两个接口的正常要求。 |
| BepInEx | AUTO-7 | 误报 | 泛型约束误作继承 | 类继承 AcceptableValueBase；where T : IEquatable<T> 是泛型约束，T 不是共享基类，更无 Add 契约。 |
| bits-ui | AUTO-1 | 误报 | 泛型约束误作继承 | TimeRangeFieldRootState 的 T extends TimeValue 是类型参数约束；类没有继承 TimeValue。 |
| clash-verge-rev | AUTO-1 | 误报 | 忽略保留形参导致参数计数错误 | 两个平台版本都接收一个 &anyhow::Error；_error 仍是形参。 |
| Dapper | AUTO-1 | 误报 | 限定类型名截断 | 实现的是 SqlMapper.ITypeMap，不是 SqlMapper；官方用例通过 SetTypeMap 显式注入。 |
| dio | AUTO-1 | 误报 | 可选插件误要求内建注册 | NativeAdapter 是按需安装并赋给 dio.httpClientAdapter 的独立插件，README 和示例已有接入。 |
| fastapi | AUTO-1 | 误报 | 声明式模型误要求工厂注册 | Discriminator 是 Pydantic 字段类型，已在 Schema.discriminator 声明；模型无需加入其它 BaseModel 子类的工厂。 |
| fd | AUTO-1 | 误报 | 忽略保留形参导致参数计数错误 | Unix 和 Windows 两版本均有一个 fs::FileType 形参，Windows 使用 _ 并不改变签名。 |
| flask | AUTO-1 | 误报 | 限定类型名截断及嵌套函数归属错误 | NoAppException 继承 click.UsageError，AppGroup 继承 click.Group；模块 click 不是共享基类，decorator 不是异常类契约。 |
| fmt | AUTO-1 | 待确认 | 中间基类契约需进一步确认 | BranchPattern 是模式树的中间类，Required/Optional 等子类实现 match；此次未穷尽动态构造路径，不将该告警计为已确认缺陷或误报。 |
| full-stack-fastapi-template | AUTO-EXP-1 | 误报 | 框架入口未识别 | upgrade 是 Alembic revision 的标准入口；项目 prestart 脚本通过 alembic upgrade head 调用迁移。 |
| gson | AUTO-1 | 误报 | 可选扩展误要求内建注册 | extras 的 InterceptorFactory 由用户 registerTypeAdapterFactory 注入，仓内测试有完整调用。 |
| hono | AUTO-1 | 误报 | 方法属性未识别 | PreparedRegExpRouter 已通过 match: typeof match<Router<T>, T> = match 实现 match，解析器漏掉了函数属性。 |
| httpx | AUTO-1 | 误报 | 嵌套函数误作类方法 | digest 是 DigestAuth._build_auth_header 内的局部函数，不是 Auth 要求 FunctionAuth 实现的方法。 |
| koel | AUTO-1 | 误报 | 属性反射注册未识别 | RequiresDemo 被用于控制器属性，HandleDemoMode 通过 RequiresDemo::class 查找并处理。 |
| okhttp | AUTO-1 | 误报 | companion 方法误作接口要求 | buildIfSupported 位于 Android10SocketAdapter.companion object；SocketAdapter 接口没有该方法。 |
| pinia | AUTO-EXP-1 | 误报 | 框架自动导入未识别 | Nuxt 模块已经用 addImports 注册 usePinia。 |
| pocketbase | AUTO-EXP-1 | 误报 | 库与应用模式识别错误 | 项目明确支持作为 Go library 使用；NewApiError 是公开别名接口，无仓内调用者不构成接入违规。 |
| pot-desktop | AUTO-EXP-3 | 误报 | JSX 调用未识别 | WindowControl 已被 Config 和 Recognize 页面导入并作为 JSX 组件渲染。 |
| retrofit | AUTO-1 | 误报 | 工厂返回实例未正确归属 | responseBodyConverter 已 return new OptionalConverter<>(delegate)，并非没有注册或创建路径。 |
| ripgrep | AUTO-1 | 误报 | 嵌套函数作用域合并 | imp 分属 is_hidden_path、is_hidden_entry、strip_prefix 等不同外层函数；不能把所有局部 imp 当成同一跨平台函数。 |
| serilog | AUTO-1 | 误报 | 接口方法集合错误泛化 | ILogEventPropertyValueFactory 仅要求 CreatePropertyValue，DepthLimiter 已显式实现；CreateProperty 属于另一接口。 |
| sidekiq | AUTO-1 | 误报 | 错误泛化具体实例调用 | JobSet.kill_all 明确创建 DeadSet 后调用 ds.trim；并未要求 ScheduledSet 实现 trim。 |
| SwitchHosts | AUTO-1 | 误报 | 忽略保留形参导致参数计数错误 | macOS 和其它平台版本都接收三个参数，_monitors 被错误从参数个数中移除。 |
| uptime-kuma | AUTO-1 | 误报 | ORM 动态加载未识别 | 数据库启动时 autoloadModels 加载 server/model，APIKey 使用 R.dispense('api_key') 实例化。 |
| zod | AUTO-1 | 误报 | 泛型参数误作继承及继承 getter 丢失 | ZodEffects 继承 ZodType，Input 是泛型参数；description 是基类提供的 getter。 |
| chi | AUTO-EXP-1 | 误报 | 库与应用模式识别错误 | chi 是导入使用的 Go 路由库；Context.Clone 是公开 API，要求仓内运行入口是错误前提。 |
| click | AUTO-1 | 误报 | 限定类型名截断 | Sentinel 继承 enum.Enum；enum 是模块，不是工厂公共基类。枚举成员已经被模块导出使用。 |

## 优先修复的问题

1. **蓝图验证执行异常**：`src/wiring-contract.mjs:892` 对调用对象执行 c.toLowerCase()。Hono 的 control 与 defect 都能复现；完整堆栈见 `explicit-plans-complete/hono-split-path/control.json`。这条路径没有被当前合成回归样例覆盖。
2. **高置信度结论超出证据**：泛型约束/限定基类名解析错误、局部函数/trait/companion 作用域合并、继承或属性方法遗漏，均被升级为确定的 VIOLATED；应先修复类型与作用域，再收紧推断规则。
3. **项目入口识别不足**：chi、Click、httpx、Flask 等库被识别为应用；JSX、Nuxt 自动导入、Alembic、ORM/反射入口没有可靠识别。合法 API 和框架入口因此被阻断。
4. **诊断与门禁状态不一致**：默认模式发现参数未消费，却仍给 SATISFIED；需要明确区分“无任务契约的提示”和“已经证明通过”。桥接等问题可直接令最终状态 VIOLATED，却没有对应义务，标题可能仍称没有违反。不能直接把所有未使用参数升级为阻断，否则会增加误报。
5. **保留形参豁免过宽**：Click 的 _posixify(name) 被关联到 __getattr__(name) 的回调签名而豁免，真实输入丢失没有被检出；Rust 的 _ / _error / _monitors 又被从签名参数数量中丢弃。
6. **大仓资源边界**：三仓两轮未完成，memos 出现约 4 GB 堆上限错误；retrofit 的结束时 RSS 达数 GiB。需要阶段耗时、内存采样和复杂度分析，不能只增大超时来宣称通过。

## 其他验证与证据位置

- FlowGuard 自身 npm test：69 + 73 项断言及 38 项测试全部通过；当前全量自检通过。真实样本仍揭示上述问题。
- 新克隆 chi 的上游 `go test ./... -count=1` 通过（核心包与 middleware）。它支持该仓正常工作的判断，但不能证明每条静态告警都错误。
- `scans/`、`holdout-scans/scans/`：全量原始报告；`scan-runs.json`：退出状态、超时和 stderr；`stability.json`：重复结果。
- `mutations/cases/`：逐个案例的 patch、原始/对照/故障探针、探针输出和两种检测模式原始 JSON。
- `explicit-plans-complete/`：在原始代码生成并复用的显式蓝图、全部 20 次结果；`explicit-plans/` 保留第一次因 Hono 异常中断的补测证据，没有删除失败记录。
- `manifest.json`、`summary.json`、`summary.csv`、`human-review.json`：版本、汇总与标注；复现脚本位于 FlowGuard 的 `benchmark/`。

## 完整扫描清单

| 仓库 | 提交前缀 | 两轮 verify 秒数 | 结果 | 文件 | VIOLATED | 自动模式 |
|---|---|---|---|---|---|---|
| Alamofire | 6c2892ea5adb | 5.42 / 5.45 | 一致 | 107 | 80 | library |
| axum | 47399621c401 | 2.46 / 2.50 | 一致 | 310 | 1 | hybrid |
| BepInEx | dbc82f05b8ea | 0.93 / 0.92 | 一致 | 116 | 20 | application |
| bits-ui | a6f32ab5adf3 | 19.84 / 20.59 | 一致 | 1141 | 53 | application |
| bruno | 60d7517d0545 | >120 / >120 | 超时 | — | — | — |
| clash-verge-rev | 389dddf51204 | 11.54 / 12.01 | 一致 | 425 | 235 | application |
| cobra | adbc8813901b | 1.12 / 1.27 | 一致 | 36 | 0 | library |
| Dapper | eb47546a408b | 3.00 / 2.86 | 一致 | 157 | 127 | library |
| dio | f1bef462289b | 6.95 / 7.99 | 一致 | 200 | 84 | application |
| fastapi | e1144f6954eb | 13.98 / 14.55 | 一致 | 1224 | 108 | application |
| fd | 24d90b28d254 | 0.79 / 0.81 | 一致 | 25 | 7 | application |
| flask | 49943b5a9441 | 1.63 / 1.73 | 一致 | 83 | 84 | application |
| fmt | e7e6e3f71033 | 35.26 / 36.41 | 一致 | 80 | 5 | library |
| full-stack-fastapi-template | aabb90126964 | 0.96 / 1.00 | 一致 | 151 | 144 | application |
| gin | 0f09c3a9b462 | 1.81 / 1.92 | 一致 | 99 | 0 | hybrid |
| gson | a961b0fe088f | 5.77 / 6.15 | 一致 | 266 | 182 | library |
| hono | 61f7c59e5024 | 4.58 / 4.98 | 一致 | 451 | 6 | library |
| httpx | b5addb64f016 | 1.34 / 1.51 | 一致 | 60 | 125 | application |
| jq | 5c001b18d723 | 1.61 / 1.59 | 一致 | 57 | 0 | application |
| koel | 80a21bb34c5f | 24.62 / 25.23 | 一致 | 2795 | 191 | hybrid |
| llama.cpp | aa75ff3239f9 | >120 / >120 | 超时 | — | — | — |
| memos | abdeb8a57cc4 | >120 / >120 | 超时；一次有 OOM 日志 | — | — | — |
| okhttp | 4162e9da32f6 | 16.33 / 18.74 | 一致 | 646 | 475 | application |
| pinia | 4817135a2543 | 1.00 / 0.88 | 一致 | 162 | 9 | application |
| pocketbase | 7f2773ec234b | 10.74 / 10.50 | 一致 | 651 | 348 | application |
| pot-desktop | 594d32ede96a | 1.29 / 1.31 | 一致 | 202 | 49 | application |
| retrofit | ac37c6164386 | 25.05 / 24.40 | 一致 | 323 | 248 | hybrid |
| ripgrep | 178cc027e283 | 27.11 / 27.24 | 一致 | 103 | 75 | application |
| serilog | 43105b350953 | 2.50 / 2.73 | 一致 | 217 | 81 | library |
| sidekiq | 75982898ff6d | 1.74 / 1.82 | 一致 | 174 | 295 | application |
| SwitchHosts | 7c8eaa50a6c4 | 3.10 / 3.19 | 一致 | 218 | 66 | application |
| uptime-kuma | fb8ef0fa8200 | 5.78 / 5.77 | 一致 | 672 | 503 | application |
| zod | 19c40d207228 | 6.95 / 6.94 | 一致 | 523 | 2700 | application |
| chi（新增样本） | c64ed7d6635f | 1.01 / 1.06 | 一致 | 90 | 46 | application |
| click（新增样本） | 8abb77a8432e | 3.10 / 2.88 | 一致 | 91 | 323 | application |
| p-limit（新增样本） | a8a6fbec4e0e | 0.24 / 0.21 | 一致 | 5 | 0 | library |
