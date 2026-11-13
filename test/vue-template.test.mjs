import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSourceFileContent } from "../src/file-parser.mjs";
import { assembleFlowGraph } from "../src/graph-builder.mjs";
import { verifyWorkspaceFlow } from "../src/flow-verifier.mjs";

function graph(template) {
  return assembleFlowGraph([
    parseSourceFileContent(`<script setup lang="ts">\nimport { downloadProject } from './download'\nexport default {}\n</script>\n<template>${template}</template>`, "src/Header.vue"),
    parseSourceFileContent("export function downloadProject() {}", "src/download.ts")
  ], "", { projectMode: "application" });
}

function eventEdges(result) {
  return [...result.outEdgeDetails.values()].flat().filter((edge) => edge.resolution.mode === "VUE_TEMPLATE_EVENT");
}

test("Vue @click and v-on:click register imported script handlers only as candidates", () => {
  for (const directive of ['@click="downloadProject"', 'v-on:click="downloadProject()"']) {
    const result = graph(`<button ${directive}>download</button>`);
    const edge = eventEdges(result)[0];
    assert.ok(edge);
    assert.equal(edge.kind, "REGISTRATION");
    assert.equal(edge.resolution.confidence, "MEDIUM");
    assert.notEqual(result.symbolById.get(edge.toId).isReferencedInFile, true, "an event registration is not a direct script/render reference");
    assert.equal(result.reachableFromRuntimeSource.has(edge.toId), false);
  }
});

test("Vue comments, removed events, and v-for locals do not create handler edges", () => {
  for (const template of [
    '<!-- <button @click="downloadProject">comment</button> -->',
    '<button>download</button>',
    '<OtherComponent>downloadProject</OtherComponent>',
    '<div v-for="downloadProject in actions"><button @click="downloadProject">download</button></div>'
  ]) assert.equal(eventEdges(graph(template)).length, 0);
});

test("render expressions remain direct references while Vue template events remain INCONCLUSIVE", () => {
  const renderFile = parseSourceFileContent(`<script setup lang="ts">\nconst formatLabel = () => "ok"\n</script>\n<template>{{ formatLabel() }}</template>`, "src/Render.vue");
  assert.equal(renderFile.symbols.find((symbol) => symbol.name === "formatLabel")?.isReferencedInFile, true);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowguard-vue-event-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
    fs.writeFileSync(path.join(root, "src", "Header.vue"), `<script setup lang="ts">\nconst downloadProject = () => {}\n</script>\n<template><button @click="downloadProject">download</button></template>`);
    const report = verifyWorkspaceFlow(root, { fullScan: true });
    assert.equal(report.status, "INCONCLUSIVE");
    assert.equal(report.verificationVerdict, "INCONCLUSIVE");
    assert.ok(report.wiringReport.obligations.some((item) => item.status === "INCONCLUSIVE" && /Vue 模板事件注册/.test(item.finding)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
