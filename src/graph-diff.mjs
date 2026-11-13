import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EXT_LANG } from "./lang-presets.mjs";
import { parseSourceFileContent } from "./file-parser.mjs";
import { assembleFlowGraph, cloneParsedFile } from "./graph-builder.mjs";

import { readScopedState, writeScopedState } from "./state-store.mjs";
export { getFlowGuardDataDir, getWorkspaceKeyHash } from "./state-store.mjs";

function getCurrentGitHead(workspaceRoot) {
  if (!fs.existsSync(path.join(workspaceRoot, ".git"))) return null;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

export function makeSymbolBaseKey(sym) {
  const containerPrefix = sym.parentContainerName ? `${sym.parentContainerName}.` : "";
  return `${sym.file}::${containerPrefix}${sym.name}#${sym.kind}`;
}

export function serializeGraphSnapshot(graph, meta = {}) {
  const occCounter = new Map();
  const keyById = new Map();
  const symbols = {};

  const sortedSyms = Array.from(graph.symbolById.values()).sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.startLine - b.startLine;
  });

  for (const sym of sortedSyms) {
    const baseKey = makeSymbolBaseKey(sym);
    const occ = occCounter.get(baseKey) || 0;
    occCounter.set(baseKey, occ + 1);
    const stableKey = occ === 0 ? baseKey : `${baseKey}@${occ}`;
    keyById.set(sym.id, stableKey);

    symbols[stableKey] = {
      stableKey,
      baseKey,
      id: sym.id,
      name: sym.name,
      kind: sym.kind,
      zone: sym.zone,
      lang: sym.lang,
      file: sym.file,
      startLine: sym.startLine,
      endLine: sym.endLine,
      parentContainerName: sym.parentContainerName || null,
      baseTypes: [...(sym.baseTypes || [])],
      params: [...(sym.params || [])],
      isPublicApi: Boolean(sym.isPublicApi),
      projectMode: sym.projectMode || graph.workspaceProfile?.projectMode || "hybrid",
      isPackageEntryExport: Boolean(sym.isPackageEntryExport),
      hasCargoBoundary: Boolean(sym.hasCargoBoundary),
      isEntrySource: Boolean(sym.isEntrySource),
      isReferencedInFile: Boolean(sym.isReferencedInFile),
      isFeatureGated: Boolean(sym.isFeatureGated),
      isExtensionHook: Boolean(sym.isExtensionHook),
      exposure: sym.exposure || "PRIVATE_INTERNAL",
      roles: [...(sym.roles || [])],
      reachableFromRuntimeSource: graph.reachableFromRuntimeSource.has(sym.id),
      reachableFromSource: graph.reachableFromSource.has(sym.id),
      possiblyReachableFromRuntimeSource: graph.possiblyReachableFromRuntimeSource.has(sym.id),
      frameworkCallbackCandidates: (sym.frameworkCallbackCandidates || []).map(c => ({ ...c })),
      reachesSink: graph.reachesSink.has(sym.id),
      writes: [...(sym.writes || [])],
      reads: [...(sym.reads || [])],
      upperConstantsRead: [...(sym.upperConstantsRead || [])]
    };
  }

  const edges = [];
  for (const [fromId, detailList] of (graph.outEdgeDetails || new Map()).entries()) {
    const fromKey = keyById.get(fromId);
    if (!fromKey) continue;
    for (const rec of detailList) {
      const toKey = keyById.get(rec.toId);
      if (!toKey) continue;
      edges.push({
        fromKey,
        toKey,
        kind: rec.kind,
        file: rec.evidence?.file || "",
        line: rec.evidence?.line || 1,
        reason: rec.evidence?.reason || rec.kind,
        stateField: rec.evidence?.stateField || null,
        contract: rec.evidence?.contract || null,
        confidence: rec.resolution?.confidence || "HIGH",
        resolutionMode: rec.resolution?.mode || null
      });
    }
  }

  const states = {};
  for (const [stKey, own] of graph.stateOwnership.entries()) {
    states[stKey] = {
      key: stKey,
      field: own.field,
      qualifiedField: own.qualifiedField || own.field,
      scope: own.scope || null,
      writers: own.writers.map((id) => keyById.get(id)).filter(Boolean),
      readers: own.readers.map((id) => keyById.get(id)).filter(Boolean)
    };
  }

  const bridges = (graph.crossBridges || []).map((b) => ({
    kind: b.kind,
    contract: b.contract,
    fromFile: b.fromFile,
    fromLine: b.fromLine || null,
    fromSymbol: b.fromSymbol,
    toFile: b.toFile || null,
    toLine: b.toLine || null,
    toSymbol: b.toSymbol || null,
    status: b.status,
    payloadFields: [...(b.payloadFields || [])],
    confidence: b.confidence || "HIGH"
  }));

  const fieldLifecycleAsymmetries = (graph.fieldLifecycleAsymmetries || []).map((item) => ({
    kind: item.kind,
    field: item.field,
    qualifiedField: item.qualifiedField,
    files: [...(item.files || [])],
    diagnosis: item.diagnosis
  }));

  return {
    version: "0.2.0",
    createdAt: new Date().toISOString(),
    source: meta.source || "WORKING_TREE",
    baseRef: meta.baseRef || null,
    headCommit: meta.headCommit !== undefined ? meta.headCommit : getCurrentGitHead(graph.workspaceRoot || ""),
    workspaceRoot: graph.workspaceRoot || "",
    projectMode: graph.workspaceProfile?.projectMode || "hybrid",
    files: graph.files.map((f) => ({ file: f.file, zone: f.zone, lang: f.lang, contentHash: f.contentHash || null })),
    symbols,
    edges,
    states,
    bridges,
    fieldLifecycleAsymmetries
  };
}

