import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  generateFlowOverview,
  traceSymbolFlow,
  generateWiringBlueprint
} from "../src/flow-tools.mjs";
import { verifyWorkspaceFlow } from "../src/flow-verifier.mjs";
import { runHook } from "../src/hook-runner.mjs";
import { getFlowGuardDataDir, getWorkspaceKeyHash } from "../src/graph-diff.mjs";
import { clearActiveWiringPlan } from "../src/wiring-contract.mjs";

function writeWorkspaceFiles(dir, filesMap) {
  for (const [rel, content] of Object.entries(filesMap)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
}

function cleanupTempArtifacts(dir) {
  clearActiveWiringPlan(dir);
  const hash = getWorkspaceKeyHash(dir);
  const baselinePath = path.join(getFlowGuardDataDir(), `flowguard-baseline-${hash}.json`);
  fs.rmSync(baselinePath, { force: true });
}

function withTaskWorkspace(filesMap, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-guard-bench-"));
  try {
    writeWorkspaceFiles(dir, filesMap);
    return fn(dir);
  } finally {
    cleanupTempArtifacts(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function initGitCommit(dir, message = "initial baseline") {
  execSync(
    `git init && git config user.email "bench@flowguard.local" && git config user.name "FlowGuard Bench" && git add -A && git -c commit.gpgsign=false commit -m "${message}"`,
    { cwd: dir, stdio: "ignore" }
  );
}

const t0 = performance.now();
let assertionsVerified = 0;
const defectResults = [];
const counterexampleResults = [];

// ============================================================================
// TASK-01: Application `export function newlyAddedFeature()` Unwired Repro
// ============================================================================
withTaskWorkspace(
  {
    "package.json": JSON.stringify({ name: "desktop-app", private: true, version: "1.0.0" }, null, 2),
    "src/main.ts": `
import { renderDashboard } from "./dashboard";

export function main() {
  renderDashboard("home");
}
`,
    "src/dashboard.ts": `
export function renderDashboard(tab: string) {
  localStorage.setItem("active_tab", tab);
}
`
  },
  (dir) => {
    initGitCommit(dir);
    writeWorkspaceFiles(dir, {
      "src/features/extra.ts": `
export function newlyAddedFeature(input: string): string {
  return input.trim().toUpperCase();
}

function privateDeadHelper(x: number): number {
  return x * 2;
}
`
    });

    const trace = traceSymbolFlow(dir, "newlyAddedFeature");
    assert.equal(trace.traces[0].waterFlowStatus.connectedToRuntimeEntry, false);
    assert.ok(!trace.traces[0].roles.includes("source"), "App internal export must NOT be blindly marked as source");

    const verifyInc = verifyWorkspaceFlow(dir);
    assert.equal(verifyInc.status, "ISSUES_FOUND");
    assert.equal(verifyInc.verificationVerdict, "VIOLATED");
    assert.ok(verifyInc.headlineSummary.includes("违反"));
    assert.ok(
      verifyInc.unwiredExports.some(
        (u) => u.name === "newlyAddedFeature" && u.evidenceStrength === "NO_STATIC_CALLER_EVIDENCE"
      ),
      "Unwired export in app should carry NO_STATIC_CALLER_EVIDENCE"
    );
    assert.ok(
      verifyInc.unwiredOrDeadPipes.some(
        (u) => u.symbol.includes("privateDeadHelper") && u.evidenceStrength === "CONFIRMED_SAFE_TO_DELETE"
      ),
      "Private dead pipe should carry CONFIRMED_SAFE_TO_DELETE"
    );

    // Also verify standalone fullScan catches unwired app export (the exact non-diff repro)
    const verifyFull = verifyWorkspaceFlow(dir, { fullScan: true });
    assert.equal(verifyFull.status, "ISSUES_FOUND");
    assert.equal(verifyFull.verificationVerdict, "VIOLATED");

    assertionsVerified += 8;
    defectResults.push({ id: "TASK-01", detected: verifyInc.verificationVerdict === "VIOLATED" });
  }
);

// ============================================================================
// TASK-02: Shared `flow_blueprint` ⇄ `flow_verify` Closed Loop
// ("阈值已写入配置并可保存，但过滤计算仍在使用旧常量 DEFAULT_THRESHOLD")
// ============================================================================
withTaskWorkspace(
  {
    "package.json": JSON.stringify({ name: "neural-detector-app", private: true }, null, 2),
    "src/config.ts": `
export class DetectorConfig {
  public sensitivity = 0.5;

  public updateSensitivity(val: number) {
    this.sensitivity = val;
  }

  public saveConfig(): string {
    return JSON.stringify({ sensitivity: this.sensitivity });
  }

  public loadConfig(raw: string) {
    const parsed = JSON.parse(raw);
    this.sensitivity = parsed.sensitivity;
  }
}
`,
    "src/filter.ts": `
import { DetectorConfig } from "./config";

const DEFAULT_THRESHOLD = 0.75;

export class FilterEngine {
  public applyFilter(score: number, cfg: DetectorConfig): boolean {
    return score >= DEFAULT_THRESHOLD && cfg.sensitivity > 0;
  }
}
`,
    "src/main.ts": `
import { DetectorConfig } from "./config";
import { FilterEngine } from "./filter";

export function main() {
  const cfg = new DetectorConfig();
  cfg.updateSensitivity(0.8);
  const raw = cfg.saveConfig();
  cfg.loadConfig(raw);
  const engine = new FilterEngine();
  console.log(engine.applyFilter(0.9, cfg));
}
`
  },
  (dir) => {
    initGitCommit(dir);

    // 1. Generate shared WiringPlan via flow_blueprint before coding
    const bp = generateWiringBlueprint(dir, "DetectorConfig", {
      targetField: "detectionThreshold",
      consumerTarget: "applyFilter",
      requirePersistence: "required"
    });
    assert.ok(bp.wiringPlan && bp.wiringPlan.obligations.length >= 4);
    assert.ok(bp.wiringPlan.causalPipelineGoal.includes("applyFilter"));

    // 2. Half-wired edit: config writes, saves, and loads `detectionThreshold`, main calls setter,
    //    BUT `FilterEngine.applyFilter` still uses `DEFAULT_THRESHOLD`!
    writeWorkspaceFiles(dir, {
      "src/config.ts": `
export class DetectorConfig {
  public sensitivity = 0.5;
  public detectionThreshold = 0.75;

  public updateSensitivity(val: number) {
    this.sensitivity = val;
  }

  public setDetectionThreshold(threshold: number) {
    this.detectionThreshold = threshold;
  }

  public saveConfig(): string {
    return JSON.stringify({
      sensitivity: this.sensitivity,
      detectionThreshold: this.detectionThreshold
    });
  }

  public loadConfig(raw: string) {
    const parsed = JSON.parse(raw);
    this.sensitivity = parsed.sensitivity;
    this.detectionThreshold = parsed.detectionThreshold;
  }
}
`,
      "src/main.ts": `
import { DetectorConfig } from "./config";
import { FilterEngine } from "./filter";

export function main() {
  const cfg = new DetectorConfig();
  cfg.updateSensitivity(0.8);
  cfg.setDetectionThreshold(0.65);
  const raw = cfg.saveConfig();
  cfg.loadConfig(raw);
  const engine = new FilterEngine();
  console.log(engine.applyFilter(0.9, cfg));
}
`
    });

    const halfVerify = verifyWorkspaceFlow(dir);
    assert.equal(halfVerify.status, "ISSUES_FOUND");
    assert.equal(halfVerify.verificationVerdict, "VIOLATED");
    assert.equal(halfVerify.wiringReport.source, "SHARED_BLUEPRINT_AND_DIFF");

    const dataObl = halfVerify.wiringReport.obligations.find((o) => o.station === "DATA_FLOW_CONSUMPTION");
    assert.ok(dataObl && dataObl.status === "VIOLATED", "Must catch unconsumed config field in applyFilter");
    assert.ok(
      dataObl.finding.includes("DEFAULT_THRESHOLD"),
      `Expected diagnosis to highlight legacy constant DEFAULT_THRESHOLD, got: ${dataObl.finding}`
    );

    // 3. Complete the wiring in `applyFilter` + run L3 behavioral test command -> 100% SATISFIED
    writeWorkspaceFiles(dir, {
      "src/filter.ts": `
import { DetectorConfig } from "./config";

export class FilterEngine {
  public applyFilter(score: number, cfg: DetectorConfig): boolean {
    return score >= cfg.detectionThreshold && cfg.sensitivity > 0;
  }
}
`
    });

    const fullClosedVerify = verifyWorkspaceFlow(dir, {
      runTestsCommand: 'node -e "process.exit(0)"'
    });
    assert.equal(
      fullClosedVerify.status,
      "PASS",
      `TASK-02 fullClosedVerify failed: ${JSON.stringify(fullClosedVerify.wiringReport, null, 2)}`
    );
    assert.equal(fullClosedVerify.verificationVerdict, "SATISFIED");
    assert.equal(fullClosedVerify.wiringReport.counts.violated, 0);
    assert.equal(fullClosedVerify.wiringReport.counts.inconclusive, 0);

    assertionsVerified += 11;
    defectResults.push({ id: "TASK-02", detected: halfVerify.verificationVerdict === "VIOLATED" });
  }
);

// ============================================================================
// TASK-03: New Subclass Implementation Forgot Factory Registration
// ============================================================================
withTaskWorkspace(
  {
    "package.json": JSON.stringify({ name: "report-service", private: true }, null, 2),
    "src/exporters/base.ts": `
export abstract class BaseExporter {
  abstract render(rows: string[]): string;
}
`,
    "src/exporters/json.ts": `
import { BaseExporter } from "./base";
export class JsonExporter extends BaseExporter {
  render(rows: string[]): string {
    return JSON.stringify(rows);
  }
}
`,
    "src/exporters/xml.ts": `
import { BaseExporter } from "./base";
export class XmlExporter extends BaseExporter {
  render(rows: string[]): string {
    return rows.map((r) => \`<row>\${r}</row>\`).join("");
  }
}
`,
    "src/factory.ts": `
import { BaseExporter } from "./exporters/base";
import { JsonExporter } from "./exporters/json";
import { XmlExporter } from "./exporters/xml";

export function createExporter(format: string): BaseExporter {
  if (format === "xml") {
    return new XmlExporter();
  }
  return new JsonExporter();
}
`,
    "src/main.ts": `
import { createExporter } from "./factory";
export function main() {
  const exp = createExporter("json");
  console.log(exp.render(["a", "b"]));
}
`
  },
  (dir) => {
    initGitCommit(dir);

    // Developer adds CsvExporter but forgets to register it in `createExporter`
    writeWorkspaceFiles(dir, {
      "src/exporters/csv.ts": `
import { BaseExporter } from "./base";
export class CsvExporter extends BaseExporter {
  render(rows: string[]): string {
    return rows.join(",");
  }
}
`
    });

    const verify = verifyWorkspaceFlow(dir);
    assert.equal(verify.status, "ISSUES_FOUND");
    assert.equal(verify.verificationVerdict, "VIOLATED");
    const regObl = verify.wiringReport.obligations.find(
      (o) => o.station === "REGISTRATION_OR_DISPATCH" && o.status === "VIOLATED"
    );
    assert.ok(regObl, "Must detect missing factory registration for CsvExporter");
    assert.ok(regObl.finding.includes("CsvExporter") && regObl.remediation.includes("src/factory.ts"));

    assertionsVerified += 4;
    defectResults.push({ id: "TASK-03", detected: Boolean(regObl) });
  }
);

// ============================================================================
// TASK-04: Frontend Protocol Updated, Backend Handler Still Reads Legacy Field
// ============================================================================
withTaskWorkspace(
  {
    "package.json": JSON.stringify({ name: "tauri-bridge-app", private: true }, null, 2),
    "src/App.tsx": `
import { invoke } from "@tauri-apps/api/core";

export function App() {
  const legacyMode = "fast";
  void invoke("apply_inference_cfg", { legacyMode });
  return null;
}
`,
    "src-tauri/src/lib.rs": `
#[tauri::command]
pub fn apply_inference_cfg(legacy_mode: String) -> String {
    format!("applied:{legacy_mode}")
}
`
  },
  (dir) => {
    initGitCommit(dir);

    // Frontend sends new field `quantizationBits`, but Rust backend only accepts/reads `legacy_mode`
    writeWorkspaceFiles(dir, {
      "src/App.tsx": `
import { invoke } from "@tauri-apps/api/core";

export function App() {
  const legacyMode = "fast";
  const quantizationBits = 8;
  void invoke("apply_inference_cfg", { legacyMode, quantizationBits });
  return null;
}
`
    });

    const verify = verifyWorkspaceFlow(dir);
    assert.equal(verify.status, "ISSUES_FOUND");
    assert.equal(verify.verificationVerdict, "VIOLATED");
    assert.ok(verify.impactedUntouchedFiles.includes("src-tauri/src/lib.rs"));
    const protoObl = verify.wiringReport.obligations.find(
      (o) => o.station === "PROTOCOL_COUNTERPART" && o.status === "VIOLATED"
    );
    assert.ok(protoObl && protoObl.finding.includes("quantizationBits"));

    assertionsVerified += 4;
    defectResults.push({ id: "TASK-04", detected: Boolean(protoObl) });
  }
);

// ============================================================================
// TASK-05: Config Can Save, Fails to Recover on Restart (Save ⇄ Load Asymmetry)
// ============================================================================
withTaskWorkspace(
  {
    "package.json": JSON.stringify({ name: "preferences-app", private: true }, null, 2),
    "src/prefs.ts": `
export class UserPreferences {
  public theme = "dark";

  public setTheme(next: string) {
    this.theme = next;
  }

  public savePreferences(): string {
    return JSON.stringify({ theme: this.theme });
  }

  public loadPreferences(json: string) {
    const data = JSON.parse(json);
    this.theme = data.theme ?? "dark";
  }
}

export function main() {
  const p = new UserPreferences();
  p.setTheme("light");
  const snap = p.savePreferences();
  p.loadPreferences(snap);
  console.log(p.theme);
}
`
  },
  (dir) => {
    initGitCommit(dir);

    // Developer adds `autoSaveInterval`, uses it in runtime & saves it, but forgets `loadPreferences`!
    writeWorkspaceFiles(dir, {
      "src/prefs.ts": `
export class UserPreferences {
  public theme = "dark";
  public autoSaveInterval = 30;

  public setTheme(next: string) {
    this.theme = next;
  }

  public setAutoSaveInterval(sec: number) {
    this.autoSaveInterval = sec;
  }

  public savePreferences(): string {
    return JSON.stringify({
      theme: this.theme,
      autoSaveInterval: this.autoSaveInterval
    });
  }

  public loadPreferences(json: string) {
    const data = JSON.parse(json);
    this.theme = data.theme ?? "dark";
  }
}

export function main() {
  const p = new UserPreferences();
  p.setTheme("light");
  p.setAutoSaveInterval(15);
  const snap = p.savePreferences();
  p.loadPreferences(snap);
  console.log(p.theme, p.autoSaveInterval);
}
`
    });

    const verify = verifyWorkspaceFlow(dir);
    assert.equal(verify.status, "ISSUES_FOUND");
    assert.equal(verify.verificationVerdict, "VIOLATED");
    const pairObl = verify.wiringReport.obligations.find(
      (o) => o.station === "PAIRED_LIFECYCLE" && o.status === "VIOLATED"
    );
    assert.ok(pairObl && pairObl.finding.includes("autoSaveInterval"));

    assertionsVerified += 3;
    defectResults.push({ id: "TASK-05", detected: Boolean(pairObl) });
  }
);

// ============================================================================
// TASK-06: New Path Works on Windows Branch, Mac Platform Sibling Missed
// ============================================================================
withTaskWorkspace(
  {
    "package.json": JSON.stringify({ name: "cross-platform-audio", private: true }, null, 2),
    "src/driver.ts": `
export interface AudioDriver {
  play(sample: string): void;
}
`,
    "src/win_driver.ts": `
import { AudioDriver } from "./driver";
export class WindowsAudioDriver implements AudioDriver {
  play(sample: string): void {
    console.log("win:", sample);
  }
}
`,
    "src/mac_driver.ts": `
import { AudioDriver } from "./driver";
export class MacAudioDriver implements AudioDriver {
  play(sample: string): void {
    console.log("mac:", sample);
  }
}
`,
    "src/main.ts": `
import { AudioDriver } from "./driver";
import { WindowsAudioDriver } from "./win_driver";
import { MacAudioDriver } from "./mac_driver";

export function createDriver(osName: string): AudioDriver {
  return osName === "darwin" ? new MacAudioDriver() : new WindowsAudioDriver();
}

export function main() {
  const drv = createDriver("win32");
  drv.play("beep");
}
`
  },
  (dir) => {
    initGitCommit(dir);

    // Developer adds `setSpatialMode` to `AudioDriver`, `WindowsAudioDriver`, and `main()`, forgetting `MacAudioDriver`!
    writeWorkspaceFiles(dir, {
      "src/driver.ts": `
export interface AudioDriver {
  play(sample: string): void;
  setSpatialMode(enabled: boolean): void;
}
`,
      "src/win_driver.ts": `
import { AudioDriver } from "./driver";
export class WindowsAudioDriver implements AudioDriver {
  play(sample: string): void {
    console.log("win:", sample);
  }
  setSpatialMode(enabled: boolean): void {
    console.log("win-spatial:", enabled);
  }
}
`,
      "src/main.ts": `
import { AudioDriver } from "./driver";
import { WindowsAudioDriver } from "./win_driver";
import { MacAudioDriver } from "./mac_driver";

export function createDriver(osName: string): AudioDriver {
  return osName === "darwin" ? new MacAudioDriver() : new WindowsAudioDriver();
}

export function main() {
  const drv = createDriver("win32");
  drv.setSpatialMode(true);
  drv.play("beep");
}
`
    });

    const verify = verifyWorkspaceFlow(dir);
    assert.equal(verify.status, "ISSUES_FOUND");
    assert.equal(verify.verificationVerdict, "VIOLATED");
    const branchObl = verify.wiringReport.obligations.find(
      (o) =>
        o.station === "REGISTRATION_OR_DISPATCH" &&
        o.status === "VIOLATED" &&
        o.finding.includes("MacAudioDriver") &&
        o.finding.includes("setSpatialMode")
    );
    assert.ok(branchObl, "Must catch missing setSpatialMode on sibling MacAudioDriver");

    assertionsVerified += 3;
    defectResults.push({ id: "TASK-06", detected: Boolean(branchObl) });
  }
);

// ============================================================================
// TASK-07: Refactoring Leaves Old Consumer Active / New Consumer Unwired & Orphaned State Read
// ============================================================================
withTaskWorkspace(
  {
    "package.json": JSON.stringify({ name: "checkout-app", private: true }, null, 2),
    "src/cart.ts": `
export class CartStore {
  public legacyTotalCents = 0;

  public recalculate(items: number[]) {
    this.legacyTotalCents = items.reduce((a, b) => a + b, 0);
  }
}
`,
    "src/summary_view.ts": `
import { CartStore } from "./cart";

export function renderLegacySummary(store: CartStore) {
  console.log("Total:", store.legacyTotalCents);
}
`,
    "src/main.ts": `
import { CartStore } from "./cart";
import { renderLegacySummary } from "./summary_view";

export function main() {
  const store = new CartStore();
  store.recalculate([100, 250]);
  renderLegacySummary(store);
}
`
  },
  (dir) => {
    initGitCommit(dir);

    // Developer refactors `CartStore` to write `subtotalCents` and adds `renderModernSummary`,
    // BUT forgets to update `main.ts`, so `main.ts` still calls `renderLegacySummary` (which reads writerless `legacyTotalCents`)
    // and `renderModernSummary` is never wired!
    writeWorkspaceFiles(dir, {
      "src/cart.ts": `
export class CartStore {
  public subtotalCents = 0;

  public recalculate(items: number[]) {
    this.subtotalCents = items.reduce((a, b) => a + b, 0);
  }
}
`,
      "src/modern_view.ts": `
import { CartStore } from "./cart";

export function renderModernSummary(store: CartStore) {
  console.log("Modern Subtotal:", store.subtotalCents);
}
`
    });

    const verify = verifyWorkspaceFlow(dir);
    assert.equal(verify.status, "ISSUES_FOUND");
    assert.equal(verify.verificationVerdict, "VIOLATED");
    assert.ok(verify.impactedUntouchedFiles.includes("src/summary_view.ts"));
    assert.ok(
      verify.flowDiff.newlyWriterlessStateReads.some((r) => r.field === "legacyTotalCents"),
      "Must detect untouched consumer still reading refactored-away legacyTotalCents"
    );
    assert.ok(
      verify.unwiredExports.some((u) => u.name === "renderModernSummary"),
      "Must detect new consumer renderModernSummary was never wired into main"
    );

    assertionsVerified += 5;
    defectResults.push({ id: "TASK-07", detected: verify.verificationVerdict === "VIOLATED" });
  }
);

// ============================================================================
// TASK-08: Deleting Reader Turns Writer in Untouched File into Dead End (Across Committed `baseRef`)
// ============================================================================
withTaskWorkspace(
  {
    "package.json": JSON.stringify({ name: "pipeline-worker", private: true }, null, 2),
    "src/producer.ts": `
export class BatchQueue {
  public pendingPayload = "";

  public enqueue(item: string) {
    this.pendingPayload = item;
  }
}
`,
    "src/consumer.ts": `
import { BatchQueue } from "./producer";

export function flushQueue(q: BatchQueue) {
  console.log("Flushing:", q.pendingPayload);
}
`,
    "src/main.ts": `
import { BatchQueue } from "./producer";
import { flushQueue } from "./consumer";

export function main() {
  const q = new BatchQueue();
  q.enqueue("job-1");
  flushQueue(q);
}
`
  },
  (dir) => {
    initGitCommit(dir, "baseline with reader");

    // Developer changes `consumer.ts` so it no longer reads `q.pendingPayload`, AND commits the change!
    writeWorkspaceFiles(dir, {
      "src/consumer.ts": `
import { BatchQueue } from "./producer";

export function flushQueue(_q: BatchQueue) {
  console.log("No-op flush");
}
`
    });
    execSync('git add -A && git -c commit.gpgsign=false commit -m "remove reader"', {
      cwd: dir,
      stdio: "ignore"
    });

    // Working tree is now clean vs HEAD, so we pass `baseRef: "HEAD~1"` to audit the task across commits!
    const verify = verifyWorkspaceFlow(dir, { baseRef: "HEAD~1" });
    assert.equal(verify.status, "ISSUES_FOUND");
    assert.equal(verify.verificationVerdict, "VIOLATED");
    assert.ok(
      verify.impactedUntouchedFiles.includes("src/producer.ts"),
      "Untouched writer file src/producer.ts must be flagged in impactedUntouchedFiles"
    );
    assert.ok(
      verify.writeOnlyDeadEndStates.some((s) => s.qualifiedField === "BatchQueue.pendingPayload"),
      "BatchQueue.pendingPayload in untouched file must be caught as newly write-only"
    );

    assertionsVerified += 4;
    defectResults.push({ id: "TASK-08", detected: verify.verificationVerdict === "VIOLATED" });
  }
);

// ============================================================================
// LEGAL-01: Public Library Package Export (`package.json` `exports`) -> Legal Entry!
// ============================================================================
withTaskWorkspace(
  {
    "package.json": JSON.stringify(
      {
        name: "@acme/vector-kit",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./src/index.ts" }
      },
      null,
      2
    ),
    "src/index.ts": `
export { normalizeVec } from "./math";
`,
    "src/math.ts": `
export function normalizeVec(v: number[]): number[] {
  return v.map((n) => n / 2);
}
`
  },
  (dir) => {
    initGitCommit(dir);

    writeWorkspaceFiles(dir, {
      "src/index.ts": `
export { normalizeVec, dotProduct } from "./math";
`,
      "src/math.ts": `
export function normalizeVec(v: number[]): number[] {
  return v.map((n) => n / 2);
}

export function dotProduct(a: number[], b: number[]): number {
  return a.reduce((sum, val, i) => sum + val * (b[i] ?? 0), 0);
}
`
    });

    const verify = verifyWorkspaceFlow(dir);
    assert.equal(verify.workspaceProfile.projectMode, "library");
    assert.equal(verify.status, "PASS");
    assert.equal(verify.verificationVerdict, "SATISFIED");
    assert.equal(verify.unwiredExports.length, 0);
    assert.equal(verify.summary.obligationsViolated, 0);

    assertionsVerified += 5;
    counterexampleResults.push({ id: "LEGAL-01", falseViolation: verify.summary.obligationsViolated > 0 });
  }
);

// ============================================================================
// LEGAL-02: Conditional Compilation / Platform-Enabled Implementation (`#[cfg]`)
// ============================================================================
withTaskWorkspace(
  {
    "Cargo.toml": `[package]\nname = "sys-agent"\nversion = "0.1.0"\n`,
    "src/main.rs": `
pub struct OsClock;

impl OsClock {
    #[cfg(target_os = "windows")]
    pub fn tick_ns(scale: u64) -> u64 {
        100 * scale
    }

    #[cfg(target_os = "linux")]
    pub fn tick_ns(scale: u64) -> u64 {
        200 * scale
    }

    #[cfg(feature = "hardware_ptp")]
    pub fn calibrate_ptp() -> u64 {
        42
    }
}

fn main() {
    let t = OsClock::tick_ns(2);
    println!("{t}");
}
`
  },
  (dir) => {
    const verify = verifyWorkspaceFlow(dir, { fullScan: true });
    assert.equal(verify.status, "PASS");
    assert.equal(verify.summary.obligationsViolated, 0);
    assert.equal(verify.unwiredOrDeadPipes.length, 0);

    assertionsVerified += 3;
    counterexampleResults.push({ id: "LEGAL-02", falseViolation: verify.summary.obligationsViolated > 0 });
  }
);

// ============================================================================
// LEGAL-03: One-Way Event Subscribed by External Plugin -> `INCONCLUSIVE` (No Stop Block!)
// ============================================================================
withTaskWorkspace(
  {
    "package.json": JSON.stringify({ name: "extensible-editor", private: true }, null, 2),
    "src/main.ts": `
export function main() {
  console.log("boot");
}
`
  },
  (dir) => {
    initGitCommit(dir);

    writeWorkspaceFiles(dir, {
      "src/main.ts": `
const eventBus = { emit: (_t: string, _p: unknown) => {} };

export function main() {
  eventBus.emit("plugin:document-saved", { docId: "1" });
}
`
    });

    const verify = verifyWorkspaceFlow(dir);
    assert.equal(verify.status, "PASS", "External event bus emission must not fail build status");
    assert.equal(verify.verificationVerdict, "INCONCLUSIVE", "Unmatched event bus must report honest INCONCLUSIVE");
    assert.equal(verify.summary.obligationsViolated, 0);
    assert.ok(verify.summary.obligationsInconclusive >= 1);

    const stopDecision = runHook("stop", {
      workspacePaths: [dir],
      conversationId: `bench-inc-${Date.now()}`,
      terminationReason: "NO_TOOL_CALL"
    });
    assert.equal(stopDecision.decision, "allow", "Stop hook must NEVER block on INCONCLUSIVE findings");

    assertionsVerified += 5;
    counterexampleResults.push({ id: "LEGAL-03", falseViolation: verify.summary.obligationsViolated > 0 });
  }
);

// ============================================================================
// LEGAL-04: Write-Only Telemetry & Audit Sinks
// ============================================================================
withTaskWorkspace(
  {
    "package.json": JSON.stringify({ name: "metrics-daemon", private: true }, null, 2),
    "src/main.ts": `
export class WorkerNode {
  public telemetryCounter = 0;
  public auditRecord = "";

  public handleJob(jobId: string) {
    this.telemetryCounter = 1;
    this.auditRecord = jobId;
    console.log("processed", jobId);
  }
}

export function main() {
  const node = new WorkerNode();
  node.handleJob("j-42");
}
`
  },
  (dir) => {
    initGitCommit(dir);
    writeWorkspaceFiles(dir, {
      "src/main.ts": `
export class WorkerNode {
  public telemetryCounter = 0;
  public auditRecord = "";
  public metricsLatencyMs = 0;

  public handleJob(jobId: string) {
    this.telemetryCounter = 1;
    this.auditRecord = jobId;
    this.metricsLatencyMs = 12;
    console.log("processed", jobId);
  }
}

export function main() {
  const node = new WorkerNode();
  node.handleJob("j-42");
}
`
    });

    const verify = verifyWorkspaceFlow(dir);
    assert.equal(verify.status, "PASS");
    assert.equal(verify.writeOnlyDeadEndStates.length, 0, "Telemetry/metrics fields must not false-positive write-only");
    assert.equal(verify.summary.obligationsViolated, 0);

    assertionsVerified += 3;
    counterexampleResults.push({ id: "LEGAL-04", falseViolation: verify.summary.obligationsViolated > 0 });
  }
);

// ============================================================================
// LEGAL-05: Typed & Evidenced Edges (`SEQ_CALL` vs `BRANCH_DISPATCH`),
// Ambiguous RPC Candidate Preservation, plus WebView2 & SharedMemory Bridges
// ============================================================================
withTaskWorkspace(
  {
    "src/order_pipeline.ts": `
function authenticate(token: string): boolean {
  return token.length > 0;
}

function validatePayload(body: string): string {
  return body.trim();
}

function persistOrder(cleanBody: string) {
  localStorage.setItem("order", cleanBody);
}

export function handleRequest(token: string, body: string) {
  if (!authenticate(token)) {
    return;
  }
  const clean = validatePayload(body);
  persistOrder(clean);
}

export function bootFrontend() {
  chrome.webview.addEventListener("message", (evt: MessageEvent) => {
    console.log(evt.data);
  });
  chrome.webview.postMessage({ cmd: "sync_frame" });
  void genericRpcClient.deleteRecord({ id: "1" });
  void orderServiceClient.archiveItem({ id: "1" });
}
`,
    "server/services.go": `
package server

type OrderService struct{}
func (s *OrderService) DeleteRecord(id string) string { return id }
func (s *OrderService) ArchiveItem(id string) string { return id }

type BillingService struct{}
func (s *BillingService) DeleteRecord(id string) string { return id }
`,
    "native/host.cpp": `
#include <windows.h>

void sendFrameToUi(ICoreWebView2* wv) {
    HANDLE hMap = CreateFileMappingA(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, 4096, "Local\\\\ReflexFrameShm");
    wv->PostWebMessageAsJson(L"{\\"ok\\":true}");
}

void initHost(ICoreWebView2* wv) {
    wv->add_WebMessageReceived(nullptr, nullptr);
}

int main() {
    sendFrameToUi(nullptr);
    initHost(nullptr);
    return 0;
}
`,
    "python/reader.py": `
from multiprocessing.shared_memory import SharedMemory

def main():
    shm = SharedMemory(name="Local\\\\ReflexFrameShm", create=False)
    print(shm.name)
`
  },
  (dir) => {
    const valTrace = traceSymbolFlow(dir, "validatePayload").traces[0];
    assert.ok(valTrace, "validatePayload trace must exist");
    assert.equal(
      valTrace.siblingBranchesToCheck.length,
      0,
      `Sequential pipeline steps must NOT pollute siblingBranchesToCheck, got: ${JSON.stringify(valTrace.siblingBranchesToCheck)}`
    );
    assert.ok(
      valTrace.sequentialStepsInCaller.some((s) => s.includes("persistOrder")),
      "persistOrder should appear in sequentialStepsInCaller"
    );

    const overview = generateFlowOverview(dir, false);
    const ambigRpc = overview.crossLanguageBridges.find(
      (b) => b.kind === "RPC_SERVICE" && b.contract === "genericRpcClient.deleteRecord()"
    );
    assert.ok(ambigRpc, "genericRpcClient.deleteRecord bridge must exist");
    assert.equal(ambigRpc.confidence, "AMBIGUOUS", "Multi-service RPC match without prefix match must be AMBIGUOUS");
    assert.equal(ambigRpc.candidates?.length, 2, "Ambiguous RPC bridge must preserve both candidate services");

    const disambigRpc = overview.crossLanguageBridges.find(
      (b) => b.kind === "RPC_SERVICE" && b.contract === "orderServiceClient.archiveItem()"
    );
    assert.ok(disambigRpc && disambigRpc.confidence === "HIGH" && disambigRpc.toSymbol === "OrderService.ArchiveItem");

    const wv2Bridges = overview.crossLanguageBridges.filter(
      (b) => b.kind === "WEBVIEW2_IPC" && b.status === "CONNECTED"
    );
    assert.ok(wv2Bridges.length >= 2, "Bidirectional C++ <-> JS WebView2 IPC bridges should be CONNECTED");

    const shmBridge = overview.crossLanguageBridges.find(
      (b) => b.kind === "SHARED_MEMORY_IPC" && b.status === "CONNECTED"
    );
    assert.ok(shmBridge, "C++ CreateFileMapping <-> Python SharedMemory bridge should be CONNECTED");

    assertionsVerified += 9;
    counterexampleResults.push({ id: "LEGAL-05", falseViolation: false });
  }
);

// ============================================================================
// LEGAL-06: Pre-Existing Broken Bridge Isolated from Unrelated Incremental Change
// ============================================================================
withTaskWorkspace(
  {
    "package.json": JSON.stringify({ name: "legacy-monorepo", private: true }, null, 2),
    "src/legacy_page.ts": `
import { invoke } from "@tauri-apps/api/core";
export function main() {
  void invoke("historic_missing_tauri_cmd");
}
`,
    "src/theme_util.ts": `
export function getAccentColor(dark: boolean): string {
  return dark ? "#111" : "#fff";
}
`
  },
  (dir) => {
    // Wire theme_util into main before committing baseline
    writeWorkspaceFiles(dir, {
      "src/legacy_page.ts": `
import { invoke } from "@tauri-apps/api/core";
import { getAccentColor } from "./theme_util";
export function main() {
  console.log(getAccentColor(true));
  void invoke("historic_missing_tauri_cmd");
}
`
    });
    initGitCommit(dir, "baseline with pre-existing broken tauri invoke");

    // Developer edits ONLY `src/theme_util.ts` cleanly
    writeWorkspaceFiles(dir, {
      "src/theme_util.ts": `
export function getAccentColor(dark: boolean): string {
  return dark ? "#000000" : "#ffffff";
}
`
    });

    const verify = verifyWorkspaceFlow(dir);
    assert.equal(verify.status, "PASS", "Pre-existing broken bridge in untouched file must not block unrelated edit");
    assert.equal(verify.brokenBridges.length, 0);
    assert.equal(verify.flowDiff.preExistingBrokenBridges.length, 1);
    assert.equal(verify.summary.obligationsViolated, 0);

    assertionsVerified += 4;
    counterexampleResults.push({ id: "LEGAL-06", falseViolation: verify.summary.obligationsViolated > 0 });
  }
);

const detectedCount = defectResults.filter((r) => r.detected).length;
const falseViolationsCount = counterexampleResults.filter((r) => r.falseViolation).length;
assert.equal(detectedCount, defectResults.length, "Expected 100% recall across all incomplete-wiring benchmark tasks");
assert.equal(falseViolationsCount, 0, "Expected 0% false violation rate across all paired legal counterexamples");
assertionsVerified += 2;

const elapsedMs = Math.round(performance.now() - t0);
console.log(
  JSON.stringify({
    suite: "flow-guard Real-Task Incomplete-Wiring & Counterexample Benchmark Suite",
    status: "ALL_PASSED",
    metrics: {
      incompleteWiringTasks: `${detectedCount}/${defectResults.length} recall (100%)`,
      legalCounterexamples: `${falseViolationsCount}/${counterexampleResults.length} false violations (0%)`,
      assertionsVerified
    },
    elapsedMs
  })
);
