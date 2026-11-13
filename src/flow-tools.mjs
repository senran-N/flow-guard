import fs from "node:fs";
import path from "node:path";
import { buildWorkspaceFlowGraph } from "./graph-builder.mjs";
import { saveSessionBaseline } from "./graph-diff.mjs";
import { buildAndSaveWiringPlan } from "./wiring-contract.mjs";
import { buildArchitectureView, architectureOptions } from "./architecture-view.mjs";
import { findArchitecturePaths } from "./architecture-paths.mjs";
import { inspectArchitectureState } from "./architecture-state.mjs";
import { compareWorkspaceArchitecture } from "./architecture-diff.mjs";
import { jaccardSimilarity } from "./fingerprint.mjs";
import { shortId } from "./flow-verifier.mjs";
import {
  inferFileDomain,
  buildArchitectureDomains,
  extractBackboneSpines,
  extractArchitecturalHubs,
  buildExtensionAndReserveCatalog,
  computeSymbolArchContext
} from "./arch-vision.mjs";

export function generateFlowOverview(workspaceRoot, syncToAgentsMd = false, options = {}) {
  const viewOptions = architectureOptions(options);
  const graph = buildWorkspaceFlowGraph(workspaceRoot, false, {
    projectMode: options.projectMode || "auto"
  });

  const prodFiles = graph.files.filter((f) => f.zone === "prod");
  const testFiles = graph.files.filter((f) => f.zone === "test");
  const sandboxFiles = graph.files.filter((f) => f.zone === "sandbox");

  const sources = [];
  const runtimeEntrySources = [];
  const exportedApiSymbols = [];
  const branches = [];
  const sinks = [];
  for (const sym of graph.symbolById.values()) {
    if (sym.zone !== "prod") continue;
    if (sym.roles.includes("source")) sources.push(sym);
    if (sym.isEntrySource || sym.exposure === "PROTOCOL_BRIDGE_INBOUND") runtimeEntrySources.push(sym);
    if (sym.isPublicApi && (sym.kind === "function" || sym.kind === "method")) exportedApiSymbols.push(sym);
    if (sym.roles.includes("branch")) branches.push(sym);
    if (sym.roles.includes("sink")) sinks.push(sym);
  }

  const architectureDomains = buildArchitectureDomains(graph);
  const backbonePipelines = extractBackboneSpines(graph);
  const architecturalHubs = extractArchitecturalHubs(graph);
  const extensionAndReserveCatalog = buildExtensionAndReserveCatalog(graph);

  const architecture = buildArchitectureView(graph, { ...options, ...viewOptions });
  const architectureDiff = options.baseRef ? compareWorkspaceArchitecture(workspaceRoot, graph, { ...options, level: options.level || 'file' }) : undefined;
  const mermaidBlock = architecture.mermaid;
  if (options.saveBaseline) {
    saveSessionBaseline(workspaceRoot, graph, options);
  }

  const coreStates = Array.from(graph.stateOwnership.values())
    .filter((st) => st.writers.length > 0 && st.readers.length > 0)
    .sort((a, b) => b.readers.length + b.writers.length - (a.readers.length + a.writers.length))
    .slice(0, 12)
    .map((st) => ({
      field: st.qualifiedField || st.field,
      authoritativeWriters: Array.from(new Set(st.writers.map((id) => graph.symbolById.get(id)?.file))).filter(Boolean),
      consumers: Array.from(new Set(st.readers.map((id) => graph.symbolById.get(id)?.file))).filter(Boolean)
    }));

  if (syncToAgentsMd) {
    const agentsPath = path.join(workspaceRoot, "AGENTS.md");
    const section = [
      "<!-- FLOWGUARD:START -->",
      "## 实时端到端水路拓扑 (由 FlowGuard 自动维护)",
      mermaidBlock,
      `静态架构视图（${architecture.query.level}）：展示 ${architecture.coverage.returnedNodes}/${architecture.coverage.matchedNodes} 个节点、${architecture.coverage.returnedEdges}/${architecture.coverage.matchedEdges} 条关系；省略 ${architecture.coverage.omittedNodes} 个节点、${architecture.coverage.omittedEdges} 条关系。分组依据见 architecture.scope.grouping，候选连线不证明运行时执行。`,
      "<!-- FLOWGUARD:END -->"
    ].join("\n");
    if (fs.existsSync(agentsPath)) {
      const raw = fs.readFileSync(agentsPath, "utf8");
      const next = /<!-- FLOWGUARD:START -->[\s\S]*?<!-- FLOWGUARD:END -->/.test(raw)
        ? raw.replace(/<!-- FLOWGUARD:START -->[\s\S]*?<!-- FLOWGUARD:END -->/, section)
        : `${raw.trimEnd()}\n\n${section}\n`;
      fs.writeFileSync(agentsPath, next, "utf8");
    }
  }

  return {
    workspaceRoot,
    workspaceProfile: {
      projectMode: graph.workspaceProfile?.projectMode || "hybrid",
      manifestKind: graph.workspaceProfile?.manifestKind || null,
      packageEntryFiles: Array.from(graph.workspaceProfile?.packageEntryFiles || []),
      runtimeLanguages: Array.from(graph.workspaceProfile?.runtimeLanguages || []),
      hasDynamicPluginLoading: Boolean(graph.workspaceProfile?.hasDynamicPluginLoading)
    },
    zoneCounts: {
      prodFiles: prodFiles.length,
      testFiles: testFiles.length,
      sandboxFiles: sandboxFiles.length,
      totalSymbols: graph.symbolById.size
    },
    flowSummary: {
      trueSourcesCount: sources.length,
      runtimeEntrySourcesCount: runtimeEntrySources.length,
      exportedApiSurfaceCount: exportedApiSymbols.length,
      branchRoutersCount: branches.length,
      trueSinksCount: sinks.length,
      crossLanguageBridgesCount: graph.crossBridges.length
    },
    architecture,
    ...(architectureDiff ? { architectureDiff } : {}),
    architectureDomains,
    backbonePipelines,
    architecturalHubs,
    extensionAndReserveCatalog,
    crossLanguageBridges: graph.crossBridges.slice(0, 25),
    coreStateOwnershipSSOT: coreStates,
    mermaidPipeline: mermaidBlock,
    syncedToAgentsMd: Boolean(syncToAgentsMd)
  };
}