export function saveSessionBaseline(workspaceRoot, graph, options = {}) {
  const snapshot = serializeGraphSnapshot(graph, { source: "SESSION_SNAPSHOT", baseRef: "SESSION_START" });
  const baselinePath = writeScopedState("baseline", workspaceRoot, snapshot, options);
  return { saved: true, baselinePath, snapshot };
}

export function loadSavedSessionBaseline(workspaceRoot, options = {}) {
  const snapshot = readScopedState("baseline", workspaceRoot, options);
  if (snapshot && (!snapshot.symbols || !snapshot.states || !Array.isArray(snapshot.files)
    || snapshot.files.some((f) => !f.contentHash))) {
    options.stateDiagnostics?.push({ kind: "baseline", code: "INCOMPLETE_BASELINE", reason: "Missing graph or file hashes" });
    return null;
  }
  return snapshot;
}

function extractAddedAntiPatternsFromDiff(diffText) {
  const addedAntiPatterns = [];
  let currentFile = "";
  let currentLine = 0;
  for (const rawLine of diffText.split(/\r?\n/)) {
    if (rawLine.startsWith("+++ b/")) {
      currentFile = rawLine.slice(6).trim();
    } else if (rawLine.startsWith("@@ ")) {
      const m = rawLine.match(/\+(\d+)/);
      if (m) currentLine = parseInt(m[1], 10) - 1;
    } else if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      currentLine++;
      const fileExt = path.extname(currentFile).toLowerCase();
      if (!EXT_LANG[fileExt]) continue;
      const addedCode = rawLine.slice(1);
      if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(addedCode)) {
        addedAntiPatterns.push({
          location: `${currentFile}:${currentLine}`,
          kind: "NEW_EMPTY_CATCH",
          code: addedCode.trim()
        });
      }
      if (/#\[allow\(dead_code\)\]|eslint-disable.*unused|@ts-ignore/i.test(addedCode)) {
        addedAntiPatterns.push({
          location: `${currentFile}:${currentLine}`,
          kind: "NEW_SUPPRESSED_WARNING",
          code: addedCode.trim()
        });
      }
    }
  }
  return addedAntiPatterns;
}

