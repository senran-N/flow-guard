import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJsImportResolver } from "../src/js-imports.mjs";

function workspace(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowguard-js-imports-"));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("resolves relative JS/TS modules and index files without package guesses", () => workspace({
  "src/main.ts": "",
  "src/components/Button.tsx": "",
  "src/components/index.ts": "",
  "node_modules/pkg/index.js": ""
}, (root) => {
  const resolve = createJsImportResolver(root, ["src/main.ts", "src/components/Button.tsx", "src/components/index.ts", "node_modules/pkg/index.js"]);
  assert.deepEqual(resolve("src/main.ts", "./components/Button"), ["src/components/Button.tsx"]);
  assert.deepEqual(resolve("src/main.ts", "./components"), ["src/components/index.ts"]);
  assert.deepEqual(resolve("src/main.ts", "pkg"), []);
  assert.deepEqual(resolve("src/main.ts", "@scope/pkg"), []);
}));

test("honors the nearest JSONC tsconfig paths/baseUrl mapping", () => workspace({
  "tsconfig.json": `{
    // local component aliases
    "compilerOptions": {
      "baseUrl": ".",
      "paths": { "components/*": ["src/components/*",], },
    },
  }`,
  "src/main.ts": "",
  "src/components/Card.ts": ""
}, (root) => {
  const resolve = createJsImportResolver(root, ["src/main.ts", "src/components/Card.ts"]);
  assert.deepEqual(resolve("src/main.ts", "components/Card"), ["src/components/Card.ts"]);
  assert.deepEqual(resolve("src/main.ts", "components/Missing"), []);
  assert.ok(resolve.configFiles.includes(path.join(root, "tsconfig.json")));
}));

test("prefers exact paths, then longest wildcard, then the first viable target", () => workspace({
  "tsconfig.json": JSON.stringify({ compilerOptions: {
    baseUrl: ".",
    paths: {
      "ui/*": ["src/general/*"],
      "ui/cards/*": ["src/missing/*", "src/cards/*"],
      "ui/cards/Button": ["src/exact/Button"]
    }
  } }),
  "src/main.ts": "",
  "src/general/Thing.ts": "",
  "src/cards/Panel.ts": "",
  "src/exact/Button.ts": ""
}, (root) => {
  const resolve = createJsImportResolver(root, ["src/main.ts", "src/general/Thing.ts", "src/cards/Panel.ts", "src/exact/Button.ts"]);
  assert.deepEqual(resolve("src/main.ts", "ui/Thing"), ["src/general/Thing.ts"]);
  assert.deepEqual(resolve("src/main.ts", "ui/cards/Panel"), ["src/cards/Panel.ts"]);
  assert.deepEqual(resolve("src/main.ts", "ui/cards/Button"), ["src/exact/Button.ts"]);
}));

test("does not fall back after a configured alias misses and honors explicit extensions", () => workspace({
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "src", paths: { "alias/*": ["missing/*"] } } }),
  "src/main.ts": "",
  "src/alias/Card.ts": "",
  "src/widgets/Card.ts": "",
  "src/widgets/Card.js": ""
}, (root) => {
  const resolve = createJsImportResolver(root, ["src/main.ts", "src/alias/Card.ts", "src/widgets/Card.ts", "src/widgets/Card.js"]);
  assert.deepEqual(resolve("src/main.ts", "alias/Card"), []);
  assert.deepEqual(resolve("src/main.ts", "widgets/Card.ts"), ["src/widgets/Card.ts"]);
  assert.equal(resolve.isConfigured("src/main.ts"), true);
}));

