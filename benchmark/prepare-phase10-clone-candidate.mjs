// Build an A/B candidate from phase10, replacing only clone aggregation code.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [evidenceRootArg, destinationArg] = process.argv.slice(2);
assert.ok(evidenceRootArg && destinationArg, "Usage: node benchmark/prepare-phase10-clone-candidate.mjs <evidence-root> <destination>");
const evidenceRoot = path.resolve(evidenceRootArg), destination = path.resolve(destinationArg);
assert.equal(path.dirname(destination), evidenceRoot); assert.ok(!fs.existsSync(destination));
const frozen = path.join(evidenceRoot, "phase10-corpus", "engine-snapshot"), local = path.resolve(".");
fs.cpSync(frozen, destination, { recursive: true });
fs.copyFileSync(path.join(local, "src", "similarity-index.mjs"), path.join(destination, "src", "similarity-index.mjs"));
const verifierPath = path.join(destination, "src", "flow-verifier.mjs");
let verifier = fs.readFileSync(verifierPath, "utf8");
const priorCloneImport = 'import { findSimilarShinglePairs } from "./similarity-index.mjs";';
assert.ok(verifier.includes(priorCloneImport), "frozen clone-pair import not found");
verifier = verifier.replace(priorCloneImport, 'import { forEachSimilarShinglePair } from "./similarity-index.mjs";');
const start = verifier.indexOf("  // 6. Structural Clone Sprawl Detection (normalized lexical shingle Jaccard)");
const end = verifier.indexOf("  // 7. Task-Oriented Tri-State Wiring Contract Evaluation", start);
assert.ok(start >= 0 && end > start, "frozen clone section not found");
const replacement = `  // 6. Structural Clone Sprawl Detection (normalized lexical shingle Jaccard)
  let cloneCount = 0;
  const clonePreview = [];
  let fnSymbols = [];
  if (!isNonSourceDiffOnly) {
    fnSymbols = Array.from(graph.symbolById.values())
      .filter((s) => s.zone === "prod" && s.shingles.size >= 18)
      .sort((a, b) => a.shingles.size - b.shingles.size);
    const includePair = (a, b) => !(a.name === b.name && a.file === b.file) &&
      (isFullScan || changedFiles.has(a.file) || changedFiles.has(b.file));
    forEachSimilarShinglePair(fnSymbols, 0.85, includePair, (left, right, similarity) => {
      cloneCount++;
      let insertAt = clonePreview.length;
      while (insertAt > 0) {
        const previous = clonePreview[insertAt - 1];
        if (previous.left < left || (previous.left === left && previous.right <= right)) break;
        insertAt--;
      }
      if (insertAt < 10) {
        clonePreview.splice(insertAt, 0, { left, right, similarity });
        if (clonePreview.length > 10) clonePreview.pop();
      }
    });
  }
  const clones = clonePreview.map((pair) => ({
    funcA: shortId(fnSymbols[pair.left]), funcB: shortId(fnSymbols[pair.right]),
    similarity: String(Math.round(pair.similarity * 100)) + "%", method: "LEXICAL_SHINGLE_JACCARD"
  }));

`;
verifier = verifier.slice(0, start) + replacement + verifier.slice(end);
assert.ok(verifier.includes("structuralClonesCount: clones.length,"), "frozen clone count not found");
verifier = verifier.replace("structuralClonesCount: clones.length,", "structuralClonesCount: cloneCount,");
fs.writeFileSync(verifierPath, verifier);
console.log(JSON.stringify({ frozen, destination }));
