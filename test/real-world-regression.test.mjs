import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSourceFileContent } from "../src/file-parser.mjs";
import { generateWiringBlueprint } from "../src/flow-tools.mjs";
import { verifyWorkspaceFlow } from "../src/flow-verifier.mjs";
import { buildWorkspaceFlowGraph, clearFlowGraphCache } from "../src/graph-builder.mjs";
import { findSimilarShinglePairs, forEachSimilarShinglePair } from "../src/similarity-index.mjs";
import { parseRustImports } from "../src/rust-imports.mjs";
import { scanTokensAndScopes } from "../src/lexer.mjs";

test("Rust use trees preserve groups, aliases, module declarations and lexical scope", () => {
  const code = `mod service;
pub(crate) mod commands;
use service::{self as svc, start as begin, nested::{finish, *}};
fn run() {
  use crate::commands::execute as command;
  command();
}
use service::start as _;
// use imaginary::start;
const TEXT: &str = "use imaginary::start;";
`;
  const lex = scanTokensAndScopes(code, "rust");
  const parsed = parseRustImports(lex.cleanCode, lex.braceSpans, lex.commentlessCode);
  assert.deepEqual(parsed.modules.map((m) => m.name), ["service", "commands"]);
  assert.deepEqual(parsed.uses.map((u) => [u.local, u.path.join("::")]), [
    ["svc", "service"], ["begin", "service::start"], ["finish", "service::nested::finish"],
    ["*", "service::nested::*"], ["command", "crate::commands::execute"]
  ]);
  assert.equal(parsed.uses.find((u) => u.local === "command").scopeStart, 4);
});

test("Rust module calls follow declared paths and aliases without linking another crate", () => {
  const main = `mod service;
mod facade;
use facade::{self as api, start as begin};
fn main() {
  begin();
  api::finish();
  service::nested::finish();
}
`;
  workspace({
    "Cargo.toml": '[package]\nname="app"\nversion="0.1.0"\nedition="2021"\n',
    "src/main.rs": main,
    "src/service.rs": `pub mod nested;
pub fn start() { println!("start"); }
pub fn finish() { println!("finish"); }
pub fn disconnected() { println!("unused"); }
`,
    "src/service/nested.rs": `pub fn finish() { super::start(); }\n`,
    "src/facade/mod.rs": `pub use crate::service::{start, finish};\n`,
    "other/src/main.rs": `mod service;\nfn main() {}\n`,
    "other/src/service.rs": `pub fn start() { println!("other"); }\n`
  }, (root) => {
    let graph = buildWorkspaceFlowGraph(root);
    const target = (file, name) => [...graph.symbolById.values()].find((s) => s.file === file && s.name === name);
    const entry = target("src/main.rs", "main");
    for (const [file, name] of [["src/service.rs", "start"], ["src/service.rs", "finish"], ["src/service/nested.rs", "finish"]]) {
      const symbol = target(file, name);
      assert.ok(graph.reachableFromRuntimeSource.has(symbol.id), symbol.id);
      assert.ok(graph.outEdgeDetails.get(entry.id).some((e) => e.toId === symbol.id && e.resolution.mode === "RUST_MODULE_PATH"));
    }
    assert.ok(!graph.outEdges.get(entry.id).has(target("other/src/service.rs", "start").id));
    assert.ok(!graph.reachableFromRuntimeSource.has(target("src/service.rs", "disconnected").id));
    fs.writeFileSync(path.join(root, "src/main.rs"), main.replace("  begin();\n", "").replace("  api::finish();\n", "").replace("  service::nested::finish();\n", ""));
    clearFlowGraphCache(); graph = buildWorkspaceFlowGraph(root);
    assert.ok(!graph.reachableFromRuntimeSource.has(target("src/service.rs", "start").id));
    const report = verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true });
    assert.ok(report.wiringReport.obligations.some((o) => o.status === "INCONCLUSIVE" && /src\/service.rs.*start/.test(o.targetLocation)));
    const { wiringPlan } = generateWiringBlueprint(root, 'src/service.rs', { targetSymbol: 'disconnected', savePlan: false });
    assert.ok(verifyWorkspaceFlow(root, { fullScan: true, wiringPlan }).wiringReport.obligations.some(o =>
      o.station === 'ENTRY_WIRING' && o.status === 'VIOLATED' && /disconnected/.test(o.finding)));
  });
});

test("Rust block imports and path attributes neither escape their scope nor match missing modules", () => {
  workspace({
    "Cargo.toml": '[package]\nname="app"\nversion="0.1.0"\nedition="2021"\n',
    "src/main.rs": `#[path = "custom/real.rs"]
mod service;
mod unused;
fn main() {
  use service::start as begin;
  begin();
}
fn dormant() {
  use service::disconnected as hidden;
  hidden();
}
fn outside() { hidden(); }
`,
    "src/custom/real.rs": `pub fn start() { println!("start"); }\npub fn disconnected() { println!("unused"); }\n`,
    "src/unused.rs": `pub fn start() { println!("wrong"); }\n`
  }, (root) => {
    let graph = buildWorkspaceFlowGraph(root);
    const find = (file, name) => [...graph.symbolById.values()].find((s) => s.file === file && s.name === name);
    assert.ok(graph.reachableFromRuntimeSource.has(find("src/custom/real.rs", "start").id));
    assert.ok(!graph.outEdges.get(find("src/main.rs", "outside").id).has(find("src/custom/real.rs", "disconnected").id));
    assert.ok(!graph.reachableFromRuntimeSource.has(find("src/unused.rs", "start").id));
    fs.writeFileSync(path.join(root, "src/main.rs"), 'mod absent;\nuse absent::start;\nfn main() { start(); }\n');
    clearFlowGraphCache(); graph = buildWorkspaceFlowGraph(root);
    assert.ok(!graph.reachableFromRuntimeSource.has(find("src/custom/real.rs", "start").id));
    assert.ok(!graph.reachableFromRuntimeSource.has(find("src/unused.rs", "start").id));
  });
});

