// Collect evidence for the exact final source tree. Never borrow old scan counts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const root = 'D:/Myproject/flowguard-validation/2026-11-12-hardening';
const output = 'benchmark/results/2026-11-13-phase11';
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const files = Object.fromEntries(fs.readdirSync('src').filter((f) => f.endsWith('.mjs')).sort()
  .map((f) => [f, hash(fs.readFileSync(`src/${f}`))]));
const sourceHash = hash(JSON.stringify(files));
assert.equal(read(`${root}/phase11-final4-engine/source-manifest.json`).sourceHash, sourceHash);
const measuredManifest = read(`${root}/phase11-final2-engine/source-manifest.json`);
const measuredSourceHash = measuredManifest.sourceHash;
// Delivery cleanup removes only unused internal parameters and their arguments.
for (const file of Object.keys(files)) {
  let measured = fs.readFileSync(`${root}/phase11-final2-engine/src/${file}`, 'utf8');
  if (file === 'js-imports.mjs') measured = measured
    .replace('createConfigLoader(workspaceRoot, configFiles, limitations)', 'createConfigLoader(configFiles, limitations)')
    .replace('createConfigLoader(root, configFiles, limitations)', 'createConfigLoader(configFiles, limitations)');
  if (file === 'rust-imports.mjs') measured = measured
    .replace('externalCrate(node, name, seen)', 'externalCrate(node, name)')
    .replace('externalCrate(node, head, seen)', 'externalCrate(node, head)');
  if (!['file-parser.mjs', 'rust-imports.mjs'].includes(file)) assert.equal(measured, fs.readFileSync(`src/${file}`, 'utf8'), `Unexpected delivery delta: ${file}`);
}
fs.mkdirSync(output, { recursive: true });
const cohorts = ['corpus', 'holdouts', 'new-holdouts'];
const manifests = cohorts.map((name) => read(`${root}/phase11-final2-${name}/manifest.json`));
for (const manifest of manifests) assert.equal(manifest.engine.sourceHash, measuredSourceHash);
const stability = cohorts.flatMap((name) => read(`${root}/phase11-final2-${name}/stability.json`));
const runs = cohorts.flatMap((name) => read(`${root}/phase11-final2-${name}/scan-runs.json`));
for (const row of stability) {
  const original = manifests.flatMap((m) => m.repositories).find((r) => r.name === row.repository);
  assert.equal(row.finalCommit, original.commit);
  assert.equal(row.finalStatus, original.initialStatus);
  assert.equal(row.finalStatus, '');
}
const performance = ['bruno', 'llama'].map((name) => {
  const result = read(`${root}/performance-phase11-final2-${name}/results.json`);
  assert.equal(result.sourceHash, measuredSourceHash);
  return result;
});
// The two large repositories use the identical frozen worker, run serially.
// Count these completed scans once, rather than scanning them again in parallel.
for (const result of performance) {
  const repository = path.basename(result.workspace);
  assert.ok(!stability.some((row) => row.repository === repository));
  assert.equal(result.status, '');
  stability.push({ repository, completed: result.completed, deterministic: result.deterministic,
    verifyMs: result.runs.map((r) => r.verifyMs), finalStatus: result.status,
    finalCommit: result.commit, cohort: 'serial-large-repository' });
  runs.push(...result.runs.map((run) => ({ ...run, repository, run: run.index })));
}
const diagnostics = runs.filter((run) => run.resultHash).map((run) => {
  const scan = read(run.destination);
  return { repository: run.repository, run: run.run, verifyMs: scan.verifyMs,
    totalMs: scan.totalMs, rssMiB: scan.rssMiB, graph: scan.graph,
    status: scan.report.status, verdict: scan.report.verificationVerdict,
    summary: scan.report.summary, resultHash: run.resultHash };
});
const counts = { repositories: stability.length, runs: runs.length,
  completedTwice: stability.filter((r) => r.completed).length,
  deterministic: stability.filter((r) => r.deterministic).length,
  completedRuns: runs.filter((r) => r.exitCode === 0 && r.resultHash).length,
  timeouts: runs.filter((r) => r.timedOut).map((r) => ({ repository: r.repository, run: r.run })) };
