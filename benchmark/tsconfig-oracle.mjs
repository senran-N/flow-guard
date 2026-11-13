// Compare the supported config-inheritance cases with an independently installed
// TypeScript compiler. TypeScript is a validation-only dependency.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createJsImportResolver } from '../src/js-imports.mjs';

const [installation, output] = process.argv.slice(2);
assert.ok(installation, 'Usage: node benchmark/tsconfig-oracle.mjs <typescript-installation> [output.json]');
const require = createRequire(path.join(path.resolve(installation), 'package.json'));
const ts = require('typescript');
const cases = [
  { name: 'inherited paths without baseUrl', base: { paths: { 'ui/*': ['../shared/*'] } } },
  { name: 'inherited baseUrl and paths', base: { baseUrl: '../shared', paths: { 'ui/*': ['*'] } } },
  { name: 'child baseUrl changes inherited paths', base: { baseUrl: '../shared', paths: { 'ui/*': ['*'] } }, child: { baseUrl: './own' } },
  { name: 'child paths use inherited baseUrl', base: { baseUrl: '../shared', paths: { old: ['Card'] } }, child: { paths: { 'ui/*': ['*'] } } },
  { name: 'child paths replace inherited paths', base: { paths: { 'ui/*': ['../shared/*'] } }, child: { paths: { other: ['own/Card'] } } },
  { name: 'later base paths override earlier paths', base: { baseUrl: '../shared', paths: { 'ui/*': ['*'] } }, second: { paths: { 'ui/*': ['../own/*'] } } },
  { name: 'package config entry', package: true, base: { baseUrl: '../../../shared', paths: { 'ui/*': ['*'] } } }
];
const results = [];
for (const fixture of cases) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowguard-ts-oracle-'));
  const write = (file, content) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
  try {
    const base = fixture.package ? 'node_modules/@scope/config/base.json' : 'config/base.json';
    write(base, JSON.stringify({ compilerOptions: fixture.base }));
    if (fixture.package) write('node_modules/@scope/config/package.json', '{"tsconfig":"base.json"}');
    if (fixture.second) write('config/second.json', JSON.stringify({ compilerOptions: fixture.second }));
    const config = { extends: fixture.package ? '@scope/config' : fixture.second ? ['./config/base', './config/second'] : './config/base', compilerOptions: fixture.child || {} };
    write('tsconfig.json', JSON.stringify(config));
    const files = ['src/main.ts', 'shared/Card.ts', 'own/Card.ts'];
    for (const file of files) write(file, 'export const value = 1;');
    const parsed = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); } });
    assert.deepEqual(parsed.errors, []);
    const actual = ts.resolveModuleName('ui/Card', path.join(root, 'src/main.ts'), parsed.options, ts.sys).resolvedModule;
    const expected = actual ? [path.relative(root, actual.resolvedFileName).replace(/\\/g, '/')] : [];
    const observed = createJsImportResolver(root, files)('src/main.ts', 'ui/Card');
    assert.deepEqual(observed, expected, fixture.name);
    results.push({ name: fixture.name, expected, observed, passed: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const report = { typescript: ts.version, node: process.version, results };
if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report));