test("Rust cyclic globs and expanding aliases terminate without inventing a reachable function", () => {
  workspace({
    "src/main.rs": `mod alpha;
mod beta;
use alpha::*;
use missing::missing as missing;
fn main() {
  absent();
  missing::absent();
}
`,
    "src/alpha.rs": `pub use crate::beta::*;\npub fn real() { println!("real"); }\n`,
    "src/beta.rs": `pub use crate::alpha::*;\n`
  }, (root) => {
    const graph = buildWorkspaceFlowGraph(root);
    const real = graph.symbolsByName.get("real")[0];
    assert.ok(!graph.reachableFromRuntimeSource.has(real.id));
  });
});

test("tool-script consumers remain uncertain and cannot satisfy a production entry contract", () => {
  workspace({
    "package.json": JSON.stringify({ name: "private-tools", private: true, type: "module" }),
    "generate.ts": `export function generate(value: string) { console.log(value); }\n`,
    "bench/run.ts": `import * as gen from '../generate.js';\nfunction unused() { return 1; }\nawait gen.generate('value');\n`
  }, (root) => {
    let graph = buildWorkspaceFlowGraph(root);
    const generate = [...graph.symbolById.values()].find((s) => s.name === "generate");
    assert.ok(!graph.reachableFromRuntimeSource.has(generate.id));
    assert.ok(graph.inEdgeDetails.get(generate.id).some((e) => e.evidence.file === "bench/run.ts" && e.evidence.line === 3));
    let report = verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true });
    assert.ok(report.wiringReport.obligations.some((o) => /工具脚本/.test(o.finding) && o.status === "INCONCLUSIVE"));
    const blueprint = generateWiringBlueprint(root, "generate.ts", { targetSymbol: "generate", savePlan: false, requirePersistence: "not_required" });
    report = verifyWorkspaceFlow(root, { fullScan: true, wiringPlan: blueprint.wiringPlan });
    assert.ok(report.wiringReport.obligations.some((o) => o.station === "ENTRY_WIRING" && o.status === "VIOLATED"));
    fs.writeFileSync(path.join(root, "bench/run.ts"), "import * as gen from '../generate.js';\n");
    clearFlowGraphCache();
    report = verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true });
    assert.ok(report.wiringReport.obligations.some((o) => /generate/.test(o.targetLocation) && o.station === "ENTRY_WIRING" && o.status === "INCONCLUSIVE"));
    report = verifyWorkspaceFlow(root, { fullScan: true, wiringPlan: blueprint.wiringPlan });
    assert.ok(report.wiringReport.obligations.some(o => o.station === 'ENTRY_WIRING' && o.status === 'VIOLATED'));
  });
});

function workspace(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowguard real-world-"));
  const priorData = process.env.PLUGIN_DATA;
  process.env.PLUGIN_DATA = path.join(root, ".flowguard-data");
  try {
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    return fn(root);
  } finally {
    if (priorData === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = priorData;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("flowguard real-world-"));
    fs.rmSync(root, { recursive: true, force: true });
    clearFlowGraphCache();
  }
}

test("prototype-named calls remain names and do not crash real-test evidence collection (Hono)", () => {
  workspace({
    "package.json": JSON.stringify({ name: "string-library", type: "module", exports: "./src/index.mjs" }),
    "src/index.mjs": "export function render(value) {\n  return value.toString();\n}\n",
    "test/index.test.mjs": "import { render } from '../src/index.mjs';\nfunction testRender(value) {\n  const text = value.toString();\n  return render(text);\n}\n"
  }, (root) => {
    const blueprint = generateWiringBlueprint(root, "src/index.mjs", { targetSymbol: "render", savePlan: false, requirePersistence: "not_required" });
    const report = verifyWorkspaceFlow(root, { fullScan: true, wiringPlan: blueprint.wiringPlan });
    const behavioral = report.wiringReport.obligations.find((o) => o.layer === "L3_BEHAVIORAL");
    assert.equal(behavioral.status, "INCONCLUSIVE");
    assert.ok(behavioral.evidence.some((e) => e.includes("test/index.test.mjs")));
  });
});

test("import aliases safely support Object prototype names", () => {
  const source = `import { convert as __proto__, convert as constructor } from './convert';
export function useAliases(value) {
  return constructor(__proto__(value)).toString();
}`;
  const parsed = parseSourceFileContent(source, "src/aliases.ts");
  const symbol = parsed.symbols.find((s) => s.name === "useAliases");
  assert.ok(symbol.calls.includes("convert"));
  assert.ok(symbol.calls.includes("toString"));
  assert.ok(symbol.calls.every((call) => typeof call === "string"));
  assert.ok(symbol.callSites.every((site) => typeof site.callee === "string"));
});

test("indexed clone comparison agrees exactly with exhaustive Jaccard pairs", () => {
  let seed = 719;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (const threshold of [0.5, 0.85, 1]) {
    for (let run = 0; run < 15; run++) {
      const items = Array.from({ length: 35 }, (_, index) => ({ id: index,
        shingles: new Set(Array.from({ length: Math.floor(random() * 50) }, () => String(Math.floor(random() * 60)))) }));
      items.push({ id: 35, shingles: new Set(items[12].shingles) });
      const filter = (a, b) => a.id % 2 === 0 || b.id % 2 === 0;
      const expected = [];
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        if (!filter(items[i], items[j])) continue;
        const intersection = [...items[i].shingles].filter((s) => items[j].shingles.has(s)).length;
        const similarity = intersection / new Set([...items[i].shingles, ...items[j].shingles]).size;
        if (similarity >= threshold) expected.push({ left: i, right: j, similarity });
      }
      assert.deepEqual(findSimilarShinglePairs(items, threshold, filter), expected);
      const visited = [];
      forEachSimilarShinglePair(items, threshold, filter, (left, right, similarity) => visited.push({ left, right, similarity }));
      assert.deepEqual(visited.sort((a, b) => a.left - b.left || a.right - b.right), expected);
    }
  }
});