test("does not treat the config directory as baseUrl unless baseUrl is explicit", () => workspace({
  "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "alias/*": ["src/aliases/*"] } } }),
  "src/main.ts": "",
  "widgets/Card.ts": ""
}, (root) => {
  const resolve = createJsImportResolver(root, ["src/main.ts", "widgets/Card.ts"]);
  assert.deepEqual(resolve("src/main.ts", "widgets/Card"), []);
}));

test("uses baseUrl even without paths and preserves comma-like JSON strings", () => workspace({
  "jsconfig.json": `{
    "compilerOptions": { "baseUrl": "src", },
    "note": "this string contains ,} and ,] exactly",
  }`,
  "src/main.js": "",
  "src/local/Helper.js": ""
}, (root) => {
  const resolve = createJsImportResolver(root, ["src/main.js", "src/local/Helper.js"]);
  assert.deepEqual(resolve("src/main.js", "local/Helper"), ["src/local/Helper.js"]);
}));

test("uses nested jsconfig before parent config and refreshes changed path settings on rebuild", () => workspace({
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "ui/*": ["src/parent/*"] } } }),
  "packages/web/jsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "ui/*": ["src/first/*"] } } }),
  "packages/web/src/main.js": "",
  "packages/web/src/first/Panel.js": "",
  "packages/web/src/second/Panel.js": "",
  "src/parent/Panel.js": ""
}, (root) => {
  const files = ["packages/web/src/main.js", "packages/web/src/first/Panel.js", "packages/web/src/second/Panel.js", "src/parent/Panel.js"];
  const resolve = createJsImportResolver(root, files);
  assert.deepEqual(resolve("packages/web/src/main.js", "ui/Panel"), ["packages/web/src/first/Panel.js"]);
  fs.writeFileSync(path.join(root, "packages/web/jsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "ui/*": ["src/second/*"] } } }));
  const rebuilt = createJsImportResolver(root, files);
  assert.deepEqual(rebuilt("packages/web/src/main.js", "ui/Panel"), ["packages/web/src/second/Panel.js"]);
}));

test("invalid or unsupported mappings do not guess alias targets", () => workspace({
  "tsconfig.json": "{ broken jsonc",
  "src/main.ts": "",
  "src/components/Card.ts": ""
}, (root) => {
  const resolve = createJsImportResolver(root, ["src/main.ts", "src/components/Card.ts"]);
  assert.deepEqual(resolve("src/main.ts", "components/Card"), []);
  assert.deepEqual(resolve("src/main.ts", "./components/Card"), ["src/components/Card.ts"]);
}));

test("inherits explicit base config without leaking across configless nested packages", () => workspace({
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "ui/*": ["shared/*"] } } }),
  "packages/isolated/package.json": JSON.stringify({ name: "isolated", private: true }),
  "packages/isolated/src/main.ts": "",
  "shared/Card.ts": "",
  "packages/inherited/tsconfig.json": JSON.stringify({ extends: "../../tsconfig.json" }),
  "packages/inherited/src/main.ts": ""
}, (root) => {
  const resolve = createJsImportResolver(root, ["packages/isolated/src/main.ts", "packages/inherited/src/main.ts", "shared/Card.ts"]);
  assert.deepEqual(resolve("packages/isolated/src/main.ts", "ui/Card"), []);
  assert.deepEqual(resolve("packages/inherited/src/main.ts", "ui/Card"), ["shared/Card.ts"]);
  assert.equal(resolve.isConfigured("packages/isolated/src/main.ts"), false);
  assert.equal(resolve.isConfigured("packages/inherited/src/main.ts"), true);
  assert.ok(resolve.configFiles.includes(path.join(root, "packages/isolated/jsconfig.json")));
  assert.ok(resolve.configFiles.includes(path.join(root, "packages/inherited/tsconfig.json")));
}));

test('inherits paths relative to their origin and replaces the paths object in a child', () => workspace({
  'config/base.json': JSON.stringify({ compilerOptions: { paths: { 'ui/*': ['../shared/*'] } } }),
  'tsconfig.json': JSON.stringify({ extends: './config/base' }),
  'src/main.ts': '', 'shared/Card.ts': '', 'own/Card.ts': ''
}, (root) => {
  const files = ['src/main.ts', 'shared/Card.ts', 'own/Card.ts'];
  assert.deepEqual(createJsImportResolver(root, files)('src/main.ts', 'ui/Card'), ['shared/Card.ts']);
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ extends: './config/base', compilerOptions: { paths: { 'mine/*': ['own/*'] } } }));
  const resolve = createJsImportResolver(root, files);
  assert.deepEqual(resolve('src/main.ts', 'ui/Card'), []);
  assert.deepEqual(resolve('src/main.ts', 'mine/Card'), ['own/Card.ts']);
}));

test('merges multiple bases in order, preserving baseUrl origin while child paths override', () => workspace({
  'config/base.json': JSON.stringify({ compilerOptions: { baseUrl: '../shared', paths: { 'ui/*': ['first/*'] } } }),
  'config/last.json': JSON.stringify({ compilerOptions: { paths: { 'ui/*': ['second/*'] } } }),
  'tsconfig.json': JSON.stringify({ extends: ['./config/base.json', './config/last.json'] }),
  'src/main.ts': '', 'shared/first/Card.ts': '', 'shared/second/Card.ts': '', 'own/Card.ts': ''
}, (root) => {
  const files = ['src/main.ts', 'shared/first/Card.ts', 'shared/second/Card.ts', 'own/Card.ts'];
  const resolve = createJsImportResolver(root, files);
  assert.deepEqual(resolve('src/main.ts', 'ui/Card'), ['shared/second/Card.ts']);
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ extends: './config/base', compilerOptions: { baseUrl: './own', paths: { 'ui/*': ['*'] } } }));
  assert.deepEqual(createJsImportResolver(root, files)('src/main.ts', 'ui/Card'), ['own/Card.ts']);
}));

test('resolves installed package tsconfig entries and scoped config subpaths', () => workspace({
  'node_modules/@scope/config/package.json': JSON.stringify({ tsconfig: './base.json' }),
  'node_modules/@scope/config/base.json': JSON.stringify({ compilerOptions: { baseUrl: '../../../src', paths: { 'ui/*': ['widgets/*'] } } }),
  'tsconfig.json': JSON.stringify({ extends: '@scope/config' }),
  'src/main.ts': '', 'src/widgets/Card.ts': ''
}, (root) => {
  const files = ['src/main.ts', 'src/widgets/Card.ts'];
  const resolve = createJsImportResolver(root, files);
  assert.deepEqual(resolve('src/main.ts', 'ui/Card'), ['src/widgets/Card.ts']);
  assert.ok(resolve.configFiles.includes(path.join(root, 'node_modules/@scope/config/package.json')));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ extends: '@scope/config/base' }));
  assert.deepEqual(createJsImportResolver(root, files)('src/main.ts', 'ui/Card'), ['src/widgets/Card.ts']);
}));

test('rejects cycles, missing bases and malformed inheritance without partial guesses', () => workspace({
  'tsconfig.json': JSON.stringify({ extends: './base.json', compilerOptions: { baseUrl: 'src' } }),
  'base.json': JSON.stringify({ extends: './tsconfig.json' }),
  'src/main.ts': '', 'src/Card.ts': ''
}, (root) => {
  const files = ['src/main.ts', 'src/Card.ts'];
  for (const value of ['./base.json', './missing.json', 42, ['./missing.json', './base.json']]) {
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ extends: value, compilerOptions: { baseUrl: 'src' } }));
    const resolve = createJsImportResolver(root, files);
    assert.deepEqual(resolve('src/main.ts', 'Card'), []);
    assert.ok(resolve.limitations.length > 0);
    assert.deepEqual(resolve('src/main.ts', './Card'), ['src/Card.ts']);
  }
}));
