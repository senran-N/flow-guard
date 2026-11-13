import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSourceFileContent } from "../src/file-parser.mjs";
import { createRustResolver } from "../src/rust-imports.mjs";
import { analyzeCargoProject } from "../src/rust-project.mjs";
import { buildWorkspaceFlowGraph, clearFlowGraphCache } from "../src/graph-builder.mjs";

function withWorkspace(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowguard-rust-project-"));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const destination = path.join(root, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }
    return fn(root);
  } finally {
    clearFlowGraphCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('macro_rules templates do not emit ordinary symbols or import bindings', () => {
  const parsed = parseSourceFileContent(`macro_rules! make_type {
    ($name:ident) => {
        pub struct $name;
        impl $name {
            pub(crate) fn template_only() {}
        }
        use crate::other::phantom;
    };
}
pub fn ordinary() {}
`, 'src/macros.rs');
  assert.ok(!parsed.symbols.some((symbol) => symbol.name === 'template_only'));
  assert.ok(parsed.symbols.some((symbol) => symbol.name === 'ordinary'));
  assert.ok(!parsed.rustImports.uses.some((binding) => binding.local === 'phantom'));
  assert.equal(parsed.rustImports.macroDefinitions.length, 1);
});

test("Cargo project analysis maps renamed path dependencies without choosing a cfg target", () => {
  const project = analyzeCargoProject([
    { file: "Cargo.toml", content: "[workspace]\nmembers = [\"app\", \"vendor/actual-lib\"]\n" },
    { file: "app/Cargo.toml", content: `[package]\nname = "app-bin"\nversion = "0.1.0"\n\n[dependencies]\nlocal_alias = { package = "actual-lib", path = "../vendor/actual-lib" }\noptional_alias = { package = "actual-lib", path = "../vendor/actual-lib", optional = true }\nescaped = { package = "actual-lib", path = "../../outside" }\n\n[target.'cfg(windows)'.dependencies]\nwin_alias = { package = "actual-lib", path = "../vendor/actual-lib" }\n\n[dev-dependencies]\ndev_alias = { package = "actual-lib", path = "../vendor/actual-lib" }\n` },
    { file: "vendor/actual-lib/Cargo.toml", content: "[package]\nname = \"actual-lib\"\nversion = \"0.1.0\"\n" }
  ], ["app/src/main.rs", "vendor/actual-lib/src/lib.rs"]);
  const app = project.packages.find((pkg) => pkg.name === "app-bin");
  assert.equal(app.crateName, "app_bin");
  assert.deepEqual(app.targets.map((target) => [target.kind, target.file]), [["bin", "app/src/main.rs"]]);
  assert.deepEqual(project.entryRoots, ["app/src/main.rs"]);
  assert.deepEqual(project.libraryFiles, ["vendor/actual-lib/src/lib.rs"]);
  assert.deepEqual(app.dependencies.map((dep) => [dep.localName, dep.packageCrateName, dep.packageManifest, dep.condition, dep.active, dep.resolution]), [
    ["local_alias", "actual_lib", "vendor/actual-lib/Cargo.toml", null, true, "LOCAL_PATH"],
    ["optional_alias", "actual_lib", "vendor/actual-lib/Cargo.toml", null, false, "OPTIONAL_UNSELECTED"],
    ["escaped", "actual_lib", null, null, true, "OUTSIDE_WORKSPACE"],
    ["win_alias", "actual_lib", "vendor/actual-lib/Cargo.toml", "cfg(windows)", false, "TARGET_CONDITIONAL"]
  ]);
});

test("Cargo autobins include direct src/bin files only when autobins is enabled", () => {
  const manifests = [
    { file: "on/Cargo.toml", content: "[package]\nname = \"on\"\nversion = \"0.1.0\"\nautolib = false\n\n[[bin]]\nname = \"on\"\n\n[[bin]]\npath = \"cmd/path-only.rs\"\n" },
    { file: "off/Cargo.toml", content: "[package]\nname = \"off\"\nversion = \"0.1.0\"\nautobins = false\n\n[[bin]]\nname = \"declared\"\npath = \"cmd/declared.rs\"\n" }
  ];
  const project = analyzeCargoProject(manifests, ["on/src/lib.rs", "on/src/main.rs", "on/src/bin/worker.rs", "on/src/bin/worker/main.rs", "on/src/bin/nested/ignored.rs", "on/cmd/path-only.rs", "off/src/main.rs", "off/src/bin/ignored.rs", "off/cmd/declared.rs"]);
  assert.deepEqual(project.packages.find((pkg) => pkg.name === "on").targets.map((target) => target.file).sort(), ["on/cmd/path-only.rs", "on/src/bin/worker.rs", "on/src/bin/worker/main.rs", "on/src/main.rs"]);
  assert.deepEqual(project.packages.find((pkg) => pkg.name === "off").targets.map((target) => [target.file, target.explicit]), [["off/cmd/declared.rs", true]]);
});

test("crate-qualified re-export aliases cross private modules and disappear when unwired", () => withWorkspace({
  "Cargo.toml": "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n",
  "src/main.rs": "mod flags;\nfn main() { flags::generate_complete_bash(); flags::generate_help_short(); }\n",
  "src/flags/mod.rs": "mod complete; mod doc;\npub(crate) use crate::flags::{ complete::bash::generate as generate_complete_bash, doc::help::generate_short as generate_help_short };\n",
  "src/flags/complete/mod.rs": "pub mod bash;\n",
  "src/flags/complete/bash.rs": "pub(crate) fn generate() {}\n",
  "src/flags/doc/mod.rs": "pub mod help;\n",
  "src/flags/doc/help.rs": "pub(crate) fn generate_short() {}\n"
}, (root) => {
  const get = (graph, file, name) => [...graph.symbolById.values()].find((symbol) => symbol.file === file && symbol.name === name);
  let graph = buildWorkspaceFlowGraph(root, true);
  const main = get(graph, "src/main.rs", "main");
  for (const [file, name] of [["src/flags/complete/bash.rs", "generate"], ["src/flags/doc/help.rs", "generate_short"]]) {
    const target = get(graph, file, name);
    assert.ok(graph.outEdges.get(main.id).has(target.id), `${file}:${name} should resolve through its alias`);
    assert.ok(graph.reachableFromRuntimeSource.has(target.id), `${file}:${name} should be runtime-reachable`);
  }
  fs.writeFileSync(path.join(root, "src/main.rs"), "mod flags;\nfn main() {}\n");
  clearFlowGraphCache();
  graph = buildWorkspaceFlowGraph(root, true);
  for (const [file, name] of [["src/flags/complete/bash.rs", "generate"], ["src/flags/doc/help.rs", "generate_short"]]) {
    assert.ok(!graph.reachableFromRuntimeSource.has(get(graph, file, name).id), `${file}:${name} should be disconnected after calls are removed`);
  }
}));

test("custom Cargo bin roots resolve sibling modules while autobins=false excludes src/main.rs", () => {
  const project = analyzeCargoProject([{ file: "Cargo.toml", content: `[package]\nname = "custom-bin"\nversion = "0.1.0"\nautobins = false\n\n[[bin]]\nname = "custom-bin"\npath = "cmd/entry.rs"\n` }], ["src/main.rs", "cmd/entry.rs", "cmd/feature.rs"]);
  assert.deepEqual(project.entryRoots, ["cmd/entry.rs"]);
  const files = [
    parseSourceFileContent("mod feature;\nfn main() { feature::run(); }\n", "cmd/entry.rs"),
    parseSourceFileContent("pub(crate) fn run() {}\n", "cmd/feature.rs"),
    parseSourceFileContent("fn main() {}\n", "src/main.rs")
  ];
  const resolver = createRustResolver(files, project);
  const entry = files[0].symbols.find((symbol) => symbol.name === "main");
  const call = entry.callSites.find((site) => site.rawCallee === "run");
  assert.deepEqual(resolver(entry, call).map((symbol) => symbol.file), ["cmd/feature.rs"]);
});

test("Cargo local path aliases resolve only bare-pub APIs and preserve conditional uncertainty", () => {
  const manifests = [
    { file: "app/Cargo.toml", content: `[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nrenamed = { package = "api-lib", path = "../api" }\noptional_api = { package = "api-lib", path = "../api", optional = true }\n\n[target.'cfg(windows)'.dependencies]\nwindows_api = { package = "api-lib", path = "../api" }\n` },
    { file: "api/Cargo.toml", content: "[package]\nname = \"api-lib\"\nversion = \"0.1.0\"\n" }
  ];
  const project = analyzeCargoProject(manifests, ["app/src/main.rs", "api/src/lib.rs", "api/src/inner.rs", "api/src/public_api.rs"]);
  const files = [
    parseSourceFileContent(`fn main() {
  renamed::exported();
  renamed::hidden();
  renamed::public_api::direct();
  optional_api::exported();
  windows_api::exported();
}
`, "app/src/main.rs"),
    parseSourceFileContent("mod inner;\npub mod public_api;\npub use crate::inner::exported;\npub use crate::inner::hidden;\n", "api/src/lib.rs"),
    parseSourceFileContent("pub fn exported() {}\npub(crate) fn hidden() {}\n", "api/src/inner.rs"),
    parseSourceFileContent("pub fn direct() {}\n", "api/src/public_api.rs")
  ];
  const resolver = createRustResolver(files, project);
  const main = files[0].symbols.find((symbol) => symbol.name === "main");
  const site = (name) => main.callSites.find((candidate) => candidate.rustPath === name);
  assert.deepEqual(resolver(main, site("renamed::exported")).map((symbol) => [symbol.file, symbol.name]), [["api/src/inner.rs", "exported"]]);
  assert.deepEqual(resolver(main, site("renamed::hidden")), []);
  assert.deepEqual(resolver(main, site("renamed::public_api::direct")).map((symbol) => symbol.file), ["api/src/public_api.rs"]);
  assert.deepEqual(resolver(main, site("optional_api::exported")), []);
  assert.deepEqual(resolver(main, site("windows_api::exported")), []);
  assert.ok(resolver.limitations.some((limit) => limit.kind === "CARGO_OPTIONAL_DEPENDENCY_UNSELECTED" && /optional_api/.test(limit.reason)));
  assert.ok(resolver.limitations.some((limit) => limit.kind === "CARGO_TARGET_CONDITION_UNSELECTED" && /windows_api/.test(limit.reason)));
  assert.ok(resolver.isPublicApi(resolver(main, site("renamed::exported"))[0]));
  assert.ok(!resolver.isPublicApi(files[2].symbols.find((symbol) => symbol.name === "hidden")));
  const disconnected = parseSourceFileContent("fn main() {}\n", "app/src/main.rs");
  const disconnectedResolver = createRustResolver([disconnected, ...files.slice(1)], project);
  assert.equal(disconnected.symbols.find((symbol) => symbol.name === "main").callSites.length, 0);
  assert.equal(disconnectedResolver(disconnected.symbols.find((symbol) => symbol.name === "main"), { rawCallee: "exported", rustPath: "renamed::exported", line: 1 }).length, 1, "resolver availability alone is not a call edge");
});

test("Rust cfg modules and macro invocations surface one limitation per file", () => {
  const file = parseSourceFileContent(`#[cfg(feature = "fast")]
mod gated;
make_api!();
#[cfg(feature = "fast")]
pub fn conditional() {}
fn main() {}
`, "src/main.rs");
  const resolver = createRustResolver([file]);
  assert.deepEqual(resolver.limitations, [
    { kind: "RUST_CFG_MODULE_UNRESOLVED", file: "src/main.rs", reason: "module gated at line 2" },
    { kind: "RUST_CFG_ITEM_UNRESOLVED", file: "src/main.rs", reason: "conditional declaration(s) require selected cfg/features" },
    { kind: "RUST_MACRO_EXPANSION_UNRESOLVED", file: "src/main.rs", reason: "macro invocation may create items or calls" }
  ]);
});

test("public library API respects blank-line locations, public modules, re-exports, and pub(crate)", () => {
  const project = analyzeCargoProject([{ file: "api/Cargo.toml", content: "[package]\nname = \"api\"\nversion = \"0.1.0\"\n" }], ["api/src/lib.rs", "api/src/public_api.rs", "api/src/private_api.rs"]);
  const files = [
    parseSourceFileContent("\n\npub mod public_api;\nmod private_api;\nmod inline_private { pub fn inline_leak() {} }\npub use crate::private_api::reexported;\n", "api/src/lib.rs"),
    parseSourceFileContent("pub struct Client;\nimpl Client {\n  pub fn request(&self) {}\n  pub(crate) fn local(&self) {}\n}\n", "api/src/public_api.rs"),
    parseSourceFileContent("pub fn reexported() {}\npub fn leaked() {}\n", "api/src/private_api.rs")
  ];
  const resolver = createRustResolver(files, project);
  const ids = (file) => new Set(files.find((item) => item.file === file).symbols.filter((symbol) => resolver.isPublicApi(symbol)).map((symbol) => symbol.name));
  assert.deepEqual([...ids("api/src/public_api.rs")].sort(), ["Client", "request"]);
  assert.deepEqual([...ids("api/src/private_api.rs")], ["reexported"]);
  const inlineLeak = files[0].symbols.find((symbol) => symbol.name === "inline_leak");
  assert.ok(!inlineLeak || !resolver.isPublicApi(inlineLeak));
  assert.ok(resolver.publicApiSymbolIds.has(files[1].symbols.find((symbol) => symbol.name === "request").id));
  assert.ok(!resolver.isPublicApi(files[1].symbols.find((symbol) => symbol.name === "local")));
});

test("public glob re-exports enumerate bare-pub items through private modules without leaking pub(crate)", () => {
  const project = analyzeCargoProject([{ file: "api/Cargo.toml", content: "[package]\nname = \"api\"\nversion = \"0.1.0\"\n" }], ["api/src/lib.rs", "api/src/inner.rs"]);
  const files = [
    parseSourceFileContent("mod inner;\npub use crate::inner::*;\n", "api/src/lib.rs"),
    parseSourceFileContent("pub fn exported() {}\npub(crate) fn crate_only() {}\n", "api/src/inner.rs")
  ];
  const resolver = createRustResolver(files, project);
  const inner = files[1].symbols;
  assert.ok(resolver.isPublicApi(inner.find((symbol) => symbol.name === "exported")));
  assert.ok(!resolver.isPublicApi(inner.find((symbol) => symbol.name === "crate_only")));
});

test("cfg-gated public symbols remain observable but marked conditional", () => {
  const project = analyzeCargoProject([{ file: "api/Cargo.toml", content: "[package]\nname = \"api\"\nversion = \"0.1.0\"\n" }], ["api/src/lib.rs", "api/src/gated.rs"]);
  const files = [
    parseSourceFileContent("#[cfg(feature = \"fast\")]\npub mod gated;\n", "api/src/lib.rs"),
    parseSourceFileContent("pub fn api() {}\n", "api/src/gated.rs")
  ];
  const resolver = createRustResolver(files, project);
  const api = files[1].symbols.find((symbol) => symbol.name === "api");
  assert.ok(resolver.isPublicApi(api));
  assert.ok(resolver.isConditional(api));
});

test("Cargo graph links a renamed local dependency re-export and removes it after call deletion", () => withWorkspace({
  "Cargo.toml": "[workspace]\nmembers = [\"app\", \"api\"]\n",
  "app/Cargo.toml": "[package]\nname = \"app\"\nversion = \"0.1.0\"\n\n[dependencies]\nrenamed = { package = \"api-lib\", path = \"../api\" }\n",
  "app/src/main.rs": "fn main() { renamed::exported(); renamed::hidden(); }\n",
  "api/Cargo.toml": "[package]\nname = \"api-lib\"\nversion = \"0.1.0\"\n",
  "api/src/lib.rs": "mod implementation;\npub use crate::implementation::{exported, hidden};\n",
  "api/src/implementation.rs": "pub fn exported() {}\npub(crate) fn hidden() {}\n"
}, (root) => {
  const symbol = (graph, file, name) => [...graph.symbolById.values()].find((item) => item.file === file && item.name === name);
  let graph = buildWorkspaceFlowGraph(root, true);
  const main = symbol(graph, "app/src/main.rs", "main");
  const exported = symbol(graph, "api/src/implementation.rs", "exported");
  const hidden = symbol(graph, "api/src/implementation.rs", "hidden");
  assert.ok(graph.outEdges.get(main.id).has(exported.id));
  assert.ok(!graph.outEdges.get(main.id).has(hidden.id));
  fs.writeFileSync(path.join(root, "app/src/main.rs"), "fn main() {}\n");
  clearFlowGraphCache();
  graph = buildWorkspaceFlowGraph(root, true);
  assert.ok(!graph.reachableFromRuntimeSource.has(symbol(graph, "api/src/implementation.rs", "exported").id));
}));

test("Cargo graph recognizes custom and src/bin entry points without treating a function named run as a source", () => withWorkspace({
  "Cargo.toml": '[package]\nname = "entry-test"\nversion = "0.1.0"\nautobins = false\n\n[[bin]]\nname = "tool"\npath = "cmd/entry.rs"\n',
  "cmd/entry.rs": 'mod feature;\nfn main() { feature::run(); }\n',
  "cmd/feature.rs": 'pub(crate) fn run() {\n println!("feature");\n}\n',
  "src/main.rs": 'fn main() {\n println!("disabled");\n}\n',
  "src/bin/extra.rs": 'fn main() {\n println!("extra");\n}\n'
}, (root) => {
  const symbols = (graph) => [...graph.symbolById.values()];
  let graph = buildWorkspaceFlowGraph(root, true);
  assert.ok(graph.files.some((file) => file.file === 'src/bin/extra.rs'));
  for (const file of ['src/main.rs', 'src/bin/extra.rs']) {
    assert.equal(symbols(graph).find((symbol) => symbol.file === file).isEntrySource, false);
  }
  let run = symbols(graph).find((symbol) => symbol.name === 'run');
  assert.equal(run.isEntrySource, false);
  assert.ok(graph.reachableFromRuntimeSource.has(run.id));
  fs.writeFileSync(path.join(root, 'cmd/entry.rs'), 'mod feature;\nfn main() {}\n');
  graph = buildWorkspaceFlowGraph(root, true);
  run = symbols(graph).find((symbol) => symbol.name === 'run');
  assert.ok(!graph.reachableFromRuntimeSource.has(run.id));
  const cargo = path.join(root, 'Cargo.toml');
  fs.writeFileSync(cargo, fs.readFileSync(cargo, 'utf8').replace('autobins = false', 'autobins = true'));
  graph = buildWorkspaceFlowGraph(root, true);
  assert.equal(symbols(graph).find((symbol) => symbol.file === 'src/bin/extra.rs').isEntrySource, true);
}));