test("clone report materializes a matching preview without scope errors", () => {
  const body = "const alpha = value + 1; const beta = alpha * 2; const gamma = beta + 3; const delta = gamma * 4; const epsilon = delta + 5; const zeta = epsilon * 6; const eta = zeta + 7; return eta;";
  workspace({
    "package.json": JSON.stringify({ name: "clone-preview", type: "module" }),
    "src/index.mjs": `export function first(value) { ${body} }\nexport function second(value) { ${body} }\n`
  }, (root) => {
    const report = verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true });
    assert.equal(report.summary.structuralClonesCount, 1);
    assert.deepEqual(report.structuralClones.map((clone) => [clone.funcA, clone.funcB, clone.similarity]), [
      ["src/index.mjs:1-1 (first)", "src/index.mjs:2-2 (second)", "100%"]
    ]);
  });
});

test("report counts and headline include every blocker and unresolved dropped input", () => {
  workspace({
    "package.json": JSON.stringify({ name: "pipeline", exports: "./src/index.mjs" }),
    "src/index.mjs": `export function calculate(value) { return value * 2; }
export function pipeline(value) {
  const discarded = calculate(value);
  return value;
}
export function dropped(option) { return 42; }
`
  }, (root) => {
    const report = verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true });
    assert.equal(report.verificationVerdict, "VIOLATED");
    assert.ok(report.wiringReport.obligations.some((o) => o.status === "VIOLATED" && o.finding.includes("discarded")));
    assert.ok(report.wiringReport.obligations.some((o) => o.status === "INCONCLUSIVE" && o.finding.includes("option")));
    const counts = report.wiringReport.counts;
    assert.equal(counts.violated, report.wiringReport.obligations.filter((o) => o.status === "VIOLATED").length);
    assert.equal(counts.violated, report.summary.obligationsViolated);
    assert.ok(report.headlineSummary.includes(`${counts.violated} 项违反`));
    fs.writeFileSync(path.join(root, "src/index.mjs"), "export function dropped(option) { return 42; }\n");
    clearFlowGraphCache();
    assert.equal(verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true }).verificationVerdict, "INCONCLUSIVE");
  });
});

test("inline function bodies retain consumed arguments, return values and call-site positions", () => {
  for (const body of ["return consume(value);", "return 42;"]) {
    const parsed = parseSourceFileContent(`export function inline(value) { ${body} }`, "inline.ts");
    const symbol = parsed.symbols.find((s) => s.name === "inline");
    assert.equal(symbol.hasReturnValue, true);
    assert.deepEqual(symbol.readParams, body.includes("consume") ? ["value"] : []);
    assert.deepEqual(symbol.unusedParams, body.includes("consume") ? [] : ["value"]);
    if (body.includes("consume")) {
      const call = symbol.callSites.find((c) => c.callee === "consume");
      assert.equal(call.line, 1);
      assert.equal(call.returnFlow, "RETURNED");
      assert.deepEqual(call.positionalArgs, ["value"]);
    }
  }
});

test("validation guards remain executable bodies instead of unconditional exception stubs (p-limit)", () => {
  for (const value of ["concurrency", "1"]) {
    const source = `function validateConcurrency(concurrency) {
      if (!((Number.isInteger(${value}) || ${value} === Number.POSITIVE_INFINITY) && ${value} > 0)) {
        throw new TypeError('Expected a positive concurrency');
      }
    }`;
    const symbol = parseSourceFileContent(source, "index.js").symbols[0];
    assert.deepEqual(symbol.unusedParams, value === "1" ? ["concurrency"] : []);
  }
});

test("multiline generic class bodies retain their actual implementations (Zod)", () => {
  const parsed = parseSourceFileContent(`export abstract class Schema<T> {
    abstract parse(input: T): T;
  }
  export class ArraySchema<T, Cardinality = "many"> extends Schema<
    Cardinality extends "one" ? [T, ...T[]] : T[]
  > {
    parse(input: T[]): T[] { return input; }
  }`, "schema.ts");
  const member = parsed.symbols.find((s) => s.name === "parse" && s.parentContainerName === "ArraySchema");
  assert.ok(member);
  assert.equal(member.hasImplementation, true);
});

test("same-named versioned base classes never share method obligations (Zod v3/v4)", () => {
  workspace({
    "package.json": JSON.stringify({ name: "schemas", exports: { "./v3": "./v3/types.ts", "./v4": "./v4/types.ts" } }),
    "v3/types.ts": `export abstract class Schema<T> {
      abstract parse(input: T): T;
    }
    export class OldSchema extends Schema<string> {
      parse(input: string) { return input; }
    }`,
    "v4/types.ts": `export interface Schema<T> {
      toJSONSchema(): object;
    }
    export class NewSchema implements Schema<string> {
      toJSONSchema() { return {}; }
    }
    export class MissingSchema implements Schema<string> {
    }`
  }, (root) => {
    const report = verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true });
    const missing = report.wiringReport.obligations.filter((o) => o.status === "VIOLATED" && o.finding.includes("遗漏实现"));
    assert.equal(missing.length, 1, JSON.stringify(missing));
    assert.ok(missing[0].finding.includes("MissingSchema"));
    assert.ok(missing[0].finding.includes("toJSONSchema"));
  });
});

