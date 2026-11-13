import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const evidence = 'D:/Myproject/flowguard-validation/2026-11-12-hardening';
const cohort = path.join(evidence, 'phase15-validation');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sourceFiles = root => Object.fromEntries(fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.mjs')).sort().map(f => [f, hash(fs.readFileSync(path.join(root, 'src', f)))]));
const manifest = read(path.join(cohort, 'manifest.json'));
assert.deepEqual(sourceFiles('.'), manifest.engine.files);
assert.deepEqual(sourceFiles(path.join(evidence, 'phase15-package/package')), manifest.engine.files);
assert.equal(hash(JSON.stringify(manifest.engine.files)), manifest.engine.sourceHash);
const output = 'benchmark/results/2026-11-13-phase15';
fs.mkdirSync(output, { recursive: true });
const repositories = manifest.repositories.map(repo => {
  const results = read(path.join(cohort, repo.name, 'results.json'));
  assert.equal(results.sourceHash, manifest.engine.sourceHash);
  assert.ok(results.completed && results.deterministic);
  assert.equal(results.runs.length, 2);
  const report = read(path.join(cohort, repo.name, '1.json')).report;
  assert.equal(execFileSync('git', ['-C', repo.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), repo.commit);
  assert.equal(execFileSync('git', ['-C', repo.workspace, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), repo.initialStatus);
  return { name: repo.name, commit: repo.commit, counts: report.wiringReport.counts, deterministic: true, runs: results.runs };
});
const old = read('benchmark/results/2026-11-13-phase14-audit/audit.json');
const residuals = old.findings.map(finding => {
  const report = read(path.join(cohort, finding.repository, '1.json')).report;
  const matches = report.wiringReport.obligations.filter(o => [finding.target, finding.target.replace(/-\d+ /, ' ')].includes(o.targetLocation));
  assert.equal(matches.length, 1); assert.equal(matches[0].status, 'INCONCLUSIVE');
  return { repository: finding.repository, target: finding.target, previousClassification: finding.classification, status: matches[0].status, finding: matches[0].finding, evidence: matches[0].evidence };
});
const testLogs = ['phase15-tests-final.log', 'phase15-tests-node18.log', 'phase15-tests-linux.log'];
for (const log of testLogs) {
  const text = fs.readFileSync(path.join(evidence, log), 'utf8').replaceAll('\0', '');
  assert.match(text, /ALL_PASSED/); assert.match(text, /(?:pass |# pass )164/);
  assert.match(text, /(?:fail |# fail )0/);
}
const cases = read(path.join(evidence, 'entry-source-cases-phase15-final2/results.json'));
assert.equal(cases.sourceHash, manifest.engine.sourceHash); assert.equal(cases.results.length, 4);
for (const result of cases.results.filter(c => c.variant === 'defect')) assert.deepEqual(result.modes.planned.targetStatuses, ['VIOLATED']);
const mcp = read(path.join(evidence, 'phase15-package/mcp.json'));
assert.equal(mcp.results.length, 2); assert.ok(mcp.results.every(r => r.outcome === 'PASSED'));
const mcpLinux = read(path.join(evidence, 'phase15-package/mcp-linux.json'));
assert.equal(mcpLinux.results.length, 2); assert.ok(mcpLinux.results.every(r => r.outcome === 'PASSED'));
const summary = { sourceHash: manifest.engine.sourceHash, tests: { scenarioAssertions: 147, nodeTests: 164,
  environments: ['Windows Node 24.14.0', 'Windows Node 18.20.8', 'WSL Linux Node 22.23.3'], logs: testLogs },
  repositories, residuals, sourceMutationCases: cases.results, mcpWindows: mcp, mcpLinux,
  testLogHashes: Object.fromEntries(testLogs.map(log => [log, hash(fs.readFileSync(path.join(evidence, log)))])),
  packageSha256: hash(fs.readFileSync(path.join(evidence, 'phase15-package/flow-guard-0.2.0.tgz'))), packageSourcesMatch: true };
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(output, 'source-manifest.json'), JSON.stringify(manifest.engine, null, 2));
fs.writeFileSync(path.join(output, 'REPORT.md'), `# FlowGuard phase15：入口证据修复\n\n源码 SHA-256：\`${manifest.engine.sourceHash}\`。\n\n修复 Rust 多行链式方法遗漏：有唯一具体工厂返回类型时建立类型调用边；类型未知、同一行混合调用、复杂绑定及宏生成方法保留候选，不按名称建立执行边。Serde 跨模块属性按 Rust 导入作用域解析；CodeMirror WidgetType 与 Homebrew Formula 回调记录宿主候选，均不作为运行时根或已执行证明。\n\n全量扫描缺少任务上下文时，无静态引用导出改为 INCONCLUSIVE，保留名称、位置及审查建议。显式蓝图目标与 Git 新增功能/删除连接的检查仍保留违反结论。\n\n三套完整测试均通过：**147 项场景断言 + 164 个 Node 测试**。新增 8 个测试包括具体返回类型、未知接收者、跨模块同名隔离、属性移除、伪造框架、字符串、同一行混合链及删除调用对照。部分旧测试改用显式目标验证阻断语义，未将明确断连改为通过。Windows/Linux 实际 npm 包入口通过官方 MCP SDK 1.32.2 / 2.4.0 的完整 stdio 流程，包内全部源码哈希与冻结版一致。\n\n六仓各扫描两次，**12 次完成、0 超时、6 仓完整报告各自一致**；原仓库提交与工作树均未改变。\n\n| 仓库 | VIOLATED | INCONCLUSIVE |\n| --- | --- | --- |\n${repositories.map(r => `| ${r.name} | ${r.counts.violated} | ${r.counts.inconclusive} |`).join('\n')}\n\n原 14 条残余全部逐项匹配为 INCONCLUSIVE：6 条调用/属性引用、3 条宿主回调、5 条未发现外部引用。具体返回类型修复由独立对照覆盖；真实 Clash 的宏生成 singleton 接收者和 ripgrep 字段包装链仍未获得完整类型证明。**违反数归零包含判定策略变化，不代表准确率提高或所有功能通过。**\n\n完整 Pot 源码副本的两对连接删除对照：直接调用 control 的显式目标 SATISFIED，回调 control 为 INCONCLUSIVE；删除连接后的两个显式目标均 VIOLATED。全量无任务上下文的 defect 为 INCONCLUSIVE；直接调用删除的增量为 VIOLATED；回调删除的增量仍 INCONCLUSIVE。未运行 Tauri 程序。初次对照因旧脚本要求全量无目标也必须失败而停止，旧证据保留；更新脚本的全量期望后，新目录重跑且显式目标的失败断言保持不变。\n\n适用于辅助审查及明确目标验收。尚不支持任意宏展开、完整 Rust 类型推导、动态宿主执行或任意项目自动门禁。其余 33 仓和 Bruno/llama.cpp 性能本轮未复测。详见 [结构化证据](summary.json)；本地完整证据位于 \`${evidence}\`。\n`);
console.log(JSON.stringify({ sourceHash: summary.sourceHash, scans: 12, nodeTests: 164, residuals: residuals.length, report: output + '/REPORT.md' }));
