import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const evidence = 'D:/Myproject/flowguard-validation/2026-11-12-hardening';
const cohort = path.join(evidence, 'phase16-final3-validation'), pkg = path.join(evidence, 'phase16-final3-package');
const output = 'benchmark/results/2026-11-13-phase16';
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const manifest = read(path.join(cohort, 'manifest.json'));
const hashes = root => Object.fromEntries(fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.mjs')).sort().map(f => [f, hash(fs.readFileSync(path.join(root, 'src', f)))]));
assert.deepEqual(hashes('.'), manifest.engine.files);
assert.deepEqual(hashes(path.join(pkg, 'package')), manifest.engine.files);
assert.equal(hash(JSON.stringify(manifest.engine.files)), manifest.engine.sourceHash);
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const repositories = manifest.repositories.map(repo => {
  assert.equal(git(repo.workspace, 'rev-parse', 'HEAD'), repo.commit); assert.equal(git(repo.workspace, 'status', '--porcelain'), repo.initialStatus);
  const runs = read(path.join(cohort, repo.name, 'results.json'));
  assert.equal(runs.sourceHash, manifest.engine.sourceHash); assert.ok(runs.completed && runs.deterministic);
  assert.equal(runs.runs.length, 2); assert.ok(runs.runs.every(r => r.exitCode === 0 && !r.timedOut));
  return { name: repo.name, commit: repo.commit, counts: read(path.join(cohort, repo.name, '1.json')).report.wiringReport.counts, runs };
});
const tests = ['phase16-tests-final3.log', 'phase16-tests-final3-node18.log', 'phase16-tests-final3-linux.log'].map(file => {
  const bytes = fs.readFileSync(path.join(evidence, file)), text = bytes.toString('utf8').replaceAll('\0', '');
  assert.match(text, /ALL_PASSED/); assert.match(text, /(?:pass |# pass )173/); assert.match(text, /(?:fail |# fail )0/);
  return { file, sha256: hash(bytes), nodeTests: 173, scenarioAssertions: 147 };
});
const pot = read(path.join(evidence, 'entry-source-cases-phase16-final3/results.json'));
const clash = read(path.join(evidence, 'phase16-final3-clash-pairs/results.json'));
const probes = read(path.join(evidence, 'phase16-final3-compiler-probes/results.json'));
for (const result of [pot, clash, probes]) assert.equal(result.sourceHash, manifest.engine.sourceHash);
assert.equal(pot.results.length, 4); assert.equal(clash.results.length, 6); assert.equal(probes.results.length, 6);
for (const item of pot.results.filter(r => r.variant === 'defect')) {
  assert.ok(item.modes.incremental.targetStatuses.includes('VIOLATED')); assert.deepEqual(item.modes.planned.targetStatuses, ['VIOLATED']);
}
for (const item of clash.results) {
  assert.deepEqual(item.statuses, [item.variant === 'control' ? 'SATISFIED' : 'VIOLATED']);
  if (item.variant === 'defect') assert.ok(item.incremental.includes('VIOLATED'));
}
const mcp = ['mcp.json', 'mcp-linux.json'].map(file => read(path.join(pkg, file)));
for (const result of mcp) { assert.equal(result.results.length, 2); assert.ok(result.results.every(r => r.outcome === 'PASSED')); }
const { buildWorkspaceFlowGraph, clearFlowGraphCache } = await import(pathToFileURL(path.join(cohort, 'engine-snapshot/src/graph-builder.mjs')));
const sourceAudit = [];
for (const repo of ['clash-verge-rev', 'ripgrep']) {
  const graph = buildWorkspaceFlowGraph(path.join('D:/Myproject/crack', repo), true);
  const targets = repo === 'clash-verge-rev' ? ['CoreManager.get_clash_logs', 'Sysopt.refresh_guard', 'SilentUpdater.install_update'] : ['LineBuffer.set_binary_detection'];
  for (const name of targets) {
    const target = [...graph.symbolById.values()].find(s => `${s.parentContainerName}.${s.name}` === name);
    assert.ok(target); const edges = graph.inEdgeDetails.get(target.id).filter(e => e.resolution.mode === 'RUST_TYPED_RECEIVER' && e.resolution.confidence === 'HIGH');
    assert.ok(edges.length); if (repo === 'clash-verge-rev') assert.ok(graph.reachableFromRuntimeSource.has(target.id));
    sourceAudit.push({ repository: repo, target: name, file: target.file, line: target.startLine,
      runtimeReachable: graph.reachableFromRuntimeSource.has(target.id), sourceReachable: graph.reachableFromSource.has(target.id), edges });
  }
  clearFlowGraphCache();
}
const summary = { sourceHash: manifest.engine.sourceHash, tests, repositories, sourceAudit, pot, clash, probes, mcp,
  archiveSha256: hash(fs.readFileSync(path.join(pkg, 'flow-guard-0.2.0.tgz'))), packageSourcesMatch: true,
  limits: ['Nominal type flow and simple declarative factory signatures only; not complete Rust typing, procedural macros, arbitrary trait dispatch or arbitrary cfg selection.',
    'Callback registration is structural evidence, not execution. Local synchronous direct-invoker bodies can provide call edges; external host execution still requires real tests.',
    'No Tauri desktop business runtime tests or complete upstream Cargo builds; no fresh 39-repository/performance/independent accuracy claim.',
    'Historical saved baselines without callback candidate fields cannot reconstruct these facts; create a fresh baseline after upgrading. Git baselines are reconstructed by the current engine.'] };
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(output, 'source-manifest.json'), JSON.stringify(manifest.engine, null, 2));
fs.writeFileSync(path.join(output, 'REPORT.md'), `# Phase16：Rust 类型与回调断连修复\n\n源码 SHA-256：\`${summary.sourceHash}\`。仅下列最终源码证据计入交付；其他预览目录不计入。\n\n修复了命名字段、具体泛型参数替换、支持的标准库包装类型与受限声明宏工厂签名。宏签名来自实际定义和调用，不按 singleton 名称假设；遵守导入、crate、模块作用域、cfg 和重复候选边界。真实 Clash 的 CoreManager.get_clash_logs、Sysopt.refresh_guard、SilentUpdater.install_update 均有确定类型调用边及运行入口可达路径。ripgrep 的 LineBuffer.set_binary_detection 有来自 Searcher 字段包装链的确定调用边；这不证明整个 ripgrep 的运行行为。\n\n回调注册与执行分开建模：接收函数可解析且同步直接调用参数时，记录静态调用边；存储、条件分支、遮蔽、未轮询 async future 和未知外部宿主保持候选。快照保存回调注册候选，删除最后生产连接时生成明确结构断连；保留替代注册、迁移调用和无关格式修改不报此类断连。Serde/CodeMirror 等已记录框架候选的移除也参与增量比较。\n\n**三套完整测试：147 项场景断言 + 173 个 Node 测试全部通过**（Windows Node 18.20.8 / 24.14.0、WSL Linux Node 22.23.3）。本轮新增 9 个测试，覆盖泛型/字段/包装类型、宏定义变更和 cfg 边界、注册删除及替代连接、直接回调/仅存储/条件调用/遮蔽/async future，另覆盖 CodeMirror 注册移除。\n\n**Rust 编译执行对照 6/6**：使用上游原样 singleton 宏、泛型字段 RefCell、泛型工厂与委托、删除调用、直接回调、仅存储回调；实际计数与分析器可达性一致。编译器：\`${probes.rustc}\`。这是小程序执行证据，不是完整工程构建。\n\n**完整真实源码副本 5 对控制/断连测试**：\n\n| 案例 | 控制的显式目标 | 删除连接后的显式目标 | 删除后的增量 |\n| --- | --- | --- | --- |\n| Pot start_server | SATISFIED | VIOLATED | VIOLATED |\n| Pot tray_event_handler | INCONCLUSIVE（仅注册） | VIOLATED | VIOLATED |\n| Clash CoreManager.get_clash_logs | SATISFIED | VIOLATED | VIOLATED |\n| Clash Sysopt.refresh_guard | SATISFIED | VIOLATED | VIOLATED |\n| Clash SilentUpdater.install_update | SATISFIED | VIOLATED | VIOLATED |\n\n原先托盘注册删除的增量漏报已在完整 Pot 源码副本复测消除。控制注册仍保持待确认，不将其升级为已执行。没有运行 Tauri 桌面程序。\n\n六个原仓库各两次扫描：**12 次完成、0 超时、各仓报告一致**；原仓库提交及工作树未改变。\n\n| 仓库 | VIOLATED | INCONCLUSIVE |\n| --- | --- | --- |\n${repositories.map(r => `| ${r.name} | ${r.counts.violated} | ${r.counts.inconclusive} |`).join('\n')}\n\n实际 npm 包源码与冻结版逐文件哈希一致；官方 MCP SDK 1.32.2 / 2.4.0 在 Windows/Linux 均通过打包入口的 stdio 流程。\n\n边界仍然存在：上述实现不是完整 Rust 编译器，不支持任意过程宏、trait 动态分派、任意类型别名或 cfg 选择；外部宿主是否触发回调需要该项目的实际行为测试。因此不能把“1、2 对任意项目完全解决”作为交付承诺。旧保存快照若缺少新回调字段，升级后应重新建立基线；Git 基线由当前引擎重建。其余 33 仓、大仓性能和独立准确率未在本轮验证。\n\n[结构化证据](summary.json)。完整本地证据：\`${evidence}\`。\n`);
console.log(JSON.stringify({ sourceHash: summary.sourceHash, nodeTests: 173, mutationPairs: 5, compilerControls: 6, scans: 12, sourceChecks: sourceAudit.length }));