test("stream decoding is data consumption, not a persistence-only field read (httpx)", () => {
  workspace({ "decoder.py": `class Chunker:
    def __init__(self, size):
        self.size = size
        self.buffer = []
    def decode(self, value):
        self.buffer.append(value[:self.size])
        return self.buffer
    def flush(self):
        return self.buffer
` }, (root) => {
    const report = verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true });
    assert.ok(!report.wiringReport.obligations.some((o) => o.status === "VIOLATED" && /持久化/.test(o.finding)));
  });
});

test("Go package calls connect library helpers without accepting another package's names", () => {
  workspace({
    "go.mod": "module example.org/parse\n",
    "api.go": "package parse\nfunc Parse(value int) int { return parseValue(value) }",
    "helper.go": "package parse\nfunc parseValue(value int) int { return value }",
    "cmd/main.go": "package main\nfunc wrongPackage(value int) int { return parseValue(value) }"
  }, (root) => {
    const graph = buildWorkspaceFlowGraph(root, true);
    const helper = graph.symbolsByName.get("parseValue")[0];
    assert.ok(graph.reachableFromSource.has(helper.id));
    assert.ok([...graph.callInEdges.get(helper.id)].every((id) => !id.startsWith("cmd/")));
  });
});

test("library package boundaries preserve app wiring checks in mixed workspaces", () => {
  workspace({
    "package.json": JSON.stringify({ private: true, workspaces: ["packages/*", "apps/*"] }),
    "packages/ui/package.json": JSON.stringify({ name: "ui", svelte: "./dist/index.js", exports: { ".": "./dist/index.js" } }),
    "packages/ui/src/lib/index.ts": "export function Button(value) { return value; }",
    "apps/web/package.json": JSON.stringify({ private: true }),
    "apps/web/src/main.ts": "function main() { launch(); }\nexport function LostAction(value) { return value; }",
    "go/go.mod": "module example.org/router\n",
    "go/context.go": "package router\nfunc Clone(value int) int { return value }",
    "go/cmd/main.go": "package main\nfunc main() { launch() }\nfunc LostCommand(value int) int { return value }",
    "python/pyproject.toml": '[project]\nname = "client"\n[build-system]\nbuild-backend = "hatchling.build"\n',
    "python/client/__init__.py": "from .utils import convert\n",
    "python/client/utils.py": "def convert(value):\n    return value\n",
    "backend/pyproject.toml": '[project]\nname = "app"\n[build-system]\nbuild-backend = "hatchling.build"\n[tool.fastapi]\nentrypoint = "app.main:app"\n',
    "backend/app/__init__.py": "",
    "backend/app/main.py": "def main():\n    launch()\ndef lost(value):\n    return value\n"
  }, (root) => {
    const graph = buildWorkspaceFlowGraph(root, true);
    for (const name of ["Button", "Clone", "convert"]) {
      const symbol = graph.symbolsByName.get(name)[0];
      assert.equal(symbol.projectMode, "library", name);
      assert.ok(graph.reachableFromSource.has(symbol.id), name);
    }
    assert.equal(graph.symbolsByName.get("Button")[0].isPackageEntryExport, true);
    for (const name of ["LostAction", "LostCommand", "lost"]) assert.equal(graph.symbolsByName.get(name)[0].projectMode, "application", name);
    for (const [file, name, expected] of [
      ["packages/ui/src/lib/index.ts", "Button", "SATISFIED"],
      ["python/client/utils.py", "convert", "SATISFIED"],
      ["go/context.go", "Clone", "SATISFIED"],
      ["apps/web/src/main.ts", "LostAction", "VIOLATED"],
      ["go/cmd/main.go", "LostCommand", "VIOLATED"],
      ["backend/app/main.py", "lost", "VIOLATED"]
    ]) {
      const blueprint = generateWiringBlueprint(root, file, { targetSymbol: name, savePlan: false, requirePersistence: "not_required" });
      const report = verifyWorkspaceFlow(root, { fullScan: true, wiringPlan: blueprint.wiringPlan });
      assert.equal(report.wiringReport.obligations.find((o) => o.checkSpec?.type === "ENTRY_REACHABILITY").status, expected, name);
    }
    const forced = buildWorkspaceFlowGraph(root, true, { projectMode: "application" });
    assert.equal(forced.symbolsByName.get("Button")[0].projectMode, "application");
  });
});

test("Dart callback fields do not become abstract methods (Dio)", () => {
  const parsed = parseSourceFileContent(`abstract class BaseHandler {
    void Function()? _processNextInQueue;
    void Function(int value)? onValue;
    void handle(int value);
  }
  class Handler extends BaseHandler {
    void handle(int value) { consume(value); }
    void setCallback(void Function(int value) callback) { callback(1); }
    void localCallback() { void Function()? pending; consume(pending); }
    void invoke(
      void Function(int value) onValue,
      int value,
    ) { onValue(value); }
  }`, "lib/handler.dart");
  assert.equal(parsed.symbols.some((s) => s.name === "Function"), false);
  assert.equal(parsed.symbols.filter((s) => s.name === "handle").length, 2);
  assert.deepEqual(parsed.symbols.find((s) => s.name === "setCallback").params, ["callback"]);
  assert.ok(parsed.symbols.some((s) => s.name === "localCallback"));
  assert.deepEqual(parsed.symbols.find((s) => s.name === "invoke").params, ["onValue", "value"]);
});

