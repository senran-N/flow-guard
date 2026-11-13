import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const [rootArg, corpusArg, phase = "phase5"] = process.argv.slice(2);
assert.ok(rootArg && corpusArg, "Usage: framework-source-audit.mjs <validation-root> <corpus> [phase5]");
assert.match(phase, /^phase\d+(?:-final\d+)?$/);
const root = path.resolve(rootArg), corpus = path.resolve(corpusArg);
const suffix = process.argv[5] || '';
assert.match(suffix, /^(?:-[a-z0-9-]+)?$/);
const output = path.join(root, `framework-source-audit-${phase}${suffix}.json`);
assert.ok(!fs.existsSync(output), "Existing evidence must not be overwritten");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const manifest = read(path.join(root, `${phase}-corpus`, "manifest.json"));
const engine = path.join(root, `${phase}-corpus`, "engine-snapshot", "src");
const { parseSourceFileContent } = await import(pathToFileURL(path.join(engine, "file-parser.mjs")));
const { inferPackageBoundaries } = await import(pathToFileURL(path.join(engine, "package-boundaries.mjs")));
const { buildWorkspaceFlowGraph, clearFlowGraphCache } = await import(pathToFileURL(path.join(engine, "graph-builder.mjs")));
const { verifyWorkspaceFlow } = await import(pathToFileURL(path.join(engine, "flow-verifier.mjs")));
const sources = [], checks = [];
function source(repo, file, first = 1, last = first + 15) {
  const text = fs.readFileSync(path.join(corpus, repo, file), "utf8");
  sources.push({ repo, commit: manifest.repositories.find((r) => r.name === repo).commit, file,
    sha256: crypto.createHash("sha256").update(text).digest("hex"), firstLine: first,
    excerpt: text.split(/\r?\n/).slice(first - 1, last).join("\n") });
  return text;
}

const handlerText = source("dio", "dio/lib/src/interceptor.dart", 23, 28);
assert.match(handlerText, /void Function\(\)\? _processNextInQueue;/);
const handler = parseSourceFileContent(handlerText, "dio/lib/src/interceptor.dart");
assert.equal(handler.symbols.some((s) => s.name === "Function"), false);
checks.push({ check: "Dio callback field is not an abstract Function method", passed: true });

for (const [repo, file, metadata, expected] of [
  ["dio", "dio/lib/src/interceptor.dart", "dio/pubspec.yaml", "library"],
  ["sidekiq", "lib/sidekiq/client.rb", "sidekiq.gemspec", "library"],
  ["okhttp", "okhttp/src/commonJvmAndroid/kotlin/okhttp3/Call.kt", "okhttp/build.gradle.kts", "library"],
  ["okhttp", "android-test-app/src/main/kotlin/okhttp/android/testapp/MainActivity.kt", "android-test-app/build.gradle.kts", "application"],
]) {
  const parsed = parseSourceFileContent(source(repo, file), file);
  source(repo, metadata, 1, 18);
  const boundaries = inferPackageBoundaries(path.join(corpus, repo), [parsed]);
  assert.equal(boundaries.fileModes.get(file), expected);
  checks.push({ check: "Package boundary", repo, file, expected, actual: boundaries.fileModes.get(file), manifests: boundaries.manifests, passed: true });
}
source("okhttp", "okhttp/build.gradle.kts", 42, 53);

source("pot-desktop", "src/components/WindowControl/index.jsx", 1, 12);
source("pot-desktop", "src/window/Config/index.jsx", 64, 70);
source("pot-desktop", "src/window/Recognize/index.jsx", 135, 142);
let graph = buildWorkspaceFlowGraph(path.join(corpus, "pot-desktop"), true);
const windowControl = graph.symbolsByName.get("WindowControl").find((s) => s.file === "src/components/WindowControl/index.jsx");
const renders = graph.inEdgeDetails.get(windowControl.id).filter((e) => e.kind === "REGISTRATION" && e.evidence.reason.startsWith("JSX"));
assert.ok(graph.reachableFromSource.has(windowControl.id));
assert.ok(renders.some((e) => e.evidence.file === "src/window/Config/index.jsx" && e.evidence.line === 68));
assert.ok(renders.some((e) => e.evidence.file === "src/window/Recognize/index.jsx" && e.evidence.line === 139));
checks.push({ check: "WindowControl connected by actual JSX import and render sites", passed: true, renders });
clearFlowGraphCache();

