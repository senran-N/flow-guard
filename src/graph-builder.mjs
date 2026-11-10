import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { IGNORE_DIRS, EXT_LANG } from "./lang-presets.mjs";
import { parseSourceFile } from "./file-parser.mjs";
import { linkCrossBoundaryBridges } from "./bridge-linker.mjs";

let cachedGraph = null;
let cachedRoot = "";
let cachedAtMs = 0;
let cachedStamps = null;

function isCacheStillFresh(stamps) {
  if (!stamps) return false;
  for (let i = 0; i < stamps.length; i++) {
    const [targetPath, prevSize, prevMtime] = stamps[i];
    try {
      const st = fs.statSync(targetPath);
      if (st.size !== prevSize || st.mtimeMs !== prevMtime) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function buildWorkspaceFlowGraph(workspaceRoot, forceRebuild = false) {
  const normRoot = path.resolve(workspaceRoot);
  const now = performance.now();
  if (
    !forceRebuild &&
    cachedGraph &&
    cachedRoot === normRoot &&
    now - cachedAtMs < 2500 &&
    isCacheStillFresh(cachedStamps)
  ) {
    return cachedGraph;
  }

  const files = [];
  const nextStamps = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    const dirStat = fs.statSync(dir);
    nextStamps.push([dir, dirStat.size, dirStat.mtimeMs]);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        if (ent.name.endsWith(".d.ts") || ent.name.endsWith(".min.js") || ent.name.endsWith(".bundle.js")) continue;
        const ext = path.extname(ent.name).toLowerCase();
        if (EXT_LANG[ext]) {
          const fileStat = fs.statSync(full);
          nextStamps.push([full, fileStat.size, fileStat.mtimeMs]);
          const rel = path.relative(normRoot, full).replace(/\\/g, "/");
          const parsed = parseSourceFile(full, rel);
          if (parsed) files.push(parsed);
        }
      }
    }
  }

  walk(normRoot);
  cachedGraph = assembleFlowGraph(files, normRoot);
  cachedRoot = normRoot;
  cachedAtMs = performance.now();
  cachedStamps = nextStamps;
  return cachedGraph;
}