export function reconstructBaselineFromGitRef(workspaceRoot, currGraph, baseRef = "HEAD", options = {}) {
  const normRoot = path.resolve(workspaceRoot);
  if (!fs.existsSync(path.join(normRoot, ".git"))) return null;

  try {
    const resolvedCommit = execFileSync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], {
      cwd: normRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();

    const diffOut = execFileSync("git", ["diff", "--name-status", resolvedCommit], {
      cwd: normRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024
    });

    const untrackedOut = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: normRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024
    });

    const addedInWorking = new Set();
    const modifiedInWorking = new Set();
    const deletedInWorking = new Set();
    const renamedOldByNew = new Map();

    for (const raw of untrackedOut.split(/\r?\n/)) {
      const f = raw.trim().replace(/\\/g, "/");
      if (f) addedInWorking.add(f);
    }

    for (const line of diffOut.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const status = parts[0].trim();
      if (status.startsWith("R") && parts.length >= 3) {
        const oldPath = parts[1].trim().replace(/\\/g, "/");
        const newPath = parts[2].trim().replace(/\\/g, "/");
        addedInWorking.add(newPath);
        deletedInWorking.add(oldPath);
        renamedOldByNew.set(newPath, oldPath);
      } else if (status.startsWith("A") && parts[1]) {
        addedInWorking.add(parts[1].trim().replace(/\\/g, "/"));
      } else if (status.startsWith("D") && parts[1]) {
        deletedInWorking.add(parts[1].trim().replace(/\\/g, "/"));
      } else if (parts[1]) {
        modifiedInWorking.add(parts[1].trim().replace(/\\/g, "/"));
      }
    }

    const baseFiles = [];
    for (const currFile of currGraph.files) {
      if (addedInWorking.has(currFile.file)) {
        continue;
      }
      if (!modifiedInWorking.has(currFile.file)) {
        baseFiles.push(cloneParsedFile(currFile));
      }
    }

    const filesToLoadFromGit = new Set([...modifiedInWorking, ...deletedInWorking]);
    for (const relPath of filesToLoadFromGit) {
      const ext = path.extname(relPath).toLowerCase();
      if (!EXT_LANG[ext]) continue;
      if (
        relPath.endsWith(".d.ts") ||
        relPath.endsWith(".min.js") ||
        relPath.endsWith(".bundle.js") ||
        relPath.endsWith(".wasm.js")
      ) {
        continue;
      }
      try {
        const oldContent = execFileSync("git", ["show", `${resolvedCommit}:${relPath}`], {
          cwd: normRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 16 * 1024 * 1024
        });
        const parsed = parseSourceFileContent(oldContent, relPath);
        if (parsed) baseFiles.push(parsed);
      } catch {
        // File might be a submodule or binary; ignore gracefully
      }
    }

    const changedFiles = Array.from(new Set([...addedInWorking, ...modifiedInWorking]));
    const deletedFiles = Array.from(deletedInWorking);
    let addedAntiPatterns = [];
    if (changedFiles.length > 0) {
      try {
        const rawDiffText = execFileSync("git", ["diff", "-U0", resolvedCommit], {
          cwd: normRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 16 * 1024 * 1024
        });
        addedAntiPatterns = extractAddedAntiPatternsFromDiff(rawDiffText);
      } catch {
        addedAntiPatterns = [];
      }
    }

    const baseGraph = assembleFlowGraph(baseFiles, normRoot, {
      projectMode: options.projectMode || currGraph.workspaceProfile?.projectMode || "auto"
    });
    const snapshot = serializeGraphSnapshot(baseGraph, {
      source: "GIT_REF",
      baseRef,
      headCommit: resolvedCommit
    });

    return {
      snapshot,
      changedFiles,
      deletedFiles,
      renamedOldByNew: Object.fromEntries(renamedOldByNew),
      addedAntiPatterns
    };
  } catch {
    return null;
  }
}

export function resolveBaselineForVerification(workspaceRoot, currGraph, gitWorkingStatus, options = {}) {
  // 1. Explicit `baseRef` always takes highest priority (supports multi-commit tasks & branch diffs)
  if (options.baseRef) {
    const gitBase = reconstructBaselineFromGitRef(workspaceRoot, currGraph, options.baseRef, options);
    if (gitBase) return gitBase;
    throw new Error(`Cannot resolve or reconstruct requested Git baseline: ${options.baseRef}`);
  }

  if (options.fullScan) {
    return null;
  }

  // A valid session snapshot represents the actual task start, including pre-existing dirty files.
  const savedSession = options.useSessionBaseline === false ? null : loadSavedSessionBaseline(workspaceRoot, options);
  const hasWorkingChanges = gitWorkingStatus.isGitRepo &&
    (gitWorkingStatus.changedFiles.length > 0 || (gitWorkingStatus.deletedFiles?.length || 0) > 0);
  if (savedSession) {
    const before = new Map(savedSession.files.map((file) => [file.file, file.contentHash]));
    const after = new Map(currGraph.files.map((file) => [file.file, file.contentHash]));
    const changedFiles = [...after].filter(([file, hash]) => before.get(file) !== hash).map(([file]) => file);
    const deletedFiles = [...before.keys()].filter((file) => !after.has(file));
    return {
      snapshot: savedSession, changedFiles, deletedFiles, renamedOldByNew: {},
      addedAntiPatterns: (gitWorkingStatus.addedAntiPatterns || []).filter((item) =>
        changedFiles.some((file) => item.location.startsWith(`${file}:`)))
    };
  }

  if (hasWorkingChanges) {
    const headBase = reconstructBaselineFromGitRef(workspaceRoot, currGraph, "HEAD", options);
    if (headBase) {
      // Merge untracked file anti-patterns if any
      return {
        ...headBase,
        changedFiles: Array.from(new Set([...headBase.changedFiles, ...gitWorkingStatus.changedFiles])),
        deletedFiles: Array.from(new Set([...headBase.deletedFiles, ...(gitWorkingStatus.deletedFiles || [])])),
        addedAntiPatterns:
          headBase.addedAntiPatterns.length > 0 ? headBase.addedAntiPatterns : gitWorkingStatus.addedAntiPatterns || []
      };
    }
  }

  return null;
}

function formatSnapSym(s) {
  const label = s.parentContainerName ? `${s.parentContainerName}.${s.name}` : s.name;
  return `${s.file}:${s.startLine}-${s.endLine} (${label})`;
}

