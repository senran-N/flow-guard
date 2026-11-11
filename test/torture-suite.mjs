import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { generateFlowOverview, traceSymbolFlow, generateWiringBlueprint } from "../src/flow-tools.mjs";
import { verifyWorkspaceFlow } from "../src/flow-verifier.mjs";
import { runHook } from "../src/hook-runner.mjs";
import { resolveRoot, handleRpcMessage } from "../src/server.mjs";

function withTempWorkspace(filesMap, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-guard-torture-"));
  try {
    for (const [rel, content] of Object.entries(filesMap)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf8");
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const t0 = performance.now();
let assertionsCount = 0;

// ============================================================================
// PHASE 1: 10-Language High-Density Adversarial Syntax Torture Suite
// (Packs 35+ nasty real-world syntax edge cases; expects 0 false positives)
// ============================================================================
const CLEAN_TORTURE_FILES = {
  // 1. TypeScript / TSX / Barrel Re-Export / Vue SFC: JSX </Tag> & />, hoisted closure, multi-line object return type `: Promise<{...; ...}>`, ES2022 `#private` fields & arrow methods, barrel `export *` + `import as`
  "src/tools/pages.ts": `
export const barrelTool = (id: string): string => id.trim();
`,
  "src/tools/index.ts": `
export * from "./pages.js";
`,
  "src/Panel.vue": `
<template>
  <button :title="'Don\\'t break template quotes'" @click="onVueSave">{{ formatVueLabel(vueTitle) }}</button>
</template>
<script setup lang="ts">
const vueTitle = "panel";
const formatVueLabel = (v: string): string => v.toUpperCase();
const onVueSave = () => {
  localStorage.setItem("vue_saved", formatVueLabel(vueTitle));
};
</script>
<style scoped>
.btn { color: red; }
</style>
`,
  "src/index.tsx": `
import { invoke as __TAURI_INVOKE } from "@tauri-apps/api/core";
import { revalidateQuery, assertValidTag, ConfigService, UnrelatedClient } from "./services";
import { barrelTool as aliasedBarrelTool } from "./tools/index.js";

export function overloadFn(x: number): { a: number };
export function overloadFn(x: string): { a: string };
export function overloadFn(x: number | string) {
  return { a: x };
}

export const buildExtensions = (opts: { tag: string } = { tag: "a" }): string[] => [
  opts.tag,
  "b",
];

export const preloadEditor = (): Promise<void> =>
  Promise.resolve().then(() => undefined);

export const TortureViewer = (props: { open: boolean; label: string; onClose: () => void }) => {
  const { open, label, onClose } = props;
  const handleClose = () => onClose();
  const isReady = () => open && label.length > 0;
  const cleanup = () => {
    clearTimeout(timer);
  };
  const timer = setTimeout(() => {
    cleanup();
  }, 1000);

  preloadEditor();
  handleClose();
  revalidateQuery("cfg");
  assertValidTag(label);
  const cleanedId = aliasedBarrelTool(label);
  const cfgSvc = new ConfigService("https://example.com");
  void cfgSvc.inspectMeta();
  const unrelated = new UnrelatedClient(cfgSvc.url() + cfgSvc.publicBadge, 1);
  const globStart = "src/*";
  const exts = buildExtensions({ tag: cleanedId });
  const ov = overloadFn(1);
  void __TAURI_INVOKE<string>("sync_vault", { label, exts, ov, globStart, unrelated });
  void fetch(\`/api/memos/\${label}\`);
  void fetch(\`/api/memos/\${cleanedId}\`, { method: "DELETE" });
  void memoServiceClient.createMemo({ label });
  const globEnd = "*/dist";
  const busTopic = globEnd ? "verge://refresh-verge-config" : "idle";

  return (
    <div title={
      isReady()
        ? busTopic
        : "waiting"
    }>
      <span>{label}</span>
    </div>
  );
};
`,
  "src/services.ts": `
import assert from "node:assert/strict";

export function assertValidTag(tag: string): string {
  assert.ok(tag.length > 0);
  return tag.trim();
}

export class ConfigService {
  readonly publicBadge: string;
  #secretSalt: string;

  constructor(
    private readonly endpoint: string,
    private retries = 3,
  ) {
    this.publicBadge = "v1";
    this.#secretSalt = "salty";
  }

  #readSalt = () => this.#secretSalt;

  async inspectMeta(): Promise<{
    host: string;
    salt: string;
  }> {
    return {
      host: this.endpoint,
      salt: this.#readSalt(),
    };
  }

  url() {
    return \`\${this.endpoint}:\${this.retries}\`;
  }
}

export class UnrelatedClient {
  constructor(host: string, attempts: number) {
    localStorage.setItem(host, String(attempts));
  }
}

export const revalidateQuery = (key: string) => {
  localStorage.setItem("last_key", key);
};
export const memoServiceClient = {
  createMemo: (req: unknown) => Promise.resolve(req)
};
`,
  "tests/helper.ts": `
export function makeTestFixture() {
  return "fixture-ok";
}
`,
  "scripts/eval_bench.ts": `
import { makeTestFixture } from "../tests/helper";

export function main() {
  console.log(makeTestFixture());
}
`,

  // 2. Rust: #[command] + #[specta::specta], r#"..."# raw string interpolation {var}, #[cfg] platform twins with unused param on Windows
  "src-tauri/src/lib.rs": `
#[command]
#[specta::specta]
pub async fn sync_vault(label: String) -> Result<String, String> {
    let evt = "verge://refresh-verge-config";
    let html = format!(r#"<div class="badge" data-evt="{evt}">v{label}</div>"#);
    let p = PlatformEntry::from_path(&html, 3);
    Ok(p)
}

pub struct PlatformEntry;

impl PlatformEntry {
    #[cfg(unix)]
    pub fn from_path(path: &str, depth: usize) -> String {
        format!("{path}:{depth}")
    }

    #[cfg(windows)]
    pub fn from_path(path: &str, depth: usize) -> String {
        format!("{path}")
    }
}
`,

  // 3. Go: shared-type parameters, unexported interface, raw backtick string ending with backslash
  "server/main.go": `
package server

import "fmt"

type dbExecutor interface {
	Exec(query string) error
}

type APIService struct{}

func (s *APIService) CreateMemo(label string) string {
	return connectDB("admin", label)
}

func connectDB(user, pass string) string {
	rawPath := \`C:\\data\\\`
	return fmt.Sprintf("%s:%s@%s", user, pass, rawPath)
}

func Run() {
	res := connectDB("admin", "secret")
	fmt.Println(res)
}
`,

  // 4. Python: triple-quoted f-string interpolation, generator yield, base class extension hook, FastAPI dynamic route
  "app/engine.py": `
class BaseApp:
    def get_max_age(self, filename: str) -> int:
        """Subclasses can override this hook."""
        default_age = 3600
        return default_age

@app.get("/api/memos/{memo_id}")
def get_memo_detail(memo_id: str):
    return f"memo:{memo_id}"

@app.delete("/api/memos/{memo_id}")
def delete_memo_detail(memo_id: str):
    return f"deleted:{memo_id}"

def render_template(title: str):
    doc = f"""
    <html>
      <h1>{title}</h1>
    </html>
    """
    yield doc.strip()

def main():
    app = BaseApp()
    age = app.get_max_age("index.html")
    for chunk in render_template(str(age)):
        print(chunk)
`,

  // 5. C# / Kotlin / C++: C# $@"..." verbatim interpolation + : base(arg) + Guard precondition, Kotlin = expr, C++ : member_{...}
  "native/Runtime.cs": `
using System;

public class BaseService {
    public BaseService(string endpoint) {
        Console.WriteLine(endpoint);
    }
}

public class RuntimeService : BaseService {
    public RuntimeService(string endpoint) : base(endpoint) {}

    public static string AgainstNull(string input) {
        if (input == null) throw new ArgumentNullException(nameof(input));
        return input;
    }

    public void Main(string user) {
        AgainstNull(user);
        var msg = $@"Hello ""{user}""";
        Console.WriteLine(msg);
    }
}
`,
  "native/Helper.kt": `
class Helper {
    fun formatTag(tag: String) = "[$tag]"
    fun main() {
        println(formatTag("ok"))
    }
}
`,
  "native/formatter.cpp": `
#include <cstdio>

class Formatter {
    int mode_;
public:
    Formatter(int mode, const char* label) : mode_{mode} {
        std::printf("%s: %d\\n", label, mode_);
    }
};

int main() {
    Formatter f(1, "init");
    return 0;
}
`,
  // 6. Swift / PHP / Ruby: Swift extension + \(interp) + external/internal labels, PHP 8 promoted ctor + $this->field, Ruby rescue + #{interp} + @ivar
  "ios/VaultBridge.swift": `
struct VaultBadge {
    let prefix: String
}

extension VaultBadge {
    func format(for user: String, _ retries: Int = 2) -> String {
        return "\\(prefix):\\(user)#\\(retries)"
    }
}

@main
struct VaultApp {
    static func main() {
        let badge = VaultBadge(prefix: "v1")
        print(badge.format(for: "alice"))
    }
}
`,
  "web/MemoController.php": `
<?php
class MemoController {
    private string $lastSlug = "";

    public function __construct(private string $prefix) {}

    #[Route("/api/health")]
    public function check(string $slug): string {
        $this->lastSlug = $slug;
        return "{$this->lastSlug}:ok";
    }
}
`,
  "worker/job.rb": `
class JobWorker
  def call(payload)
    @last_job = payload
    "done:#{payload}:#{@last_job}"
  rescue StandardError => err
    "err:#{err}"
  end
end
`
};

withTempWorkspace(CLEAN_TORTURE_FILES, (dir) => {
  const overview = generateFlowOverview(dir, false);
  const verify = verifyWorkspaceFlow(dir);

  // Assert 0 false-positive data-flow breaks, 0 unwired pipes, 0 broken bridges, 0 write-only states, 0 sandbox leaks
  assert.equal(verify.brokenBridges.length, 0, `Expected 0 broken bridges, got: ${JSON.stringify(verify.brokenBridges)}`);
  assertionsCount++;
  assert.equal(verify.sandboxViolations.length, 0, `Expected 0 sandboxViolations for scripts/eval_bench.ts, got: ${JSON.stringify(verify.sandboxViolations)}`);
  assertionsCount++;
  assert.ok(overview.zoneCounts.sandboxFiles >= 1, "Expected scripts/eval_bench.ts to be classified in sandbox zone");
  assertionsCount++;
  assert.equal(verify.dataFlowBreaks.length, 0, `Expected 0 false-positive dataFlowBreaks, got: ${JSON.stringify(verify.dataFlowBreaks)}`);
  assertionsCount++;
  assert.equal(verify.unwiredOrDeadPipes.length, 0, `Expected 0 unwired pipes, got: ${JSON.stringify(verify.unwiredOrDeadPipes)}`);
  assertionsCount++;
  assert.equal(verify.writeOnlyDeadEndStates.length, 0, `Expected 0 writeOnly states, got: ${JSON.stringify(verify.writeOnlyDeadEndStates)}`);
  assertionsCount++;

  // Assert TS constructor parameter properties are consumed without spurious constructor twin reservedContracts
  const hasCtorReserveNoise = verify.reservedContracts.some((r) => r.symbol.includes("ConfigService.constructor"));
  assert.ok(!hasCtorReserveNoise, "ConfigService.constructor should not emit spurious reservedContracts");
  const bpIndex = generateWiringBlueprint(dir, "src/index.tsx");
  const overloadEntries = bpIndex.moduleArchitectureProfile.publicApiSurface.filter((s) => s.startsWith("overloadFn("));
  assert.equal(overloadEntries.length, 1, "Overloaded public API signatures should be deduplicated in flow_blueprint");
  assertionsCount += 2;

  // Assert Tauri bridge (__TAURI_INVOKE("sync_vault") -> #[command] fn sync_vault), RPC bridge (memoServiceClient.createMemo -> APIService.CreateMemo), and Event Bus bridge ("verge://refresh-verge-config") are all CONNECTED with exact symbol attribution
  const tauriBridge = overview.crossLanguageBridges.find((b) => b.kind === "TAURI_IPC");
  assert.ok(tauriBridge && tauriBridge.status === "CONNECTED");
  assert.equal(tauriBridge.fromSymbol, "TortureViewer");
  assert.equal(tauriBridge.toSymbol, "sync_vault");

  const rpcBridge = overview.crossLanguageBridges.find((b) => b.kind === "RPC_SERVICE");
  assert.ok(rpcBridge && rpcBridge.status === "CONNECTED");
  assert.equal(rpcBridge.fromSymbol, "TortureViewer");
  assert.equal(rpcBridge.toSymbol, "APIService.CreateMemo");

  const evtBridge = overview.crossLanguageBridges.find((b) => b.kind === "EVENT_BUS_BRIDGE");
  assert.ok(evtBridge && evtBridge.status === "CONNECTED");
  assert.equal(evtBridge.fromSymbol, "sync_vault");
  assert.equal(evtBridge.toSymbol, "TortureViewer");

  const restGetBridge = overview.crossLanguageBridges.find(
    (b) => b.kind === "HTTP_REST_API" && b.fromSymbol === "TortureViewer" && b.contract.startsWith("GET ")
  );
  assert.ok(restGetBridge && restGetBridge.status === "CONNECTED", "GET /api/memos/:param bridge should be CONNECTED");
  assert.equal(restGetBridge.toSymbol, "get_memo_detail");

  const restDeleteBridge = overview.crossLanguageBridges.find(
    (b) => b.kind === "HTTP_REST_API" && b.fromSymbol === "TortureViewer" && b.contract.startsWith("DELETE ")
  );
  assert.ok(restDeleteBridge && restDeleteBridge.status === "CONNECTED", "DELETE /api/memos/:param bridge should be CONNECTED without overwriting GET");
  assert.equal(restDeleteBridge.toSymbol, "delete_memo_detail");
  assertionsCount += 13;

  // Assert Barrel Re-Export (`export * from "./pages.js"`) + `import { barrelTool as aliasedBarrelTool }` links TortureViewer -> barrelTool
  const barrelTrace = traceSymbolFlow(dir, "barrelTool");
  assert.ok(
    barrelTrace.traces[0]?.directCallers.some((c) => c.includes("TortureViewer")),
    `Expected TortureViewer to link to barrelTool across barrel index, got: ${JSON.stringify(barrelTrace.traces[0]?.directCallers)}`
  );
  assertionsCount++;

  // Assert Vue SFC `<template @click="onVueSave">` wires `<script setup>` handler as UI Source -> Sink
  const vueTrace = traceSymbolFlow(dir, "onVueSave");
  assert.ok(vueTrace.traces[0]?.roles.includes("source") && vueTrace.traces[0]?.roles.includes("sink"), "Vue SFC @click handler should be wired Source -> Sink");
  assertionsCount++;

  // Assert dedicated Swift extension, PHP 8 promoted ctor + $this->field, and Ruby rescue + @ivar parsers extract clean symbols
  assert.ok(traceSymbolFlow(dir, "format").matchCount >= 1, "Swift extension method VaultBadge.format not parsed");
  assert.ok(traceSymbolFlow(dir, "check").matchCount >= 1, "PHP MemoController.check not parsed");
  assert.ok(traceSymbolFlow(dir, "JobWorker").matchCount >= 1, "Ruby JobWorker.call not parsed");
  assertionsCount += 3;

  // Assert reserved contracts (Rust #[cfg] twin `from_path(depth)` + Python BaseApp hook `get_max_age(filename)`) are protected
  assert.ok(verify.reservedContracts.length >= 2, `Expected >=2 reservedContracts, got: ${JSON.stringify(verify.reservedContracts)}`);
  assertionsCount++;
});

// ============================================================================
// PHASE 2: Automated Fault-Injection Mutation Fuzzing Suite
// (Injects 8 distinct architectural defects and asserts 100% recall)
// ============================================================================
const MUTATED_DEFECT_FILES = {
  "lab/experiment.ts": `
export function leakFromLab(seed: string): string {
  return seed;
}
`,
  "src/index.ts": `
import { invoke } from "@tauri-apps/api/core";
import { leakFromLab } from "../lab/experiment";

class StateStore {
  private orphanField = 0;

  public start(usedArg: string, deadInputParam: number) {
    this.orphanField = 42;
    pureCompute(usedArg);
    pureLoopCompute([usedArg]);
    const deadLocal = computeToken(usedArg);
    void invoke("non_existent_rust_cmd");
    console.log(leakFromLab(usedArg));
  }
}

class HealthyStore {
  public orphanField = 1;
  public readHealthy(): number {
    this.orphanField = 2;
    return this.orphanField;
  }
}

class SecretVault {
  #unusedSecret = 0;
  public seal(code: number) {
    this.#unusedSecret = code;
  }
}

function pureCompute(x: string): string {
  return x.trim();
}

function pureLoopCompute(arr: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    out.push(arr[i]);
  }
  return out;
}

function computeToken(x: string): string {
  return x.toUpperCase();
}

function completelyUnwiredDeadPipe(a: number): number {
  return a + 1;
}

export function main() {
  const s = new StateStore();
  s.start("hello", 99);
  const h = new HealthyStore();
  console.log(h.readHealthy());
  const v = new SecretVault();
  v.seal(7);
}
`
};

withTempWorkspace(MUTATED_DEFECT_FILES, (dir) => {
  const verify = verifyWorkspaceFlow(dir);

  // 1. Must catch DEAD_INPUT_PARAM (`deadInputParam`)
  const hasDeadParam = verify.dataFlowBreaks.some(
    (b) => b.kind === "DEAD_INPUT_PARAM" && b.unusedParams?.includes("deadInputParam")
  );
  assert.ok(hasDeadParam, "Mutation fuzzer failed to catch DEAD_INPUT_PARAM");
  assertionsCount++;

  // 2. Must catch IGNORED_PURE_CALL (`pureCompute(usedArg)`)
  const hasIgnoredPure = verify.dataFlowBreaks.some(
    (b) => b.kind === "IGNORED_PURE_CALL" && b.callee.includes("pureCompute")
  );
  assert.ok(hasIgnoredPure, "Mutation fuzzer failed to catch IGNORED_PURE_CALL");
  assertionsCount++;

  // 3. Must catch IGNORED_PURE_CALL on pure function with local loop & array accumulator (`pureLoopCompute`)
  const hasIgnoredPureLoop = verify.dataFlowBreaks.some(
    (b) => b.kind === "IGNORED_PURE_CALL" && b.callee.includes("pureLoopCompute")
  );
  assert.ok(hasIgnoredPureLoop, "Mutation fuzzer failed to catch IGNORED_PURE_CALL for pureLoopCompute");
  assertionsCount++;

  // 4. Must catch DEAD_LOCAL_ASSIGNMENT (`deadLocal = computeToken(...)`)
  const hasDeadLocal = verify.dataFlowBreaks.some(
    (b) => b.kind === "DEAD_LOCAL_ASSIGNMENT" && b.variable === "deadLocal"
  );
  assert.ok(hasDeadLocal, "Mutation fuzzer failed to catch DEAD_LOCAL_ASSIGNMENT");
  assertionsCount++;

  // 5. Must catch BROKEN_TARGET Tauri bridge (`invoke("non_existent_rust_cmd")`)
  const hasBrokenBridge = verify.brokenBridges.some(
    (b) => b.toSymbol === "non_existent_rust_cmd" && b.status === "BROKEN_TARGET"
  );
  assert.ok(hasBrokenBridge, "Mutation fuzzer failed to catch BROKEN_TARGET Tauri bridge");
  assertionsCount++;

  // 6. Must catch sandbox reverse dependency leak (`src/index.ts` -> `lab/experiment.ts`)
  const hasSandboxLeak = verify.sandboxViolations.some(
    (v) =>
      v.prodCaller.includes("src/index.ts") &&
      v.illegalTarget.includes("lab/experiment.ts") &&
      v.targetZone === "sandbox"
  );
  assert.ok(hasSandboxLeak, "Mutation fuzzer failed to catch prod -> lab/ sandbox violation");
  assertionsCount++;

  // 7. Must catch UNWIRED_DEAD_PIPE (`completelyUnwiredDeadPipe`)
  const hasUnwired = verify.unwiredOrDeadPipes.some((u) => u.symbol.includes("completelyUnwiredDeadPipe"));
  assert.ok(hasUnwired, "Mutation fuzzer failed to catch UNWIRED_DEAD_PIPE");
  assertionsCount++;

  // 8. Must catch container-scoped WRITE_ONLY_STATE (`StateStore.orphanField` NOT masked by `HealthyStore.orphanField`, plus `#unusedSecret`)
  const hasScopedWriteOnly = verify.writeOnlyDeadEndStates.some(
    (w) => w.field === "orphanField" && w.qualifiedField === "StateStore.orphanField"
  );
  assert.ok(hasScopedWriteOnly, "Mutation fuzzer failed to isolate StateStore.orphanField from HealthyStore.orphanField");
  const hasHealthyFalsePos = verify.writeOnlyDeadEndStates.some(
    (w) => w.qualifiedField === "HealthyStore.orphanField"
  );
  assert.ok(!hasHealthyFalsePos, "HealthyStore.orphanField should NOT be flagged as write-only");
  const hasPrivateHashWriteOnly = verify.writeOnlyDeadEndStates.some(
    (w) => w.field === "#unusedSecret" && w.qualifiedField === "SecretVault.#unusedSecret"
  );
  assert.ok(hasPrivateHashWriteOnly, "Mutation fuzzer failed to catch ES2022 #unusedSecret write-only state");
  assertionsCount += 3;

  // 9. Verify `flow_trace` and `flow_blueprint` architectural vision output
  const trace = traceSymbolFlow(dir, "start");
  assert.ok(trace.matchCount >= 1);
  assert.equal(trace.traces[0].architecturalContext.parameterFlowMatrix.length, 2);
  const bp = generateWiringBlueprint(dir, "src/index.ts");
  assert.ok(bp.moduleArchitectureProfile);
  assertionsCount += 3;
});

// ============================================================================
// PHASE 3: Lifecycle Hook & MCP Protocol Contract Suite
// (Verifies SessionStart injection, Stop hook dataFlowBreaks + SHA-1 dedupe, and MCP rootUri handshake)
// ============================================================================
const lastWorkspaceCachePath = path.join(os.tmpdir(), "flowguard-last-workspace.txt");
const savedLastWorkspace = fs.existsSync(lastWorkspaceCachePath)
  ? fs.readFileSync(lastWorkspaceCachePath, "utf8")
  : null;

try {
  withTempWorkspace(
    {
      "README.md": "# Demo\n",
      "src/legacy.ts": `
function untouchedLegacyDead(): number {
  return 1;
}
export function keepAlive() {
  localStorage.setItem("ok", "1");
}
`,
      "src/app.ts": `
export function runApp(name: string) {
  console.log(name);
}
`
    },
    (gitDir) => {
      // 1. SessionStart hook baseline injection
      const startRes = runHook("session-start", { workspacePaths: [gitDir] });
      const sysMsg = startRes.injectSteps?.[0]?.systemMessage?.systemMessage || "";
      assert.ok(sysMsg.includes("[FlowGuard 端到端水路基线已就绪]"), "SessionStart failed to inject baseline");
      assertionsCount++;

      // 2. MCP initialize rootUri handshake + resolveRoot()
      const rpcCaptured = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => {
        rpcCaptured.push(String(chunk));
        return true;
      };
      try {
        handleRpcMessage({
          jsonrpc: "2.0",
          id: 7,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            rootUri: pathToFileURL(gitDir).href
          }
        });
      } finally {
        process.stdout.write = origWrite;
      }
      const initPayload = JSON.parse(rpcCaptured.join("").trim());
      assert.equal(initPayload.result?.serverInfo?.version, "0.1.0");
      assert.equal(resolveRoot(), path.resolve(gitDir));
      assertionsCount += 2;

      // 3. Non-source git diff guard (`NON_SOURCE_DIFF_ONLY` vs `fullScan: true`) & Stop hook blocking + SHA-1 deduplication
      execSync(
        'git init && git config user.email "torture@flowguard.local" && git config user.name "FlowGuard Torture" && git add . && git -c commit.gpgsign=false commit -m "init clean baseline"',
        { cwd: gitDir, stdio: "ignore" }
      );

      fs.writeFileSync(path.join(gitDir, "README.md"), "# Demo Updated\n", "utf8");
      const mdOnlyVerify = verifyWorkspaceFlow(gitDir);
      assert.equal(mdOnlyVerify.scanMode, "NON_SOURCE_DIFF_ONLY", "Editing only README.md should enter NON_SOURCE_DIFF_ONLY mode");
      assert.equal(mdOnlyVerify.unwiredOrDeadPipes.length, 0, "Editing only README.md must NOT trigger full-repo legacy unwired scan");
      const forcedFullVerify = verifyWorkspaceFlow(gitDir, { fullScan: true });
      assert.equal(forcedFullVerify.scanMode, "FULL_WORKSPACE");
      assert.ok(
        forcedFullVerify.unwiredOrDeadPipes.some((u) => u.symbol.includes("untouchedLegacyDead")),
        "fullScan: true should still audit untouched legacy files cleanly across cached file AST snapshots"
      );
      assertionsCount += 4;

      fs.writeFileSync(
        path.join(gitDir, "src/app.ts"),
        `
function makeUpper(s: string): string {
  return s.toUpperCase();
}
export function runApp(name: string) {
  const unusedToken = makeUpper(name);
  console.log(name);
}
`,
        "utf8"
      );

      const convId = `torture-conv-${process.pid}-${Date.now()}`;
      const stopCacheFile = path.join(os.tmpdir(), `flowguard-stop-${convId}.txt`);
      try {
        const firstStop = runHook("stop", {
          workspacePaths: [gitDir],
          conversationId: convId,
          terminationReason: "NO_TOOL_CALL"
        });
        assert.equal(firstStop.decision, "continue", "Stop hook should block uncommitted DEAD_LOCAL_ASSIGNMENT");
        assert.ok(firstStop.reason?.includes("局部数据流断裂"), "Stop hook reason should report dataFlowBreaks");

        const secondStop = runHook("stop", {
          workspacePaths: [gitDir],
          conversationId: convId,
          terminationReason: "NO_TOOL_CALL"
        });
        assert.equal(secondStop.decision, "allow", "Stop hook should deduplicate identical failure hash");
        assertionsCount += 3;
      } finally {
        fs.rmSync(stopCacheFile, { force: true });
      }
    }
  );
} finally {
  if (savedLastWorkspace !== null) {
    fs.writeFileSync(lastWorkspaceCachePath, savedLastWorkspace, "utf8");
  } else {
    fs.rmSync(lastWorkspaceCachePath, { force: true });
  }
}

const elapsedMs = Math.round(performance.now() - t0);
console.log(
  JSON.stringify({
    suite: "flow-guard Adversarial Torture, Mutation Fuzzing & Contract Suite",
    status: "ALL_PASSED",
    assertionsVerified: assertionsCount,
    elapsedMs
  })
);
