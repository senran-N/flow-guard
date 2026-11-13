import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const evidence = 'D:/Myproject/flowguard-validation/2026-11-12-hardening';
const cohort = path.join(evidence, process.argv[2] || 'phase16-final3-validation'), output = path.join(evidence, process.argv[3] || 'phase16-final3-clash-pairs');
assert.ok(!fs.existsSync(output)); fs.mkdirSync(output);
const manifest = JSON.parse(fs.readFileSync(path.join(cohort, 'manifest.json')));
const upstream = manifest.repositories.find(r => r.name === 'clash-verge-rev');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
assert.equal(git(upstream.workspace, 'status', '--porcelain'), upstream.initialStatus);
assert.equal(git(upstream.workspace, 'rev-parse', 'HEAD'), upstream.commit);
const archive = path.join(output, 'source.tar'), workspace = path.join(output, 'copy');
git(upstream.workspace, 'archive', '--format=tar', '-o', archive, 'HEAD'); fs.mkdirSync(workspace);
execFileSync('tar', ['-xf', archive, '-C', workspace], { windowsHide: true });
git(workspace, 'init', '--quiet'); git(workspace, 'config', 'core.autocrlf', 'false'); git(workspace, 'add', '.');
git(workspace, '-c', 'user.name=FlowGuard Validation', '-c', 'user.email=validation@localhost', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Source control');
const { generateWiringBlueprint } = await import(pathToFileURL(path.join(cohort, 'engine-snapshot/src/flow-tools.mjs')));
const { verifyWorkspaceFlow } = await import(pathToFileURL(path.join(cohort, 'engine-snapshot/src/flow-verifier.mjs')));
const { clearFlowGraphCache } = await import(pathToFileURL(path.join(cohort, 'engine-snapshot/src/graph-builder.mjs')));
process.env.PLUGIN_DATA = path.join(output, 'state');
const cases = [
  { target: 'CoreManager.get_clash_logs', reference: 'src-tauri/src/core/manager/state.rs', file: 'src-tauri/src/cmd/clash.rs',
    token: 'let logs = CoreManager::global().get_clash_logs().await.unwrap_or_default();', replacement: 'let logs = Vec::<String>::new();' },
  { target: 'Sysopt.refresh_guard', reference: 'src-tauri/src/core/sysopt.rs', file: 'src-tauri/src/core/proxy_control.rs',
    token: 'Sysopt::global().refresh_guard().await', replacement: 'false' },
  { target: 'SilentUpdater.install_update', reference: 'src-tauri/src/core/updater.rs', file: 'src-tauri/src/cmd/app.rs',
    token: /SilentUpdater::global\(\)\s*\.install_update\(&app_handle, &version, \|event\| \{[\s\S]*?\}\)\s*\.await\s*\.stringify_err\(\)/g,
    replacement: 'unimplemented!()' }
];
const results = [];
for (const item of cases) {
  const file = path.join(workspace, item.file), bytes = fs.readFileSync(file), original = bytes.toString('utf8');
  const count = typeof item.token === 'string' ? original.split(item.token).length - 1 : [...original.matchAll(item.token)].length;
  assert.equal(count, 1);
  const { wiringPlan } = generateWiringBlueprint(workspace, item.reference, { targetSymbol: item.target, savePlan: false, requirePersistence: 'not_required' });
  for (const variant of ['control', 'defect']) {
    try {
      fs.writeFileSync(file, variant === 'control' ? original : original.replace(item.token, item.replacement)); clearFlowGraphCache();
      const destination = path.join(output, item.target + '-' + variant); fs.mkdirSync(destination);
      const report = verifyWorkspaceFlow(workspace, { fullScan: true, wiringPlan, ignoreSavedPlan: true });
      fs.writeFileSync(path.join(destination, 'planned.json'), JSON.stringify(report, null, 2));
      const statuses = report.wiringReport.obligations.filter(o => o.checkSpec?.type === 'ENTRY_REACHABILITY' && o.checkSpec.targetSymbol === item.target).map(o => o.status);
      assert.deepEqual(statuses, [variant === 'control' ? 'SATISFIED' : 'VIOLATED']);
      let incremental = null;
      if (variant === 'defect') {
        const inc = verifyWorkspaceFlow(workspace, { baseRef: 'HEAD', ignoreSavedPlan: true });
        fs.writeFileSync(path.join(destination, 'incremental.json'), JSON.stringify(inc, null, 2));
        incremental = inc.wiringReport.obligations.filter(o => o.station === 'ENTRY_WIRING' && o.targetLocation?.includes(item.target)).map(o => o.status);
        assert.ok(incremental.includes('VIOLATED'));
        fs.writeFileSync(path.join(destination, 'change.patch'), git(workspace, 'diff', '--', item.file));
      }
      results.push({ target: item.target, variant, statuses, incremental });
      console.log(JSON.stringify(results.at(-1)));
    } finally { fs.writeFileSync(file, bytes); clearFlowGraphCache(); }
  }
}
assert.equal(git(workspace, 'status', '--porcelain'), '');
assert.equal(git(upstream.workspace, 'status', '--porcelain'), upstream.initialStatus);
assert.equal(git(upstream.workspace, 'rev-parse', 'HEAD'), upstream.commit);
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ sourceHash: manifest.engine.sourceHash, commit: upstream.commit, results,
  limitation: 'Complete upstream source copies with static connection mutations; desktop app not built or executed.' }, null, 2));
