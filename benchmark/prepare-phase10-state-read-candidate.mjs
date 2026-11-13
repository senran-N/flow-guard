// Build a phase10 candidate that changes only 3b cross-file state-reader indexing.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [evidenceRootArg, destinationArg] = process.argv.slice(2);
assert.ok(evidenceRootArg && destinationArg,
  "Usage: node benchmark/prepare-phase10-state-read-candidate.mjs <evidence-root> <destination>");
const evidenceRoot = path.resolve(evidenceRootArg), destination = path.resolve(destinationArg);
assert.equal(path.dirname(destination), evidenceRoot); assert.ok(!fs.existsSync(destination));
const phaseRoot = path.join(evidenceRoot, "phase10-corpus"), frozen = path.join(phaseRoot, "engine-snapshot");
const manifest = JSON.parse(fs.readFileSync(path.join(phaseRoot, "manifest.json"), "utf8"));
fs.cpSync(frozen, destination, { recursive: true });
const graphPath = path.join(destination, "src", "graph-builder.mjs");
let graph = fs.readFileSync(graphPath, "utf8"), replacements = 0;
const eol = graph.includes("\r\n") ? "\r\n" : "\n";
const lines = (...values) => values.join(eol);
const replaceOnce = (from, to, label) => {
  assert.ok(graph.includes(from), `phase10 3b anchor not found: ${label}`);
  graph = graph.replace(from, to); replacements++;
};
replaceOnce(
  lines('  const prodFilesForReads = files.filter((f) => f.zone === "prod");', '  for (const st of stateOwnership.values()) {'),
  lines(
    '  const prodFilesForReads = files.filter((f) => f.zone === "prod");',
    '  const prodFileReadInfo = new Map();',
    '  const prodFilesByMemberRead = new Map();',
    '  for (const f of prodFilesForReads) {',
    '    const info = {',
    '      importedStems: new Set(f.importedStems || []),',
    '      fileCalls: new Set(f.fileCalls || []),',
    '      dir: path.dirname(f.file),',
    '      stem: path.basename(f.file, path.extname(f.file)),',
    '      resolvedImports: resolvedImportedFilesByFile.get(f.file) || new Set()',
    '    };',
    '    prodFileReadInfo.set(f.file, info);',
    '    for (const field of new Set(f.memberReads || [])) {',
    '      if (!prodFilesByMemberRead.has(field)) prodFilesByMemberRead.set(field, []);',
    '      prodFilesByMemberRead.get(field).push(f);',
    '    }',
    '  }',
    '  for (const st of stateOwnership.values()) {'
  ),
  'read indexes'
);
replaceOnce(
  lines(
    '      const wStem = path.basename(wSym.file, path.extname(wSym.file));',
    '      const wDir = path.dirname(wSym.file);',
    '      const wImportedStems = new Set(wFileObj?.importedStems || []);'
  ),
  lines(
    '      const wFileReadInfo = prodFileReadInfo.get(wSym.file);',
    '      const wStem = wFileReadInfo?.stem || path.basename(wSym.file, path.extname(wSym.file));',
    '      const wDir = wFileReadInfo?.dir || path.dirname(wSym.file);',
    '      const wImportedStems = wFileReadInfo?.importedStems || new Set(wFileObj?.importedStems || []);'
  ),
  'writer info'
);
replaceOnce(
  lines(
    '      for (const rf of prodFilesForReads) {',
    '        if (rf.file === wSym.file) continue;',
    '        if (!(rf.memberReads || []).includes(st.field)) continue;',
    '        const rfResolved = resolvedImportedFilesByFile.get(rf.file) || new Set();',
    '        const rfStems = new Set(rf.importedStems || []);',
    '        const rfCalls = new Set(rf.fileCalls || []);'
  ),
  lines(
    '      for (const rf of prodFilesByMemberRead.get(st.field) || []) {',
    '        if (rf.file === wSym.file) continue;',
    '        const rfReadInfo = prodFileReadInfo.get(rf.file);',
    '        const rfResolved = rfReadInfo.resolvedImports;',
    '        const rfStems = rfReadInfo.importedStems;',
    '        const rfCalls = rfReadInfo.fileCalls;'
  ),
  'reader loop'
);
replaceOnce('          (path.dirname(rf.file) === wDir &&', '          (rfReadInfo.dir === wDir &&', 'same-dir condition');
assert.equal(replacements, 4);
fs.writeFileSync(graphPath, graph);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const candidateManifest = {
  basePhase: "phase10",
  baseSourceHash: manifest.engine.sourceHash,
  changedFiles: [{ file: "src/graph-builder.mjs", beforeSha256: manifest.engine.files["graph-builder.mjs"], afterSha256: hash(graph) }],
  scope: "3b cross-file .prop reader index; preserves source file iteration order and all connection predicates",
  replacements
};
fs.writeFileSync(path.join(destination, "candidate-manifest.json"), JSON.stringify(candidateManifest, null, 2));
console.log(JSON.stringify({ frozen, destination, candidateManifest }));
