import path from "node:path";
import { resolveStateScope } from "./state-store.mjs";
import { buildWorkspaceFlowGraph, getGitWorkingTreeStatus, GRAPH_CONFIG_FILES } from "./graph-builder.mjs";
import {
  resolveBaselineForVerification,
  computeFlowGraphDiff,
  isTelemetryOrAuditField
} from "./graph-diff.mjs";
import { evaluateWiringContracts, clearActiveWiringPlan, summarizeObligations, bridgeDiagnosticKey } from "./wiring-contract.mjs";
import { forEachSimilarShinglePair } from "./similarity-index.mjs";
import { EXT_LANG } from "./lang-presets.mjs";

export function shortId(sym) {
  const label = sym.parentContainerName ? `${sym.parentContainerName}.${sym.name}` : sym.name;
  return `${sym.file}:${sym.startLine}-${sym.endLine} (${label})`;
}

export function verifyWorkspaceFlow(workspaceRoot, options = {}) {
  if (options.rustSemantic && (!options.fullScan || options.baseRef)) {
    throw new TypeError('rustSemantic requires fullScan:true without baseRef; semantic results apply only to the current checkout');
  }
  if (options.allowInconclusive !== undefined && typeof options.allowInconclusive !== "boolean") {
    throw new TypeError("allowInconclusive must be a boolean when provided");
  }
  options = { ...options, stateDiagnostics: [] };
  if (options.clearPlan) {
    clearActiveWiringPlan(workspaceRoot, options);
  }

  const fullScan = Boolean(options.fullScan) && !options.baseRef;
  const graph = buildWorkspaceFlowGraph(workspaceRoot, true, {
    ...options,
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

  const configurationFiles = new Set((graph.configurationFiles || []).map((file) => path.resolve(file)));
  const hasConfigurationChange = [...rawChangedFiles, ...rawDeletedFiles].some((file) =>
    GRAPH_CONFIG_FILES.has(path.basename(file)) || configurationFiles.has(path.resolve(workspaceRoot, file)));
  // Git source reconstruction does not restore historical resolver configuration.
  // Recheck the entire current graph instead of comparing two graphs resolved
  // against the same current config or skipping a config-only edit altogether.
  const isFullScan = fullScan || hasConfigurationChange || (!baselineBundle && !hasAnyRepoChanges);
  const isNonSourceDiffOnly =
    !isFullScan && !options.baseRef && baselineBundle?.snapshot?.source !== "SESSION_SNAPSHOT"
    && changedFiles.size === 0 && deletedSourceFiles.size === 0 && !hasConfigurationChange;
  const scanMode = isFullScan
    ? "FULL_WORKSPACE"
    : isNonSourceDiffOnly
      ? "NON_SOURCE_DIFF_ONLY"
      : baselineBundle?.snapshot?.source === "SESSION_SNAPSHOT" ? "INCREMENTAL_SESSION_DIFF" : "INCREMENTAL_GIT_DIFF";

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
  const sandboxCandidates = [];
  if (!isNonSourceDiffOnly) {
    for (const sym of graph.symbolById.values()) {
      if (sym.zone !== "prod") continue;
      if (!isFullScan && !impactedFiles.has(sym.file)) continue;
      for (const calleeId of graph.outEdges.get(sym.id) || []) {
        const target = graph.symbolById.get(calleeId);
        if (target && target.zone !== "prod") {
          const edges = (graph.outEdgeDetails.get(sym.id) || []).filter((edge) => edge.toId === calleeId);
          const uncertainRust = sym.lang === "rust" && edges.length > 0 && edges.every((edge) =>
            ["RUST_CONDITIONAL_PATH", "RUST_CALLBACK_REFERENCE", 'RUST_COMPILER_TRAIT_CANDIDATE', 'RUST_COMPILER_REFERENCE'].includes(edge.resolution?.mode) && edge.resolution?.confidence !== "HIGH");
          (uncertainRust ? sandboxCandidates : sandboxViolations).push({
            prodCaller: shortId(sym),
            illegalTarget: shortId(target),
            targetZone: target.zone,
            ...(uncertainRust ? { evidence: edges.map((edge) => `${edge.evidence.file}:${edge.evidence.line}: ${edge.resolution.mode}`) } : {})
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
  const unresolvedEntryPaths = [];
  const dataFlowBreaks = [];
  const reservedContracts = [];
  const newlyOrphanedFileSyms = new Set((flowDiff?.newlyOrphanedSymbols || []).map((o) => o.symbol));

  for (const sym of graph.symbolById.values()) {
    if (sym.zone !== "prod") continue;
    const symShort = shortId(sym);
    const inScope = isFullScan ? true : changedFiles.has(sym.file) || newlyOrphanedFileSyms.has(symShort);
    if (!inScope) continue;
    let rustEntryUncertain = false;
    if (sym.frameworkCallbackCandidates?.length && !graph.reachableFromSource.has(sym.id)) {
      unresolvedEntryPaths.push({ symbol: symShort, name: sym.name,
        finding: `待确认：${sym.name} 有框架或宏回调引用，尚未证明运行时执行`,
        evidence: sym.frameworkCallbackCandidates.map(c => `${c.file}:${c.line}: ${c.reason}`) });
      rustEntryUncertain = true;
    }
    // Cargo does not select a cfg feature/target in this analyzer. A bare-pub
    // symbol beneath such a Rust cfg module cannot be classified as an
    // unwired application export. Keep it out of runtime/source reachability,
    // but surface the unselected compilation condition as explicit ENTRY
    // WIRING uncertainty rather than a deletion/wiring violation.
    if (
      sym.lang === "rust" &&
      sym.isConditionalCompilation &&
      sym.hasCargoBoundary &&
      sym.isPublicApi &&
      (sym.kind === "function" || sym.kind === "method") &&
      !graph.reachableFromSource.has(sym.id)
    ) {
      unresolvedEntryPaths.push({
        symbol: symShort,
        name: sym.name,
        finding: `待确认：${sym.name} 是受 Rust cfg 条件控制的符号；未选择 feature/target 时无法证明其入口连通性`,
        evidence: [`${sym.file}:${sym.startLine}: Rust cfg 条件未选择`]
      });
      rustEntryUncertain = true;
    }
    if ((sym.kind === "function" || sym.kind === "method") && !graph.reachableFromSource.has(sym.id)) {
      const candidateEdges = (graph.inEdgeDetails.get(sym.id) || []).filter((edge) =>
        ["ANONYMOUS_OBJECT_ARGUMENT", "DYNAMIC_COMPONENT_SELECTION", "REACT_LIFECYCLE", "VUE_TEMPLATE_EVENT", "RUST_CALLBACK_REFERENCE"].includes(edge.resolution?.mode));
      if (candidateEdges.length && (graph.possiblyReachableFromSource.has(sym.id) ||
          candidateEdges.some((edge) => edge.resolution?.mode === "VUE_TEMPLATE_EVENT"))) unresolvedEntryPaths.push({ symbol: symShort, name: sym.name,
        finding: candidateEdges.some((edge) => edge.resolution?.mode === "REACT_LIFECYCLE")
          ? `待确认：${sym.name} 属于 React 生命周期回调，是否执行取决于挂载、更新或卸载等运行条件`
          : candidateEdges.some((edge) => edge.resolution?.mode === "RUST_CALLBACK_REFERENCE")
            ? `待确认：${sym.name} 作为 Rust 函数参数传递，实际调用取决于接收函数的运行行为`
          : candidateEdges.some((edge) => edge.resolution?.mode === "VUE_TEMPLATE_EVENT")
            ? `待确认：${sym.name} 由 Vue 模板事件注册，是否执行取决于用户交互或运行时条件`
            : undefined,
        evidence: candidateEdges.map((edge) => `${edge.evidence.file}:${edge.evidence.line}: ${edge.evidence.reason}`) });
      if (sym.lang === "rust" && candidateEdges.some((edge) => edge.resolution?.mode === "RUST_CALLBACK_REFERENCE") && graph.possiblyReachableFromSource.has(sym.id)) rustEntryUncertain = true;
    }

    // An unresolved Rust receiver/type chain records lexical candidates only;
    // no edge is added, so it cannot prove reachability or satisfy a wiring
    // blueprint. Avoid turning the same uncertainty into an AUTO-EXP
    // violation for a public method: report it as ENTRY_WIRING instead.
    if (
      sym.lang === "rust" &&
      sym.isPublicApi &&
      Array.isArray(sym.rustReceiverCandidates) &&
      sym.rustReceiverCandidates.length > 0
    ) {
      if (!rustEntryUncertain) unresolvedEntryPaths.push({
        symbol: symShort,
        name: sym.name,
        finding: `待确认：${sym.name} 仅被未解析 Rust receiver/type 链候选命中，尚无可证明调用边`,
        evidence: sym.rustReceiverCandidates.map((candidate) =>
          `${candidate.file}:${candidate.line}: ${candidate.reason || "未解析 Rust receiver/type 链候选"}`
        )
      });
      rustEntryUncertain = true;
    }

    if (sym.reservedParams && sym.reservedParams.length > 0) {
      reservedContracts.push({
        symbol: symShort,
        kind: "RESERVED_PARAM_SIGNATURE",
        reservedParams: sym.reservedParams,
        verdict: "KEEP_SIGNATURE_DO_NOT_BREAK"
      });
    }

    // 4a. Zero-Inflow Unwired Symbol (distinguishes unreferenced internal symbols from NO_STATIC_CALLER_EVIDENCE unwired exports)
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
            evidenceStrength: "NO_STATIC_CALLER_EVIDENCE",
            verdict: "REVIEW_BEFORE_DELETE_OR_WIRE",
            analysisScope: { sourceFiles: graph.files.length, method: "LEXICAL_IMPORT_GRAPH" },
            uncertainty: ["动态调用、反射、外部宿主和未解析语法可能未被识别"],
            remediation: "确认调用契约并用测试验证后，再决定保留、接入或删除。"
          });
        } else if ((graph.inEdgeDetails.get(sym.id) || []).some((edge) =>
          !["CONTAINS", "IMPLEMENTS", "STATE_RW"].includes(edge.kind) && graph.symbolById.get(edge.fromId)?.zone !== "prod")) {
          unresolvedEntryPaths.push({ symbol: symShort, name: sym.name,
            finding: `待确认：${sym.name} 被测试或工具脚本引用，尚未证明生产入口；需确认它是否属于生产功能`,
            evidence: (graph.inEdgeDetails.get(sym.id) || []).filter((edge) =>
              !["CONTAINS", "IMPLEMENTS", "STATE_RW"].includes(edge.kind) && graph.symbolById.get(edge.fromId)?.zone !== "prod")
              .map((edge) => `${edge.evidence.file}:${edge.evidence.line}: ${edge.evidence.reason}`) });
        } else if (!rustEntryUncertain && !sym.isConstructor && !graph.workspaceProfile?.hasDynamicPluginLoading) {
          unwiredExports.push({
            symbol: symShort,
            name: sym.name,
            file: sym.file,
            exposure: sym.exposure || "INTERNAL_MODULE_EXPORT",
            evidenceStrength: "NO_STATIC_CALLER_EVIDENCE",
            verdict: "REVIEW_ENTRY_REQUIREMENT",
            diagnosis: `导出函数 "${sym.name}" 未找到静态调用入口；需确认其接入要求及动态或宿主调用`
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
          !target.isAbstract && !target.isExtensionHook &&
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
      const previewPair = { left, right, similarity };
      let insertAt = clonePreview.length;
      while (insertAt > 0) {
        const previous = clonePreview[insertAt - 1];
        if (previous.left < left || (previous.left === left && previous.right <= right)) break;
        insertAt--;
      }
      if (insertAt < 10) {
        clonePreview.splice(insertAt, 0, previewPair);
        if (clonePreview.length > 10) clonePreview.pop();
      }
    });
  }
  const clones = clonePreview.map((pair) => ({
    funcA: shortId(fnSymbols[pair.left]), funcB: shortId(fnSymbols[pair.right]),
    similarity: `${Math.round(pair.similarity * 100)}%`, method: "LEXICAL_SHINGLE_JACCARD"
  }));

  // 7. Task-Oriented Tri-State Wiring Contract Evaluation (`SATISFIED` / `VIOLATED` / `INCONCLUSIVE`)
  const contractEval = isNonSourceDiffOnly && !options.runTestsCommand
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

  // Absence in a lexical graph is not proof of a missing business requirement.
  // Explicit task contracts are evaluated separately and retain their verdict.
  if (isFullScan && unwiredExports.length > 0) {
    const existingLocs = new Set(contractEval.wiringReport.obligations.map((o) => o.targetLocation));
    for (const ue of unwiredExports) {
      if (!existingLocs.has(ue.symbol)) {
        contractEval.wiringReport.obligations.push({
          id: `AUTO-EXP-${contractEval.wiringReport.obligations.length + 1}`,
          station: "ENTRY_WIRING",
          layer: "L1_STRUCTURAL",
          required: false,
          targetLocation: ue.symbol,
          reason: "自动扫描未找到静态调用证据，尚无明确任务契约证明该函数必须接入运行入口",
          expectedRelation: `建立从真实入口（UI/IPC/路由/主循环）到 ${ue.name} 的调用连接`,
          sourceBasis: `项目模式识别: ${graph.workspaceProfile?.projectMode}`,
          status: "INCONCLUSIVE",
          evidence: [ue.symbol],
          finding: `待确认：${ue.diagnosis}`,
          remediation: `确认 "${ue.name}" 的业务接入要求、宿主回调和外部调用；若必须接入，请建立显式 ENTRY_WIRING 目标并验证，勿仅据此自动删除。`
        });
      }
    }
  }

  if (options.stateDiagnostics.length > 0) {
    contractEval.wiringReport.obligations.push({
      id: "STATE-VALIDITY", station: "STATE_VALIDITY", layer: "L1_STRUCTURAL", required: false,
      status: "INCONCLUSIVE", evidence: options.stateDiagnostics.map((d) => `${d.kind}: ${d.reason}`),
      finding: "已忽略失效的任务状态；请重新保存基线或生成蓝图。"
    });
  }

  const isBlockingBreak = (d) => d.kind === "DEAD_LOCAL_ASSIGNMENT" || d.kind === "IGNORED_PURE_CALL";
  dataFlowBreaks.sort((a, b) => Number(isBlockingBreak(b)) - Number(isBlockingBreak(a)));

  const antiPatterns = baselineBundle ? baselineBundle.addedAntiPatterns : gitStatus.addedAntiPatterns;
  const obligations = contractEval.wiringReport.obligations;
  const existingKeys = new Set(obligations.map((o) => o.diagnosticKey).filter(Boolean));
  const addDiagnostic = (kind, status, location, finding, evidence, diagnosticKey) => {
    if (diagnosticKey && existingKeys.has(diagnosticKey)) return;
    if (diagnosticKey) existingKeys.add(diagnosticKey);
    obligations.push({ id: `DIAGNOSTIC-${obligations.length + 1}`, diagnosticKey, station: kind,
      layer: kind === "DATA_FLOW_CONSUMPTION" ? "L2_DATA_FLOW" : "L1_STRUCTURAL",
      required: status === "VIOLATED", status, targetLocation: location, finding, evidence,
      sourceBasis: isFullScan ? "全量静态分析" : "本次变更范围静态分析" });
  };
  for (const limitation of graph.analysisLimitations || []) {
    if (isNonSourceDiffOnly) continue;
    if (!isFullScan && !impactedFiles.has(limitation.file) && limitation.kind !== 'TSCONFIG') continue;
    addDiagnostic('ANALYSIS_LIMITATION', 'INCONCLUSIVE', limitation.file,
      `待确认：${limitation.reason}`, [limitation.file, limitation.reason],
      `analysis-limit:${limitation.kind}:${limitation.file}:${limitation.reason}`);
  }
  for (const bridge of brokenBridges) {
    const ambiguous = bridge.status?.startsWith("AMBIGUOUS");
    addDiagnostic("PROTOCOL_COUNTERPART", ambiguous ? "INCONCLUSIVE" : "VIOLATED",
      `${bridge.fromFile}:${bridge.fromLine || 1} (${bridge.fromSymbol})`,
      `${ambiguous ? "待确认" : "违反"}：跨界协议 "${bridge.contract}" ${ambiguous ? "对端有歧义" : "断链"} (${bridge.status})`,
      bridge.candidates || [`${bridge.fromFile} -> ${bridge.status}`], bridgeDiagnosticKey(bridge));
  }
  for (const candidate of unresolvedEntryPaths) addDiagnostic("ENTRY_WIRING", "INCONCLUSIVE", candidate.symbol,
    candidate.finding || `待确认：${candidate.name} 有匿名对象传参或动态组件选择的候选入口，尚未证明实际调用`,
    candidate.evidence, `possible-entry:${candidate.symbol}`);
  for (const leak of sandboxViolations) addDiagnostic("SANDBOX_DEPENDENCY", "VIOLATED", leak.prodCaller,
    `违反：生产代码依赖 ${leak.targetZone} 区符号 ${leak.illegalTarget}`, [leak.prodCaller, leak.illegalTarget]);
  for (const candidate of sandboxCandidates) addDiagnostic("SANDBOX_DEPENDENCY", "INCONCLUSIVE", candidate.prodCaller,
    `待确认：Rust 条件编译或回调引用指向按路径分类的 ${candidate.targetZone} 区符号 ${candidate.illegalTarget}，尚未证明运行调用`,
    [candidate.prodCaller, candidate.illegalTarget, ...candidate.evidence]);
  for (const pattern of antiPatterns) addDiagnostic("CHANGE_ANTI_PATTERN", "VIOLATED", pattern.location,
    `违反：新增 ${pattern.kind}`, [pattern.location, pattern.code]);
  for (const drop of dataFlowBreaks) {
    // Unused arguments can be intentional API reserves. Surface uncertainty unless
    // an explicit task contract establishes that the input must be consumed.
    addDiagnostic("DATA_FLOW_CONSUMPTION", isBlockingBreak(drop) ? "VIOLATED" : "INCONCLUSIVE", drop.location,
      `${isBlockingBreak(drop) ? "违反" : "待确认"}：${drop.diagnosis}`, [drop.location]);
  }
  const aggregation = summarizeObligations(obligations);
  contractEval.wiringReport.counts = aggregation.counts;
  contractEval.headlineSummary = aggregation.headlineSummary;
  const finalVerdict = aggregation.verificationVerdict;

  const executionErrors = contractEval.wiringReport.obligations
    .filter((o) => o.execution && !["PASSED", "TEST_FAILED"].includes(o.execution.outcome))
    .map((o) => o.execution);
  if (['EXECUTION_ERROR', 'TIMED_OUT'].includes(graph.rustSemantics?.outcome)) {
    executionErrors.push({ tool: 'rust-analyzer', outcome: graph.rustSemantics.outcome, message: graph.rustSemantics.reason });
  }
  return {
    stateScope: resolveStateScope(workspaceRoot, options),
    stateDiagnostics: options.stateDiagnostics,
    baseline: baselineBundle ? {
      source: baselineBundle.snapshot.source,
      requestedRef: options.baseRef || null,
      resolvedRef: baselineBundle.snapshot.baseRef,
      commit: baselineBundle.snapshot.headCommit,
      createdAt: baselineBundle.snapshot.createdAt
    } : null,
    executionErrors,
    // `allowInconclusive` is a CLI exit-code compatibility option only. The report
    // must remain honest: an inconclusive verification is never a PASS.
    status: executionErrors.length > 0
      ? "EXECUTION_ERROR"
      : finalVerdict === "VIOLATED"
        ? "ISSUES_FOUND"
        : finalVerdict === "INCONCLUSIVE"
          ? "INCONCLUSIVE"
          : "PASS",
    verificationVerdict: finalVerdict,
    headlineSummary: contractEval.headlineSummary,
    scanMode,
    workspaceProfile: {
      projectMode: graph.workspaceProfile?.projectMode || "hybrid",
      manifestKind: graph.workspaceProfile?.manifestKind || null
    },
    ...(graph.rustSemantics ? { rustSemantics: graph.rustSemantics } : {}),
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
      possibleSandboxDependencies: sandboxCandidates.length,
      unwiredOrDeadPipesCount: unwiredSymbols.length,
      unwiredExportsCount: unwiredExports.length,
      dataFlowBreaksCount: dataFlowBreaks.length,
      reservedContractsCount: reservedContracts.length,
      writeOnlyDeadEndStatesCount: writeOnlyStates.length,
      asymmetricLifecycleWarnings: asymmetricWarnings.length,
      structuralClonesCount: cloneCount,
      antiPatternsCount: antiPatterns.length
    },
    brokenBridges,
    sandboxViolations,
    sandboxCandidates,
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
