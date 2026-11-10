import fs from "node:fs";
import path from "node:path";
import { buildWorkspaceFlowGraph } from "./graph-builder.mjs";
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

export function generateFlowOverview(workspaceRoot, syncToAgentsMd = false) {
  const graph = buildWorkspaceFlowGraph(workspaceRoot);
  const prodFiles = graph.files.filter((f) => f.zone === "prod");
  const testFiles = graph.files.filter((f) => f.zone === "test");
  const sandboxFiles = graph.files.filter((f) => f.zone === "sandbox");

  const sources = [];
  const branches = [];
  const sinks = [];
  for (const sym of graph.symbolById.values()) {
    if (sym.zone !== "prod") continue;
    if (sym.roles.includes("source")) sources.push(sym);
    if (sym.roles.includes("branch")) branches.push(sym);
    if (sym.roles.includes("sink")) sinks.push(sym);
  }

  const architectureDomains = buildArchitectureDomains(graph);
  const backbonePipelines = extractBackboneSpines(graph);
  const architecturalHubs = extractArchitecturalHubs(graph);
  const extensionAndReserveCatalog = buildExtensionAndReserveCatalog(graph);

  const mermaidLines = [
    "```mermaid",
    "flowchart LR",
    '  subgraph Sources["1. 真实水源 (True Sources)"]',
    "    direction TB"
  ];
  const sourceFiles = Array.from(new Set(sources.map((s) => s.file))).slice(0, 10);
  sourceFiles.forEach((f, idx) => {
    const syms = sources.filter((s) => s.file === f).map((s) => s.name).slice(0, 3).join(", ");
    mermaidLines.push(`    S${idx}["${path.basename(f)}\\n(${syms})"]`);
  });
  mermaidLines.push("  end", '  subgraph Branches["2. 核心分流阀与跨界桥 (Branches & Bridges)"]', "    direction TB");

  const branchFiles = Array.from(new Set(branches.map((s) => s.file))).slice(0, 10);
  branchFiles.forEach((f, idx) => {
    const syms = branches.filter((s) => s.file === f).map((s) => s.name).slice(0, 3).join(", ");
    mermaidLines.push(`    B${idx}["${path.basename(f)}\\n(${syms})"]`);
  });
  mermaidLines.push("  end", '  subgraph Sinks["3. 真实终端出水口 (True Sinks)"]', "    direction TB");

  const sinkFiles = Array.from(new Set(sinks.map((s) => s.file))).slice(0, 10);
  sinkFiles.forEach((f, idx) => {
    const syms = sinks.filter((s) => s.file === f).map((s) => s.name).slice(0, 3).join(", ");
    mermaidLines.push(`    K${idx}["${path.basename(f)}\\n(${syms})"]`);
  });
  mermaidLines.push("  end");

  const addedEdges = new Set();
  sourceFiles.forEach((sf, sIdx) => {
    const outs = graph.fileOutEdges.get(sf) || new Set();
    branchFiles.forEach((bf, bIdx) => {
      if (sf !== bf && outs.has(bf) && !addedEdges.has(`S${sIdx}-->B${bIdx}`)) {
        addedEdges.add(`S${sIdx}-->B${bIdx}`);
        mermaidLines.push(`  S${sIdx}-->B${bIdx}`);
      }
    });
  });
  branchFiles.forEach((bf, bIdx) => {
    const outs = graph.fileOutEdges.get(bf) || new Set();
    sinkFiles.forEach((kf, kIdx) => {
      if (bf !== kf && outs.has(kf) && !addedEdges.has(`B${bIdx}-->K${kIdx}`)) {
        addedEdges.add(`B${bIdx}-->K${kIdx}`);
        mermaidLines.push(`  B${bIdx}-->K${kIdx}`);
      }
    });
  });
  mermaidLines.push("```");
  const mermaidBlock = mermaidLines.join("\n");

  const coreStates = Array.from(graph.stateOwnership.values())
    .filter((st) => st.writers.length > 0 && st.readers.length > 0)
    .sort((a, b) => b.readers.length + b.writers.length - (a.readers.length + a.writers.length))
    .slice(0, 12)
    .map((st) => ({
      field: st.field,
      authoritativeWriters: Array.from(new Set(st.writers.map((id) => graph.symbolById.get(id)?.file))).filter(Boolean),
      consumers: Array.from(new Set(st.readers.map((id) => graph.symbolById.get(id)?.file))).filter(Boolean)
    }));

  if (syncToAgentsMd) {
    const agentsPath = path.join(workspaceRoot, "AGENTS.md");
    const section = [
      "<!-- FLOWGUARD:START -->",
      "## 实时端到端水路拓扑 (由 FlowGuard 自动维护)",
      mermaidBlock,
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
    zoneCounts: {
      prodFiles: prodFiles.length,
      testFiles: testFiles.length,
      sandboxFiles: sandboxFiles.length,
      totalSymbols: graph.symbolById.size
    },
    flowSummary: {
      trueSourcesCount: sources.length,
      branchRoutersCount: branches.length,
      trueSinksCount: sinks.length,
      crossLanguageBridgesCount: graph.crossBridges.length
    },
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

export function traceSymbolFlow(workspaceRoot, query) {
  const graph = buildWorkspaceFlowGraph(workspaceRoot);
  const qLower = String(query || "").trim().toLowerCase();

  const matched = Array.from(graph.symbolById.values())
    .filter((s) => {
      const qualDot = s.parentContainerName ? `${s.parentContainerName}.${s.name}`.toLowerCase() : "";
      const qualColon = s.parentContainerName ? `${s.parentContainerName}::${s.name}`.toLowerCase() : "";
      return (
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

  const traces = matched.slice(0, 5).map((sym) => {
    const directCallers = Array.from(graph.inEdges.get(sym.id) || []).map((id) => graph.symbolById.get(id)).filter(Boolean);
    const directCallees = Array.from(graph.outEdges.get(sym.id) || []).map((id) => graph.symbolById.get(id)).filter(Boolean);

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

    const siblingBranches = new Set();
    for (const caller of directCallers) {
      for (const sibId of graph.outEdges.get(caller.id) || []) {
        const sib = graph.symbolById.get(sibId);
        if (sibId !== sym.id && sib && sib.zone === "prod") {
          siblingBranches.add(`${shortId(sib)} [同属 ${caller.name} 分流]`);
        }
      }
    }

    const stateRules = Array.from(new Set([...sym.writes, ...sym.reads]))
      .map((f) => graph.stateOwnership.get(f))
      .filter(Boolean)
      .slice(0, 6)
      .map((own) => ({
        field: own.field,
        writers: own.writers.map((id) => shortId(graph.symbolById.get(id))).slice(0, 5),
        readersCount: own.readers.length
      }));

    const reusableCandidates = [];
    for (const other of graph.symbolById.values()) {
      if (other.id !== sym.id && other.zone === "prod" && sym.shingles.size > 0 && other.shingles.size > 0) {
        const sim = jaccardSimilarity(sym.shingles, other.shingles);
        if (sim >= 0.55) reusableCandidates.push({ symbol: shortId(other), similarity: `${Math.round(sim * 100)}%` });
      }
    }

    return {
      symbol: shortId(sym),
      zone: sym.zone,
      roles: sym.roles,
      architecturalContext: computeSymbolArchContext(graph, sym),
      waterFlowStatus: {
        connectedToTrueSource: graph.reachableFromSource.has(sym.id),
        reachesTrueSink: graph.reachesSink.has(sym.id)
      },
      upstreamSources,
      directCallers: directCallers.slice(0, 8).map(shortId),
      directCallees: directCallees.slice(0, 8).map(shortId),
      downstreamSinks,
      siblingBranchesToCheck: Array.from(siblingBranches).slice(0, 8),
      stateOwnershipSSOT: stateRules,
      reusableCandidates: reusableCandidates.slice(0, 5),
      codeSlice: sym.snippet
    };
  });

  return { query, matchCount: matched.length, traces };
}

export function generateWiringBlueprint(workspaceRoot, referenceQuery) {
  const graph = buildWorkspaceFlowGraph(workspaceRoot);
  const qLower = String(referenceQuery || "").trim().toLowerCase();
  const refSymbols = Array.from(graph.symbolById.values())
    .filter((s) => s.name.toLowerCase().includes(qLower) || s.file.toLowerCase().includes(qLower))
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

  // Find peer implementations (classes sharing a base contract or sharing >=2 method names)
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
    for (const callerId of graph.inEdges.get(s.id) || []) {
      const caller = graph.symbolById.get(callerId);
      if (caller && caller.zone === "prod" && caller.file !== targetFile) {
        const lineStr = `${caller.file}:${caller.startLine} (${caller.name} ➔ 调用 ${s.name})`;
        if (s.kind === "class" || s.kind === "struct" || s.name === "new" || s.name === "__init__" || s.name === "constructor") {
          registrationHooks.add(lineStr);
        } else {
          inboundHooks.add(lineStr);
        }
      }
    }
    for (const calleeId of graph.outEdges.get(s.id) || []) {
      const callee = graph.symbolById.get(calleeId);
      if (callee && callee.file !== targetFile) {
        outboundSinks.add(`${callee.file}:${callee.startLine} (${s.name} ➔ 调用 ${callee.name})`);
      }
    }
    if (s.paired) pairedInterfaces.push(`${s.name} (L${s.startLine}) — [${s.paired.group}] (${s.paired.side})`);
    for (const w of s.writes) stateContracts.add(`写入状态: ${w}`);
    for (const r of s.reads) stateContracts.add(`读取状态: ${r}`);
  }

  return {
    referenceModule: targetFile,
    moduleArchitectureProfile: {
      domain: inferFileDomain(targetFile),
      containers: containers.map((c) => ({
        name: c.name,
        kind: c.kind,
        baseTypes: c.baseTypes || [],
        subclasses: (graph.subclassesByBase?.get(c.name) || []).map((sub) => `${sub.name} (${sub.file})`)
      })),
      publicApiSurface: fileSyms
        .filter((s) => s.isPublicApi && (s.kind === "function" || s.kind === "method"))
        .slice(0, 12)
        .map((s) => `${s.name}(${s.params.join(", ")})`),
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
