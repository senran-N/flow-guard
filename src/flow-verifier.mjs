import path from "node:path";
import { buildWorkspaceFlowGraph, getGitWorkingTreeStatus } from "./graph-builder.mjs";
import {
  resolveBaselineForVerification,
  computeFlowGraphDiff,
  isTelemetryOrAuditField
} from "./graph-diff.mjs";
import { evaluateWiringContracts, clearActiveWiringPlan } from "./wiring-contract.mjs";
import { jaccardSimilarity } from "./fingerprint.mjs";
import { EXT_LANG } from "./lang-presets.mjs";

export function shortId(sym) {
  const label = sym.parentContainerName ? `${sym.parentContainerName}.${sym.name}` : sym.name;
  return `${sym.file}:${sym.startLine}-${sym.endLine} (${label})`;
}

export function verifyWorkspaceFlow(workspaceRoot, options = {}) {
  if (options.clearPlan) {
    clearActiveWiringPlan(workspaceRoot);
  }

  const fullScan = Boolean(options.fullScan) && !options.baseRef;
  const graph = buildWorkspaceFlowGraph(workspaceRoot, true, {
    projectMode: options.projectMode || "auto"
  });
  const gitStatus = getGitWorkingTreeStatus(workspaceRoot);
  const baselineBundle = resolveBaselineForVerification(workspaceRoot, graph, gitStatus, {
    ...options,
    fullScan
  });

  const rawChangedFiles = baselineBundle ? baselineBundle.changedFiles : gitStatus.changedFiles;
  const rawDeletedFiles = baselineBundle ? baselineBundle.deletedFiles : gitStatus.deletedFiles || [];
  const changedFiles = new Set(
    rawChangedFiles.filter((f) => Boolean(EXT_LANG[path.extname(f).toLowerCase()]))
  );
  const deletedSourceFiles = new Set(
    rawDeletedFiles.filter((f) => Boolean(EXT_LANG[path.extname(f).toLowerCase()]))
  );

  const hasAnyRepoChanges =
    Boolean(options.baseRef && baselineBundle) ||
    (gitStatus.isGitRepo && (rawChangedFiles.length > 0 || rawDeletedFiles.length > 0)) ||
    Boolean(baselineBundle && (rawChangedFiles.length > 0 || rawDeletedFiles.length > 0));

  const isFullScan = fullScan || !hasAnyRepoChanges;
  const isNonSourceDiffOnly =
    !isFullScan && !options.baseRef && changedFiles.size === 0 && deletedSourceFiles.size === 0;
  const scanMode = isFullScan
    ? "FULL_WORKSPACE"
    : isNonSourceDiffOnly
      ? "NON_SOURCE_DIFF_ONLY"
      : "INCREMENTAL_GIT_DIFF";

  const flowDiff =
    !isFullScan && !isNonSourceDiffOnly && baselineBundle?.snapshot
      ? computeFlowGraphDiff(baselineBundle.snapshot, graph, {
          changedFiles: Array.from(changedFiles),
          deletedFiles: Array.from(deletedSourceFiles)
        })
      : null;

  // Scope includes both directly edited files AND untouched files impacted by broken graph edges / state readers
  const impactedFiles = new Set([
    ...changedFiles,
    ...(flowDiff?.impactedUntouchedFiles || [])
  ]);

  // 1. Cross-Boundary Bridge Integrity (distinguishing newly broken vs pre-existing when baseline diff is active)
  const allBrokenBridges = graph.crossBridges.filter((b) => b.status !== "CONNECTED");
  const brokenBridges = isNonSourceDiffOnly
    ? []
    : flowDiff
      ? flowDiff.newlyBrokenBridges
      : allBrokenBridges;

  // 2. Sandbox / Test Reverse Dependency Leaks
  const sandboxViolations = [];
  if (!isNonSourceDiffOnly) {
    for (const sym of graph.symbolById.values()) {
      if (sym.zone !== "prod") continue;
      if (!isFullScan && !impactedFiles.has(sym.file)) continue;
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
  }

  // 3. Write-Only Dead-End States (including untouched-file writers whose sole reader was deleted in this diff!)
  const writeOnlyStates = [];
  const newlyWriteOnlyKeys = new Set((flowDiff?.newlyWriteOnlyStates || []).map((s) => s.qualifiedField));
  if (!isNonSourceDiffOnly) {
    for (const own of graph.stateOwnership.values()) {
      const rawField = own.field;
      const qualKey = own.qualifiedField || rawField;
      if (
        own.writers.length > 0 &&
        own.readers.length === 0 &&
        !/^(Instance|Log|Logger|Enabled|Visible)$/i.test(rawField) &&
        !isTelemetryOrAuditField(rawField)
      ) {
        const writerSyms = own.writers.map((id) => graph.symbolById.get(id)).filter(Boolean);
        if (
          isFullScan ||
          newlyWriteOnlyKeys.has(qualKey) ||
          writerSyms.some((s) => changedFiles.has(s.file))
        ) {
          writeOnlyStates.push({
            field: rawField,
            qualifiedField: qualKey,
            writers: writerSyms.map(shortId)
          });
        }
      }
    }
  }

  // 4. Unwired / Dead Pipes + Unwired Application Exports + Data-Flow Drops + Intentional Reserved Contracts
  const unwiredSymbols = [];
  const unwiredExports = [];
  const dataFlowBreaks = [];
  const reservedContracts = [];
  const newlyOrphanedFileSyms = new Set((flowDiff?.newlyOrphanedSymbols || []).map((o) => o.symbol));

  for (const sym of graph.symbolById.values()) {
    if (sym.zone !== "prod") continue;
    const symShort = shortId(sym);
    const inScope = isFullScan ? true : changedFiles.has(sym.file) || newlyOrphanedFileSyms.has(symShort);
    if (!inScope) continue;

    if (sym.reservedParams && sym.reservedParams.length > 0) {
      reservedContracts.push({
        symbol: symShort,
        kind: "RESERVED_PARAM_SIGNATURE",
        reservedParams: sym.reservedParams,
        verdict: "KEEP_SIGNATURE_DO_NOT_BREAK"
      });
    }

    // 4a. Zero-Inflow Unwired Symbol (distinguishes CONFIRMED_SAFE_TO_DELETE private dead pipes from NO_STATIC_CALLER_EVIDENCE unwired exports)
    if (
      (sym.kind === "function" || sym.kind === "method") &&
      !sym.roles.includes("source") &&
      !sym.isReferencedInFile
    ) {
      const callInDeg = (graph.callInEdges.get(sym.id) || new Set()).size;
      if (callInDeg === 0 && !graph.reachableFromSource.has(sym.id)) {
        if (sym.isFeatureGated || sym.isExtensionHook) {
          reservedContracts.push({
            symbol: symShort,
            kind: sym.isFeatureGated ? "FEATURE_GATED_OR_ALLOWED_DEAD" : "EXTENSION_HOOK_RESERVE",
            verdict: "RESERVED_DO_NOT_BLINDLY_DELETE"
          });
        } else if (!sym.isPublicApi) {
          unwiredSymbols.push({
            symbol: symShort,
            exposure: sym.exposure || "PRIVATE_INTERNAL",
            evidenceStrength: "CONFIRMED_SAFE_TO_DELETE",
            verdict: "SAFE_TO_DELETE_OR_WIRE"
          });
        } else if (!sym.isConstructor && !graph.workspaceProfile?.hasDynamicPluginLoading) {
          unwiredExports.push({
            symbol: symShort,
            name: sym.name,
            file: sym.file,
            exposure: sym.exposure || "INTERNAL_MODULE_EXPORT",
            evidenceStrength: "NO_STATIC_CALLER_EVIDENCE",
            verdict: "UNWIRED_EXPORT_NEEDS_ENTRY",
            diagnosis: `导出函数 "${sym.name}" 在应用工程中未连通任何真实入口（应用新功能不能仅凭 export 视为已接入；删除前请确认无外部反射调用）`
          });
        }
      }
    }

    // Skip dataFlowBreaks on untouched files unless fullScan
    if (!isFullScan && !changedFiles.has(sym.file)) continue;

    // 4b. Dead Input Parameters (Parameter received but never read in function body)
    const nonFrameworkUnusedParams = sym.isEntrySource
      ? sym.unusedParams.filter(
          (p) =>
            !/^(?:req|request|res|response|next|ctx|context|event|evt|e|err|error|argc|argv|sender|args|app|window|state)$/i.test(
              p
            )
        )
      : sym.unusedParams;
    if (
      nonFrameworkUnusedParams.length > 0 &&
      sym.name !== "main" &&
      !/^(Prefix|Postfix|Transpiler|Finalizer)$/.test(sym.name)
    ) {
      dataFlowBreaks.push({
        kind: "DEAD_INPUT_PARAM",
        location: symShort,
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
      if (!bare.qualifier && (sym.params.includes(bare.callee) || (sym.localVars || []).includes(bare.callee))) {
        continue;
      }
      const symOutEdges = graph.outEdges.get(sym.id) || new Set();
      const candidates = (graph.symbolsByName.get(bare.callee) || []).filter(
        (t) =>
          t.zone === "prod" &&
          symOutEdges.has(t.id) &&
          (t.lang === sym.lang ||
            (sym.lang === "vue" && t.lang === "ts") ||
            (sym.lang === "ts" && t.lang === "vue") ||
            (sym.lang === "java" && t.lang === "kotlin") ||
            (sym.lang === "kotlin" && t.lang === "java"))
      );
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

  // 5. Asymmetric Paired Updates in Changed Files + Field-Level Save/Load Asymmetries
  const asymmetricWarnings = [];
  for (const relFile of isFullScan ? Array.from(graph.fileByPath.keys()) : Array.from(changedFiles)) {
    const fObj = graph.fileByPath.get(relFile);
    if (!fObj || fObj.zone !== "prod") continue;
    if (!isFullScan) {
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
  }
  const relevantFieldAsyms = flowDiff
    ? flowDiff.newlyIntroducedLifecycleAsymmetries || []
    : (graph.fieldLifecycleAsymmetries || []).filter(
        (a) => isFullScan || (a.files || []).some((f) => changedFiles.has(f))
      );
  for (const fa of relevantFieldAsyms) {
    asymmetricWarnings.push({
      file: (fa.files || [])[0] || "",
      group: "Save/Load (Field Recovery)",
      field: fa.qualifiedField,
      kind: fa.kind,
      diagnosis: fa.diagnosis
    });
  }

  // 6. Structural Clone Sprawl Detection (normalized lexical shingle Jaccard)
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
        if (sim >= 0.85) {
          clones.push({
            funcA: shortId(a),
            funcB: shortId(b),
            similarity: `${Math.round(sim * 100)}%`,
            method: "LEXICAL_SHINGLE_JACCARD"
          });
        }
      }
    }
  }

  // 7. Task-Oriented Tri-State Wiring Contract Evaluation (`SATISFIED` / `VIOLATED` / `INCONCLUSIVE`)
  const contractEval = isNonSourceDiffOnly
    ? {
        verificationVerdict: "SATISFIED",
        headlineSummary: "本次仅变更非源码文件，跳过代码链路契约验收。",
        wiringReport: {
          planId: null,
          source: "NON_SOURCE_DIFF_ONLY",
          causalPipelineGoal: null,
          ambiguitiesToConfirm: [],
          counts: { total: 0, satisfied: 0, violated: 0, inconclusive: 0 },
          obligations: []
        }
      }
    : evaluateWiringContracts(graph, flowDiff, workspaceRoot, {
        ...options,
        fullScan: isFullScan,
        changedFiles: isFullScan ? [] : Array.from(changedFiles)
      });

  // In full-workspace scan without git diff, also surface `unwiredExports` in application mode as VIOLATED obligations!
  if (isFullScan && unwiredExports.length > 0) {
    const existingLocs = new Set(contractEval.wiringReport.obligations.map((o) => o.targetLocation));
    for (const ue of unwiredExports) {
      if (!existingLocs.has(ue.symbol)) {
        contractEval.wiringReport.obligations.push({
          id: `AUTO-EXP-${contractEval.wiringReport.obligations.length + 1}`,
          station: "ENTRY_WIRING",
          layer: "L1_STRUCTURAL",
          required: true,
          targetLocation: ue.symbol,
          reason: "应用工程中的新增或导出功能必须连通真实运行入口，不能仅因带有 export 就视为已接入",
          expectedRelation: `建立从真实入口（UI/IPC/路由/主循环）到 ${ue.name} 的调用连接`,
          sourceBasis: `项目模式识别: ${graph.workspaceProfile?.projectMode}`,
          status: "VIOLATED",
          evidence: [ue.symbol],
          finding: `违反：${ue.diagnosis}`,
          remediation: `请将 "${ue.name}" 接入真实上游入口；若该函数应作为公共 SDK 导出，请通过包主入口模块暴露或声明库导出配置。`
        });
      }
    }
    const obls = contractEval.wiringReport.obligations;
    contractEval.wiringReport.counts = {
      total: obls.length,
      satisfied: obls.filter((o) => o.status === "SATISFIED").length,
      violated: obls.filter((o) => o.status === "VIOLATED").length,
      inconclusive: obls.filter((o) => o.status === "INCONCLUSIVE").length
    };
    contractEval.verificationVerdict =
      contractEval.wiringReport.counts.violated > 0
        ? "VIOLATED"
        : contractEval.wiringReport.counts.inconclusive > 0
          ? "INCONCLUSIVE"
          : "SATISFIED";
    const c = contractEval.wiringReport.counts;
    contractEval.headlineSummary = [
      `本次 ${c.total} 项接入要求：${c.satisfied} 项满足，${c.violated} 项违反，${c.inconclusive} 项待确认。`,
      ...obls
        .filter((o) => o.status === "VIOLATED")
        .slice(0, 3)
        .map((o) => o.finding)
    ].join(" ");
  }

  const isBlockingBreak = (d) => d.kind === "DEAD_LOCAL_ASSIGNMENT" || d.kind === "IGNORED_PURE_CALL";
  dataFlowBreaks.sort((a, b) => Number(isBlockingBreak(b)) - Number(isBlockingBreak(a)));

  const antiPatterns = baselineBundle ? baselineBundle.addedAntiPatterns : gitStatus.addedAntiPatterns;
  const violatedRequiredObligationsCount = contractEval.wiringReport.obligations.filter(
    (o) => o.status === "VIOLATED" && o.required !== false
  ).length;

  const blockingCount =
    brokenBridges.length +
    sandboxViolations.length +
    antiPatterns.length +
    dataFlowBreaks.filter(isBlockingBreak).length +
    violatedRequiredObligationsCount;

  const finalVerdict =
    blockingCount > 0 || contractEval.verificationVerdict === "VIOLATED"
      ? "VIOLATED"
      : contractEval.verificationVerdict === "INCONCLUSIVE"
        ? "INCONCLUSIVE"
        : "SATISFIED";

  return {
    status: blockingCount === 0 ? "PASS" : "ISSUES_FOUND",
    verificationVerdict: finalVerdict,
    headlineSummary: contractEval.headlineSummary,
    scanMode,
    workspaceProfile: {
      projectMode: graph.workspaceProfile?.projectMode || "hybrid",
      manifestKind: graph.workspaceProfile?.manifestKind || null
    },
    changedFilesScanned: Array.from(changedFiles),
    impactedUntouchedFiles: flowDiff ? flowDiff.impactedUntouchedFiles : [],
    wiringReport: contractEval.wiringReport,
    flowDiff,
    summary: {
      obligationsTotal: contractEval.wiringReport.counts.total,
      obligationsSatisfied: contractEval.wiringReport.counts.satisfied,
      obligationsViolated: contractEval.wiringReport.counts.violated,
      obligationsInconclusive: contractEval.wiringReport.counts.inconclusive,
      brokenCrossLanguageBridges: brokenBridges.length,
      preExistingBrokenBridgesCount: flowDiff ? flowDiff.preExistingBrokenBridges.length : 0,
      sandboxReverseDependencyLeaks: sandboxViolations.length,
      unwiredOrDeadPipesCount: unwiredSymbols.length,
      unwiredExportsCount: unwiredExports.length,
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
    unwiredExports: unwiredExports.slice(0, 20),
    reservedContracts: reservedContracts.slice(0, 20),
    writeOnlyDeadEndStates: writeOnlyStates.slice(0, 15),
    asymmetricLifecycleWarnings: asymmetricWarnings.slice(0, 10),
    structuralClones: clones.slice(0, 10),
    antiPatterns: antiPatterns.slice(0, 10)
  };
}
