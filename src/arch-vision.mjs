import path from "node:path";
import { shortId } from "./flow-verifier.mjs";

export function inferFileDomain(relPath) {
  const parts = relPath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 1) return "(root)";
  if ((parts[0] === "packages" || parts[0] === "crates" || parts[0] === "modules") && parts.length >= 2) {
    if (parts[2] === "src" && parts.length >= 5) return `${parts[0]}/${parts[1]}/${parts[3]}`;
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts[0] === "src" && parts.length >= 3) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}

export function classifyDomainLayer(domainStats) {
  const { sourcesCount, branchesCount, sinksCount, totalSyms, domain } = domainStats;
  const dLow = domain.toLowerCase();
  if (/(?:^|\/)(?:cli|cmd|ui|views?|pages?|routes?|controllers?|handlers?|api|app|main)(?:\/|$)/.test(dLow)) {
    return "ENTRY_SURFACE (入口与交互暴露层)";
  }
  if (/(?:^|\/)(?:transports?|storage|db|persistence|io|sinks?|drivers?|net|adapters?)(?:\/|$)/.test(dLow)) {
    return "INFRA_SINK (底层驱动与终端落点层)";
  }
  const sourceRatio = sourcesCount / Math.max(1, totalSyms);
  const branchRatio = branchesCount / Math.max(1, totalSyms);
  const sinkRatio = sinksCount / Math.max(1, totalSyms);
  if (branchRatio >= 0.28) return "ORCHESTRATION_ROUTING (核心编排与分流路由层)";
  if (sourceRatio >= 0.55 && sinkRatio < 0.35) return "ENTRY_SURFACE (入口与协议暴露层)";
  if (sinkRatio >= 0.45) return "INFRA_SINK (状态落点与外部终端层)";
  return "DOMAIN_CORE (核心领域模型与计算层)";
}

export function buildArchitectureDomains(graph) {
  const domainMap = new Map();

  for (const f of graph.files) {
    if (f.zone !== "prod") continue;
    const dom = inferFileDomain(f.file);
    if (!domainMap.has(dom)) {
      domainMap.set(dom, {
        domain: dom,
        langs: new Set(),
        files: new Set(),
        totalSyms: 0,
        sourcesCount: 0,
        branchesCount: 0,
        sinksCount: 0,
        containers: [],
        entryPoints: [],
        ownedStates: new Set(),
        outboundDomains: new Map()
      });
    }
    const d = domainMap.get(dom);
    d.langs.add(f.lang);
    d.files.add(f.file);

    for (const s of f.symbols) {
      if (s.zone !== "prod") continue;
      d.totalSyms++;
      if (s.roles.includes("source")) d.sourcesCount++;
      if (s.roles.includes("branch")) d.branchesCount++;
      if (s.roles.includes("sink")) d.sinksCount++;
      if (s.kind === "class" || s.kind === "struct") d.containers.push(s.name);
      if (s.isEntrySource && d.entryPoints.length < 5) d.entryPoints.push(`${s.name} (${path.basename(s.file)})`);
      for (const w of s.writes) d.ownedStates.add(w);

      for (const targetId of graph.outEdges.get(s.id) || []) {
        const target = graph.symbolById.get(targetId);
        if (target && target.zone === "prod") {
          const targetDom = inferFileDomain(target.file);
          if (targetDom !== dom) {
            d.outboundDomains.set(targetDom, (d.outboundDomains.get(targetDom) || 0) + 1);
          }
        }
      }
    }
  }

  return Array.from(domainMap.values())
    .sort((a, b) => b.totalSyms - a.totalSyms)
    .slice(0, 18)
    .map((d) => ({
      domain: d.domain,
      layer: classifyDomainLayer(d),
      languages: Array.from(d.langs),
      filesCount: d.files.size,
      symbolsCount: d.totalSyms,
      roleDistribution: {
        sources: d.sourcesCount,
        branches: d.branchesCount,
        sinks: d.sinksCount
      },
      keyContainers: Array.from(new Set(d.containers)).slice(0, 8),
      entryPoints: d.entryPoints,
      ownedStates: Array.from(d.ownedStates).slice(0, 8),
      dependsOnDomains: Array.from(d.outboundDomains.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([targetDom, weight]) => `${targetDom} (${weight} edges)`)
    }));
}

