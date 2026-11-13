import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Read-only provenance capture. This does not rerun scans or relabel their outputs.
const root = 'D:/Myproject/flowguard-validation/2026-11-12-hardening';
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const frozen = read('benchmark/results/2026-11-13-phase13/source-manifest.json');
const files = Object.fromEntries(fs.readdirSync('src').filter(x => x.endsWith('.mjs')).sort()
  .map(x => [x, hash(fs.readFileSync(path.join('src', x)))]));
assert.deepEqual(files, frozen.files);
assert.equal(hash(JSON.stringify(files)), frozen.sourceHash);
const manifest = read('benchmark/results/2026-11-13-phase13/manifest.json');
const cm = 'src/renderer/components/Editor/hosts_cm.ts';
const hf = 'src/common/hostsFn.ts';
const rows = [
  ['clash-verge-rev', 'AUTO-EXP-3', 'FALSE_POSITIVE_REFERENCE', [['src-tauri/src/config/verge.rs', 182, 'serialize_with = "serialize_encrypted"']], 'Serde derive 属性引用；不等同于本轮运行过序列化。'],
  ['clash-verge-rev', 'AUTO-EXP-4', 'FALSE_POSITIVE_REFERENCE', [['src-tauri/src/config/verge.rs', 183, 'deserialize_with = "deserialize_encrypted"']], 'Serde derive 属性引用；不等同于本轮运行过反序列化。'],
  ['clash-verge-rev', 'AUTO-EXP-5', 'FALSE_POSITIVE_REFERENCE', [['src-tauri/src/cmd/clash.rs', 247, 'CoreManager::global().get_clash_logs()'], ['src-tauri/src/ipc.rs', 61, 'cmd::get_clash_logs'], ['src/services/bindings.ts', 118, 'get_clash_logs']], 'Tauri 命令注册及前端 invoke；未运行桌面业务。'],
  ['clash-verge-rev', 'AUTO-EXP-6', 'FALSE_POSITIVE_REFERENCE', [['src-tauri/src/core/proxy_control.rs', 592, 'Sysopt::global().refresh_guard()'], ['src-tauri/src/core/manager/lifecycle.rs', 608, 'refresh_guard']], '实际生产调用及上游调用；未证明所有配置下分支执行。'],
  ['clash-verge-rev', 'AUTO-EXP-7', 'FALSE_POSITIVE_REFERENCE', [['src-tauri/src/cmd/app.rs', 69, '.install_update('], ['src-tauri/src/ipc.rs', 21, 'cmd::install_update'], ['src/services/bindings.ts', 30, 'install_update']], 'Tauri 命令中的链式方法调用；未安装更新。'],
  ['ripgrep', 'AUTO-EXP-1', 'FALSE_POSITIVE_REFERENCE', [['crates/searcher/src/searcher/mod.rs', 619, 'RefCell<LineBuffer>'], ['crates/searcher/src/searcher/mod.rs', 800, '.set_binary_detection(detection.0)'], ['crates/core/search.rs', 257, '.set_binary_detection(bin)']], '字段类型与 borrow_mut 调用对应目标 LineBuffer；未执行完整 Cargo 测试。'],
  ['ripgrep', 'AUTO-EXP-2', 'FALSE_POSITIVE_HOST_CALLBACK', [['pkg/brew/ripgrep-bin.rb', 1, 'class RipgrepBin < Formula'], ['pkg/brew/ripgrep-bin.rb', 16, 'def install']], 'Homebrew Formula 安装入口；仓内无需显式调用，未运行 brew install。'],
  ['SwitchHosts', 'AUTO-EXP-6', 'NO_EXTERNAL_STATIC_REFERENCE_FOUND', [[hf, 26, 'export const cleanHostsList']], '仅找到声明；不能证明业务缺陷或排除动态访问。'],
  ['SwitchHosts', 'AUTO-EXP-7', 'NO_EXTERNAL_STATIC_REFERENCE_FOUND', [[hf, 53, 'export const updateOneItem'], ['test/common/hostsFn.test.ts', 8, 'findItemById, setOnStateOfItem']], '测试第 62/96 行仅标题含函数名，测试实际调用 setOnStateOfItem。'],
  ['SwitchHosts', 'AUTO-EXP-8', 'NO_EXTERNAL_STATIC_REFERENCE_FOUND', [[hf, 178, 'export const deleteItemById'], [hf, 185, 'deleteItemById(item.children']], '另有自递归，未找到函数外部调用。'],
  ['SwitchHosts', 'AUTO-EXP-9', 'FALSE_POSITIVE_HOST_CALLBACK', [[cm, 38, 'extends WidgetType'], [cm, 43, 'eq(other: BoundaryLabel)'], [cm, 85, 'new BoundaryLabel'], [cm, 271, 'hostsHighlighter'], ['src/renderer/components/Editor/HostsEditor.tsx', 214, '...built.extensions']], 'CodeMirror WidgetType 回调；有插件注册路径，执行取决于文档和渲染状态。'],
  ['SwitchHosts', 'AUTO-EXP-10', 'FALSE_POSITIVE_HOST_CALLBACK', [[cm, 47, 'toDOM()'], [cm, 85, 'new BoundaryLabel'], [cm, 271, 'hostsHighlighter'], ['src/renderer/components/Editor/HostsEditor.tsx', 209, 'rebuildExtensions()']], 'CodeMirror WidgetType 回调；未运行编辑器验证实际绘制。'],
  ['SwitchHosts', 'AUTO-EXP-11', 'NO_EXTERNAL_STATIC_REFERENCE_FOUND', [['src/renderer/components/Tree/fn.ts', 155, 'export function isParent']], '仅找到声明；isParentIsDragSource 为不同符号。'],
  ['SwitchHosts', 'AUTO-EXP-12', 'NO_EXTERNAL_STATIC_REFERENCE_FOUND', [['src/renderer/utils/css-var.ts', 7, 'export const getCssVar']], '仅找到声明；不能证明业务缺陷。'],
];
const repositories = manifest.repositories.filter(r => rows.some(x => x[0] === r.name)).map(r => {
  const git = (...args) => execFileSync('git', ['-C', r.workspace, ...args], { encoding: 'utf8' }).trim();
  const commit = git('rev-parse', 'HEAD'), status = git('status', '--porcelain=v1', '--untracked-files=all');
  assert.equal(commit, r.commit); assert.equal(status, r.initialStatus);
  return { name: r.name, workspace: r.workspace, commit, status, matchesPhase13: true };
});
const scans = Object.fromEntries(repositories.map(r => [r.name, read(path.join(root, 'phase13-final2-rust/scans', r.name + '.1.json'))]));
const evidenceFiles = {};
const findings = rows.map(([repository, id, classification, refs, limitation]) => {
  const obligation = scans[repository].report.wiringReport.obligations.find(x => x.id === id);
  assert.equal(obligation?.status, 'VIOLATED');
  const repo = repositories.find(r => r.name === repository);
  const evidence = refs.map(([file, line, text]) => {
    const buffer = fs.readFileSync(path.join(repo.workspace, file));
    const actual = buffer.toString('utf8').split(/\r?\n/)[line - 1];
    assert.ok(actual?.includes(text), `${repository}/${file}:${line} expected ${text}, got ${actual}`);
    evidenceFiles[repository + '/' + file] = hash(buffer);
    return { file, line, text: actual.trim() };
  });
  return { repository, id, target: obligation.targetLocation, originalStatus: obligation.status, classification, evidence, limitation };
});
assert.equal(findings.length, 14);
assert.equal(new Set(findings.map(f => f.repository + ':' + f.id)).size, 14);
assert.equal(Object.values(scans).flatMap(s => s.report.wiringReport.obligations).filter(x => x.status === 'VIOLATED').length, 14);
const counts = Object.fromEntries([...new Set(findings.map(f => f.classification))].map(c => [c, findings.filter(f => f.classification === c).length]));
assert.equal(counts.NO_EXTERNAL_STATIC_REFERENCE_FOUND, 5);
const output = 'benchmark/results/2026-11-13-phase14-audit';
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'audit.json'), JSON.stringify({
  capturedAt: new Date().toISOString(), sourceHash: frozen.sourceHash,
  scope: 'Manual review of all 14 phase13 residual VIOLATED diagnostics; no runtime validation, no engine changes, no scan relabeling.',
  counts, repositories, evidenceFiles, findings,
  scanFiles: Object.fromEntries(repositories.map(r => [r.name, hash(fs.readFileSync(path.join(root, 'phase13-final2-rust/scans', r.name + '.1.json')))])),
  negativeSearch: { command: 'rg -n -w "cleanHostsList|updateOneItem|deleteItemById|isParent|getCssVar" D:/Myproject/crack/SwitchHosts', limitation: 'Text search plus import/namespace inspection; not whole-program dynamic reachability proof.' },
  primarySources: ['https://serde.rs/field-attrs.html', 'https://raw.githubusercontent.com/codemirror/view/main/src/decoration.ts', 'https://docs.brew.sh/Formula-Cookbook'],
}, null, 2) + '\n');
console.log(JSON.stringify({ sourceHash: frozen.sourceHash, reviewed: findings.length, counts, provenanceVerified: true }));