const revision = "backend/app/alembic/versions/1a31ce608336_add_cascade_delete_relationships.py";
source("full-stack-fastapi-template", "backend/alembic.ini", 1, 15);
source("full-stack-fastapi-template", revision, 8, 36);
graph = buildWorkspaceFlowGraph(path.join(corpus, "full-stack-fastapi-template"), true);
for (const name of ["upgrade", "downgrade"]) {
  const hook = graph.symbolsByName.get(name).find((s) => s.file === revision);
  assert.equal(hook.frameworkEntryEvidence, "backend/alembic.ini");
  assert.ok(graph.reachableFromSource.has(hook.id));
  checks.push({ check: "Configured Alembic revision hook", name, file: revision, configuration: hook.frameworkEntryEvidence, passed: true });
}
clearFlowGraphCache();

// Record dynamic selection without treating candidate reachability as invocation.
source("pot-desktop", "src/services/recognize/qrcode/Config.jsx", 5, 25);
source("pot-desktop", "src/services/recognize/qrcode/index.jsx", 27, 33);
source("pot-desktop", "src/window/Config/pages/Service/Recognize/ConfigModal/index.jsx", 20, 27);
source("pot-desktop", "src/window/Config/pages/Service/Recognize/ConfigModal/index.jsx", 63, 75);
if (Number.parseInt(phase.slice(5), 10) >= 6) {
  graph = buildWorkspaceFlowGraph(path.join(corpus, "pot-desktop"), true);
  const component = graph.symbolsByName.get("Config").find((s) => s.file === "src/services/recognize/qrcode/Config.jsx");
  assert.equal(graph.reachableFromRuntimeSource.has(component.id), false);
  assert.ok(graph.possiblyReachableFromRuntimeSource.has(component.id));
  checks.push({ check: "Dynamic QR component is a candidate, not proven invocation", passed: true,
    edges: graph.inEdgeDetails.get(component.id).filter((e) => e.resolution.mode === "DYNAMIC_COMPONENT_SELECTION") });
  clearFlowGraphCache();
}
if (Number.parseInt(phase.slice(5), 10) >= 9) {
  source("pot-desktop", "src-tauri/src/main.rs", 4, 36);
  source("pot-desktop", "src-tauri/src/main.rs", 89, 113);
  source("pot-desktop", "src-tauri/src/main.rs", 150, 157);
  graph = buildWorkspaceFlowGraph(path.join(corpus, "pot-desktop"), true);
  for (const name of ["start_server", "register_shortcut", "check_update", "tray_event_handler"]) {
    const symbol = graph.symbolsByName.get(name).find((s) => s.file.startsWith("src-tauri/"));
    assert.ok(graph.reachableFromRuntimeSource.has(symbol.id));
    const edges = graph.inEdgeDetails.get(symbol.id).filter((e) => e.resolution.mode === "RUST_MODULE_PATH");
    assert.ok(edges.some((e) => e.evidence.file === "src-tauri/src/main.rs"));
    checks.push({ check: "Rust entry follows actual module imports and call/registration sites", name, edges, passed: true });
  }
  clearFlowGraphCache();
  source("zod", "packages/tsc/bench/lots-of-objects.ts", 1, 30);
  source("zod", "packages/tsc/generate.ts", 45, 55);
  graph = buildWorkspaceFlowGraph(path.join(corpus, "zod"), true);
  const generator = graph.symbolsByName.get("generate").find((s) => s.file === "packages/tsc/generate.ts");
  assert.equal(graph.reachableFromRuntimeSource.has(generator.id), false);
  const report = verifyWorkspaceFlow(path.join(corpus, "zod"), { fullScan: true, ignoreSavedPlan: true });
  const finding = report.wiringReport.obligations.find((o) => o.station === "ENTRY_WIRING" && o.targetLocation.includes("packages/tsc/generate.ts"));
  assert.equal(finding?.status, "INCONCLUSIVE"); assert.match(finding.finding, /工具脚本/);
  checks.push({ check: "Benchmark consumer is evidence without pretending to be a production entry", passed: true, finding });
  clearFlowGraphCache();
}
const audit = { sourceHash: manifest.engine.sourceHash, phase, checks, sources,
  limitations: ["Selected source-backed checks, not an unbiased precision estimate",
    "Runtime selection of builtinServices[serviceName].Config in pot-desktop is not proven",
    "No browser/runtime execution of React or Alembic migrations is claimed"] };
fs.writeFileSync(output, JSON.stringify(audit, null, 2));
console.log(JSON.stringify({ output, sourceHash: audit.sourceHash, checks: checks.length, passed: checks.every((c) => c.passed) }));
