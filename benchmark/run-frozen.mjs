// Serial, bounded validation of an explicit immutable engine directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const [engineArg, workspaceArg, outputArg, countArg = '2'] = process.argv.slice(2);
assert.ok(engineArg && workspaceArg && outputArg, 'Usage: run-frozen.mjs <engine> <workspace> <new-output> [repetitions]');
const engine = path.resolve(engineArg), workspace = path.resolve(workspaceArg), output = path.resolve(outputArg), repetitions = Number(countArg);
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 4);
assert.ok(!fs.existsSync(output), 'Evidence must not be overwritten');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hashes = () => Object.fromEntries(fs.readdirSync(path.join(engine, 'src')).filter((file) => file.endsWith('.mjs')).sort()
  .map((file) => [file, hash(fs.readFileSync(path.join(engine, 'src', file)))]));
const sourceFiles = hashes();
const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true }).trim();
const commit = git('rev-parse', 'HEAD'), status = git('status', '--porcelain');
const result = { engine, workspace, sourceHash: hash(JSON.stringify(sourceFiles)), sourceFiles, commit, status,
  node: process.version, platform: process.platform, timeoutMs: 120000, runs: [], startedAt: new Date().toISOString() };
fs.mkdirSync(output, { recursive: true });
const persist = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
persist();
for (let index = 1; index <= repetitions; index++) {
  assert.deepEqual(hashes(), sourceFiles, 'Engine changed during validation');
  const destination = path.join(output, `${index}.json`), start = Date.now();
  const run = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(engine, 'benchmark/real-world-worker.mjs'), workspace, destination], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PLUGIN_DATA: path.join(output, 'state', String(index)) }
    });
    let stderr = '', timedOut = false;
    child.stdout.resume(); child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', (error) => { stderr += error.stack; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
        catch { child.kill('SIGKILL'); }
      } else child.kill('SIGKILL');
    }, 120000);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const scan = fs.existsSync(destination) ? JSON.parse(fs.readFileSync(destination, 'utf8')) : null;
      resolve({ index, exitCode, signal, timedOut, elapsedMs: Date.now() - start, stderr, destination,
        verifyMs: scan?.verifyMs, totalMs: scan?.totalMs, rssMiB: scan?.rssMiB,
        resultHash: scan?.report ? hash(JSON.stringify({ graph: scan.graph, report: scan.report })) : null });
    });
  });
  result.runs.push(run); persist(); console.log(JSON.stringify(run));
}
assert.deepEqual(hashes(), sourceFiles);
assert.equal(git('rev-parse', 'HEAD'), commit); assert.equal(git('status', '--porcelain'), status);
result.completed = result.runs.every((run) => run.exitCode === 0 && !run.timedOut && run.resultHash);
result.deterministic = repetitions >= 2 && result.completed ? result.runs.every((run) => run.resultHash === result.runs[0].resultHash) : null;
result.finishedAt = new Date().toISOString(); persist();
if (!result.completed || result.deterministic === false) process.exitCode = 1;