export function traceSymbolFlow(workspaceRoot, query, options = {}) {
  const viewOptions = architectureOptions({ ...options, level: options.level ?? "symbol" });
  const graph = buildWorkspaceFlowGraph(workspaceRoot, false, {
    projectMode: options.projectMode || "auto"
  });
  const qLower = String(query || "").trim().toLowerCase();

  const matched = Array.from(graph.symbolById.values())
    .filter((s) => {
      const qualDot = s.parentContainerName ? `${s.parentContainerName}.${s.name}`.toLowerCase() : "";
      const qualColon = s.parentContainerName ? `${s.parentContainerName}::${s.name}`.toLowerCase() : "";
      return (
        s.id.toLowerCase() === qLower ||
        `symbol:${s.id}`.toLowerCase() === qLower ||
        s.name.toLowerCase().includes(qLower) ||
        qualDot.includes(qLower) ||
        qualColon.includes(qLower) ||
        s.file.toLowerCase().includes(qLower) ||
        (s.parentContainerName && s.parentContainerName.toLowerCase().includes(qLower)) ||
        s.writes.some((w) => w.toLowerCase().includes(qLower)) ||
        s.reads.some((r) => r.toLowerCase().includes(qLower))
      );
    })
    .sort((a, b) => {
      const aQualDot = a.parentContainerName ? `${a.parentContainerName}.${a.name}`.toLowerCase() : "";
      const bQualDot = b.parentContainerName ? `${b.parentContainerName}.${b.name}`.toLowerCase() : "";
      const aQualColon = a.parentContainerName ? `${a.parentContainerName}::${a.name}`.toLowerCase() : "";
      const bQualColon = b.parentContainerName ? `${b.parentContainerName}::${b.name}`.toLowerCase() : "";
      const aEx = a.name.toLowerCase() === qLower || aQualDot === qLower || aQualColon === qLower ? 0 : 1;
      const bEx = b.name.toLowerCase() === qLower || bQualDot === qLower || bQualColon === qLower ? 0 : 1;
      if (aEx !== bEx) return aEx - bEx;
      return (a.zone === "prod" ? 0 : 1) - (b.zone === "prod" ? 0 : 1);
    });

  const formatEdgeRecord = (rec, direction) => {
    const peerSym = graph.symbolById.get(direction === "in" ? rec.fromId : rec.toId);
    return {
      kind: rec.kind,
      peer: peerSym ? shortId(peerSym) : direction === "in" ? rec.fromId : rec.toId,
      location: `${rec.evidence?.file || ""}:${rec.evidence?.line || 1}`,
      reason: rec.evidence?.reason || rec.kind,
      ...(rec.evidence?.passedArgs ? { passedArgs: rec.evidence.passedArgs } : {}),
      ...(rec.evidence?.argumentSites ? { argumentSites: rec.evidence.argumentSites } : {}),
      ...(rec.evidence?.returnFlow ? { returnFlow: rec.evidence.returnFlow } : {}),
      ...(rec.evidence?.stateField ? { stateField: rec.evidence.stateField } : {}),
      ...(rec.evidence?.contract ? { contract: rec.evidence.contract } : {}),
      resolution: rec.resolution || { mode: "IMPORT_OR_SCOPE", confidence: "HIGH" }
    };
  };

  const traces = matched.slice(0, 5).map((sym) => {
    const inDetails = graph.inEdgeDetails?.get(sym.id) || [];
    const outDetails = graph.outEdgeDetails?.get(sym.id) || [];

    // Direct control callers exclude CONTAINS / IMPLEMENTS / STATE_RW unless no call edges exist
    const callEdgesIn = inDetails.filter(
      (r) => r.kind !== "CONTAINS" && r.kind !== "IMPLEMENTS" && r.kind !== "STATE_RW"
    );
    const directCallers = (callEdgesIn.length > 0 ? callEdgesIn : inDetails)
      .map((r) => graph.symbolById.get(r.fromId))
      .filter(Boolean);
    const uniqueDirectCallers = Array.from(new Map(directCallers.map((s) => [s.id, s])).values());

    const callEdgesOut = outDetails.filter((r) => r.kind !== "CONTAINS" && r.kind !== "IMPLEMENTS");
    const directCallees = (callEdgesOut.length > 0 ? callEdgesOut : outDetails)
      .map((r) => graph.symbolById.get(r.toId))
      .filter(Boolean);
    const uniqueDirectCallees = Array.from(new Map(directCallees.map((s) => [s.id, s])).values());

    const upstreamSources = [];
    const visitedUp = new Set([sym.id]);
    const qUp = [{ id: sym.id, path: [sym.name] }];
    while (qUp.length > 0 && upstreamSources.length < 6) {
      const curr = qUp.shift();
      const node = graph.symbolById.get(curr.id);
      if (node && node.zone === "prod" && node.id !== sym.id && node.roles.includes("source")) {
        upstreamSources.push({ source: shortId(node), chain: curr.path.slice().reverse().join(" ➔ ") });
      }
      if (curr.path.length >= 6) continue;
      for (const prevId of graph.inEdges.get(curr.id) || []) {
        const prevNode = graph.symbolById.get(prevId);
        if (!visitedUp.has(prevId) && prevNode && prevNode.zone === "prod") {
          visitedUp.add(prevId);
          qUp.push({ id: prevId, path: [...curr.path, `${prevNode.name} (${path.basename(prevNode.file)})`] });
        }
      }
    }

    const downstreamSinks = [];
    const visitedDown = new Set([sym.id]);
    const qDown = [{ id: sym.id, path: [sym.name] }];
    while (qDown.length > 0 && downstreamSinks.length < 6) {
      const curr = qDown.shift();
      const node = graph.symbolById.get(curr.id);
      if (node && node.id !== sym.id && node.roles.includes("sink")) {
        downstreamSinks.push({ sink: shortId(node), chain: curr.path.join(" ➔ ") });
      }
      if (curr.path.length >= 6) continue;
      for (const nextId of graph.outEdges.get(curr.id) || []) {
        const nextNode = graph.symbolById.get(nextId);
        if (!visitedDown.has(nextId) && nextNode) {
          visitedDown.add(nextId);
          qDown.push({ id: nextId, path: [...curr.path, `${nextNode.name} (${path.basename(nextNode.file)})`] });
        }
      }
    }

    // Distinguish true parallel branches / co-registrations / polymorphic peers from sequential steps!
    const siblingBranches = new Set();
    const sequentialSteps = new Set();

    for (const inRec of callEdgesIn) {
      const caller = graph.symbolById.get(inRec.fromId);
      if (!caller || caller.zone !== "prod") continue;
      const callerOuts = graph.outEdgeDetails?.get(caller.id) || [];

      for (const sibRec of callerOuts) {
        if (sibRec.toId === sym.id) continue;
        if (sibRec.kind === "CONTAINS" || sibRec.kind === "IMPLEMENTS" || sibRec.kind === "STATE_RW") continue;
        const sib = graph.symbolById.get(sibRec.toId);
        if (!sib || sib.zone !== "prod") continue;

        if (inRec.kind === "BRANCH_DISPATCH" && sibRec.kind === "BRANCH_DISPATCH") {
          const sameGroup =
            inRec.evidence?.branchGroupLine &&
            sibRec.evidence?.branchGroupLine &&
            inRec.evidence.branchGroupLine === sibRec.evidence.branchGroupLine;
          siblingBranches.add(
            `${shortId(sib)} [同属 ${caller.name}${sameGroup ? ` L${sibRec.evidence.branchGroupLine}` : ""} 条件分支派发]`
          );
        } else if (inRec.kind === "REGISTRATION" && sibRec.kind === "REGISTRATION") {
          siblingBranches.add(`${shortId(sib)} [同属 ${caller.name} 注册表挂载]`);
        } else if (sibRec.kind === "SEQ_CALL" || inRec.kind === "SEQ_CALL") {
          sequentialSteps.add(
            `${shortId(sib)} [${caller.name} 内顺序职责步骤 L${sibRec.evidence?.line || caller.startLine}]`
          );
        }
      }
    }

    // Add polymorphic / interface sibling implementations to `siblingBranchesToCheck`
    if (sym.kind === "class" || sym.kind === "struct") {
      for (const baseName of sym.baseTypes || []) {
        for (const peerSub of graph.subclassesByBase?.get(baseName) || []) {
          if (peerSub.id !== sym.id && peerSub.zone === "prod") {
            siblingBranches.add(`${shortId(peerSub)} [同继承/实现契约 ${baseName}]`);
          }
        }
      }
    } else if (sym.parentContainerName) {
      const parentSyms = graph.containersByName?.get(sym.parentContainerName) || [];
      for (const pSym of parentSyms) {
        for (const baseName of pSym.baseTypes || []) {
          for (const peerSub of graph.subclassesByBase?.get(baseName) || []) {
            if (peerSub.name === sym.parentContainerName) continue;
            const peerMethod = (graph.symbolsByName.get(sym.name) || []).find(
              (m) => m.zone === "prod" && m.parentContainerName === peerSub.name
            );
            if (peerMethod) {
              siblingBranches.add(`${shortId(peerMethod)} [多态同族方法 (${baseName})]`);
            }
          }
        }
      }
    }

    const symStateKeys = graph.stateKeysBySymbol?.get(sym.id)
      ? Array.from(graph.stateKeysBySymbol.get(sym.id))
      : Array.from(new Set([...sym.writes, ...sym.reads]));
    const stateRules = symStateKeys
      .map((k) => graph.stateOwnership.get(k))
      .filter(Boolean)
      .slice(0, 6)
      .map((own) => ({
        field: own.qualifiedField || own.field,
        writers: own.writers.map((id) => shortId(graph.symbolById.get(id))).slice(0, 5),
        readersCount: own.readers.length
      }));

    const reusableCandidates = [];
    for (const other of graph.symbolById.values()) {
      if (other.id !== sym.id && other.zone === "prod" && sym.shingles.size > 0 && other.shingles.size > 0) {
        const sim = jaccardSimilarity(sym.shingles, other.shingles);
        if (sim >= 0.55) {
          reusableCandidates.push({
            symbol: shortId(other),
            similarity: `${Math.round(sim * 100)}%`,
            method: "LEXICAL_SHINGLE_JACCARD"
          });
        }
      }
    }

    return {
      symbol: shortId(sym),
      zone: sym.zone,
      roles: sym.roles,
      exposure: sym.exposure,
      architecturalContext: computeSymbolArchContext(graph, sym),
      waterFlowStatus: {
        connectedToRuntimeEntry: graph.reachableFromRuntimeSource.has(sym.id),
        possiblyConnectedToRuntimeEntry: graph.possiblyReachableFromRuntimeSource.has(sym.id),
        connectedToTrueSource: graph.reachableFromSource.has(sym.id),
        exposureSurface: sym.exposure,
        reachesTrueSink: graph.reachesSink.has(sym.id)
      },
      evidencedRelations: {
        inbound: inDetails.slice(0, 12).map((r) => formatEdgeRecord(r, "in")),
        outbound: outDetails.slice(0, 14).map((r) => formatEdgeRecord(r, "out")),
        coverage: { inboundTotal: inDetails.length, inboundOmitted: Math.max(0, inDetails.length - 12),
          outboundTotal: outDetails.length, outboundOmitted: Math.max(0, outDetails.length - 14) }
      },
      upstreamSources,
      directCallers: uniqueDirectCallers.slice(0, 8).map(shortId),
      directCallees: uniqueDirectCallees.slice(0, 8).map(shortId),
      downstreamSinks,
      siblingBranchesToCheck: Array.from(siblingBranches).slice(0, 8),
      sequentialStepsInCaller: Array.from(sequentialSteps).slice(0, 8),
      stateOwnershipSSOT: stateRules,
      reusableCandidates: reusableCandidates.slice(0, 5),
      codeSlice: sym.snippet
    };
  });

  const architecture = buildArchitectureView(graph, {
    ...options, ...viewOptions,
    ...(options.impact && options.focus === undefined ? { focus: query } : {}),
    ...(options.focus === undefined && !options.impact ? { focusIds: matched.map(s => s.id) } : {})
  });
  const paths = options.to !== undefined ? findArchitecturePaths(graph, query, options.to, options) : undefined;
  const stateImpact = options.inspectState ? inspectArchitectureState(graph, query, options) : undefined;
  return { query, matchCount: matched.length, traces, ...(paths ? { paths } : {}),
    ...(stateImpact ? { stateImpact } : {}),
    traceCoverage: { matched: matched.length, returned: traces.length, omitted: matched.length - traces.length }, architecture };
}

