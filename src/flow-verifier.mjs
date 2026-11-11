import path from "node:path";
import { buildWorkspaceFlowGraph, getGitWorkingTreeStatus } from "./graph-builder.mjs";
import { jaccardSimilarity } from "./fingerprint.mjs";
import { EXT_LANG } from "./lang-presets.mjs";

export function shortId(sym) {
  const label = sym.parentContainerName ? `${sym.parentContainerName}.${sym.name}` : sym.name;
  return `${sym.file}:${sym.startLine}-${sym.endLine} (${label})`;
}

export function verifyWorkspaceFlow(workspaceRoot, options = {}) {
  const fullScan = Boolean(options.fullScan);
  const graph = buildWorkspaceFlowGraph(workspaceRoot, true);
  const gitStatus = getGitWorkingTreeStatus(workspaceRoot);
  const changedFiles = new Set(
    gitStatus.changedFiles.filter((f) => Boolean(EXT_LANG[path.extname(f).toLowerCase()]))
  );
  const hasAnyGitChanges = gitStatus.isGitRepo && gitStatus.changedFiles.length > 0;
  const isFullScan = fullScan || !hasAnyGitChanges;
  const isNonSourceDiffOnly = !isFullScan && changedFiles.size === 0;
  const scanMode = isFullScan
    ? "FULL_WORKSPACE"
    : isNonSourceDiffOnly
      ? "NON_SOURCE_DIFF_ONLY"
      : "INCREMENTAL_GIT_DIFF";

  // 1. Cross-Boundary Bridge Integrity
  const brokenBridges = graph.crossBridges.filter((b) => b.status !== "CONNECTED");

  // 2. Sandbox / Test Reverse Dependency Leaks
  const sandboxViolations = [];
  for (const sym of graph.symbolById.values()) {
    if (sym.zone !== "prod") continue;
    for (const calleeId of graph.outEdges.get(sym.id) || []) {
      const target = graph.symbolById.get(calleeId);
      if (target && target.zone !== "prod") {
        sandboxViolations.push({
          prodCaller: shortId(sym),
          illegalTarget: shortId(target),
          targetZone: target.zone
        });
      }
    }
  }

  // 3. Write-Only Dead-End States (States written in prod with 0 readers)
  const writeOnlyStates = [];
  for (const own of graph.stateOwnership.values()) {
    const rawField = own.field;
    if (own.writers.length > 0 && own.readers.length === 0 && !/^(Instance|Log|Logger|Enabled|Visible)$/i.test(rawField)) {
      const writerSyms = own.writers.map((id) => graph.symbolById.get(id)).filter(Boolean);
      if (isFullScan || writerSyms.some((s) => changedFiles.has(s.file))) {
        writeOnlyStates.push({
          field: rawField,
          qualifiedField: own.qualifiedField || rawField,
          writers: writerSyms.map(shortId)
        });
      }
    }
  }

  // 4. Unwired / Dead Pipes + Data-Flow Drops + Intentional Reserved Contracts
  const unwiredSymbols = [];
  const dataFlowBreaks = [];
  const reservedContracts = [];

  for (const sym of graph.symbolById.values()) {
    if (sym.zone !== "prod") continue;
    const inScope = isFullScan ? true : changedFiles.has(sym.file);
    if (!inScope) continue;

    if (sym.reservedParams && sym.reservedParams.length > 0) {
      reservedContracts.push({
        symbol: shortId(sym),
        kind: "RESERVED_PARAM_SIGNATURE",
        reservedParams: sym.reservedParams,
        verdict: "KEEP_SIGNATURE_DO_NOT_BREAK"
      });
    }

    // 4a. Zero-Inflow Unwired Symbol (uses `callInEdges` so class containment does not mask dead methods)
    if (
      (sym.kind === "function" || sym.kind === "method") &&
      !sym.roles.includes("source") &&
      !sym.isPublicApi &&
      !sym.isReferencedInFile
    ) {
      const callInDeg = (graph.callInEdges.get(sym.id) || new Set()).size;
      if (callInDeg === 0 && !graph.reachableFromSource.has(sym.id)) {
        if (sym.isFeatureGated || sym.isExtensionHook) {
          reservedContracts.push({
            symbol: shortId(sym),
            kind: sym.isFeatureGated ? "FEATURE_GATED_OR_ALLOWED_DEAD" : "EXTENSION_HOOK_RESERVE",
            verdict: "RESERVED_DO_NOT_BLINDLY_DELETE"
          });
        } else {
          unwiredSymbols.push({ symbol: shortId(sym), verdict: "SAFE_TO_DELETE_OR_WIRE" });
        }
      }
    }

    // 4b. Dead Input Parameters (Parameter received but never read in function body)
    const nonFrameworkUnusedParams = sym.isEntrySource
      ? sym.unusedParams.filter(
          (p) => !/^(?:req|request|res|response|next|ctx|context|event|evt|e|err|error|argc|argv|sender|args|app|window|state)$/i.test(p)
        )
      : sym.unusedParams;
    if (
      nonFrameworkUnusedParams.length > 0 &&
      sym.name !== "main" &&
      !/^(Prefix|Postfix|Transpiler)$/.test(sym.name)
    ) {
      dataFlowBreaks.push({
        kind: "DEAD_INPUT_PARAM",
        location: shortId(sym),
        unusedParams: nonFrameworkUnusedParams,
        diagnosis: `进水口断流：形参 [${nonFrameworkUnusedParams.join(", ")}] 传入后在函数体内从未被读取使用`
      });
    }

    // 4c. Dead Local Assignments (`const res = fn()` where `res` is never read)
    for (const dlv of sym.deadLocalVars) {
      dataFlowBreaks.push({
        kind: "DEAD_LOCAL_ASSIGNMENT",
        location: `${sym.file}:${sym.startLine + dlv.lineOffset} (${sym.name})`,
        variable: dlv.varName,
        callee: dlv.callee,
        diagnosis: `出水口断流：调用 ${dlv.callee}() 的返回值赋给了局部变量 "${dlv.varName}"，但后续从未被读取或传递`
      });
    }

    // 4d. Ignored Pure Function Call (`fn()` called as bare statement, discarding return value when `fn` has no side effects)
    for (const bare of sym.bareIgnoredCalls) {
      const candidates = (graph.symbolsByName.get(bare.callee) || []).filter((t) => t.zone === "prod");
      if (candidates.length === 1) {
        const target = candidates[0];
        const targetStem = path.basename(target.file, path.extname(target.file));
        const qualifierMatches =
          !bare.qualifier ||
          bare.qualifier === "this" ||
          bare.qualifier === "self" ||
          bare.qualifier === target.parentContainerName ||
          bare.qualifier === targetStem;

        if (
          qualifierMatches &&
          target.hasReturnValue &&
          !target.canIgnoreReturnValue &&
          !target.hasInternalMutation &&
          target.writes.length === 0 &&
          !target.hasExternalBoundaryEffect &&
          !(graph.reachesSideEffectSink || graph.reachesSink).has(target.id)
        ) {
          dataFlowBreaks.push({
            kind: "IGNORED_PURE_CALL",
            location: `${sym.file}:${sym.startLine + bare.lineOffset} (${sym.name})`,
            callee: shortId(target),
            diagnosis: `空转假调用：${target.name}() 是无副作用的纯计算函数，此处裸调丢弃了其返回值，未产生任何实际效果`
          });
        }
      }
    }
  }

  // 5. Asymmetric Paired Updates in Changed Files
  const asymmetricWarnings = [];
  for (const relFile of changedFiles) {
    const fObj = graph.fileByPath.get(relFile);
    if (!fObj || fObj.zone !== "prod") continue;
    const groups = new Map();
    for (const s of fObj.symbols) {
      if (s.paired) {
        if (!groups.has(s.paired.group)) groups.set(s.paired.group, { left: [], right: [] });
        groups.get(s.paired.group)[s.paired.side].push(s.name);
      }
    }
    for (const [gName, sides] of groups.entries()) {
      if (sides.left.length > 0 && sides.right.length === 0) {
        asymmetricWarnings.push({ file: relFile, group: gName, present: sides.left, missingSide: "right" });
      } else if (sides.right.length > 0 && sides.left.length === 0) {
        asymmetricWarnings.push({ file: relFile, group: gName, present: sides.right, missingSide: "left" });
      }
    }
  }

  // 6. Structural Clone Sprawl Detection (with size-ratio bucketing to skip trivial getters and O(N^2) waste)
  const clones = [];
  if (!isNonSourceDiffOnly) {
    const fnSymbols = Array.from(graph.symbolById.values())
      .filter((s) => s.zone === "prod" && s.shingles.size >= 18)
      .sort((a, b) => a.shingles.size - b.shingles.size);
    for (let i = 0; i < fnSymbols.length; i++) {
      const a = fnSymbols[i];
      const maxBSize = Math.ceil(a.shingles.size / 0.82);
      for (let j = i + 1; j < fnSymbols.length; j++) {
        const b = fnSymbols[j];
        if (b.shingles.size > maxBSize) break;
        if (a.name === b.name && a.file === b.file) continue;
        if (!isFullScan && !changedFiles.has(a.file) && !changedFiles.has(b.file)) continue;
        const sim = jaccardSimilarity(a.shingles, b.shingles);
        if (sim >= 0.85) clones.push({ funcA: shortId(a), funcB: shortId(b), similarity: `${Math.round(sim * 100)}%` });
      }
    }
  }

  const antiPatterns = gitStatus.addedAntiPatterns;
  const blockingCount =
    brokenBridges.length +
    sandboxViolations.length +
    antiPatterns.length +
    dataFlowBreaks.filter((d) => d.kind === "DEAD_LOCAL_ASSIGNMENT" || d.kind === "IGNORED_PURE_CALL").length;

  return {
    status: blockingCount === 0 ? "PASS" : "ISSUES_FOUND",
    scanMode,
    changedFilesScanned: Array.from(changedFiles),
    summary: {
      brokenCrossLanguageBridges: brokenBridges.length,
      sandboxReverseDependencyLeaks: sandboxViolations.length,
      unwiredOrDeadPipesCount: unwiredSymbols.length,
      dataFlowBreaksCount: dataFlowBreaks.length,
      reservedContractsCount: reservedContracts.length,
      writeOnlyDeadEndStatesCount: writeOnlyStates.length,
      asymmetricLifecycleWarnings: asymmetricWarnings.length,
      structuralClonesCount: clones.length,
      antiPatternsCount: antiPatterns.length
    },
    brokenBridges,
    sandboxViolations,
    dataFlowBreaks: dataFlowBreaks.slice(0, 20),
    unwiredOrDeadPipes: unwiredSymbols.slice(0, 20),
    reservedContracts: reservedContracts.slice(0, 20),
    writeOnlyDeadEndStates: writeOnlyStates.slice(0, 15),
    asymmetricLifecycleWarnings: asymmetricWarnings.slice(0, 10),
    structuralClones: clones.slice(0, 10),
    antiPatterns: antiPatterns.slice(0, 10)
  };
}