export function extractBackboneSpines(graph) {
  const spines = [];
  const seenKey = new Set();

  // Prioritize runtime entry sources or cross-bridge sources
  const candidateSources = Array.from(graph.symbolById.values())
    .filter(
      (s) =>
        s.zone === "prod" &&
        (s.kind === "function" || s.kind === "method") &&
        s.roles.includes("source") &&
        (graph.outEdges.get(s.id)?.size || 0) > 0
    )
    .sort((a, b) => {
      const aEntry = a.isEntrySource ? 1 : 0;
      const bEntry = b.isEntrySource ? 1 : 0;
      if (aEntry !== bEntry) return bEntry - aEntry;
      return (graph.outEdges.get(b.id)?.size || 0) - (graph.outEdges.get(a.id)?.size || 0);
    })
    .slice(0, 35);

  for (const src of candidateSources) {
    if (spines.length >= 8) break;
    const queue = [{ id: src.id, nodes: [src] }];
    const visited = new Set([src.id]);
    let bestCandidate = null;

    while (queue.length > 0) {
      const curr = queue.shift();
      const last = curr.nodes[curr.nodes.length - 1];
      if (
        curr.nodes.length >= 3 &&
        last.roles.includes("sink") &&
        (last.kind === "function" || last.kind === "method") &&
        !last.isConstructor &&
        last.name !== "__init__"
      ) {
        const hasBranch = curr.nodes.some((n) => n.roles.includes("branch"));
        const crossesFile = curr.nodes.some((n) => n.file !== src.file);
        if (hasBranch) {
          const candidate = {
            entrySource: shortId(src),
            terminalSink: shortId(last),
            crossesFile,
            hops: curr.nodes.length,
            pipeline: curr.nodes
              .map((n, idx) => {
                const tag =
                  idx === 0
                    ? "[Source]"
                    : idx === curr.nodes.length - 1
                      ? "[Sink]"
                      : n.roles.includes("branch")
                        ? "[Branch]"
                        : "[Pipe]";
                const label = n.parentContainerName ? `${n.parentContainerName}.${n.name}` : n.name;
                return `${tag} ${label} (${path.basename(n.file)}:${n.startLine})`;
              })
              .join(" ➔ ")
          };
          if (crossesFile && curr.nodes.length >= 4) {
            bestCandidate = candidate;
            break;
          }
          if (!bestCandidate || (candidate.crossesFile && !bestCandidate.crossesFile)) {
            bestCandidate = candidate;
          }
        }
      }
      if (curr.nodes.length >= 5) continue;
      const nextIds = Array.from(graph.outEdges.get(last.id) || []);
      nextIds.sort((a, b) => {
        const aSym = graph.symbolById.get(a);
        const bSym = graph.symbolById.get(b);
        const aCross = aSym && aSym.file !== last.file ? 1 : 0;
        const bCross = bSym && bSym.file !== last.file ? 1 : 0;
        if (aCross !== bCross) return bCross - aCross;
        return (graph.outEdges.get(b)?.size || 0) - (graph.outEdges.get(a)?.size || 0);
      });
      for (const nextId of nextIds.slice(0, 8)) {
        const nextSym = graph.symbolById.get(nextId);
        if (
          nextSym &&
          nextSym.zone === "prod" &&
          (nextSym.kind === "function" || nextSym.kind === "method") &&
          !visited.has(nextId)
        ) {
          visited.add(nextId);
          queue.push({ id: nextId, nodes: [...curr.nodes, nextSym] });
        }
      }
    }

    if (bestCandidate) {
      const key = `${bestCandidate.entrySource}->${bestCandidate.terminalSink}`;
      if (!seenKey.has(key)) {
        seenKey.add(key);
        delete bestCandidate.crossesFile;
        spines.push(bestCandidate);
      }
    }
  }
  return spines;
}

export function extractArchitecturalHubs(graph) {
  const candidates = [];
  for (const sym of graph.symbolById.values()) {
    if (sym.zone !== "prod" || (sym.kind !== "function" && sym.kind !== "method")) continue;
    const inDeg = (graph.callInEdges.get(sym.id) || new Set()).size;
    const outDeg = (graph.outEdges.get(sym.id) || new Set()).size;
    if (inDeg >= 1 && outDeg >= 2) {
      candidates.push({
        symbol: shortId(sym),
        file: sym.file,
        name: sym.name,
        domain: inferFileDomain(sym.file),
        roles: sym.roles,
        inDegree: inDeg,
        outDegree: outDeg,
        centralityScore: inDeg * outDeg
      });
    }
  }
  candidates.sort((a, b) => b.centralityScore - a.centralityScore);

  const hubs = [];
  const perFileCount = new Map();
  const seenFileAndName = new Set();
  for (const c of candidates) {
    if (hubs.length >= 10) break;
    const fnKey = `${c.file}::${c.name}`;
    if (seenFileAndName.has(fnKey)) continue;
    const fileCount = perFileCount.get(c.file) || 0;
    if (fileCount >= 2) continue;
    seenFileAndName.add(fnKey);
    perFileCount.set(c.file, fileCount + 1);
    hubs.push({
      symbol: c.symbol,
      domain: c.domain,
      roles: c.roles,
      inDegree: c.inDegree,
      outDegree: c.outDegree,
      centralityScore: c.centralityScore
    });
  }
  return hubs;
}