test("Ruby, Dart and Gradle package boundaries preserve application-only entry checks", () => {
  workspace({
    "ruby/tool.gemspec": 'Gem::Specification.new do |spec|\n spec.name = "tool"\n spec.require_paths = ["custom"]\nend',
    "ruby/custom/tool.rb": "def ruby_api(value)\n value\nend",
    "ruby/exe/command.rb": "def ruby_lost(value)\n value\nend",
    "dart/pubspec.yaml": "name: parser\n",
    "dart/lib/parser.dart": "String dartApi(String value) { return value; }",
    "dart/apps/client/pubspec.yaml": "name: client\nflutter:\n  uses-material-design: true\n",
    "dart/apps/client/lib/main.dart": "void main() { launch(); }\nString dartLost(String value) { return value; }",
    "jvm/build.gradle.kts": 'plugins { kotlin("multiplatform") }\ntasks.register<JavaExec>("generate") { mainClass.set("Generator") }',
    "jvm/src/main/kotlin/Client.kt": "fun kotlinApi(value: String): String { return value; }",
    "jvm/apps/client/build.gradle.kts": 'plugins { kotlin("jvm"); id("application") }',
    "jvm/apps/client/src/main/kotlin/Command.kt": "fun kotlinLost(value: String): String { return value; }",
  }, (root) => {
    const graph = buildWorkspaceFlowGraph(root, true);
    for (const name of ["ruby_api", "dartApi", "kotlinApi"]) {
      const symbol = graph.symbolsByName.get(name)[0];
      assert.equal(symbol.projectMode, "library", name);
      assert.ok(graph.reachableFromSource.has(symbol.id), name);
    }
    for (const name of ["ruby_lost", "dartLost", "kotlinLost"]) {
      const symbol = graph.symbolsByName.get(name)[0];
      assert.equal(symbol.projectMode, "application", name);
      assert.equal(graph.reachableFromSource.has(symbol.id), false, name);
      const blueprint = generateWiringBlueprint(root, symbol.file, { targetSymbol: name, savePlan: false, requirePersistence: "not_required" });
      const report = verifyWorkspaceFlow(root, { fullScan: true, wiringPlan: blueprint.wiringPlan });
      assert.equal(report.wiringReport.obligations.find((o) => o.checkSpec?.type === "ENTRY_REACHABILITY").status, "VIOLATED", name);
    }
  });
});

test("JSX connects exact default, named and namespace imports with rendering evidence", () => {
  workspace({
    "package.json": JSON.stringify({ private: true }),
    "src/main.js": `import LocalName from './controls';
import { Badge as Display } from './badge';
import * as Layout from './layout';
export function NeverRendered(value) { return value; }
createRoot(document.body).render(<LocalName><Display/><Layout.Panel /></LocalName>);`,
    "src/controls.js": "export default function WindowControl() { return <div />; }",
    "src/badge.jsx": "export function Badge() { return <span />; }",
    "src/layout.jsx": "export function Panel() { return <section />; }",
    "src/unrelated.jsx": "export function Badge() { return <div />; }",
    "src/unused.jsx": "export function Dormant() { return <WindowControl />; }",
    "src/generic.tsx": "export function make<T>() { return cast<T>(); }",
  }, (root) => {
    const graph = buildWorkspaceFlowGraph(root, true);
    for (const [name, file] of [["WindowControl", "src/controls.js"], ["Badge", "src/badge.jsx"], ["Panel", "src/layout.jsx"]]) {
      const symbol = graph.symbolsByName.get(name).find((s) => s.file === file);
      assert.ok(graph.reachableFromSource.has(symbol.id), name);
      const edge = graph.inEdgeDetails.get(symbol.id).find((e) => e.kind === "REGISTRATION");
      assert.equal(edge.evidence.line, 5);
      assert.equal(edge.resolution.mode, "EXACT_IMPORT");
      assert.equal(edge.resolution.confidence, "HIGH");
      assert.equal(edge.evidence.argumentSites, undefined);
    }
    for (const file of ["src/unrelated.jsx", "src/unused.jsx", "src/generic.tsx"]) {
      for (const symbol of graph.symbolById.values()) if (symbol.file === file) assert.equal(graph.reachableFromSource.has(symbol.id), false, file);
    }
    const never = graph.symbolsByName.get("NeverRendered")[0];
    assert.equal(graph.reachableFromSource.has(never.id), false);
    fs.writeFileSync(path.join(root, "src/main.js"), "createRoot(document.body).render(<div />);");
    const removed = buildWorkspaceFlowGraph(root, true);
    assert.equal(removed.reachableFromSource.has(graph.symbolsByName.get("WindowControl")[0].id), false);
  });
});

