# Phase14：14 条残余告警人工核验

核验对象是 phase13 最终版的全部 14 条 VIOLATED，而非全部诊断或随机抽样。结果：**6 条有源码调用/属性引用，3 条有宿主回调依据，5 条未找到外部静态引用**。前 9 条的“未连通真实入口”确定性结论存在反证；后 5 条只能确认静态检索事实，不能据此确认业务缺陷。

本轮未修改引擎、未重扫、未修改原始扫描结果，未运行三个项目的业务程序。源码哈希仍为 `d045c3b926d18ee3fd896c785251068274ea8c1f413c56d37f01c08f16683265`；三个原仓库的提交及工作树状态均与 phase13 清单一致。结构化逐条证据、文件哈希和扫描文件哈希见 [audit.json](../results/2026-11-13-phase14-audit/audit.json)。可执行 `node benchmark/phase14-audit.mjs` 重新检查出处与哈希；该脚本不重新作出人工判断。

下表路径均相对对应原仓库 `D:/Myproject/crack/<仓库>`；精确行号和原文见 JSON。

| 仓库 / 目标 | 分类 | 核验证据 |
| --- | --- | --- |
| clash-verge-rev / serialize_encrypted | 有属性引用，原结论误报 | `src-tauri/src/config/verge.rs:182,191,200` 的 serialize_with；第 14 行派生 Serialize |
| clash-verge-rev / deserialize_encrypted | 有属性引用，原结论误报 | 同文件 `183,192,201` 的 deserialize_with；派生 Deserialize |
| clash-verge-rev / CoreManager.get_clash_logs | 有实际调用，原结论误报 | `cmd/clash.rs:247` 调用；`ipc.rs:61` 注册；`src/services/bindings.ts:118` invoke |
| clash-verge-rev / Sysopt.refresh_guard | 有实际调用，原结论误报 | `core/proxy_control.rs:592` 调用；`core/manager/lifecycle.rs:608` 等上游调用 |
| clash-verge-rev / SilentUpdater.install_update | 有实际调用，原结论误报 | `cmd/app.rs:68-69` 链式调用；`ipc.rs:21` 注册；bindings 第 30 行 invoke |
| ripgrep / LineBuffer.set_binary_detection | 有实际调用，原结论误报 | `crates/searcher/src/searcher/mod.rs:619` 声明 RefCell<LineBuffer> 字段；第 800 行 borrow_mut 后调用；`crates/core/search.rs:257` 为上游 |
| ripgrep / RipgrepBin.install | 宿主回调，原结论误报 | `pkg/brew/ripgrep-bin.rb:1,16`：Formula 子类实现 install，属于 Homebrew 安装入口 |
| SwitchHosts / cleanHostsList | 未发现外部静态引用 | `src/common/hostsFn.ts:26` 声明；全仓同名检索未发现调用 |
| SwitchHosts / updateOneItem | 未发现外部静态引用 | 同文件第 53 行声明；测试第 62/96 行仅为用例标题，实际导入及调用 setOnStateOfItem |
| SwitchHosts / deleteItemById | 未发现外部静态引用 | 同文件第 178 行声明，第 185 行自递归；未找到外部调用 |
| SwitchHosts / BoundaryLabel.eq | 宿主回调，原结论误报 | `hosts_cm.ts:38,43,85`：WidgetType 子类进入 Decoration.widget；插件在第 271 行加入扩展 |
| SwitchHosts / BoundaryLabel.toDOM | 宿主回调，原结论误报 | 同文件第 47/85 行；`HostsEditor.tsx:209-214` 将构建扩展交给 EditorState / EditorView |
| SwitchHosts / isParent | 未发现外部静态引用 | `src/renderer/components/Tree/fn.ts:155` 声明；isParentIsDragSource 为不同符号 |
| SwitchHosts / getCssVar | 未发现外部静态引用 | `src/renderer/utils/css-var.ts:7` 声明；未找到调用 |

Serde 的属性会选择自定义序列化/反序列化函数，属性字符串不能按普通无引用字符串处理。[Serde 官方属性文档](https://serde.rs/field-attrs.html)

CodeMirror 的 WidgetType 定义了 toDOM 和 eq，内部 compare 会调用 eq。结合此仓库的实例创建、Decoration 和插件注册，可反驳“无接入”的确定性结论；本轮未验证特定文档下是否触发绘制或比较。[CodeMirror 官方源码](https://raw.githubusercontent.com/codemirror/view/main/src/decoration.ts)

Homebrew Formula 由宿主安装流程消费，install 是配方安装方法；仓内没有直接调用不等于失联。本轮没有执行 brew install，也没有核验该历史配方的下载链接或安装成败。[Homebrew Formula Cookbook](https://docs.brew.sh/Formula-Cookbook)

对 5 条未发现外部引用的结论，已检查精确标识符、相关导入及 hostsFn 命名空间消费者。命名空间消费者使用的是 findItemById / flatten，未发现 hostsFn 的动态方括号访问。检索仍不能排除反射、外部消费者、构建转换或未来用途；这里不建议自动删除函数。

此审计只评价“未连通”诊断的证据充分性，不证明目标功能正确，也不能用 9/14 或 5/14 作为项目准确率：样本只含先前被报为 VIOLATED 的项目，且 5 条缺少独立业务真值。INCONCLUSIVE 诊断也未在本轮逐条核验。

接下来应修复 FlowGuard 的调用解析与结论强度：支持有明确类型证据的 Rust 链式接收者；识别有注册上下文的 Serde / CodeMirror / Homebrew 回调；将自动发现但无明确验收目标的未引用导出，与显式要求必须接入却确实断连的目标分别处理。每项修改均需保留删除真实连接后的反向对照，避免仅靠抑制告警获得通过。本报告记录的是已完成核验，尚未实现这些引擎修改。