export function isTelemetryOrAuditField(fieldName) {
  return /^(?:telemetry|metrics?|audit|traceLog|eventLog|analytics|perfCounter|histogram|span)/i.test(fieldName || "");
}

export function computeFlowGraphDiff(baseSnap, currGraph, diffMeta = {}) {
  const currSnap = serializeGraphSnapshot(currGraph, { source: "WORKING_TREE" });
  const changedSourceFiles = new Set(
    (diffMeta.changedFiles || []).filter((f) => Boolean(EXT_LANG[path.extname(f).toLowerCase()]))
  );
  const deletedSourceFiles = new Set(
    (diffMeta.deletedFiles || []).filter((f) => Boolean(EXT_LANG[path.extname(f).toLowerCase()]))
  );

  const impactedUntouchedFiles = new Set();
  const markIfUntouched = (file) => {
    if (file && !changedSourceFiles.has(file) && !deletedSourceFiles.has(file)) {
      impactedUntouchedFiles.add(file);
    }
  };

  // Build lookup maps (with baseKey fallback if symbol occurrence index shifted)
  const baseByStable = new Map(Object.entries(baseSnap.symbols || {}));
  const baseByBaseKey = new Map();
  for (const bSym of baseByStable.values()) {
    if (!baseByBaseKey.has(bSym.baseKey)) baseByBaseKey.set(bSym.baseKey, []);
    baseByBaseKey.get(bSym.baseKey).push(bSym);
  }
  const currByStable = new Map(Object.entries(currSnap.symbols || {}));

  const findBaseMatch = (cSym) => {
    if (baseByStable.has(cSym.stableKey)) return baseByStable.get(cSym.stableKey);
    const sameBase = baseByBaseKey.get(cSym.baseKey) || [];
    if (sameBase.length === 1) return sameBase[0];
    return null;
  };

  const matchedBaseKeys = new Set();
  const addedSymbols = [];
  const addedEntryPoints = [];
  const newlyAddedUnwired = [];
  const newlyOrphanedSymbols = [];
  const newlySeveredFromSink = [];

  const profile = currGraph.workspaceProfile || {
    projectMode: "hybrid",
    packageEntryFiles: new Set(),
    runtimeLanguages: new Set(),
    hasDynamicPluginLoading: false
  };

  // Check test callers so exported helpers added solely for unit tests aren't misclassified blindly
  const calledByTestIds = new Set();
  for (const sym of currGraph.symbolById.values()) {
    if (sym.zone !== "test") continue;
    for (const targetId of currGraph.outEdges.get(sym.id) || []) {
      calledByTestIds.add(targetId);
    }
  }

  for (const cSym of currByStable.values()) {
    if (cSym.zone !== "prod") continue;
    const bSym = findBaseMatch(cSym);
    if (!bSym) {
      addedSymbols.push(formatSnapSym(cSym));
      if (cSym.isEntrySource || cSym.exposure === "PROTOCOL_BRIDGE_INBOUND") {
        addedEntryPoints.push({
          symbol: formatSnapSym(cSym),
          exposure: cSym.exposure
        });
      }

      if (
        (cSym.kind === "function" || cSym.kind === "method") &&
        !cSym.isEntrySource &&
        cSym.exposure !== "PROTOCOL_BRIDGE_INBOUND" &&
        !cSym.isFeatureGated &&
        !cSym.isExtensionHook
      ) {
        const currGraphSym = currGraph.symbolById.get(cSym.id);
        const prodCallInCount = currGraphSym ? (currGraph.callInEdges.get(currGraphSym.id) || new Set()).size : 0;
        const hasTestCaller = currGraphSym ? calledByTestIds.has(currGraphSym.id) : false;

        if (!cSym.reachableFromRuntimeSource && prodCallInCount === 0 && !cSym.isReferencedInFile) {
          if (!cSym.isPublicApi) {
            newlyAddedUnwired.push({
              symbol: formatSnapSym(cSym),
              file: cSym.file,
              name: cSym.name,
              exposure: cSym.exposure,
              classification: "UNWIRED_NEW_PRIVATE_SYMBOL",
              verdict: "VIOLATED",
              evidenceStrength: "NO_STATIC_CALLER_EVIDENCE",
              diagnosis: `新增内部符号 "${cSym.name}" 无任何生产调用边或入口触发路径（写了却没接上）`
            });
          } else {
            const langHasRuntime = profile.runtimeLanguages?.has(cSym.lang);
            const isLibMode = cSym.projectMode === "library" && (!cSym.hasCargoBoundary || cSym.isPackageEntryExport);
            const isPkgEntry = Boolean(cSym.isPackageEntryExport);

            if (isLibMode || (isPkgEntry && cSym.projectMode !== "application")) {
              // Legitimate public library API surface — NOT a violation
            } else if (
              cSym.projectMode === "application" &&
              (langHasRuntime || profile.declaredApp) &&
              !profile.hasDynamicPluginLoading
            ) {
              newlyAddedUnwired.push({
                symbol: formatSnapSym(cSym),
                file: cSym.file,
                name: cSym.name,
                exposure: cSym.exposure,
                hasTestCaller,
                classification: "UNWIRED_NEW_EXPORT_IN_APP",
                verdict: "VIOLATED",
                evidenceStrength: "NO_APP_ENTRY_PATH",
                diagnosis: hasTestCaller
                  ? `应用工程新增导出函数 "${cSym.name}" 仅被测试调用，未接入任何真实生产入口（UI/IPC/路由/主循环）`
                  : `应用工程新增导出函数 "${cSym.name}" 在全仓无任何调用方且未连通真实入口（仅加 export 不代表在应用中已接入）`
              });
            } else if (!isPkgEntry && profile.packageEntryFiles?.size > 0 && !profile.hasDynamicPluginLoading) {
              newlyAddedUnwired.push({
                symbol: formatSnapSym(cSym),
                file: cSym.file,
                name: cSym.name,
                exposure: cSym.exposure,
                hasTestCaller,
                classification: "UNCONSUMED_INTERNAL_MODULE_EXPORT",
                verdict: langHasRuntime ? "VIOLATED" : "INCONCLUSIVE",
                evidenceStrength: "NO_STATIC_CALLER_EVIDENCE",
                diagnosis: `模块内部导出函数 "${cSym.name}" 未被仓内任何生产代码调用，也未通过包主入口对外重导出`
              });
            } else {
              newlyAddedUnwired.push({
                symbol: formatSnapSym(cSym),
                file: cSym.file,
                name: cSym.name,
                exposure: cSym.exposure,
                hasTestCaller,
                classification: "EXPORTED_WITHOUT_INTERNAL_CALLER",
                verdict: "INCONCLUSIVE",
                evidenceStrength: "NO_STATIC_CALLER_EVIDENCE",
                diagnosis: `新增导出符号 "${cSym.name}" 在仓内未发现生产调用方；若非供外部宿主/插件动态加载，请补齐真实入口接线`
              });
            }
          }
        }
      }
      continue;
    }

    matchedBaseKeys.add(bSym.stableKey);

    if (
      (cSym.kind === "function" || cSym.kind === "method") &&
      (bSym.reachableFromRuntimeSource || bSym.reachableFromSource) &&
      !cSym.reachableFromSource
    ) {
      markIfUntouched(cSym.file);
      newlyOrphanedSymbols.push({
        symbol: formatSnapSym(cSym),
        file: cSym.file,
        inUntouchedFile: !changedSourceFiles.has(cSym.file),
        diagnosis: `原有可达符号 "${cSym.name}" 在本次修改后失去上游水源连通，沦为孤立断流节点`
      });
    } else if (
      (cSym.kind === "function" || cSym.kind === "method") &&
      bSym.reachableFromRuntimeSource &&
      !cSym.reachableFromRuntimeSource &&
      cSym.projectMode === "application"
    ) {
      markIfUntouched(cSym.file);
      newlyOrphanedSymbols.push({
        symbol: formatSnapSym(cSym),
        file: cSym.file,
        inUntouchedFile: !changedSourceFiles.has(cSym.file),
        diagnosis: `符号 "${cSym.name}" 原先连通真实运行入口，本次修改后仅剩悬空导出，运行期入口链路已断开`
      });
    }

    if ((cSym.kind === "function" || cSym.kind === "method") && bSym.reachesSink && !cSym.reachesSink) {
      markIfUntouched(cSym.file);
      newlySeveredFromSink.push({
        symbol: formatSnapSym(cSym),
        file: cSym.file,
        inUntouchedFile: !changedSourceFiles.has(cSym.file),
        diagnosis: `符号 "${cSym.name}" 原先流向真实终端 Sink，本次修改后下游消费链路断裂`
      });
    }
    if (bSym.frameworkCallbackCandidates?.length && !cSym.frameworkCallbackCandidates?.length &&
        !cSym.possiblyReachableFromRuntimeSource && !newlyOrphanedSymbols.some(s => s.symbol === formatSnapSym(cSym))) {
      markIfUntouched(cSym.file);
      newlyOrphanedSymbols.push({ symbol: formatSnapSym(cSym), file: cSym.file,
        inUntouchedFile: !changedSourceFiles.has(cSym.file), classification: 'REMOVED_CALLBACK_REGISTRATION',
        evidence: bSym.frameworkCallbackCandidates.map(c => `${c.file}:${c.line}: ${c.reason}`),
        diagnosis: `原有框架回调引用 "${cSym.name}" 已删除，未发现替代生产连接；不证明此前运行时已执行` });
    }
  }

  const removedSymbols = [];
  for (const bSym of baseByStable.values()) {
    if (bSym.zone !== "prod") continue;
    if (!matchedBaseKeys.has(bSym.stableKey) && !currByStable.has(bSym.stableKey)) {
      removedSymbols.push(formatSnapSym(bSym));
    }
  }

  // Edge deltas (`REGISTRATION`, `BRANCH_DISPATCH`, `PROTOCOL_BRIDGE`, `SEQ_CALL`, `STATE_RW`)
  const edgeSig = (e) => `${e.fromKey}|${e.toKey}|${e.kind}|${e.stateField || ""}|${e.contract || ""}`;
  const baseEdgeMap = new Map((baseSnap.edges || []).map((e) => [edgeSig(e), e]));
  const currEdgeMap = new Map((currSnap.edges || []).map((e) => [edgeSig(e), e]));

  const addedEdges = [];
  for (const [sig, e] of currEdgeMap.entries()) {
    if (!baseEdgeMap.has(sig)) addedEdges.push(e);
  }

  const removedEdges = [];
  const newlyBrokenPaths = [];
  const canStillReach = (startSymId, targetSymId, maxDepth = 5) => {
    if (!startSymId || !targetSymId) return false;
    const visited = new Set([startSymId]);
    const queue = [{ id: startSymId, depth: 0 }];
    while (queue.length > 0) {
      const { id, depth } = queue.shift();
      if (id === targetSymId) return true;
      if (depth >= maxDepth) continue;
      for (const nextId of currGraph.outEdges.get(id) || []) {
        if (!visited.has(nextId)) {
          visited.add(nextId);
          queue.push({ id: nextId, depth: depth + 1 });
        }
      }
    }
    return false;
  };

  for (const [sig, e] of baseEdgeMap.entries()) {
    if (!currEdgeMap.has(sig)) {
      removedEdges.push(e);
      const fromStillExists = currByStable.get(e.fromKey);
      const toStillExists = currByStable.get(e.toKey);
      // A registration is a structural contract even when execution of its
      // callback was never proven. Losing its last runtime-connected candidate
      // must be visible in an incremental scan, without upgrading the baseline
      // callback to an executed call.
      if (e.kind === 'REGISTRATION' && e.confidence !== 'AMBIGUOUS' &&
          ['RUST_CALLBACK_REFERENCE', 'VUE_TEMPLATE_EVENT', 'REACT_LIFECYCLE'].includes(e.resolutionMode) &&
          baseByStable.get(e.fromKey)?.possiblyReachableFromRuntimeSource && toStillExists?.zone === 'prod' &&
          !toStillExists.possiblyReachableFromRuntimeSource &&
          !newlyOrphanedSymbols.some(item => item.symbol === formatSnapSym(toStillExists))) {
        markIfUntouched(toStillExists.file);
        newlyOrphanedSymbols.push({ symbol: formatSnapSym(toStillExists), file: toStillExists.file,
          inUntouchedFile: !changedSourceFiles.has(toStillExists.file), classification: 'REMOVED_CALLBACK_REGISTRATION',
          evidence: [`${e.file}:${e.line}: ${e.reason}`],
          diagnosis: `原有回调注册 "${toStillExists.name}" 已删除，未发现其他生产入口注册或调用；该结论只证明注册连接丢失，不证明回调曾执行` });
      }
      if (
        fromStillExists &&
        toStillExists &&
        !canStillReach(fromStillExists.id, toStillExists.id) &&
        (e.kind === "REGISTRATION" ||
          e.kind === "BRANCH_DISPATCH" ||
          e.kind === "PROTOCOL_BRIDGE" ||
          (!toStillExists.reachableFromRuntimeSource && (baseByStable.get(e.toKey)?.reachableFromRuntimeSource || false)))
      ) {
        markIfUntouched(toStillExists.file);
        newlyBrokenPaths.push({
          kind: e.kind,
          from: formatSnapSym(fromStillExists),
          to: formatSnapSym(toStillExists),
          reason: `原有 ${e.kind} 路径已彻底断开 (${e.reason || sig})，且未建立新的中转连接`
        });
      }
    }
  }

  // State ownership deltas (catches untouched-file writers turned into dead ends, AND readers left reading a state whose writers were refactored away!)
  const newlyWriteOnlyStates = [];
  const newlyWriterlessStateReads = [];
  const seenWriterlessKeys = new Set();

  for (const [stKey, baseSt] of Object.entries(baseSnap.states || {})) {
    if (!baseSt.writers?.length || !baseSt.readers?.length) continue;
    const currSt = currSnap.states?.[stKey];
    if (!currSt || currSt.writers.length === 0) {
      const lingeringReaders = [];
      for (const rKey of baseSt.readers) {
        const cReader = currByStable.get(rKey);
        if (!cReader || cReader.zone !== "prod") continue;
        const rFileObj = currGraph.fileByPath.get(cReader.file);
        const stillReads =
          (cReader.reads || []).includes(baseSt.field) ||
          (rFileObj?.memberReads || []).includes(baseSt.field);
        if (stillReads) {
          lingeringReaders.push(cReader);
        }
      }
      if (lingeringReaders.length > 0) {
        seenWriterlessKeys.add(stKey);
        for (const rSym of lingeringReaders) markIfUntouched(rSym.file);
        newlyWriterlessStateReads.push({
          field: baseSt.field,
          qualifiedField: baseSt.qualifiedField || stKey,
          readers: lingeringReaders.map(formatSnapSym),
          formerWriters: baseSt.writers.map((k) => baseByStable.get(k)).filter(Boolean).map(formatSnapSym),
          diagnosis: `状态 "${baseSt.qualifiedField || stKey}" 的原有写入方已被移除或改写新字段，但消费者 [${lingeringReaders.map((r) => `${r.file}:${r.name}`).join(", ")}] 仍在读取该旧字段`
        });
      }
    }
  }

  for (const [stKey, currSt] of Object.entries(currSnap.states || {})) {
    const baseSt = baseSnap.states?.[stKey];
    if (currSt.writers.length === 0 && currSt.readers.length > 0) {
      const hadWritersBefore = Boolean(baseSt && baseSt.writers && baseSt.writers.length > 0);
      if (hadWritersBefore && !seenWriterlessKeys.has(stKey)) {
        const readerSyms = currSt.readers.map((k) => currByStable.get(k)).filter(Boolean);
        for (const rSym of readerSyms) markIfUntouched(rSym.file);
        newlyWriterlessStateReads.push({
          field: currSt.field,
          qualifiedField: currSt.qualifiedField,
          readers: readerSyms.map(formatSnapSym),
          formerWriters: baseSt.writers.map((k) => baseByStable.get(k)).filter(Boolean).map(formatSnapSym),
          diagnosis: `状态 "${currSt.qualifiedField}" 的原有写入方已被移除或改写新字段，但消费者 [${readerSyms.map((r) => `${r.file}:${r.name}`).join(", ")}] 仍在读取该旧字段`
        });
      }
      continue;
    }
    if (currSt.writers.length === 0 || currSt.readers.length > 0) continue;
    if (/^(Instance|Log|Logger|Enabled|Visible)$/i.test(currSt.field)) continue;
    const hadReadersBefore = Boolean(baseSt && baseSt.readers && baseSt.readers.length > 0);
    const isBrandNewState = !baseSt || (baseSt.writers || []).length === 0;

    if (hadReadersBefore || isBrandNewState) {
      const writerSyms = currSt.writers.map((k) => currByStable.get(k)).filter(Boolean);
      for (const wSym of writerSyms) {
        markIfUntouched(wSym.file);
      }
      const isTelemetry = isTelemetryOrAuditField(currSt.field);
      newlyWriteOnlyStates.push({
        field: currSt.field,
        qualifiedField: currSt.qualifiedField,
        writers: writerSyms.map(formatSnapSym),
        formerReaders: hadReadersBefore
          ? baseSt.readers.map((k) => baseByStable.get(k)).filter(Boolean).map(formatSnapSym)
          : [],
        cause: hadReadersBefore ? "READER_REMOVED_OR_REDIRECTED" : "NEW_WRITE_WITHOUT_READER",
        verdict: isTelemetry ? "INCONCLUSIVE" : "VIOLATED",
        writersInUntouchedFiles: writerSyms
          .filter((w) => !changedSourceFiles.has(w.file))
          .map((w) => w.file),
        diagnosis: hadReadersBefore
          ? `状态 "${currSt.qualifiedField}" 原有的读取消费者已被移除或改道，导致 ${writerSyms.map((w) => `${w.file}:${w.name}`).join(", ")} 中的写入变成死水终点`
          : isTelemetry
            ? `新增遥测/审计类字段 "${currSt.qualifiedField}" 仅见写入未见仓内读取（若由外部采集器消费属正常，否则需核实）`
            : `新增状态 "${currSt.qualifiedField}" 存在写入但全仓无任何读取消费者`
      });
    }
  }

  // Bridge deltas (`newlyBrokenBridges` vs `preExistingBrokenBridges` + `bridgePayloadDiffs`)
  const bridgeKey = (b) => `${b.kind}|${b.contract}|${b.fromFile}`;
  const baseBridgesByKey = new Map((baseSnap.bridges || []).map((b) => [bridgeKey(b), b]));

  const newlyBrokenBridges = [];
  const preExistingBrokenBridges = [];
  const bridgePayloadDiffs = [];

  for (const b of currGraph.crossBridges || []) {
    const bKey = bridgeKey(b);
    const prevB = baseBridgesByKey.get(bKey);
    if (b.status !== "CONNECTED") {
      const wasBrokenBefore = Boolean(prevB && prevB.status !== "CONNECTED");
      const touchedCaller = changedSourceFiles.has(b.fromFile);
      if (!wasBrokenBefore || touchedCaller) {
        if (!changedSourceFiles.has(b.fromFile)) markIfUntouched(b.fromFile);
        newlyBrokenBridges.push(b);
      } else {
        preExistingBrokenBridges.push(b);
      }
    } else if ((b.payloadFields || []).length > 0) {
      const prevPayload = new Set(prevB?.payloadFields || []);
      const addedPayloadFields = prevB
        ? b.payloadFields.filter((f) => !prevPayload.has(f))
        : changedSourceFiles.has(b.fromFile)
          ? [...b.payloadFields]
          : [];

      if (addedPayloadFields.length > 0 && b.toFile) {
        const targetLeaf = b.toSymbol?.split(".").pop() || b.toSymbol;
        const targetCandidates = (currGraph.symbolsByName.get(targetLeaf) || []).filter((s) => s.file === b.toFile);
        const targetSym = targetCandidates[0] || null;
        const targetFileObj = currGraph.fileByPath.get(b.toFile);

        if (targetSym) {
          const toNorm = (x) => x.replace(/_([a-z])/g, (_, c) => c.toUpperCase()).toLowerCase();
          const acceptedTokens = new Set();
          for (const p of targetSym.params || []) acceptedTokens.add(toNorm(p));
          for (const r of targetSym.reads || []) acceptedTokens.add(toNorm(r));
          for (const mr of targetFileObj?.memberReads || []) acceptedTokens.add(toNorm(mr));
          let bodySource = targetSym.snippet || "";
          if (currGraph.workspaceRoot) {
            const fullTargetPath = path.join(currGraph.workspaceRoot, b.toFile);
            if (fs.existsSync(fullTargetPath)) {
              try {
                bodySource = fs.readFileSync(fullTargetPath, "utf8");
              } catch {
                bodySource = targetSym.snippet || "";
              }
            }
          }
          const bodyTokens = bodySource.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
          for (const idTok of bodyTokens) acceptedTokens.add(toNorm(idTok));

          const unconsumedFields = addedPayloadFields.filter((fld) => !acceptedTokens.has(toNorm(fld)));
          if (unconsumedFields.length > 0) {
            markIfUntouched(b.toFile);
            bridgePayloadDiffs.push({
              kind: b.kind,
              contract: b.contract,
              from: `${b.fromFile}:${b.fromLine || 1} (${b.fromSymbol})`,
              to: `${b.toFile}:${b.toLine || targetSym.startLine} (${b.toSymbol})`,
              addedPayloadFields,
              unconsumedByBackend: unconsumedFields,
              diagnosis: `跨端协议字段漂移：调用端在桥接 "${b.contract}" 中新增了字段 [${unconsumedFields.join(", ")}]，但对端处理器 ${b.toFile}:${targetSym.name} 未接收或读取这些新字段（可能仍在读旧字段）`
            });
          }
        }
      }
    }
  }

  // Field-level persistence asymmetries introduced in this change
  const baseAsymSet = new Set(
    (baseSnap.fieldLifecycleAsymmetries || []).map((a) => `${a.kind}|${a.qualifiedField}`)
  );
  const newlyIntroducedLifecycleAsymmetries = (currGraph.fieldLifecycleAsymmetries || []).filter(
    (a) =>
      !baseAsymSet.has(`${a.kind}|${a.qualifiedField}`) ||
      (a.files || []).some((f) => changedSourceFiles.has(f))
  );
  for (const asym of newlyIntroducedLifecycleAsymmetries) {
    for (const f of asym.files || []) markIfUntouched(f);
  }

  return {
    baselineSource: baseSnap.source,
    baseRef: baseSnap.baseRef,
    baseCommit: baseSnap.headCommit || null,
    changedSourceFiles: Array.from(changedSourceFiles),
    deletedSourceFiles: Array.from(deletedSourceFiles),
    impactedUntouchedFiles: Array.from(impactedUntouchedFiles),
    addedSymbols: addedSymbols.slice(0, 30),
    removedSymbols: removedSymbols.slice(0, 30),
    addedEntryPoints,
    addedEdgesCount: addedEdges.length,
    removedEdgesCount: removedEdges.length,
    newlyAddedUnwired,
    newlyBrokenPaths,
    newlyOrphanedSymbols,
    newlySeveredFromSink,
    newlyWriteOnlyStates,
    newlyWriterlessStateReads,
    newlyBrokenBridges,
    preExistingBrokenBridges,
    bridgePayloadDiffs,
    newlyIntroducedLifecycleAsymmetries
  };
}
