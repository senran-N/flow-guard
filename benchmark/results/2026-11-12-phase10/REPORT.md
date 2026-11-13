# FlowGuard phase10 验收记录

冻结源码 SHA-256：`0323942c1d88f42755fa890cf5917262e0ca0868fee841bc84800e64203790b5`。

已修复：INCONCLUSIVE 默认显示独立状态、CLI 退出 3（显式 --allow-inconclusive 才兼容返回 0）；MCP 坏消息崩溃、字节分片、通知响应和参数类型校验；JS/TS 路径别名与配置缓存；React 生命周期候选路径；Rust 私有模块重导出、Cargo 自定义入口、src/bin 扫描与 run 名称误判。

Windows Node 18/24 与 Linux Node 22 的 142 项断言、102 个测试通过。官方 MCP SDK 1.32.2/2.4.0 在 Windows/Linux 各完成完整 stdio 流程。打包检查和项目全量自检通过；自检无义务不代表目标行为已验证。

39 个真实仓库：37/39 完成两轮，37 个完整报告一致；74/78 次扫描完成，4 次超时。原仓库提交与工作树均核对未改变。详情见 summary.json、stability.json。扫描与其他任务并发，耗时不能用于受控性能结论。

明确 L2 目标的 10/10 个故障阻断，合法对照 0/10 误阻断；扩充案例结果见 new-cases.json，未运行的 L3 保持待确认。14 项真实框架源码核查通过。案例为已知回归，不能用于全局准确率估计。

性能候选撤回：llama.cpp 四次完整报告一致，候选平均总耗时约改善 3.7%，Bruno 单次候选反而增加约 11.3%。样本小、系统负载未控制，不能确定因果；本轮未保留该优化。原始记录位于 D:/Myproject/flowguard-validation/2026-11-12-hardening/performance-argument-sites-rerun 与 performance-argument-sites-bruno。

当前可用于辅助审查和带明确目标、实际行为测试的验收。大仓库耗时、残余误报、完整 Rust 跨 crate/类型/cfg/宏及 TS 配置继承仍未解决，尚不能声称任意项目生产门禁已完全可用。CLI 退出码 0/1/2/3 分别表示满足或显式兼容、不满足、执行错误、待确认。