export function assembleFlowGraph(files, workspaceRoot = "") {
  const symbolById = new Map();
  const symbolsByName = new Map();
  const containersByName = new Map();
  const fileByPath = new Map();
  const tauriCommands = new Map();

  for (const f of files) {
    fileByPath.set(f.file, f);
    for (const s of f.symbols) {
      symbolById.set(s.id, s);
      if (!symbolsByName.has(s.name)) symbolsByName.set(s.name, []);
      symbolsByName.get(s.name).push(s);
      if (s.kind === "class" || s.kind === "struct") {
        if (!containersByName.has(s.name)) containersByName.set(s.name, []);
        containersByName.get(s.name).push(s);
      }
      if (s.isTauriCommand) tauriCommands.set(s.name, s);
    }
  }

  // Link cross-file Go receiver methods & Rust `impl` methods to their struct/class container in same package/dir
  const subclassesByBase = new Map();
  for (const sym of symbolById.values()) {
    if (!sym.parentContainerId && sym.parentContainerName) {
      const candidates = containersByName.get(sym.parentContainerName) || [];
      if (candidates.length > 0) {
        const symDir = path.dirname(sym.file);
        const sameDir = candidates.find((c) => path.dirname(c.file) === symDir);
        const chosen = sameDir || candidates[0];
        sym.parentContainerId = chosen.id;
      }
    }
    if ((sym.kind === "class" || sym.kind === "struct") && sym.zone === "prod") {
      for (const baseName of sym.baseTypes || []) {
        if (!subclassesByBase.has(baseName)) subclassesByBase.set(baseName, []);
        subclassesByBase.get(baseName).push(sym);
      }
    }
  }

  const outEdges = new Map();
  const inEdges = new Map();
  const callInEdges = new Map();
  const fileOutEdges = new Map();
  const fileInEdges = new Map();

  for (const id of symbolById.keys()) {
    outEdges.set(id, new Set());
    inEdges.set(id, new Set());
    callInEdges.set(id, new Set());
  }
  for (const f of files) {
    fileOutEdges.set(f.file, new Set());
    fileInEdges.set(f.file, new Set());
  }

  function addSymEdge(fromId, toId, isStructuralContainerEdge = false) {
    if (fromId === toId) return;
    if (!outEdges.has(fromId) || !inEdges.has(toId)) return;
    const fromSym = symbolById.get(fromId);
    const toSym = symbolById.get(toId);
    outEdges.get(fromId).add(toId);
    inEdges.get(toId).add(fromId);
    if (!isStructuralContainerEdge && (!fromSym || fromSym.zone === "prod")) {
      callInEdges.get(toId).add(fromId);
    }
    if (fromSym && toSym && fromSym.file !== toSym.file) {
      fileOutEdges.get(fromSym.file)?.add(toSym.file);
      fileInEdges.get(toSym.file)?.add(fromSym.file);
    }
  }

  // 0. Link Container (Class/Struct) <-> Member Methods (marked as structural edge so `callInEdges` stays pure)
  for (const sym of symbolById.values()) {
    if (sym.parentContainerId && symbolById.has(sym.parentContainerId)) {
      const parentSym = symbolById.get(sym.parentContainerId);
      if (parentSym && (parentSym.zone !== "prod" || sym.zone === "prod")) {
        addSymEdge(sym.parentContainerId, sym.id, true);
      }
    }
  }

  // Propagate 1-hop header includes (e.g., `foo.cpp` includes `foo.h` -> inherits stems included by `foo.h`)
  const filesByStem = new Map();
  for (const f of files) {
    const stem = path.basename(f.file, path.extname(f.file));
    if (!filesByStem.has(stem)) filesByStem.set(stem, []);
    filesByStem.get(stem).push(f);
  }
  for (const f of files) {
    if (f.lang === "cpp" && f.importedStems) {
      const expanded = new Set(f.importedStems);
      for (const st of f.importedStems) {
        for (const hdr of filesByStem.get(st) || []) {
          if (hdr.file.endsWith(".h") || hdr.file.endsWith(".hpp") || hdr.file.endsWith(".cuh")) {
            for (const sub of hdr.importedStems || []) expanded.add(sub);
          }
        }
      }
      f.importedStems = Array.from(expanded);
    }
  }

  // 1. Scoped Call Edge Resolution (with explicit import & module stem binding)
  for (const sym of symbolById.values()) {
    const callerFileObj = fileByPath.get(sym.file);
    const importedSet = new Set(callerFileObj?.importedStems || []);
    const importedPaths = callerFileObj?.importedPaths || [];
    const callSet = new Set(sym.calls);
    const symDir = path.dirname(sym.file);

    const qualifiedReceiversForMember = new Map();
    for (const qc of sym.qualifiedCalls || []) {
      if (!qualifiedReceiversForMember.has(qc.member)) {
        qualifiedReceiversForMember.set(qc.member, new Set());
      }
      qualifiedReceiversForMember.get(qc.member).add(qc.receiver);
    }

    for (const calleeName of sym.calls) {
      if (/^(main|wmain|WinMain|wWinMain|DllMain)$/.test(calleeName)) continue;
      const targets = symbolsByName.get(calleeName) || [];
      const qualRecvs = qualifiedReceiversForMember.get(calleeName);
      const hasExternalQualifier =
        qualRecvs &&
        Array.from(qualRecvs).some((r) => r !== "this" && r !== "self" && r !== sym.parentContainerName);

      const sameFileTargets = targets.filter(
        (t) => t.file === sym.file && t.id !== sym.id && (sym.zone !== "prod" || t.zone === "prod")
      );
      if (sameFileTargets.length > 0 && !/^[A-Z]/.test(calleeName) && !hasExternalQualifier) {
        for (const t of sameFileTargets) addSymEdge(sym.id, t.id);
        continue;
      }

      for (const t of targets) {
        if (t.id === sym.id) continue;
        const targetStem = path.basename(t.file, path.extname(t.file));

        // Never link `prod` to `test`/`sandbox` unless `prod` explicitly imports that specific non-prod path
        if (sym.zone === "prod" && t.zone !== "prod") {
          const tDir = path.dirname(t.file).replace(/\\/g, "/");
          const matchesTargetImport = importedPaths.some(
            (p) => p.includes(tDir) && p.includes(targetStem)
          );
          if (!matchesTargetImport) {
            continue;
          }
        }

        const sameLangFamily =
          t.lang === sym.lang ||
          (sym.lang === "vue" && t.lang === "ts") ||
          (sym.lang === "ts" && t.lang === "vue") ||
          (sym.lang === "java" && t.lang === "kotlin") ||
          (sym.lang === "kotlin" && t.lang === "java");
        if (!sameLangFamily) continue;

        if (t.file === sym.file) {
          addSymEdge(sym.id, t.id);
        } else {
          // Standalone executable entry files (`apps/*`, `tools/*`, `plugins/*` `main.*`) are never imported as libraries by other directories
          const tDirNorm = path.dirname(t.file).replace(/\\/g, "/");
          const symDirNorm = symDir.replace(/\\/g, "/");
          if (
            tDirNorm !== symDirNorm &&
            /^(apps|tools|plugins|cmd|bin)\//.test(tDirNorm) &&
            /^main\./i.test(path.basename(t.file))
          ) {
            continue;
          }

          if (
            importedSet.has(targetStem) ||
            callSet.has(targetStem) ||
            (t.parentContainerName && (callSet.has(t.parentContainerName) || importedSet.has(t.parentContainerName))) ||
            calleeName === targetStem ||
            ((t.kind === "class" || t.kind === "struct") && (importedSet.size === 0 || importedSet.has(targetStem) || path.dirname(t.file) === symDir)) ||
            (t.lang === "go" && path.dirname(t.file) === symDir) ||
            (t.lang === "cpp" && path.dirname(t.file) === symDir) ||
            (importedSet.size === 0 &&
              (t.lang === "csharp" || t.lang === "java" || t.lang === "kotlin" || t.lang === "swift" || t.lang === "cpp"))
          ) {
            addSymEdge(sym.id, t.id);
          }
        }
      }
    }
  }

  // 2. Cross-Boundary Bridges
  const crossBridges = linkCrossBoundaryBridges(files, tauriCommands, addSymEdge, symbolsByName);
  const bridgeSources = new Set();
  const bridgeSinks = new Set();
  for (const b of crossBridges) {
    for (const s of symbolsByName.get(b.toSymbol) || []) {
      if (s.file === b.toFile) bridgeSources.add(s.id);
    }
    for (const s of symbolsByName.get(b.fromSymbol) || []) {
      if (s.file === b.fromFile) bridgeSinks.add(s.id);
    }
  }

  // 3. State Ownership Map (Writer -> Reader Data-Flow Edges)
  const stateOwnership = new Map();
  for (const sym of symbolById.values()) {
    if (sym.zone !== "prod") continue;
    for (const w of sym.writes) {
      if (!stateOwnership.has(w)) stateOwnership.set(w, { field: w, writers: [], readers: [] });
      stateOwnership.get(w).writers.push(sym.id);
    }
    for (const r of sym.reads) {
      if (!stateOwnership.has(r)) stateOwnership.set(r, { field: r, writers: [], readers: [] });
      stateOwnership.get(r).readers.push(sym.id);
    }
  }
  for (const st of stateOwnership.values()) {
    for (const wId of st.writers) {
      const wSym = symbolById.get(wId);
      if (!wSym) continue;
      for (const rId of st.readers) {
        const rSym = symbolById.get(rId);
        if (!rSym) continue;
        const sameLang =
          wSym.lang === rSym.lang ||
          (wSym.lang === "vue" && rSym.lang === "ts") ||
          (wSym.lang === "ts" && rSym.lang === "vue");
        if (!sameLang) continue;
        if (
          wSym.file === rSym.file ||
          (wSym.parentContainerName && wSym.parentContainerName === rSym.parentContainerName)
        ) {
          addSymEdge(wId, rId);
        }
      }
    }
  }

  // 4. Internal vs. External Symbol Table Diff & Topological Role Assignment
  const PURE_RECEIVERS =
    /^(?:Math|JSON|Object|Array|Number|String|Boolean|RegExp|Date|Symbol|BigInt|Reflect|Intl|Buffer|path|url|querystring|performance|crypto|strconv|strings|bytes|filepath|unicode|utf8)$/;
  const PURE_MEMBER_METHODS =
    /^(?:has|get|at|exec|compile|localeCompare|normalize|codePointAt|trim|trimStart|trimEnd|slice|substring|substr|split|join|replace|replaceAll|toLowerCase|toUpperCase|startsWith|endsWith|includes|indexOf|lastIndexOf|charAt|charCodeAt|padStart|padEnd|repeat|match|search|test|map|filter|reduce|reduceRight|find|findIndex|some|every|flat|flatMap|concat|keys|values|entries|from|of|isArray|freeze|hasOwnProperty|toString|valueOf|toFixed|toPrecision|parseInt|parseFloat|isNaN|isFinite|abs|ceil|floor|round|max|min|pow|sqrt|trunc|sign|sin|cos|tan|exp|stringify|parse|clone|len|len_utf8|is_empty|as_str|as_bytes|to_owned|to_string|into|iter|into_iter|chars|lines|bytes|collect|unwrap|unwrap_or|unwrap_or_else|unwrap_or_default|expect|ok|err|is_some|is_none|is_ok|is_err|map_err|and_then|or_else|as_ref|as_mut|cloned|copied|take|skip|enumerate|zip|chain|any|all|count|sum|strip_prefix|strip_suffix|equals|hashCode|compareTo|length|size|isEmpty|contains|containsKey|containsValue|stream|toList|toArray|Select|Where|OrderBy|OrderByDescending|ThenBy|ToList|ToArray|FirstOrDefault|SingleOrDefault|Any|All|Count|Sum|Min|Max|Distinct|GroupBy|ToDictionary|strip|lstrip|rstrip|lower|upper|title|capitalize|splitlines|startswith|endswith|isdigit|isalpha|isalnum|items|copy|Sprintf|Errorf)$/;
  const HTTP_OR_ROUTE_RECEIVERS = /^(?:axios|http|https|got|ky|superagent|request|client|api|app|router|mux)$/i;
  const IO_MEMBER_METHODS =
    /^(?:Write|WriteLine|Send|Emit|Flush|Close|Dispose|Save|Execute|Commit|Publish|Broadcast|Dispatch|write|send|emit|flush|close|dispose|save|commit|publish|broadcast|dispatch|postMessage|setItem|removeItem)$/;

  for (const sym of symbolById.values()) {
    const outSet = outEdges.get(sym.id) || new Set();
    const inSet = inEdges.get(sym.id) || new Set();
    const callInSet = callInEdges.get(sym.id) || new Set();

    const resolvedInternalCalleeNames = new Set();
    for (const targetId of outSet) {
      const targetSym = symbolById.get(targetId);
      if (targetSym) resolvedInternalCalleeNames.add(targetSym.name);
    }

    let callsExternalBoundary = false;
    for (const qc of sym.qualifiedCalls || []) {
      if (qc.isLocal && !IO_MEMBER_METHODS.test(qc.member)) continue;
      if (PURE_RECEIVERS.test(qc.rootReceiver || qc.receiver)) continue;
      if (PURE_MEMBER_METHODS.test(qc.member) && !(qc.member === "get" && HTTP_OR_ROUTE_RECEIVERS.test(qc.receiver))) {
        continue;
      }
      if (!resolvedInternalCalleeNames.has(qc.member) && !symbolsByName.has(qc.receiver)) {
        callsExternalBoundary = true;
        break;
      }
    }
    sym.hasExternalBoundaryEffect = callsExternalBoundary;

    const roles = new Set();

    const isExposedPublicApi =
      (sym.isPublicApi || sym.isReferencedInFile) &&
      (sym.kind === "function" || sym.kind === "method");

    if (
      sym.isEntrySource ||
      bridgeSources.has(sym.id) ||
      (isExposedPublicApi && callInSet.size === 0)
    ) {
      roles.add("source");
    }
    if (
      (inSet.size > 0 || sym.isEntrySource || isExposedPublicApi) &&
      ((sym.conditionalCount >= 1 && outSet.size >= 2) || outSet.size >= 3)
    ) {
      roles.add("branch");
    }
    if (
      sym.writes.length > 0 ||
      sym.hasInternalMutation ||
      sym.hasExternalBoundaryEffect ||
      bridgeSinks.has(sym.id)
    ) {
      roles.add("sink");
    }
    if (roles.size === 0) roles.add("pipe");
    sym.roles = Array.from(roles);
  }

  // 5. Bidirectional BFS (Forward from Prod Sources & Public Library Roots, Backward from Prod Sinks)
  const reachableFromSource = new Set();
  const sourceQueue = [];
  for (const sym of symbolById.values()) {
    if (sym.zone === "prod" && sym.roles.includes("source")) {
      reachableFromSource.add(sym.id);
      sourceQueue.push(sym.id);
    }
  }
  while (sourceQueue.length > 0) {
    const curr = sourceQueue.shift();
    for (const next of outEdges.get(curr) || []) {
      if (!reachableFromSource.has(next)) {
        reachableFromSource.add(next);
        sourceQueue.push(next);
      }
    }
  }
  // Ensure mutually-recursive exported library APIs (with no uncalled root) are also marked reachable
  for (const sym of symbolById.values()) {
    if (
      sym.zone === "prod" &&
      !reachableFromSource.has(sym.id) &&
      (sym.isPublicApi || sym.isReferencedInFile) &&
      (sym.kind === "function" || sym.kind === "method")
    ) {
      reachableFromSource.add(sym.id);
      sourceQueue.push(sym.id);
    }
  }
  while (sourceQueue.length > 0) {
    const curr = sourceQueue.shift();
    for (const next of outEdges.get(curr) || []) {
      if (!reachableFromSource.has(next)) {
        reachableFromSource.add(next);
        sourceQueue.push(next);
      }
    }
  }

  const reachesSideEffectSink = new Set();
  const sinkQueue = [];
  for (const sym of symbolById.values()) {
    if (sym.zone === "prod" && sym.roles.includes("sink")) {
      reachesSideEffectSink.add(sym.id);
      sinkQueue.push(sym.id);
    }
  }
  while (sinkQueue.length > 0) {
    const curr = sinkQueue.shift();
    for (const prev of inEdges.get(curr) || []) {
      if (!reachesSideEffectSink.has(prev)) {
        reachesSideEffectSink.add(prev);
        sinkQueue.push(prev);
      }
    }
  }

  // Full causal sink reachability: includes side-effect sinks, public/entry API value outputs, and value-returning helpers consumed by sink-reaching callers
  const reachesSink = new Set(reachesSideEffectSink);
  const valSinkQueue = Array.from(reachesSink);
  for (const sym of symbolById.values()) {
    if (
      sym.zone === "prod" &&
      !reachesSink.has(sym.id) &&
      (sym.hasReturnValue || sym.isContractMethod || sym.isExtensionHook) &&
      (sym.isPublicApi || sym.roles.includes("source"))
    ) {
      reachesSink.add(sym.id);
      valSinkQueue.push(sym.id);
    }
  }
  // If `caller` reaches a sink and calls `callee` to consume its return value (or contract method), `callee`'s output flows into `caller` -> sink
  while (valSinkQueue.length > 0) {
    const curr = valSinkQueue.shift();
    for (const calleeId of outEdges.get(curr) || []) {
      const callee = symbolById.get(calleeId);
      if (callee && callee.zone === "prod" && !reachesSink.has(calleeId) && (callee.hasReturnValue || callee.isContractMethod || callee.isExtensionHook)) {
        reachesSink.add(calleeId);
        valSinkQueue.push(calleeId);
      }
    }
    for (const callerId of inEdges.get(curr) || []) {
      const caller = symbolById.get(callerId);
      if (caller && caller.zone === "prod" && !reachesSink.has(callerId)) {
        reachesSink.add(callerId);
        valSinkQueue.push(callerId);
      }
    }
  }

  // Sync container (`class`/`struct`/`module`) reachability with their member methods & active files
  const activeProdFiles = new Set();
  const sinkProdFiles = new Set();
  for (const id of reachableFromSource) {
    const s = symbolById.get(id);
    if (s) activeProdFiles.add(s.file);
  }
  for (const id of reachesSink) {
    const s = symbolById.get(id);
    if (s) sinkProdFiles.add(s.file);
  }
  for (const sym of symbolById.values()) {
    if (sym.zone !== "prod") continue;
    if (sym.parentContainerId && reachableFromSource.has(sym.id)) {
      reachableFromSource.add(sym.parentContainerId);
    }
    if (sym.parentContainerId && reachesSink.has(sym.id)) {
      reachesSink.add(sym.parentContainerId);
    }
    if (
      (sym.kind === "class" || sym.kind === "struct" || sym.kind === "module") &&
      (sym.isPublicApi || activeProdFiles.has(sym.file))
    ) {
      reachableFromSource.add(sym.id);
    }
    if (
      (sym.kind === "class" || sym.kind === "struct" || sym.kind === "module") &&
      sinkProdFiles.has(sym.file)
    ) {
      reachesSink.add(sym.id);
    }
  }

  // 6. Reconcile Polymorphic Contracts, Subclassed Base Hooks, and `#[cfg]` Platform Twins
  for (const sym of symbolById.values()) {
    if (sym.zone !== "prod" || (sym.kind !== "function" && sym.kind !== "method")) continue;
    const isSubclassedBaseMethod =
      Boolean(sym.parentContainerName && subclassesByBase.has(sym.parentContainerName)) &&
      !sym.name.startsWith("_");
    const peers = (symbolsByName.get(sym.name) || []).filter(
      (p) => p.id !== sym.id && p.zone === "prod" && p.params.length === sym.params.length && p.params.length > 0
    );

    if (sym.unusedParams.length > 0) {
      const stillUnused = [];
      const reserved = [];
      for (const pName of sym.unusedParams) {
        const pIdx = sym.params.indexOf(pName);
        const consumingPeer =
          pIdx >= 0
            ? peers.find((peer) => {
                const peerParam = peer.params[pIdx];
                return peerParam && !peer.unusedParams.includes(peerParam);
              })
            : null;
        if (consumingPeer) {
          const peerLabel = consumingPeer.parentContainerName
            ? `${consumingPeer.parentContainerName}.${consumingPeer.name}`
            : `${path.basename(consumingPeer.file)}:${consumingPeer.name}`;
          reserved.push({
            param: pName,
            kind: "POLYMORPHIC_OR_PLATFORM_TWIN",
            peer: `${consumingPeer.file}:${consumingPeer.startLine} (${peerLabel})`
          });
        } else if (sym.isExtensionHook || isSubclassedBaseMethod || sym.isFeatureGated) {
          reserved.push({
            param: pName,
            kind: sym.isFeatureGated ? "FEATURE_GATED_SIGNATURE" : "OVERRIDABLE_EXTENSION_HOOK",
            contract: sym.parentContainerName || sym.name
          });
        } else {
          stillUnused.push(pName);
        }
      }
      sym.unusedParams = stillUnused;
      sym.reservedParams = reserved;
    }
  }

  return {
    workspaceRoot,
    files,
    fileByPath,
    symbolById,
    symbolsByName,
    containersByName,
    subclassesByBase,
    outEdges,
    inEdges,
    callInEdges,
    fileOutEdges,
    fileInEdges,
    crossBridges,
    stateOwnership,
    reachableFromSource,
    reachesSideEffectSink,
    reachesSink
  };
}

export function getGitWorkingTreeStatus(workspaceRoot) {
  if (!fs.existsSync(path.join(workspaceRoot, ".git"))) {
    return { isGitRepo: false, changedFiles: [], addedAntiPatterns: [] };
  }
  try {
    const statusOut = execSync("git status --porcelain", {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const changedFiles = statusOut
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0 && !/^\s*D\s/.test(l))
      .map((l) => {
        const raw = l.slice(3).trim();
        const target = raw.includes(" -> ") ? raw.split(" -> ").pop() : raw;
        return target.replace(/^"|"$/g, "").replace(/\\/g, "/");
      });

    const addedAntiPatterns = [];
    if (changedFiles.length > 0) {
      const diffText = execSync("git diff -U0 HEAD", {
        cwd: workspaceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
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
    }

    return { isGitRepo: true, changedFiles, addedAntiPatterns };
  } catch {
    return { isGitRepo: false, changedFiles: [], addedAntiPatterns: [] };
  }
}