test("dynamic JSX follows namespace barrels without proving a particular runtime selection", () => {
  workspace({
    "package.json": JSON.stringify({ private: true }),
    "src/Shell.jsx": `import * as providers from './providers';
export function main() {
  const Panel = providers[serviceName].Config;
  return <Panel />;
}`,
    "src/providers/index.js": "import * as one from './one';\nimport * as two from './two';\nexport const alpha = one;\nexport const beta = two;",
    "src/providers/one/index.js": "export * from './Config';",
    "src/providers/one/Config.jsx": "export function Config() { return <section />; }",
    "src/providers/two/index.js": "export { Editor as Config } from './Editor';",
    "src/providers/two/Editor.jsx": "export function Editor() { return <section />; }",
    "src/unrelated/Config.jsx": "export function Config() { return <aside />; }",
    "src/fake.js": "export type { Config } from './providers/one/Config';",
  }, (root) => {
    const graph = buildWorkspaceFlowGraph(root, true);
    const target = graph.symbolsByName.get("Config").find((s) => s.file.includes("providers/one"));
    const other = graph.symbolsByName.get("Editor")[0];
    for (const symbol of [target, other]) {
      assert.equal(graph.reachableFromRuntimeSource.has(symbol.id), false);
      assert.ok(graph.possiblyReachableFromRuntimeSource.has(symbol.id));
    }
    assert.equal(graph.possiblyReachableFromRuntimeSource.has(graph.symbolsByName.get("Config").find((s) => s.file.includes("unrelated")).id), false);
    const report = verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true });
    assert.ok(report.wiringReport.obligations.some((o) => o.targetLocation?.includes(target.file) && o.status === "INCONCLUSIVE"));
    fs.writeFileSync(path.join(root, "src/Shell.jsx"), "import * as providers from './providers';\nexport function main() { const Panel = providers.alpha.Config; return <Panel />; }");
    const direct = buildWorkspaceFlowGraph(root, true);
    assert.ok(direct.reachableFromRuntimeSource.has(target.id));
    assert.equal(direct.possiblyReachableFromRuntimeSource.has(other.id), false);
    fs.writeFileSync(path.join(root, "src/providers/one/index.js"), "export const unrelated = 1;");
    const removed = buildWorkspaceFlowGraph(root, true);
    assert.equal(removed.possiblyReachableFromRuntimeSource.has(target.id), false);
  });
});

test("Kotlin anonymous callback exposure stays scoped and uncertain until invocation is proven", () => {
  for (const passed of [true, false]) workspace({
    "build.gradle.kts": 'plugins { id("application") }',
    "Main.kt": `class Screen {
      fun onCreate() {
        ${passed ? "client.enqueue(" : "val unused ="}
          object : Callback {
            override fun onResponse(response: Response) { response.close(); }
          }
        ${passed ? ")" : ""}
      }
      fun neverRun() {
        client.enqueue(
          object : Callback {
            override fun onFailure(error: Error) { report(error); }
          }
        )
      }
      companion object {
        fun create(value: String): String { return value; }
      }
    }
    object Other {
      fun create(value: String): String { return value; }
    }`
  }, (root) => {
    const graph = buildWorkspaceFlowGraph(root, true);
    const callback = graph.symbolsByName.get("onResponse")[0];
    assert.match(callback.parentContainerName, /^anonymous@/);
    assert.equal(callback.kind, "method");
    assert.equal(callback.isPublicApi, false);
    assert.equal(graph.reachableFromRuntimeSource.has(callback.id), false);
    assert.equal(graph.possiblyReachableFromRuntimeSource.has(callback.id), passed);
    assert.equal(graph.possiblyReachableFromRuntimeSource.has(graph.symbolsByName.get("onFailure")[0].id), false);
    assert.deepEqual(graph.symbolsByName.get("create").map((s) => s.parentContainerName).sort(), ["Companion", "Other"]);
    const blueprint = generateWiringBlueprint(root, "Main.kt", { targetSymbol: "onResponse", savePlan: false, requirePersistence: "not_required" });
    const report = verifyWorkspaceFlow(root, { fullScan: true, wiringPlan: blueprint.wiringPlan });
    assert.equal(report.wiringReport.obligations.find((o) => o.checkSpec?.type === "ENTRY_REACHABILITY").status, passed ? "INCONCLUSIVE" : "VIOLATED");
  });
});

test("JVM bases honor qualified external imports and nested interface aliases", () => {
  workspace({
    "protocol.kt": `package transport
class Reader {
  interface Handler {
    fun consume(data: Data)
  }
}`,
    "logging.kt": `package transport
import java.util.logging.Handler
object Logger : Handler() {
  override fun publish(record: Record) { print(record); }
}`,
    "missing.kt": `package transport
import transport.Reader.Handler as InputHandler
class Missing : InputHandler {
}`,
  }, (root) => {
    const report = verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true });
    const missing = report.wiringReport.obligations.filter((o) => /遗漏实现方法/.test(o.finding));
    assert.equal(missing.length, 1, JSON.stringify(missing));
    assert.ok(missing[0].finding.includes('"Missing"'));
    assert.ok(missing[0].finding.includes('"consume()"'));
  });
});

test("persistence helpers consume cancellation handles without inventing sibling-field contracts", () => {
  workspace({
    "package.json": JSON.stringify({ exports: "./store.js" }),
    "store.js": `export class Store {
      constructor() { this.timer = null; this.threshold = 0.75; this.enabled = true; }
      save() {
        clearTimeout((this.timer));
        this.timer = setTimeout(() => write(), 50);
        return JSON.stringify({ threshold: this.threshold });
      }
      calculate(score) { return this.enabled && score > 0.75; }
    }`
  }, (root) => {
    const report = verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true });
    const fieldChecks = report.wiringReport.obligations.filter((o) => o.station === "DATA_FLOW_CONSUMPTION");
    assert.equal(fieldChecks.some((o) => o.finding.includes('"Store.timer"')), false);
    assert.ok(fieldChecks.some((o) => o.finding.includes('"Store.threshold"') && o.status === "INCONCLUSIVE"));
    const blueprint = generateWiringBlueprint(root, "store.js", { targetField: "threshold", consumerTarget: "calculate", savePlan: false, requirePersistence: "not_required" });
    const failed = verifyWorkspaceFlow(root, { fullScan: true, wiringPlan: blueprint.wiringPlan });
    assert.equal(failed.wiringReport.obligations.find((o) => o.checkSpec?.type === "TARGET_DATA_CONSUMPTION").status, "VIOLATED");
    const file = path.join(root, "store.js");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("score > 0.75", "score > this.threshold"));
    const fixed = verifyWorkspaceFlow(root, { fullScan: true, wiringPlan: blueprint.wiringPlan });
    assert.equal(fixed.wiringReport.obligations.find((o) => o.checkSpec?.type === "TARGET_DATA_CONSUMPTION").status, "SATISFIED");
    const timerPlan = generateWiringBlueprint(root, "store.js", { targetField: "timer", savePlan: false, requirePersistence: "not_required" });
    const timerUsed = verifyWorkspaceFlow(root, { fullScan: true, wiringPlan: timerPlan.wiringPlan });
    assert.equal(timerUsed.wiringReport.obligations.find((o) => o.checkSpec?.type === "TARGET_DATA_CONSUMPTION").status, "SATISFIED");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("clearTimeout((this.timer))", "JSON.stringify(this.timer)"));
    const timerDropped = verifyWorkspaceFlow(root, { fullScan: true, wiringPlan: timerPlan.wiringPlan });
    assert.equal(timerDropped.wiringReport.obligations.find((o) => o.checkSpec?.type === "TARGET_DATA_CONSUMPTION").status, "VIOLATED");
  });
});

