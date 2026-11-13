import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(process.argv[2] || 'D:/Myproject/flowguard-validation/2026-11-12-hardening/phase15-validation');
assert.ok(!fs.existsSync(root), 'Do not overwrite validation evidence');
fs.mkdirSync(path.join(root, 'engine-snapshot/benchmark'), { recursive: true });
for (const file of ['src', 'package.json', 'benchmark/real-world-worker.mjs']) {
  fs.cpSync(file, path.join(root, 'engine-snapshot', file), { recursive: true });
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const files = Object.fromEntries(fs.readdirSync('src').filter(f => f.endsWith('.mjs')).sort().map(f => [f, hash(fs.readFileSync(path.join('src', f)))]));
const previous = JSON.parse(fs.readFileSync('benchmark/results/2026-11-13-phase13/manifest.json'));
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const repositories = previous.repositories.map(repo => {
  assert.equal(git(repo.workspace, 'rev-parse', 'HEAD'), repo.commit);
  assert.equal(git(repo.workspace, 'status', '--porcelain'), repo.initialStatus);
  return repo;
});
const manifest = { createdAt: new Date().toISOString(), engine: { sourceHash: hash(JSON.stringify(files)), files }, repositories };
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
for (const repo of repositories) {
  execFileSync(process.execPath, ['benchmark/run-frozen.mjs', path.join(root, 'engine-snapshot'), repo.workspace, path.join(root, repo.name), '2'], { stdio: 'inherit', windowsHide: true });
}
console.log(JSON.stringify({ completed: true, sourceHash: manifest.engine.sourceHash, root }));