for (const name of ['windows24', 'windows18', 'linux22']) {
  const log = fs.readFileSync(`${root}/phase11-final4b-${name}.log`, 'utf8').replaceAll('\0', '');
  assert.match(log, /tests 140/);
  assert.match(log, /pass 140/);
  assert.match(log, /fail 0/);
  assert.match(log, /assertionsVerified["\s:]+72/);
  assert.match(log, /assertionsVerified["\s:]+75/);
  fs.copyFileSync(`${root}/phase11-final4b-${name}.log`, `${output}/tests-${name}.log`);
}
for (const file of ['source-manifest.json']) fs.copyFileSync(`${root}/phase11-final4-engine/${file}`, `${output}/${file}`);
for (const [file, value] of Object.entries({ 'summary.json': { sourceHash, measuredSourceHash, deliveryDelta: 'Unused internal parameters removed and Rust macro templates excluded; six Rust repositories rescanned separately', counts, tests: { assertions: 147, nodeCases: 140 },
  typescriptOracle: read(`${root}/phase11-ts-oracle/results.json`) },
  'stability.json': stability, 'scan-runs.json': runs, 'diagnostics.json': diagnostics,
  'performance.json': performance, 'manifests.json': manifests })) {
  fs.writeFileSync(path.join(output, file), JSON.stringify(value, null, 2));
}
const table = performance.map((p) => `| ${path.basename(p.workspace)} | ${p.runs.map((r) => r.timedOut ? '超时' : `${(r.elapsedMs / 1000).toFixed(2)} s`).join(' | ')} | ${p.deterministic ? '一致' : '未通过'} |`).join('\n');
fs.writeFileSync(`${output}/REPORT.md`, `# FlowGuard phase11 验收记录\n\n交付源码 SHA-256：\`${sourceHash}\`。\n\n大仓与39仓批量测量源码：\`${measuredSourceHash}\`；交付版另清理内部未使用参数，并排除 Rust 宏模板中的虚假声明和导入。所有含 Rust 的六个仓库另做两轮复测；交付版完成跨平台全套测试、自检与打包接入验证。39仓统计与大仓耗时仍明确归属于上述测量源码。\n\n本轮修复：TS/JS 配置继承、配置缓存失效和仅配置变更漏检；Rust 本地路径依赖、重命名 crate、公开重导出和 glob、同包 bin→lib、具体类型接收者及简单零参数链式方法；Vue 模板事件、FastAPI 路由依赖、React Email 模板入口误报。cfg/宏/无法解析的接收者显式保留待确认。\n\nWindows Node 18/24 与 Linux Node 22：147 项场景断言、140 个 Node 测试通过。TypeScript 5.9.3 独立解析对照 7/7 一致，编译器仅用于验证，不增加产品依赖。\n\n单独串行性能复测，每次硬上限仍为 120 秒：\n\n| 仓库 | 第一次进程耗时 | 第二次进程耗时 | 完整报告 |\n| --- | --- | --- | --- |\n${table}\n\n这是上述测量源码的完成时间与重复稳定性记录；没有受控交替基线，不能声称精确加速比例。较早的纯索引候选 Bruno 曾超时，其失败记录保留于 performance-state-index-bruno。索引保留全部匹配条件与文件顺序；克隆比较流式累计准确总数及原顺序前十项，不截断分析范围。\n\n真实仓库复测：${counts.repositories} 个仓库、${counts.runs} 次扫描；${counts.completedTwice} 个仓库两轮完成，${counts.deterministic} 个完整报告一致；${counts.completedRuns} 次完成、${counts.timeouts.length} 次超时。原仓库提交与工作树未改变。批量扫描采用两个并发进程，耗时不能与串行性能结果直接比较。扫描完成或报告一致不表示项目没有问题，也不表示诊断全都准确。\n\n目前适用于辅助代码审查和有明确目标、实际行为测试的验收。尚未实现完整 Rust 编译器类型推导、宏展开、cfg/feature/目标选择及所有动态框架调用；残余诊断需要逐条审阅，不能承诺全局零误报或任意项目生产自动门禁。配置变更会全量检查当前工作区，不伪称历史配置图差异已重建。\n\n原始证据：\`${root}\`。便携摘要见本目录 JSON 与测试日志；源码核查和正反例结果另列于附加验证记录。\n`);
const extraFiles = {
  'framework-source-audit.json': 'framework-source-audit-phase11-final2-complete.json',
  'entry-source-cases.json': 'entry-source-cases-phase11-final2/results.json',
  'new-cases.json': 'new-holdout-cases-phase11-final2/results.json',
  'self-check.json': 'phase11-final4-self.log',
  'package-manifest.json': 'phase11-final4-pack.log'
};
for (const [target, source] of Object.entries(extraFiles)) fs.copyFileSync(`${root}/${source}`, `${output}/${target}`);
const frameworkAudit = read(`${output}/framework-source-audit.json`);
assert.equal(frameworkAudit.checks.length, 14);
assert.ok(frameworkAudit.checks.every((check) => check.passed));
assert.equal(read(`${output}/self-check.json`).status, 'PASS');
const newCases = read(`${output}/new-cases.json`);
assert.equal(newCases.filter((row) => row.variant === 'defect' && row.scans.planned.targetedBlock).length, 3);
assert.equal(newCases.filter((row) => row.variant === 'control' && row.scans.planned.targetedBlock).length, 0);
const mcp = ['windows', 'linux'].map((platform) => {
  const text = fs.readFileSync(`${root}/phase11-final4-mcp-packed-${platform}.log`, 'utf8').replaceAll('\0', '');
  const start = text.search(/\{\r?\n/);
  assert.ok(start >= 0);
  const result = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((row) => row.outcome === 'PASSED'));
  return result;
});
fs.writeFileSync(`${output}/mcp-packed.json`, JSON.stringify(mcp, null, 2));
for (const [file, expected] of Object.entries(files)) assert.equal(hash(fs.readFileSync(`${root}/phase11-final4-package/unpacked/package/src/${file}`)), expected);
fs.appendFileSync(`${output}/REPORT.md`, '\n附加验证：实际 npm 打包源码逐文件哈希与交付版一致。官方 MCP SDK 1.32.2/2.4.0 在 Windows/Linux 均通过打包程序的完整 stdio 流程；项目全量自检 PASS（零义务，不代表业务行为已验证）。14 项真实框架源码核查通过；两对真实 Rust 入口断连及三对扩充数据流案例中，故障均在显式目标验收中阻断，合法对照无相关误阻断。\n');
const rustCohorts = ['rust', 'rust-extra'].map((name) => {
  const directory = `${root}/phase11-final4-${name}`;
  const manifest = read(`${directory}/manifest.json`);
  assert.equal(manifest.engine.sourceHash, sourceHash);
  const rows = read(`${directory}/stability.json`);
  assert.ok(rows.every((row) => row.completed && row.deterministic && row.finalStatus === ''));
  return { manifest, stability: rows, runs: read(`${directory}/scan-runs.json`) };
});
fs.writeFileSync(`${output}/delivery-rust-retests.json`, JSON.stringify(rustCohorts, null, 2));
fs.appendFileSync(`${output}/REPORT.md`, '\n交付版宏模板修复后，六个含 Rust 的真实仓库额外完成 12 次扫描，全部完成且各仓两轮报告一致；原 Axum 宏模板 name.new/from_err 误报已消除。该复测单列于 delivery-rust-retests.json，不与此前 78 次混作同一源码版本。\n');
console.log(JSON.stringify({ output, sourceHash, counts }));
