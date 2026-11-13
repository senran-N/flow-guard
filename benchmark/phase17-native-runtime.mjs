// Windows native Tauri/WebView2 control and deletion tests on a source copy.
// Usage: node benchmark/phase17-native-runtime.mjs <SwitchHosts-repo> <new-output>
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert.equal(process.platform, 'win32', 'This native fixture requires Windows, MSVC and WebView2');
const [sourceArg, outputArg] = process.argv.slice(2);
assert.ok(sourceArg && outputArg, 'Supply the upstream repository and a new evidence directory');
const source = path.resolve(sourceArg), output = path.resolve(outputArg), workspace = path.join(output, 'SwitchHosts');
assert.ok(!fs.existsSync(output), 'Evidence must not be overwritten');
assert.ok(!output.startsWith(`${source}${path.sep}`), 'Keep evidence outside the upstream repository');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: workspace, windowsHide: true, ...options });
const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const original = { commit: git('rev-parse', 'HEAD'), status: git('status', '--porcelain') };
const fixture = fileURLToPath(new URL('./fixtures/phase17-native/', import.meta.url));
const patches = JSON.parse(fs.readFileSync(path.join(fixture, 'patches.json')));
assert.equal(original.commit, patches.upstreamCommit, 'Fixture patches require their recorded upstream commit');
fs.mkdirSync(workspace, { recursive: true });
execFileSync('git', ['-C', source, 'archive', '--format=tar', '--output', path.join(output, 'upstream.tar'), original.commit], { windowsHide: true });
run('tar', ['-xf', path.join(output, 'upstream.tar'), '-C', workspace]);
for (const patch of patches.edits) {
  const file = path.join(workspace, patch.file);
  const content = fs.readFileSync(file, 'utf8');
  assert.equal(hash(content), patch.beforeSha256, patch.file);
  assert.equal(content.split(patch.find).length, 2, `Patch must match once: ${patch.file}`);
  fs.writeFileSync(file, content.replace(patch.find, () => patch.replace));
}
fs.copyFileSync(path.join(fixture, 'flowguard-native-probe.ts'), path.join(workspace, 'src/renderer/flowguard-native-probe.ts'));
const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
assert.ok(fs.existsSync(npmCli), 'Run using a Node installation with npm alongside it');
const target = path.resolve(process.env.FLOWGUARD_NATIVE_CARGO_TARGET || path.join(output, 'target'));
const buildEnv = { ...process.env, CARGO_TARGET_DIR: target };
function logged(name, command, args) {
  const fd = fs.openSync(path.join(output, `${name}.log`), 'w');
  try { run(command, args, { env: buildEnv, stdio: ['ignore', fd, fd] }); } finally { fs.closeSync(fd); }
}
logged('npm-ci', process.execPath, [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
logged('renderer-build', process.execPath, [npmCli, 'run', 'build:renderer:tauri']);
logged('cargo-check', 'cargo', ['check', '--locked', '--manifest-path', 'src-tauri/Cargo.toml']);
logged('cargo-build', 'cargo', ['build', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'switchhosts']);
const binary = path.join(target, 'debug/switchhosts.exe');
fs.copyFileSync(binary, path.join(output, 'switchhosts-control.exe'));
const { chromium } = await import(pathToFileURL(path.join(workspace, 'node_modules/playwright-core/index.mjs')));
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const number = server.address().port; server.close(() => resolve(number)); }); });
const viteLog = fs.openSync(path.join(output, 'vite.log'), 'w');
await new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(8220, '127.0.0.1', () => server.close(resolve));
});
const vite = spawn(process.execPath, [npmCli, 'run', 'dev:renderer', '--', '--strictPort'], { cwd: workspace, windowsHide: true, stdio: ['ignore', viteLog, viteLog] });
const stop = child => { if (child?.pid) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} } };
const hosts = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/drivers/etc/hosts');
const beforeHosts = hash(fs.readFileSync(hosts));
const results = { original, binarySha256: hash(fs.readFileSync(binary)), beforeHosts, runs: [] };
async function nativeCase(name, deleted) {
  const evidence = path.join(output, name);
  fs.mkdirSync(path.join(evidence, 'data/internal'), { recursive: true });
  fs.writeFileSync(path.join(evidence, 'data/internal/config.json'), JSON.stringify({ auto_check_update: false,
    http_api_on: false, refresh_remote_hosts_on_startup: false, launch_at_login: false }));
  const fd = fs.openSync(path.join(evidence, 'native.log'), 'w');
  const child = spawn(binary, [], { windowsHide: true, env: { ...process.env, FLOWGUARD_NATIVE_TEST_ROOT: evidence,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` }, stdio: ['ignore', fd, fd] });
  let browser;
  const result = { name, deleted };
  try {
    let url;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { url = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; if (url) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.ok(url, 'WebView2 endpoint did not start');
    browser = await chromium.connectOverCDP(url);
    const page = browser.contexts().flatMap(context => context.pages())[0];
    assert.ok(page);
    await page.waitForFunction(() => typeof window.__FLOWGUARD_PROBE__ === 'function', null, { timeout: 30000 });
    result.url = page.url();
    assert.ok(await page.evaluate(() => !!window.__TAURI_INTERNALS__ && !window.__SWITCHHOSTS_E2E__), 'Requires native Tauri without the upstream mock');
    result.probe = await page.evaluate(async deleted => {
      try { return { ok: true, value: await window.__FLOWGUARD_PROBE__() }; }
      catch (error) { return { ok: false, message: String(error) }; }
    }, deleted);
    assert.equal(result.probe.ok, !deleted);
    if (deleted) assert.match(result.probe.message, /Command ping not found/);
    else {
      result.widgetDeletionDetected = await page.evaluate(async () => {
        try { await window.__FLOWGUARD_PROBE__('widget'); return false; } catch { return true; }
      });
      assert.ok(result.widgetDeletionDetected);
    }
    await page.evaluate(() => window.__FLOWGUARD_EMIT_READY__());
    await page.waitForTimeout(300);
    result.readyCallback = fs.existsSync(path.join(evidence, 'main-window-ready.txt'));
    assert.equal(result.readyCallback, !deleted);
    await page.screenshot({ path: path.join(evidence, 'native.png') });
    result.outcome = 'PASSED';
  } finally { if (browser) await browser.close(); stop(child); fs.closeSync(fd); results.runs.push(result); }
}
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch('http://127.0.0.1:8220')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  await nativeCase('control', false);
  const lib = path.join(workspace, 'src-tauri/src/lib.rs'), control = fs.readFileSync(lib, 'utf8');
  let negative = control.replaceAll('\r\n', '\n').replace('            commands::ping,', '            // deleted commands::ping registration');
  negative = negative.replace(/                app\.listen\("main_window_ready", move \|_event\| \{\n                    if !ready_flag[\s\S]*?                \}\);/, '                // deleted main-window-ready registration');
  assert.ok(!negative.includes('if !ready_flag.swap'), 'Listener deletion did not apply');
  fs.writeFileSync(lib, negative);
  fs.writeFileSync(path.join(output, 'lib-control.rs'), control);
  fs.writeFileSync(path.join(output, 'lib-negative.rs'), negative);
  logged('cargo-build-negative', 'cargo', ['build', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'switchhosts']);
  results.negativeBinarySha256 = hash(fs.readFileSync(binary));
  await nativeCase('deleted-registrations', true);
  fs.writeFileSync(lib, control);
  results.outcome = 'PASSED';
} finally {
  stop(vite); fs.closeSync(viteLog);
  results.afterHosts = hash(fs.readFileSync(hosts));
  assert.equal(results.afterHosts, beforeHosts);
  assert.equal(git('rev-parse', 'HEAD'), original.commit);
  assert.equal(git('status', '--porcelain'), original.status);
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results));