test("grouping parentheses preserve positional inputs without flattening compound expressions", () => {
  const parsed = parseSourceFileContent("export function main(value, other) { consume(((value)), (value, other), (value) + other, null); }", "main.js");
  const call = parsed.symbols[0].callSites.find((s) => s.callee === "consume");
  assert.deepEqual(call.positionalArgs, ["value", null, null, null]);
});

test("Alembic hooks require configured version paths and revision metadata", () => {
  const revision = `from alembic import op
revision = '1'
down_revision = None
def upgrade():
    op.create_table('data')
def downgrade():
    op.drop_table('data')
def unrelated(value):
    return value
`;
  workspace({
    "backend/alembic.ini": "[alembic]\nscript_location = %(here)s/app/migrations\n",
    "backend/app/migrations/versions/one.py": revision,
    "backend/other/versions/two.py": revision,
    "backend/app/migrations/versions/helper.py": "def upgrade():\n    perform()\n",
  }, (root) => {
    const graph = buildWorkspaceFlowGraph(root, true, { projectMode: "application" });
    for (const symbol of graph.symbolById.values()) {
      const expected = symbol.file.endsWith("one.py") && /^(upgrade|downgrade)$/.test(symbol.name);
      assert.equal(graph.reachableFromSource.has(symbol.id), expected, `${symbol.file}:${symbol.name}`);
      if (expected) assert.equal(symbol.frameworkEntryEvidence, "backend/alembic.ini");
    }
  });
});

test("generic constraints and qualified names identify only actual base types", () => {
  const fixtures = [
    ["generic.ts", "export class Range<T extends TimeValue = Time> {\n}\n", "Range", []],
    ["nested.ts", "export class Effect<T extends Base<any>, Output = Out<T>, Input = In<T>> extends Base<\n Output,\n Def<T>,\n Input\n> {\n}\n", "Effect", ["Base"]],
    ["bounded.cs", "public class Values<T> : ValueBase where T : IEquatable<T> {\n}\n", "Values", ["ValueBase"]],
    ["qualified.cs", "public class CustomMap : Mapper.ITypeMap {\n}\n", "CustomMap", ["Mapper.ITypeMap"]],
    ["qualified.py", "class Failure(click.UsageError):\n    pass\n", "Failure", ["click.UsageError"]],
    ["generic.py", "class Registry(Base, Generic[T]):\n    pass\n", "Registry", ["Base"]]
  ];
  for (const [file, source, name, bases] of fixtures) {
    const symbol = parseSourceFileContent(source, file).symbols.find((s) => s.name === name);
    assert.deepEqual(symbol?.baseTypes, bases, file);
  }
});

test("nested Python functions are local helpers, not required sibling methods (httpx)", () => {
  const source = `class Auth:
    def auth_flow(self, request):
        return request
class DigestAuth(Auth):
    def build(self, request):
        def digest(data):
            return data.upper()
        return digest(request)
`;
  const parsed = parseSourceFileContent(source, "auth.py");
  const digest = parsed.symbols.find((s) => s.name === "digest");
  const build = parsed.symbols.find((s) => s.name === "build");
  assert.equal(digest.kind, "function");
  assert.equal(digest.parentContainerName, null);
  assert.equal(digest.parentFunctionId, build.id);
});

test("platform arity includes underscore and unnamed parameters while detecting genuine drift", () => {
  workspace({ "src/platform.rs": `
#[cfg(unix)]
pub fn is_device(ft: FileType) -> bool { ft.is_device() }
#[cfg(windows)]
pub fn is_device(_: FileType) -> bool { false }
#[cfg(unix)]
pub fn restore(window: Window, monitors: Monitors) { window.apply(monitors); }
#[cfg(windows)]
pub fn restore(window: Window, _monitors: Monitors) { window.show(); }
#[cfg(unix)]
pub fn broken(window: Window, monitors: Monitors) { window.apply(monitors); }
#[cfg(windows)]
pub fn broken(window: Window) { window.show(); }
` }, (root) => {
    const report = verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true });
    const drift = report.wiringReport.obligations.filter((o) => /参数数量不一致/.test(o.finding));
    assert.equal(drift.length, 1, JSON.stringify(drift));
    assert.ok(drift[0].finding.includes('"broken"'));
  });
});

