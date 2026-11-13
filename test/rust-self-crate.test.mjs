import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildWorkspaceFlowGraph, clearFlowGraphCache } from "../src/graph-builder.mjs";
import { verifyWorkspaceFlow } from "../src/flow-verifier.mjs";

test("same-package crate-name imports resolve only the sibling lib public API, and bin exports are not library roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowguard-rust-self-crate-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "Cargo.toml"), '[package]\nname = "self-crate"\nversion = "0.1.0"\n\n[lib]\nname = "custom_api"\n');
    fs.writeFileSync(path.join(root, "src", "lib.rs"), "pub fn shared() {}\npub(crate) fn crate_only() {}\n");
    fs.writeFileSync(path.join(root, "src", "main.rs"), "use custom_api::{shared, crate_only};\nfn main() { shared(); crate_only(); }\npub fn bin_only() {}\n");

    const graph = buildWorkspaceFlowGraph(root, true);
    const symbols = [...graph.symbolById.values()];
    const main = symbols.find((symbol) => symbol.file === "src/main.rs" && symbol.name === "main");
    const shared = symbols.find((symbol) => symbol.file === "src/lib.rs" && symbol.name === "shared");
    const crateOnly = symbols.find((symbol) => symbol.file === "src/lib.rs" && symbol.name === "crate_only");
    const binOnly = symbols.find((symbol) => symbol.file === "src/main.rs" && symbol.name === "bin_only");

    assert.equal(graph.outEdges.get(main.id).has(shared.id), true, "the bin should resolve its package's explicitly named lib crate");
    assert.equal(graph.outEdges.get(main.id).has(crateOnly.id), false, "pub(crate) remains private across the bin/lib crate boundary");
    assert.equal(shared.isPackageEntryExport, true, "the lib export remains marked as package API");
    assert.equal(graph.reachableFromRuntimeSource.has(shared.id), true, "the resolved bin call should establish runtime reachability");
    assert.equal(graph.reachableFromSource.has(shared.id), true, "the lib API remains a library-surface source");
    assert.equal(binOnly.isPackageEntryExport, false, "a pub function in a bin is not a library package export");
    assert.equal(graph.reachableFromSource.has(binOnly.id), false, "an unwired bin function must not be promoted to a library root");
  } finally {
    clearFlowGraphCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cfg-gated public library methods are inconclusive entry wiring, not unwired application exports", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowguard-rust-cfg-library-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "Cargo.toml"), '[package]\nname = "cfg-library"\nversion = "0.1.0"\n');
    fs.writeFileSync(path.join(root, "src", "lib.rs"), '#[cfg(feature = "ws")]\npub mod ws;\n');
    fs.writeFileSync(path.join(root, "src", "ws.rs"), 'pub struct Upgrade;\nimpl Upgrade {\n    pub fn read_buffer_size(self) -> Self { self }\n}\n');

    const report = verifyWorkspaceFlow(root, { fullScan: true });
    assert.equal(report.status, "INCONCLUSIVE");
    assert.equal(report.verificationVerdict, "INCONCLUSIVE");
    assert.ok(report.wiringReport.obligations.some((item) =>
      item.station === "ENTRY_WIRING" && item.status === "INCONCLUSIVE" && /read_buffer_size/.test(item.targetLocation)
    ));
    assert.ok(!report.unwiredExports.some((item) => /read_buffer_size/.test(item.symbol)));
  } finally {
    clearFlowGraphCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown Rust receiver creates an inconclusive candidate without a reachability edge", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowguard-rust-receiver-candidate-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "Cargo.toml"), '[package]\nname = "receiver-app"\nversion = "0.1.0"\n');
    const mainPath = path.join(root, "src", "main.rs");
    fs.writeFileSync(mainPath, `
pub struct ClashTemp;
impl ClashTemp {
    pub fn patch_config(&self) {}
}
fn main() { unknown.patch_config(); }
`);

    let graph = buildWorkspaceFlowGraph(root, true);
    let symbols = [...graph.symbolById.values()];
    let main = symbols.find((symbol) => symbol.name === "main");
    let patchConfig = symbols.find((symbol) => symbol.name === "patch_config");
    assert.ok(patchConfig.rustReceiverCandidates?.length > 0);
    assert.equal(graph.outEdges.get(main.id).has(patchConfig.id), false, "a receiver candidate must not become a call edge");
    assert.equal(graph.reachableFromRuntimeSource.has(patchConfig.id), false, "a receiver candidate must not establish runtime reachability");
    let report = verifyWorkspaceFlow(root, { fullScan: true });
    assert.equal(report.verificationVerdict, "INCONCLUSIVE");
    assert.ok(report.wiringReport.obligations.some((item) => item.station === "ENTRY_WIRING" && item.status === "INCONCLUSIVE" && /patch_config/.test(item.targetLocation)));
    assert.ok(!report.unwiredExports.some((item) => /patch_config/.test(item.symbol)));

    fs.writeFileSync(mainPath, "pub struct ClashTemp;\nimpl ClashTemp {\n pub fn patch_config(&self) {}\n}\nfn main() {}\n");
    clearFlowGraphCache();
    graph = buildWorkspaceFlowGraph(root, true);
    symbols = [...graph.symbolById.values()];
    patchConfig = symbols.find((symbol) => symbol.name === "patch_config");
    assert.equal(patchConfig.rustReceiverCandidates, undefined, "removing the unknown receiver must remove candidate evidence");
    report = verifyWorkspaceFlow(root, { fullScan: true });
    assert.equal(report.verificationVerdict, "INCONCLUSIVE", "automatic absence is advisory without an explicit entry requirement");
    assert.ok(report.unwiredExports.some((item) => /patch_config/.test(item.symbol)));
  } finally {
    clearFlowGraphCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
