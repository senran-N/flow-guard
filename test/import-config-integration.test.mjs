import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { buildWorkspaceFlowGraph, clearFlowGraphCache } from '../src/graph-builder.mjs';
import { verifyWorkspaceFlow } from '../src/flow-verifier.mjs';
import { generateWiringBlueprint } from '../src/flow-tools.mjs';

test('configured JSX import connects the exact component and invalidates same-size config edits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowguard alias graph-'));
  const write = (file, content) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
  try {
    write('package.json', JSON.stringify({ private: true }));
    write('jsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { 'widgets/*': ['src/real/*'] } } }));
    write('src/main.jsx', "import Panel from 'widgets/Panel';\nrender(<Panel/>);\n");
    for (const dir of ['real', 'fake']) write(`src/${dir}/Panel.jsx`, 'export default function Panel() {\n return <div/>;\n}\n');
    const check = (expected) => {
      const graph = buildWorkspaceFlowGraph(root);
      const panels = [...graph.symbolById.values()].filter((s) => s.name === 'Panel');
      assert.equal(panels.length, 2);
      for (const panel of panels) assert.equal(graph.reachableFromRuntimeSource.has(panel.id), panel.file === `src/${expected}/Panel.jsx`);
      return graph;
    };
    check('real');
    const config = path.join(root, 'jsconfig.json'), previous = fs.statSync(config);
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('src/real', 'src/fake'));
    fs.utimesSync(config, previous.atime, previous.mtime);
    check('fake');
    write('src/main.jsx', 'console.log("disconnected");\n');
    check('missing');
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('flowguard alias graph-'));
    fs.rmSync(root, { recursive: true, force: true }); clearFlowGraphCache();
  }
});

test('inherited configuration changes invalidate cached edges even with restored size and mtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowguard inherited graph-'));
  const write = (file, content) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
  try {
    write('package.json', '{"private":true}');
    write('tsconfig.json', '{"extends":"./config/aliases.json"}');
    write('config/aliases.json', JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { 'widgets/*': ['src/real/*'] } } }));
    write('src/main.jsx', "import Panel from 'widgets/Panel';\nrender(<Panel/>);\n");
    for (const dir of ['real', 'fake']) write(`src/${dir}/Panel.jsx`, 'export default function Panel() { return <div/>; }\n');
    const connected = () => {
      const graph = buildWorkspaceFlowGraph(root);
      return [...graph.symbolById.values()].filter((s) => s.name === 'Panel' && graph.reachableFromRuntimeSource.has(s.id)).map((s) => s.file);
    };
    assert.deepEqual(connected(), ['src/real/Panel.jsx']);
    const config = path.join(root, 'config/aliases.json'), old = fs.statSync(config);
    write('config/aliases.json', fs.readFileSync(config, 'utf8').replace('src/real', 'src/fake'));
    fs.utimesSync(config, old.atime, old.mtime);
    assert.deepEqual(connected(), ['src/fake/Panel.jsx']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); clearFlowGraphCache(); }
});

test('missing inherited package configs remain inconclusive and creating them invalidates cache', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowguard missing config-'));
  const write = (file, content) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
  try {
    write('package.json', '{"private":true}');
    write('tsconfig.json', '{"extends":"@scope/config"}');
    write('node_modules/.placeholder', '');
    write('src/main.jsx', "import Panel from 'widgets/Panel';\nrender(<Panel/>);\n");
    write('src/Panel.jsx', 'export default function Panel() { return <div/>; }\n');
    const graph = buildWorkspaceFlowGraph(root);
    assert.ok(graph.analysisLimitations.some((l) => l.kind === 'TSCONFIG'));
    const report = verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true });
    assert.ok(report.wiringReport.obligations.some((o) => o.station === 'ANALYSIS_LIMITATION' && o.status === 'INCONCLUSIVE'));
    write('node_modules/@scope/config/tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '../../../src', paths: { 'widgets/*': ['*'] } } }));
    const rebuilt = buildWorkspaceFlowGraph(root);
    assert.notEqual(rebuilt, graph);
    assert.deepEqual(rebuilt.analysisLimitations, []);
    const panel = [...rebuilt.symbolById.values()].find((s) => s.name === 'Panel');
    assert.equal(rebuilt.reachableFromRuntimeSource.has(panel.id), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); clearFlowGraphCache(); }
});

test('a config-only Git edit is analyzed as wiring and cannot bypass validation as a documentation change', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowguard config diff-'));
  const write = (file, content) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
  const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  const previousData = process.env.PLUGIN_DATA;
  process.env.PLUGIN_DATA = path.join(root, '.state');
  try {
    write('.gitignore', '.state/\n');
    write('package.json', '{"private":true}');
    write('tsconfig.json', '{"extends":"./config/base.json"}');
    write('config/base.json', '{"compilerOptions":{"baseUrl":"..","paths":{"widgets/*":["src/*"]}}}');
    write('src/main.jsx', "import Panel from 'widgets/Panel';\nrender(<Panel/>);\n");
    write('src/Panel.jsx', 'export default function Panel() { return <div/>; }\n');
    git('init', '--quiet'); git('add', '.');
    git('-c', 'user.name=FlowGuard Test', '-c', 'user.email=test@flowguard.local', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'baseline');
    const { wiringPlan } = generateWiringBlueprint(root, 'src/Panel.jsx', { targetSymbol: 'Panel', savePlan: false });
    write('config/base.json', '{"compilerOptions":{"baseUrl":"..","paths":{"widgets/*":["absent/*"]}}}');
    const report = verifyWorkspaceFlow(root, { wiringPlan, ignoreSavedPlan: true, useSessionBaseline: false });
    assert.equal(report.scanMode, 'FULL_WORKSPACE');
    assert.equal(report.verificationVerdict, 'VIOLATED');
    assert.ok(report.wiringReport.obligations.some((item) => item.status === 'VIOLATED' && /Panel/.test(item.targetLocation || '')));
  } finally {
    if (previousData === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previousData;
    fs.rmSync(root, { recursive: true, force: true }); clearFlowGraphCache();
  }
});
