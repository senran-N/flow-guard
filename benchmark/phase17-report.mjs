import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const evidence = 'D:/Myproject/flowguard-validation/2026-11-12-hardening';
const cohort = path.join(evidence, 'phase17-final-validation');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const manifest = read(path.join(cohort, 'manifest.json'));
const hashes = root => Object.fromEntries(fs.readdirSync(path.join(root, 'src')).filter(file => file.endsWith('.mjs')).sort()
  .map(file => [file, hash(fs.readFileSync(path.join(root, 'src', file)))]));
assert.deepEqual(hashes('.'), manifest.engine.files);
assert.deepEqual(hashes(path.join(evidence, 'phase17-final-package/package')), manifest.engine.files);
const tests = ['windows', 'node18', 'wsl'].map(platform => {
  const file = path.join(evidence, `phase17-release-tests-${platform}.log`), bytes = fs.readFileSync(file), text = bytes.toString('utf8').replaceAll('\0', '');
  assert.match(text, /(?:pass |# pass )180/); assert.match(text, /(?:fail |# fail )0/);
  assert.equal((text.match(/ALL_PASSED/g) || []).length, 2);
  return { platform, nodeTests: 180, scenarioAssertions: 147, file, sha256: hash(bytes) };
});
const repositories = manifest.repositories.map(repo => {
  const result = read(path.join(cohort, repo.name, 'results.json'));
  assert.equal(result.sourceHash, manifest.engine.sourceHash);
  assert.ok(result.completed && result.deterministic);
  assert.equal(result.runs.length, 2);
  assert.ok(result.runs.every(run => !run.timedOut && run.exitCode === 0));
  const git = (...args) => execFileSync('git', ['-C', repo.workspace, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(git('rev-parse', 'HEAD'), repo.commit); assert.equal(git('status', '--porcelain'), repo.initialStatus);
  return { name: repo.name, commit: repo.commit, counts: read(path.join(cohort, repo.name, '1.json')).report.wiringReport.counts,
    timesMs: result.runs.map(run => run.elapsedMs), resultHash: result.runs[0].resultHash };
});
const pot = read(path.join(evidence, 'entry-source-cases-phase17-final2/results.json'));
const clash = read(path.join(evidence, 'phase17-final-clash-pairs/results.json'));
for (const pair of [pot, clash]) assert.equal(pair.sourceHash, manifest.engine.sourceHash);
for (const item of pot.results.filter(item => item.variant === 'defect')) {
  assert.ok(item.modes.incremental.targetStatuses.includes('VIOLATED'));
  assert.ok(item.modes.planned.targetStatuses.includes('VIOLATED'));
}
for (const item of clash.results) {
  assert.deepEqual(item.statuses, [item.variant === 'defect' ? 'VIOLATED' : 'SATISFIED']);
  if (item.variant === 'defect') assert.ok(item.incremental.includes('VIOLATED'));
}
const native = read(path.join(evidence, 'phase17-native-repro/results.json'));
assert.equal(native.outcome, 'PASSED'); assert.equal(native.beforeHosts, native.afterHosts);
assert.equal(native.runs.length, 2); assert.ok(native.runs.every(run => run.outcome === 'PASSED'));
assert.equal(native.runs[0].probe.value.count, 2); assert.equal(native.runs[1].readyCallback, false);
const semantic = read(path.join(evidence, 'phase17-native-repro/semantic-frozen.json')).rustSemantics;
assert.equal(semantic.outcome, 'COMPLETED'); assert.equal(semantic.queries, 636); assert.equal(semantic.mappedEdges.length, 1039);
const oracles = read(path.join(evidence, 'phase17-final-semantic-oracles/results.json'));
assert.equal(oracles.length, 2); assert.ok(oracles.every(item => item.outcome === 'PASSED'));
const sdk = ['windows', 'linux'].map(platform => {
  const result = read(path.join(evidence, `phase17-final-package/mcp-sdk-${platform}-final.json`));
  assert.equal(result.results.length, 2); assert.ok(result.results.every(item => item.outcome === 'PASSED'));
  return result;
});
const output = 'benchmark/results/2026-11-13-phase17'; fs.mkdirSync(output, { recursive: true });
const summary = { sourceHash: manifest.engine.sourceHash, evidence, tests, repositories, pot, clash, native,
  rustSemantics: { outcome: semantic.outcome, version: semantic.version, settings: semantic.settings, queries: semantic.queries,
    mappedEdges: semantic.mappedEdges.length, unmapped: semantic.unmapped.length, macroInvocations: semantic.macroInvocations,
    previewedMacroInvocations: semantic.expansions.length, completeCallGraph: false }, oracles, sdk };
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(output, 'REPORT.md'), `# Phase17：Rust 编译语义与真实桌面回调验证

引擎 SHA-256：\`${manifest.engine.sourceHash}\`。冻结源码、当前源码和 npm 包源码逐文件一致。外部完整日志：\`${evidence}\`。

## 1. Rust 深层语义

新增可选 rust-analyzer LSP 后端：\`verify --full --rust-semantic\`。支持显式选择 Cargo features、默认 feature 开关和 target；\`--rust-build-scripts\` 才启用构建脚本与过程宏。超时会清理整个进程树，缺失工具或超时报告执行错误。输入在分析期间变化则丢弃语义结果。语义补充只用于当前 checkout 的全量分析，禁止与 Git 历史图比较混用，不进入普通缓存或保存基线。

本地真实 Cargo/过程宏 oracle 在默认与 extra feature 两种配置下均通过：复杂 Box 类型别名和过程宏工厂返回类型各解析出一处 execute 调用；动态 trait 找到一个实现候选且保持 MEDIUM；两个 feature 分别选择正确的 enabled 声明。实际 cargo run 每次打印 3 次 execute。过程宏内部的第三次调用可在展开预览看见，尚无独立源码调用边，未声称完整调用图。

完整 SwitchHosts 源码副本：Rust 构建检查与前端构建成功；冻结引擎语义查询 **636 个生产函数，映射 1039 条引用边**。32 个引用不能唯一映射；1628 处宏调用中预览前 512 处。工具版本 ${semantic.version.version}。全仓结论仍为 INCONCLUSIVE：语义补充不覆盖所有动态行为。

## 2. 真实宿主回调

复现：\`node benchmark/phase17-native-runtime.mjs D:/Myproject/crack/SwitchHosts D:/path/to/new-evidence\`。

使用完整 SwitchHosts 提交 \`${native.original.commit}\` 的源码副本和实际 Tauri/Windows WebView2 进程。Vite 仅提供实际前端模块，IPC 走真实 Rust 宿主；未注入上游 tauri-mock。测试驱动创建带边界标记的实际 CodeMirror 编辑器，执行上游 BoundaryLabel.toDOM，得到 2 次调用及两个预期标签；真实 IPC ping 返回 pong；原窗口就绪监听器留下执行记录。

删除编辑器扩展的对照出现 0 次 toDOM，断言失败。删除 commands::ping 与窗口就绪监听器注册后重新编译桌面二进制：实际 IPC 报 Command ping not found，监听器执行记录不存在，反例被检出。独立数据目录、独立 WebView2 数据目录及应用标识用于隔离；原仓库状态与系统 hosts 内容哈希前后一致。

完整脚本已从新目录重跑通过。业务接线和回调体保留上游实现；副本修改包括路径隔离、计数/执行记录、测试驱动，以及负例注册删除。这是被触发路径的实际运行证据，不是原发行二进制全功能认证，也未覆盖 Pot/Clash 的所有桌面回调、所有平台或权限流程。

## 回归与交付

- Windows Node24、Windows Node18、WSL Node22：各 **180 个 Node 测试 + 147 项场景断言**全部通过。
- 6 个真实仓库各扫描 2 次：无超时，重复结果一致，原仓库未改动。
- Pot 两组、Clash 三组完整源码控制/删除对照：五组删除在显式计划和增量检查中均被检出；Pot 托盘控制仍保留实际运行未覆盖的不确定性。
- MCP SDK 1.32.2 / 2.4.0 在 Windows/Linux 启动打包入口通过，包括新增语义参数、非 Rust 项目和历史比较限制检查。
- 新发现并修正构建后扫描把 build-tauri 中压缩产物当源码的问题，增加回归测试。

| 仓库 | VIOLATED | INCONCLUSIVE | 两次耗时 ms |
|---|---:|---:|---|
${repositories.map(repo => `| ${repo.name} | ${repo.counts.violated} | ${repo.counts.inconclusive} | ${repo.timesMs.join(' / ')} |`).join('\n')}

这些数据不构成总体准确率：未对所有真实告警建立独立人工真值集。任意宏生成源码、动态分发的具体运行目标、未执行的宿主路径仍需报告待确认。旧版本的大语料性能结论不自动适用于本版本。

工具配置依据：[rust-analyzer 官方配置](https://rust-analyzer.github.io/book/configuration.html)、[Tauri 官方宿主测试说明](https://tauri.app/develop/tests/webdriver/)。本次实际使用 WebView2 CDP 连接真实宿主，未使用 WebDriver。
`);
console.log(JSON.stringify({ output, sourceHash: manifest.engine.sourceHash, tests: 180, native: native.outcome }));