export function buildExtensionAndReserveCatalog(graph) {
  const polymorphicHierarchies = [];
  for (const [baseName, subs] of (graph.subclassesByBase || new Map()).entries()) {
    if (subs.length > 0) {
      polymorphicHierarchies.push({
        baseContract: baseName,
        implementationsCount: subs.length,
        implementations: subs.slice(0, 8).map((s) => `${s.name} (${s.file}:${s.startLine})`)
      });
    }
  }
  polymorphicHierarchies.sort((a, b) => b.implementationsCount - a.implementationsCount);

  const reservedSignatures = [];
  for (const sym of graph.symbolById.values()) {
    if (sym.zone !== "prod") continue;
    if (sym.reservedParams && sym.reservedParams.length > 0) {
      reservedSignatures.push({
        symbol: shortId(sym),
        reservedParams: sym.reservedParams,
        architecturalGuidance: "预留扩展/多态对齐参数：由子类重写、同族多态实现或跨平台条件编译消费，严禁盲目删除或破坏签名"
      });
    }
  }

  return {
    polymorphicHierarchies: polymorphicHierarchies.slice(0, 12),
    reservedContractsCount: reservedSignatures.length,
    reservedContractSignatures: reservedSignatures.slice(0, 15)
  };
}

export function computeSymbolArchContext(graph, sym) {
  // Transitive upstream BFS for blast radius
  const upstreamVisited = new Set([sym.id]);
  const upstreamFiles = new Set([sym.file]);
  const q = [sym.id];
  while (q.length > 0 && upstreamVisited.size < 250) {
    const curr = q.shift();
    for (const callerId of graph.callInEdges.get(curr) || []) {
      if (!upstreamVisited.has(callerId)) {
        upstreamVisited.add(callerId);
        const callerSym = graph.symbolById.get(callerId);
        if (callerSym) upstreamFiles.add(callerSym.file);
        q.push(callerId);
      }
    }
  }

  const directIn = (graph.callInEdges.get(sym.id) || new Set()).size;
  const directOut = (graph.outEdges.get(sym.id) || new Set()).size;
  const transitiveUp = upstreamVisited.size - 1;
  const riskLevel =
    transitiveUp >= 15 || upstreamFiles.size >= 5
      ? "HIGH_BLAST_RADIUS (核心枢纽，改签名将波及多模块)"
      : transitiveUp >= 3 || sym.isPublicApi
        ? "MEDIUM_MODULE_CONTRACT (模块级公开/共享接口)"
        : "LOW_LOCAL_SCOPE (局部内部实现)";

  const isConstructorName = /^(?:constructor|__init__|__construct|initialize|init|new)$/.test(sym.name);
  const peers = (graph.symbolsByName.get(sym.name) || [])
    .filter(
      (p) =>
        p.id !== sym.id &&
        p.zone === "prod" &&
        (!isConstructorName ||
          Boolean(sym.parentContainerName && p.parentContainerName === sym.parentContainerName) ||
          Boolean(sym.baseTypes && sym.baseTypes.includes(p.parentContainerName)) ||
          Boolean(p.baseTypes && p.baseTypes.includes(sym.parentContainerName)))
    )
    .slice(0, 6)
    .map(shortId);

  const reservedMap = new Map((sym.reservedParams || []).map((r) => [r.param, r]));
  const unusedSet = new Set(sym.unusedParams || []);
  const parameterFlowMatrix = (sym.params || []).map((p) => {
    if (reservedMap.has(p)) {
      const r = reservedMap.get(p);
      return { param: p, status: "RESERVED_CONTRACT", detail: r.peer || r.contract, kind: r.kind };
    }
    if (unusedSet.has(p)) {
      return { param: p, status: "DEAD_UNUSED", detail: "函数体内未读取且无多态契约消费" };
    }
    return { param: p, status: "CONSUMED_IN_BODY", detail: "已在函数体或构造初始化器中消费" };
  });

  return {
    domain: inferFileDomain(sym.file),
    container: sym.parentContainerName || null,
    visibility: sym.isPublicApi ? "public/exported" : "internal/private",
    signature: `${sym.name}(${(sym.params || []).join(", ")})${sym.hasReturnValue ? " -> value" : " -> void"}`,
    isExtensionHook: Boolean(sym.isExtensionHook),
    isFeatureGated: Boolean(sym.isFeatureGated),
    polymorphicPeers: peers,
    blastRadius: {
      directCallersCount: directIn,
      transitiveUpstreamCallersCount: transitiveUp,
      directCalleesCount: directOut,
      affectedFilesCount: upstreamFiles.size,
      riskLevel
    },
    parameterFlowMatrix
  };
}
