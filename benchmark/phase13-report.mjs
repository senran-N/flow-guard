import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const evidence = path.resolve(process.argv[2] || 'D:/Myproject/flowguard-validation/2026-11-12-hardening');
const output = path.resolve('benchmark/results/2026-11-13-phase13');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hashes = (root) => Object.fromEntries(fs.readdirSync(path.join(root, 'src')).filter((file) => file.endsWith('.mjs')).sort()
  .map((file) => [file, hash(fs.readFileSync(path.join(root, 'src', file)))]));
const sourceFiles = hashes('.'), sourceHash = hash(JSON.stringify(sourceFiles));
const frozen = read(path.join(evidence, 'phase13-final2-engine/source-manifest.json'));
assert.deepEqual(sourceFiles, frozen.files);
assert.equal(sourceHash, frozen.sourceHash);
const cohort = path.join(evidence, 'phase13-final2-rust');
const manifest = read(path.join(cohort, 'manifest.json'));
assert.equal(manifest.engine.sourceHash, sourceHash);
assert.deepEqual(hashes(path.join(cohort, 'engine-snapshot')), sourceFiles);
const stability = read(path.join(cohort, 'stability.json'));
const runs = read(path.join(cohort, 'scan-runs.json'));
assert.equal(stability.length, 6);
assert.equal(runs.length, 12);
for (const item of stability) {
  assert.ok(item.completed && item.deterministic);
  const repo = manifest.repositories.find((repo) => repo.name === item.repository);
  assert.equal(item.finalCommit, repo.commit);
  assert.equal(item.finalStatus, repo.initialStatus);
  const git = (...args) => execFileSync('git', args, { cwd: repo.workspace, encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(git('rev-parse', 'HEAD'), repo.commit);
  assert.equal(git('status', '--porcelain'), repo.initialStatus);
}
for (const run of runs) assert.ok(run.exitCode === 0 && !run.timedOut && run.resultHash);
const packageRoot = path.join(evidence, 'phase13-final2-package');
const packedFiles = hashes(path.join(packageRoot, 'unpacked/package'));
assert.deepEqual(packedFiles, sourceFiles);
const sdk = ['windows', 'linux'].map((platform) => read(path.join(evidence, `phase13-final2-mcp-${platform}.json`)));
for (const item of sdk) {
  assert.equal(item.results.length, 2);
  for (const result of item.results) { assert.equal(result.outcome, 'PASSED'); assert.equal(result.stderr, ''); }
}
const audit = read(path.join(evidence, 'phase13-final2-rust-audit/results.json'));
assert.equal(audit.sourceHash, sourceHash);
assert.equal(audit.checks.length, 7);
assert.equal(audit.compiledControls.length, 5);
for (const control of audit.compiledControls) { assert.equal(control.compilation.exitCode, 0); assert.equal(control.execution.exitCode, 0); }
const cases = read(path.join(evidence, 'entry-source-cases-phase13-final2/results.json'));
assert.equal(cases.sourceHash, sourceHash); assert.equal(cases.results.length, 4);
const self = read(path.join(evidence, 'phase13-final2-self.json'));
assert.equal(self.status, 'PASS'); assert.equal(self.wiringReport.counts.total, 0);
fs.mkdirSync(output, { recursive: true });
for (const platform of ['windows24', 'windows18', 'linux22']) {
  const log = fs.readFileSync(path.join(evidence, `phase13-final2-${platform}.log`), 'utf8');
  assert.match(log, /assertionsVerified":72/); assert.match(log, /assertionsVerified":75/);
  assert.match(log, /(?:#|ℹ) tests 156\b/); assert.match(log, /(?:#|ℹ) pass 156\b/); assert.match(log, /(?:#|ℹ) fail 0\b/);
  fs.writeFileSync(path.join(output, `tests-${platform}.log`), log);
}
const observations = stability.map((item) => {
  const beforeDir = 'phase12-final-rust';
  const before = read(path.join(evidence, beforeDir, 'scans', `${item.repository}.1.json`));
  const after = read(path.join(cohort, 'scans', `${item.repository}.1.json`));
  return { repository: item.repository, previousSourceHash: '3cbb11a8c479e01def64ef3ca8504751fa8c8fee1c0fc2d5e1b58e1d351b3927',
    before: before.report.wiringReport.counts, after: after.report.wiringReport.counts, verdict: after.report.verificationVerdict };
});
const summary = { sourceHash, tests: { assertions: 147, nodeCases: 156, environments: ['Windows Node 18.20.8', 'Windows Node 24.14.0', 'WSL Ubuntu 24.04 Node 22.23.3'] },
  repositories: 6, scans: 12, completed: 12, deterministicRepositories: 6, timeouts: 0,
  compiledControls: 5, sourceChecks: 7, sourceMutationPairs: 2, packageSourceMatches: true,
  archiveSha256: hash(fs.readFileSync(path.join(packageRoot, 'flow-guard-0.2.0.tgz'))), selfCheck: 'PASS_WITH_ZERO_OBLIGATIONS' };
for (const [name, value] of Object.entries({ summary, 'source-manifest': frozen, manifest, stability, 'scan-runs': runs,
  'mcp-packed': sdk, 'rust-source-audit': audit, 'entry-source-cases': cases, observations })) fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify(value, null, 2));
const rows = observations.map((item) => `| ${item.repository} | ${item.before.violated} | ${item.after.violated} | ${item.after.inconclusive} |`).join('\n');
const report = `# FlowGuard phase13 Rust 模块分区复测

交付源码 SHA-256：\`${sourceHash}\`。本报告仅将同一最终源码的测试、六仓复测和实际打包接入作为交付证据。

已修复：从实际 Cargo bin/lib 根沿 mod 声明判断模块分区，正常源码不会仅因 \`_test.rs\` 后缀被误分为测试。保留 tests/fixtures 路径、独立测试属性、test-only 模块祖先及文件内部 cfg 的边界。构图从路径基线重算，避免污染解析缓存。模块路径与调用解析共享候选规则，并修正普通源文件和自定义根中的嵌套 path 属性。

仅控制 lint、文档、feature gate 或 Windows 子系统的 cfg_attr 不再被当作代码选择条件。影响 cfg/path 或无法解析的 cfg_attr 继续保守处理。这个分类不选择实际 Cargo features，也不执行宏展开。

Windows Node 18/24、WSL Ubuntu 24.04 Node 22：三套完整测试均通过 **147 项场景断言及 156 个 Node 测试**。新增 11 个测试覆盖模块分区、自定义根、同文件重复 mod、嵌套路径、属性字符串、内部属性、缓存重建及真实测试依赖阻断。

六个真实仓库各扫描两次，共 **12 次完成、0 次超时、6 仓完整报告各自一致**；复核原仓库提交和工作树未改变。采用两个并发工作进程，耗时不用于性能对比。

| 仓库 | 上一版违反数 | 本版违反数 | 本版待确认数 |
| --- | --- | --- | --- |
${rows}

告警数量变化不是准确率。七项真实 Axum 源码核查通过：包含上一轮的调用/候选边与本轮的 \`axum_test.rs\` 分区修正；该文件由实际 Cargo 库模块树声明，原跨测试区候选误报已消除。Axum 当前仍为 INCONCLUSIVE，不能当作项目验收通过。

独立 Rust 编译执行对照 **5/5**（\`${audit.rustVersion}\`）：构造函数、成员委托、回调执行，以及文件名带 test 的普通模块可编译、真实 test-only 模块/函数在普通构建中排除。另以编译器核对两种嵌套 path 规则。模块语义依据 [Rust Reference](https://doc.rust-lang.org/reference/items/modules.html)。这些小程序不代表完整编译器一致性；实际 Axum 未执行完整 Cargo 测试。

完整 pot-desktop 源码副本的两对入口断连案例已复验：直接调用 control 的显式目标为 SATISFIED；回调 control 为 INCONCLUSIVE；删除连接的显式目标均 VIOLATED。全量/增量合法对照无目标误阻断；未运行 Tauri 业务程序。

实际 npm 包的每个源码文件哈希与交付版一致；官方 MCP SDK 1.32.2 与 2.4.0 在 Windows/Linux 均通过打包入口的完整 stdio 流程。自检 PASS、零义务，不代表行为测试已通过。

仍有边界：完整 Rust 类型推导、字段类型链、泛型/宏展开、cfg/feature 选择和任意高阶函数执行语义尚未覆盖。其他仓库的残余违反需逐条审阅。适用于辅助代码审查与明确目标的验收，不能承诺任意项目自动门禁或全局零误报。

本轮未重跑其余 33 个仓库或 Bruno/llama.cpp 性能。历史 39 仓/大仓数据保留在 [phase11 报告](../2026-11-13-phase11/REPORT.md)，上一轮调用修复见 [phase12](../2026-11-13-phase12/REPORT.md)，不归入本版测量。初版因 Windows 子系统属性误判而失败的真实断连回归保留在 entry-source-cases-phase13；最终源码已修正并在 entry-source-cases-phase13-final2 全量重验。原始证据位于 \`${evidence.replaceAll('\\', '/')}\`。
`;
fs.writeFileSync(path.join(output, 'REPORT.md'), report);
console.log(JSON.stringify(summary));