test("conditional compilation compares branch overload sets, not nearby or body directives", () => {
  workspace({
    "Instant.swift": `struct Instant {
      init(_ value: Double) { self.value = value }
      #if canImport(Darwin)
      init() { value = clock() }
      #elseif canImport(FoundationEssentials)
      init() { value = now() }
      #endif
    }`,
    "Logger.cs": `class Logger {
      public void Write(string text) {
        #if DEBUG
        Trace(text);
        #endif
      }
      public void Write(string text, object value) { Emit(text, value); }
      #if FIRST
      public void Format(string text) { Emit(text); }
      public void Format(string text, object value) { Emit(text, value); }
      #else
      public void Format(string text) { Emit(text); }
      public void Format(string text, object value) { Emit(text, value); }
      #endif
      #if FIRST
      public void Broken(string text, object value) { Emit(text, value); }
      #else
      public void Broken(string text) { Emit(text); }
      #endif
    }`,
    "features.rs": `#[cfg(feature = "one")]
      pub fn optional(x: X) { use_x(x); }
      #[cfg(feature = "two")]
      pub fn optional(x: X, y: Y) { use_pair(x, y); }
      #[cfg(all(unix, feature = "one"))]
      pub fn branch(x: X) { use_x(x); }
      #[cfg(all(windows, feature = "one"))]
      pub fn branch(x: X, y: Y) { use_pair(x, y); }
    `
  }, (root) => {
    const report = verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true });
    const drift = report.wiringReport.obligations.filter((o) => /参数数量不一致/.test(o.finding));
    assert.equal(drift.length, 2, JSON.stringify(drift));
    assert.ok(drift.some((o) => o.finding.includes('"Broken"')));
    assert.ok(drift.some((o) => o.finding.includes('"branch"')));
  });
});

test("different Rust traits and local helper scopes do not become platform twins", () => {
  workspace({ "src/router.rs": `
pub struct Router {}
#[cfg(feature = "handler")]
impl Handler for Router {
    fn call(self, request: Request, state: State) { process(request, state); }
}
#[cfg(feature = "service")]
impl Service for Router {
    fn call(&mut self, request: Request) { process(request); }
}
pub fn hidden(path: Path) -> bool {
    #[cfg(unix)]
    fn imp(path: Path) -> bool { path.hidden() }
    imp(path)
}
pub fn strip(prefix: Path, path: Path) -> Path {
    #[cfg(unix)]
    fn imp(prefix: Path, path: Path) -> Path { path.strip(prefix) }
    imp(prefix, path)
}
` }, (root) => {
    const report = verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true });
    assert.equal(report.wiringReport.obligations.filter((o) => /参数数量不一致/.test(o.finding)).length, 0);
  });
});

test("ordinary same-file references do not exempt a dropped input as a callback (Click)", () => {
  workspace({ "utils.py": `
def transform(name):
    return "constant"
def lookup(name):
    return name.upper()
def other(name):
    return name.lower()
def main():
    return transform("first") + lookup("second") + other("third")
` }, (root) => {
    const report = verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true });
    assert.ok(report.dataFlowBreaks.some((r) => r.location.includes("transform") && r.unusedParams?.includes("name")));
  });
});

test("only declared abstract or interface members are required across siblings", () => {
  workspace({
    "package.json": JSON.stringify({ name: "auth-library", type: "module", exports: "./src/auth.ts" }),
    "src/auth.ts": `
export class Auth {}
export class Download extends Auth {}
export class Stream extends Auth {
  didReceive(data: string) { console.log(data); }
}
export function receive(stream: Stream) { stream.didReceive('data'); }
export interface Handler {
  process(value: string): string;
}
export class Working implements Handler {
  process(value: string) { return value; }
}
export class Missing implements Handler {}
export class Delegated implements Handler {
  process: typeof process = process
}
export function process(value: string) { return value; }
` }, (root) => {
    const report = verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true });
    const missing = report.wiringReport.obligations.filter((o) => /遗漏实现方法/.test(o.finding));
    assert.equal(missing.length, 1, JSON.stringify(missing));
    assert.ok(missing[0].finding.includes('"Missing"'));
  });
});

test("a function blueprint does not inherit unrelated classes' factory obligations (Click)", () => {
  workspace({
    "package.json": JSON.stringify({ name: "helper-lib", type: "module", exports: "./src/helpers.ts" }),
    "src/helpers.ts": `export function normalize(value: string) { return value.trim(); }
export class Transport { send(value: string) { return value; } }
`,
    "src/factory.ts": `import { Transport } from './helpers';
export function createTransport() { return new Transport(); }
`
  }, (root) => {
    const result = generateWiringBlueprint(root, "src/helpers.ts", { targetSymbol: "normalize", savePlan: false, requirePersistence: "not_required" });
    assert.equal(result.wiringPlan.obligations.some((o) => o.checkSpec?.type === "FACTORY_OR_DISPATCH_REGISTRATION"), false);
  });
});

test("default interface methods and protocol extensions are implementations, not missing obligations", () => {
  workspace({ "src/serializers.swift": `
protocol Serializer {
    func serialize(data: String) -> String
}
extension Serializer {
    static func factory() -> String { return "default" }
}
struct First: Serializer {
    func serialize(data: String) -> String { return data }
}
struct Second: Serializer {
    func serialize(data: String) -> String { return data }
}
` }, (root) => {
    const report = verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true });
    assert.equal(report.wiringReport.obligations.some((o) => /遗漏实现方法.*factory/.test(o.finding)), false);
  });
});

test("public library alternatives and interfaces do not imply a closed factory registry", () => {
  workspace({
    "package.json": JSON.stringify({ name: "optional-lib", type: "module", exports: "./src/index.ts" }),
    "src/index.ts": `
export interface Config { value: string; }
export interface OptionalConfig extends Config { optional: string; }
export class Base {}
export class Default extends Base {}
export class Optional extends Base {}
export function createDefault() { return new Default(); }
` }, (root) => {
    const report = verifyWorkspaceFlow(root, { fullScan: true, ignoreSavedPlan: true });
    assert.equal(report.wiringReport.obligations.some((o) => o.status === "VIOLATED" && /工厂/.test(o.finding)), false);
  });
});