export function generateWiringBlueprint(workspaceRoot, referenceQueryOrOptions, extraOptions = {}) {
  const opts =
    typeof referenceQueryOrOptions === "object" && referenceQueryOrOptions !== null
      ? referenceQueryOrOptions
      : { ...extraOptions, reference: referenceQueryOrOptions };
  const referenceQuery = String(opts.reference || "").trim();

  const graph = buildWorkspaceFlowGraph(workspaceRoot, false, {
    projectMode: opts.projectMode || "auto"
  });
  const qLower = referenceQuery.toLowerCase();
  const refSymbols = Array.from(graph.symbolById.values())
    .filter(
      (s) =>
        s.name.toLowerCase().includes(qLower) ||
        s.file.toLowerCase().includes(qLower) ||
        (s.writes || []).some((w) => w.toLowerCase().includes(qLower)) ||
        (s.reads || []).some((r) => r.toLowerCase().includes(qLower))
    )
    .sort((a, b) => {
      const aZone = a.zone === "prod" ? 0 : 1;
      const bZone = b.zone === "prod" ? 0 : 1;
      if (aZone !== bZone) return aZone - bZone;
      const aExactSym = a.name.toLowerCase() === qLower ? 0 : 1;
      const bExactSym = b.name.toLowerCase() === qLower ? 0 : 1;
      if (aExactSym !== bExactSym) return aExactSym - bExactSym;
      const aStem = path.basename(a.file, path.extname(a.file)).toLowerCase() === qLower ? 0 : 1;
      const bStem = path.basename(b.file, path.extname(b.file)).toLowerCase() === qLower ? 0 : 1;
      return aStem - bStem;
    });
  if (refSymbols.length === 0) {
    return { referenceQuery, error: `未找到与 "${referenceQuery}" 匹配的参考模块。` };
  }

  const targetFile = refSymbols[0].file;
  const fileSyms = graph.files.find((f) => f.file === targetFile)?.symbols || refSymbols.slice(0, 8);
  const containers = fileSyms.filter((s) => s.kind === "class" || s.kind === "struct");
  const baseContracts = new Set();
  for (const c of containers) {
    for (const b of c.baseTypes || []) baseContracts.add(b);
  }

  const peerImpls = new Set();
  for (const baseName of baseContracts) {
    for (const sub of graph.subclassesByBase?.get(baseName) || []) {
      if (sub.file !== targetFile) {
        peerImpls.add(`${sub.name} (${sub.file}:${sub.startLine}) [同继承自 ${baseName}]`);
      }
    }
  }

  const registrationHooks = new Set();
  const inboundHooks = new Set();
  const outboundSinks = new Set();
  const pairedInterfaces = [];
  const stateContracts = new Set();
  const reservedSignatures = [];

  for (const s of fileSyms) {
    if (s.reservedParams && s.reservedParams.length > 0) {
      reservedSignatures.push({
        method: `${s.name}(${s.params.join(", ")})`,
        reservedParams: s.reservedParams
      });
    }
    for (const inRec of graph.inEdgeDetails?.get(s.id) || []) {
      if (inRec.kind === "CONTAINS" || inRec.kind === "IMPLEMENTS" || inRec.kind === "STATE_RW") continue;
      const caller = graph.symbolById.get(inRec.fromId);
      if (caller && caller.zone === "prod" && caller.file !== targetFile) {
        const lineStr = `${caller.file}:${inRec.evidence?.line || caller.startLine} (${caller.name} --[${inRec.kind}]--> ${s.name})`;
        if (
          inRec.kind === "REGISTRATION" ||
          s.kind === "class" ||
          s.kind === "struct" ||
          s.name === "new" ||
          s.name === "__init__" ||
          s.name === "constructor"
        ) {
          registrationHooks.add(lineStr);
        } else {
          inboundHooks.add(lineStr);
        }
      }
    }
    for (const outRec of graph.outEdgeDetails?.get(s.id) || []) {
      if (outRec.kind === "CONTAINS" || outRec.kind === "IMPLEMENTS") continue;
      const callee = graph.symbolById.get(outRec.toId);
      if (callee && callee.file !== targetFile) {
        outboundSinks.add(
          `${callee.file}:${callee.startLine} (${s.name} --[${outRec.kind}]--> ${callee.name})`
        );
      }
    }
    if (s.paired) pairedInterfaces.push(`${s.name} (L${s.startLine}) — [${s.paired.group}] (${s.paired.side})`);
    for (const w of s.writes) stateContracts.add(`写入状态: ${w}`);
    for (const r of s.reads) stateContracts.add(`读取状态: ${r}`);
  }

  const wiringPlan = buildAndSaveWiringPlan(graph, workspaceRoot, {
    ...opts,
    referenceQuery,
    referenceFile: targetFile,
    fileSyms,
    containers,
    baseContracts: Array.from(baseContracts),
    targetSymbol: opts.targetSymbol || null,
    targetField: opts.targetField || null,
    consumerTarget: opts.consumerTarget || null,
    requirePersistence: opts.requirePersistence || "auto",
    savePlan: opts.savePlan !== false
  });

  return {
    referenceModule: targetFile,
    wiringPlan,
    moduleArchitectureProfile: {
      domain: inferFileDomain(targetFile),
      containers: containers.map((c) => ({
        name: c.name,
        kind: c.kind,
        baseTypes: c.baseTypes || [],
        subclasses: (graph.subclassesByBase?.get(c.name) || []).map((sub) => `${sub.name} (${sub.file})`)
      })),
      publicApiSurface: Array.from(
        new Set(
          fileSyms
            .filter((s) => s.isPublicApi && (s.kind === "function" || s.kind === "method"))
            .map((s) => `${s.name}(${s.params.join(", ")})`)
        )
      ).slice(0, 12),
      peerImplementations: Array.from(peerImpls).slice(0, 8),
      reservedContractSignatures: reservedSignatures
    },
    wiringChecklist: [
      {
        stage: "第 1 站：实例构造、工厂与注册表挂载点 (Factory / DI / Registry Wiring)",
        locations: Array.from(registrationHooks).slice(0, 8)
      },
      {
        stage: "第 2 站：上游水源与分发器挂接点 (Inbound Source / Dispatcher Wiring)",
        locations: Array.from(inboundHooks).slice(0, 10)
      },
      {
        stage: "第 3 站：成对生命周期与对称契约 (Paired Lifecycle Symmetry)",
        locations: pairedInterfaces
      },
      {
        stage: "第 4 站：下游真实终端与状态落点 (Outbound Sinks & State Mutations)",
        locations: [...Array.from(outboundSinks).slice(0, 10), ...Array.from(stateContracts).slice(0, 8)]
      }
    ]
  };
}
