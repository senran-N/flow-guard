import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const root = 'D:/Myproject/flowguard-validation/2026-11-12-hardening';
const baseline = 'D:/Myproject/flowguard-validation/2026-11-11-v020';
const output = 'benchmark/results/2026-11-12-phase10';
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const files = Object.fromEntries(fs.readdirSync('src').filter((f) => f.endsWith('.mjs')).sort().map((f) => [f, hash(fs.readFileSync('src/' + f))]));
const sourceHash = hash(JSON.stringify(files));
fs.mkdirSync(output, { recursive: true });
const cohorts = ['corpus', 'holdouts', 'new-holdouts'];
const manifests = cohorts.map((c) => read(`${root}/phase10-${c}/manifest.json`));
for (const manifest of manifests) assert.equal(manifest.engine.sourceHash, sourceHash);
const stability = cohorts.flatMap((c) => read(`${root}/phase10-${c}/stability.json`));
for (const row of stability) {
  assert.equal(row.finalStatus, '');
  const repo = manifests.flatMap((m) => m.repositories).find((r) => r.name === row.repository);
  assert.equal(row.finalCommit, repo.commit);
  const git = (...args) => execFileSync('git', args, { cwd: repo.workspace, encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('rev-parse', 'HEAD'), repo.commit);
}
const runs = cohorts.flatMap((c) => read(`${root}/phase10-${c}/scan-runs.json`));
const plans = read(`${baseline}/explicit-plans-phase10/results.json`);
assert.equal(plans.length, 20);
assert.equal(plans.filter((p) => p.variant === 'defect' && p.targetedViolation).length, 10);
assert.equal(plans.filter((p) => p.variant === 'control' && p.targetedViolation).length, 0);
const added = read(`${root}/new-holdout-cases-phase10/results.json`);
assert.equal(added.length, 6);
assert.equal(added.filter((r) => r.variant === 'defect' && r.scans.planned.targetedBlock).length, 3);
assert.equal(added.filter((r) => r.variant === 'control' && r.scans.planned.targetedBlock).length, 0);
const entry = read(`${root}/entry-source-cases-phase10/results.json`);
assert.equal(entry.sourceHash, sourceHash);
assert.equal(entry.results.filter((r) => r.variant === 'defect' && r.modes.planned.targetStatuses.includes('VIOLATED')).length, 2);
assert.equal(entry.results.filter((r) => r.variant === 'control' && r.modes.planned.targetStatuses.includes('VIOLATED')).length, 0);
for (const directory of [`${baseline}/mutations/copies`]) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true }).filter((item) => item.isDirectory())) {
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: path.join(directory, item.name), encoding: 'utf8', windowsHide: true }).trim(), '');
  }
}
for (const file of ['mcp-windows-final.json', 'mcp-linux-final.json', 'packaged-mcp.json']) {
  const result = read(`${root}/phase10-validation/${file}`);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((item) => item.outcome === 'PASSED'));
}
const counts = {
  repositories: stability.length, completedTwice: stability.filter((r) => r.completed).length,
  deterministic: stability.filter((r) => r.deterministic).length,
  runs: runs.length, completedRuns: runs.filter((r) => r.exitCode === 0 && r.resultHash).length,
  timeouts: runs.filter((r) => r.timedOut).map((r) => ({ repository: r.repository, run: r.run })),
  explicitL2FaultsBlocked: 10, explicitL2Faults: 10, explicitL2ControlsBlocked: 0,
  newCases: added.length
};
const linux = read(`${root}/phase10-validation/linux-run.json`); assert.equal(linux.exitCode, 0);
const diagnosticRows = manifests.flatMap((manifest) => manifest.repositories.map((repo) => {
  const file = `${manifest.output}/scans/${repo.name}.1.json`;
  if (!fs.existsSync(file)) return { repository: repo.name, timedOut: true };
  const scan = read(file);
  return { repository: repo.name, verifyMs: scan.verifyMs, verdict: scan.report?.verificationVerdict,
    violated: scan.report?.summary.obligationsViolated, inconclusive: scan.report?.summary.obligationsInconclusive };
}));
for (const file of ['npm-test-final.txt', 'node18-final.txt', 'linux22-confirmed.txt']) {
  const log = fs.readFileSync(`${root}/phase10-validation/${file}`, 'utf8');
  assert.match(log, /(?:pass 102|# pass 102)/);
  assert.match(log, /(?:fail 0|# fail 0)/);
}
const summary = { sourceHash, files, counts, diagnostics: diagnosticRows, linux,
  tests: { assertions: 142, nodeCases: 102, windowsNode: [18, 24], linuxNode: [22] },
  limitations: ['Large-repository latency remains unresolved', 'No global precision or recall claim',
    'Rust cross-crate/type/cfg/macro resolution remains incomplete', 'TypeScript config inheritance remains unresolved',
    'Corpus scans overlapped other tests; timing is not a controlled benchmark'] };
for (const [name, data] of Object.entries({ 'summary.json': summary, 'manifests.json': manifests,
  'scan-runs.json': runs, 'stability.json': stability, 'plans.json': plans, 'new-cases.json': added })) {
  fs.writeFileSync(path.join(output, name), JSON.stringify(data, null, 2));
}
for (const name of ['npm-test-final.txt', 'node18-final.txt', 'linux22-confirmed.txt', 'mcp-windows-final.json',
  'mcp-linux-final.json', 'self-full.json', 'package-dry-run.json', 'linux-run.json', 'packaged-mcp.json', 'package-final.json']) {
  fs.copyFileSync(`${root}/phase10-validation/${name}`, path.join(output, name));
}
fs.copyFileSync(`${root}/framework-source-audit-phase10.json`, `${output}/framework-source-audit.json`);
fs.copyFileSync(`${root}/entry-source-cases-phase10/results.json`, `${output}/entry-source-cases.json`);
fs.writeFileSync(`${output}/REPORT.md`, `# FlowGuard phase10 验收记录\n\n冻结源码 SHA-256：\`${sourceHash}\`。\n\n已修复：INCONCLUSIVE 默认显示独立状态、CLI 退出 3（显式 --allow-inconclusive 才兼容返回 0）；MCP 坏消息崩溃、字节分片、通知响应和参数类型校验；JS/TS 路径别名与配置缓存；React 生命周期候选路径；Rust 私有模块重导出、Cargo 自定义入口、src/bin 扫描与 run 名称误判。\n\nWindows Node 18/24 与 Linux Node 22 的 142 项断言、102 个测试通过。官方 MCP SDK 1.32.2/2.4.0 在 Windows/Linux 各完成完整 stdio 流程。打包检查和项目全量自检通过；自检无义务不代表目标行为已验证。\n\n39 个真实仓库：${counts.completedTwice}/39 完成两轮，${counts.deterministic} 个完整报告一致；${counts.completedRuns}/${counts.runs} 次扫描完成，${counts.timeouts.length} 次超时。原仓库提交与工作树均核对未改变。详情见 summary.json、stability.json。扫描与其他任务并发，耗时不能用于受控性能结论。\n\n明确 L2 目标的 10/10 个故障阻断，合法对照 0/10 误阻断；扩充案例结果见 new-cases.json，未运行的 L3 保持待确认。14 项真实框架源码核查通过。案例为已知回归，不能用于全局准确率估计。\n\n性能候选撤回：llama.cpp 四次完整报告一致，候选平均总耗时约改善 3.7%，Bruno 单次候选反而增加约 11.3%。样本小、系统负载未控制，不能确定因果；本轮未保留该优化。原始记录位于 ${root}/performance-argument-sites-rerun 与 performance-argument-sites-bruno。\n\n当前可用于辅助审查和带明确目标、实际行为测试的验收。大仓库耗时、残余误报、完整 Rust 跨 crate/类型/cfg/宏及 TS 配置继承仍未解决，尚不能声称任意项目生产门禁已完全可用。CLI 退出码 0/1/2/3 分别表示满足或显式兼容、不满足、执行错误、待确认。\n`);
console.log(JSON.stringify({ output, sourceHash, counts }));
