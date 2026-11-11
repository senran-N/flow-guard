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
const perFileParseCache = new Map();

function cloneParsedFile(raw) {
  return {
    ...raw,
    importedStems: [...(raw.importedStems || [])],
    importedPaths: [...(raw.importedPaths || [])],
    reExportedPaths: [...(raw.reExportedPaths || [])],
    reExportedStems: [...(raw.reExportedStems || [])],
    memberReads: [...(raw.memberReads || [])],
    fileCalls: [...(raw.fileCalls || [])],
    symbols: raw.symbols.map((s) => ({
      ...s,
      parentContainerId: s.parentContainerId,
      isPublicApi: s.isPublicApi,
      roles: [...(s.roles || [])],
      unusedParams: [...(s.unusedParams || [])],
      reservedParams: [...(s.reservedParams || [])],
      localVars: [...(s.localVars || [])],
      calls: [...(s.calls || [])],
      writes: [...(s.writes || [])],
      reads: [...(s.reads || [])]
    }))
  };
}

export function clearFlowGraphCache() {
  cachedGraph = null;
  cachedRoot = "";
  cachedAtMs = 0;
  cachedStamps = null;
  perFileParseCache.clear();
}

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
  if (perFileParseCache.size > 10000) perFileParseCache.clear();

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
        if (
          ent.name.endsWith(".d.ts") ||
          ent.name.endsWith(".min.js") ||
          ent.name.endsWith(".bundle.js") ||
          ent.name.endsWith(".wasm.js")
        )
          continue;
        const ext = path.extname(ent.name).toLowerCase();
        if (EXT_LANG[ext]) {
          const fileStat = fs.statSync(full);
          nextStamps.push([full, fileStat.size, fileStat.mtimeMs]);
          const rel = path.relative(normRoot, full).replace(/\\/g, "/");
          const cached = perFileParseCache.get(full);
          if (
            cached &&
            cached.rel === rel &&
            cached.size === fileStat.size &&
            cached.mtimeMs === fileStat.mtimeMs
          ) {
            files.push(cloneParsedFile(cached.rawParsed));
          } else {
            const parsed = parseSourceFile(full, rel);
            if (parsed) {
              perFileParseCache.set(full, {
                rel,
                size: fileStat.size,
                mtimeMs: fileStat.mtimeMs,
                rawParsed: parsed
              });
              files.push(cloneParsedFile(parsed));
            }
          }
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
      if (s.isTauriCommand && s.zone === "prod") tauriCommands.set(s.name, s);
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

  // Propagate 1-hop C++ header includes & multi-hop Barrel Re-Exports (`export * from`, `export { x } from`, `pub mod/use`, `__init__.py`)
  const filesByStem = new Map();
  const filesByNoExt = new Map();
  const stripCodeExt = (p) =>
    p.replace(/\.(?:[cm]?[jt]sx?|vue|svelte|py|rs|php|rb|h|hpp|cuh|cpp|cc|cxx|c|go|cs|java|kt|swift|dart)$/i, "");
  for (const f of files) {
    const stem = path.basename(f.file, path.extname(f.file));
    if (!filesByStem.has(stem)) filesByStem.set(stem, []);
    filesByStem.get(stem).push(f);
    const noExt = stripCodeExt(f.file.replace(/\\/g, "/"));
    if (!filesByNoExt.has(noExt)) filesByNoExt.set(noExt, []);
    filesByNoExt.get(noExt).push(f);
  }

  function resolveImportTargetFiles(fromFileRel, rawSpec, lang) {
    if (!rawSpec) return [];
    const results = new Set();
    const addCandidates = (noExtKey) => {
      for (const suffix of ["", "/index", "/__init__", "/mod"]) {
        for (const match of filesByNoExt.get(noExtKey + suffix) || []) {
          results.add(match);
        }
      }
    };

    const fromDir = path.posix.dirname(fromFileRel.replace(/\\/g, "/"));
    if (lang === "python") {
      const dotMatch = rawSpec.match(/^(\.+)(.*)$/);
      if (dotMatch) {
        const dots = dotMatch[1].length;
        const rest = dotMatch[2].replace(/\./g, "/");
        const upSegments = dots > 1 ? Array(dots - 1).fill("..").join("/") : ".";
        const joined = path.posix.normalize(path.posix.join(fromDir, upSegments, rest));
        addCandidates(stripCodeExt(joined));
      } else {
        addCandidates(rawSpec.replace(/\./g, "/"));
      }
    } else if (rawSpec.startsWith(".")) {
      const joined = path.posix.normalize(path.posix.join(fromDir, rawSpec.replace(/\\/g, "/")));
      addCandidates(stripCodeExt(joined));
    } else if (/^[@~]\//.test(rawSpec)) {
      const stripped = stripCodeExt(rawSpec.slice(2));
      addCandidates(stripped);
      addCandidates(`src/${stripped}`);
    } else if (lang === "dart" && !rawSpec.startsWith("dart:")) {
      addCandidates(stripCodeExt(rawSpec));
    }
    return Array.from(results);
  }

  // Compute transitive resolved target files & stems per file (across C++ headers & multi-hop barrel re-exports)
  const resolvedImportedFilesByFile = new Map();
  for (const f of files) {
    const expandedStems = new Set(f.importedStems || []);
    const resolvedFiles = new Set();

    if (f.lang === "cpp" && f.importedStems) {
      for (const st of f.importedStems) {
        for (const hdr of filesByStem.get(st) || []) {
          if (hdr.file.endsWith(".h") || hdr.file.endsWith(".hpp") || hdr.file.endsWith(".cuh")) {
            resolvedFiles.add(hdr.file);
            for (const sub of hdr.importedStems || []) expandedStems.add(sub);
          }
        }
      }
    }

    const queue = [];
    for (const spec of f.importedPaths || []) {
      for (const tf of resolveImportTargetFiles(f.file, spec, f.lang)) {
        queue.push({ tf, depth: 0 });
      }
    }
    if (f.lang === "rust") {
      const fDir = path.posix.dirname(f.file.replace(/\\/g, "/"));
      for (const st of f.importedStems || []) {
        for (const cand of filesByStem.get(st) || []) {
          if (cand.lang === "rust" && cand.file !== f.file && cand.file.startsWith(fDir === "." ? "" : fDir)) {
            queue.push({ tf: cand, depth: 0 });
          }
        }
      }
    }

    const visitedBarrelFiles = new Set();
    while (queue.length > 0) {
      const { tf, depth } = queue.shift();
      resolvedFiles.add(tf.file);
      const tfStem = path.basename(tf.file, path.extname(tf.file));
      if (tfStem) expandedStems.add(tfStem);
      if (depth >= 5 || visitedBarrelFiles.has(tf.file)) continue;
      visitedBarrelFiles.add(tf.file);

      for (const reSpec of tf.reExportedPaths || []) {
        for (const nextTf of resolveImportTargetFiles(tf.file, reSpec, tf.lang)) {
          queue.push({ tf: nextTf, depth: depth + 1 });
        }
      }
      for (const reStem of tf.reExportedStems || []) {
        expandedStems.add(reStem);
        const tfDir = path.posix.dirname(tf.file.replace(/\\/g, "/"));
        for (const nextTf of filesByStem.get(reStem) || []) {
          if (nextTf.lang === tf.lang && (tfDir === "." || nextTf.file.startsWith(tfDir))) {
            queue.push({ tf: nextTf, depth: depth + 1 });
          }
        }
      }
    }

    f.importedStems = Array.from(expandedStems);
    resolvedImportedFilesByFile.set(f.file, resolvedFiles);
  }

  // 1. Scoped Call Edge Resolution (with explicit import, barrel re-export & module stem binding)
  for (const sym of symbolById.values()) {
    const callerFileObj = fileByPath.get(sym.file);
    const importedSet = new Set(callerFileObj?.importedStems || []);
    const importedPaths = callerFileObj?.importedPaths || [];
    const resolvedImportFiles = resolvedImportedFilesByFile.get(sym.file) || new Set();
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

        // Never link `prod` to `test`/`sandbox` unless `prod` explicitly imports (or transitively barrel-imports) an external non-prod file
        if (sym.zone === "prod" && t.zone !== "prod") {
          const tFileObj = fileByPath.get(t.file);
          if (!tFileObj || tFileObj.zone === "prod") {
            continue;
          }
          const tDir = path.dirname(t.file).replace(/\\/g, "/");
          const matchesTargetImport =
            resolvedImportFiles.has(t.file) ||
            importedPaths.some((p) => p.includes(tDir) && p.includes(targetStem));
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
            resolvedImportFiles.has(t.file) ||
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

  // 3. Container-Scoped State Ownership Map (Writer -> Reader Data-Flow Edges + Cross-File Public `.prop` Reconciliation)
  function rootContainerOf(containerName) {
    if (!containerName) return null;
    let curr = containerName;
    const visited = new Set([curr]);
    for (let hop = 0; hop < 4; hop++) {
      const cSyms = containersByName.get(curr) || [];
      const baseWithContainer = cSyms
        .flatMap((c) => c.baseTypes || [])
        .find((b) => containersByName.has(b) && !visited.has(b));
      if (!baseWithContainer) break;
      visited.add(baseWithContainer);
      curr = baseWithContainer;
    }
    return curr;
  }

  const privateFieldsByRoot = new Map();
  for (const f of files) {
    for (const [cName, fList] of Object.entries(f.privateFieldsByContainer || {})) {
      const root = rootContainerOf(cName) || cName;
      if (!privateFieldsByRoot.has(root)) privateFieldsByRoot.set(root, new Set());
      const targetSet = privateFieldsByRoot.get(root);
      for (const fld of fList) targetSet.add(fld);
    }
  }

  const stateOwnership = new Map();
  const stateKeysBySymbol = new Map();
  const recordSymStateKey = (symId, key) => {
    if (!stateKeysBySymbol.has(symId)) stateKeysBySymbol.set(symId, new Set());
    stateKeysBySymbol.get(symId).add(key);
  };
  const ensureStateEntry = (scope, field) => {
    const key = scope ? `${scope}.${field}` : field;
    if (!stateOwnership.has(key)) {
      const isPrivate =
        field.startsWith("#") ||
        (field.startsWith("__") && !field.endsWith("__")) ||
        Boolean(scope && privateFieldsByRoot.get(scope)?.has(field));
      stateOwnership.set(key, {
        key,
        scope: scope || null,
        field,
        qualifiedField: key,
        isPrivate,
        writers: [],
        readers: []
      });
    }
    return stateOwnership.get(key);
  };

  for (const sym of symbolById.values()) {
    if (sym.zone !== "prod") continue;
    const rawContainer = sym.kind === "class" || sym.kind === "struct" ? sym.name : sym.parentContainerName;
    const scope = rootContainerOf(rawContainer);
    for (const w of sym.writes) {
      const entry = ensureStateEntry(scope, w);
      if (!entry.writers.includes(sym.id)) entry.writers.push(sym.id);
      recordSymStateKey(sym.id, entry.key);
    }
    for (const r of sym.reads) {
      const entry = ensureStateEntry(scope, r);
      if (!entry.readers.includes(sym.id)) entry.readers.push(sym.id);
      recordSymStateKey(sym.id, entry.key);
    }
  }

  // Reconcile non-private container fields read by same-file standalone functions or cross-file `.prop` consumers
  const prodFilesForReads = files.filter((f) => f.zone === "prod");
  for (const st of stateOwnership.values()) {
    if (!st.scope || st.isPrivate || st.writers.length === 0) continue;
    for (const wId of st.writers) {
      const wSym = symbolById.get(wId);
      if (!wSym) continue;
      const wFileObj = fileByPath.get(wSym.file);
      const wStem = path.basename(wSym.file, path.extname(wSym.file));
      const wDir = path.dirname(wSym.file);
      const wImportedStems = new Set(wFileObj?.importedStems || []);

      // 3a. Same-file non-container functions reading `instance.field`
      for (const s of wFileObj?.symbols || []) {
        if (s.zone === "prod" && !s.parentContainerName && s.reads.includes(st.field)) {
          if (!st.readers.includes(s.id)) st.readers.push(s.id);
          recordSymStateKey(s.id, st.key);
        }
      }

      // 3b. Cross-file `.prop` memberReads in prod files connected by import, container reference, or package dir
      for (const rf of prodFilesForReads) {
        if (rf.file === wSym.file) continue;
        if (!(rf.memberReads || []).includes(st.field)) continue;
        const rfResolved = resolvedImportedFilesByFile.get(rf.file) || new Set();
        const rfStems = new Set(rf.importedStems || []);
        const rfCalls = new Set(rf.fileCalls || []);
        const sharesImportedStore =
          wImportedStems.size > 0 && Array.from(wImportedStems).some((stem) => rfStems.has(stem));
        const connectedToWriter =
          rfResolved.has(wSym.file) ||
          rfStems.has(wStem) ||
          rfStems.has(st.scope) ||
          rfCalls.has(st.scope) ||
          (wSym.parentContainerName && (rfStems.has(wSym.parentContainerName) || rfCalls.has(wSym.parentContainerName))) ||
          sharesImportedStore ||
          (path.dirname(rf.file) === wDir &&
            (rf.lang === "go" || rf.lang === "csharp" || rf.lang === "java" || rf.lang === "kotlin" || rf.lang === "swift" || rf.lang === "cpp"));
        if (!connectedToWriter) continue;

        const matchingSyms = rf.symbols.filter((s) => s.zone === "prod" && s.reads.includes(st.field));
        const chosenReaders =
          matchingSyms.length > 0
            ? matchingSyms
            : rf.symbols.filter((s) => s.zone === "prod" && (s.kind === "function" || s.kind === "method")).slice(0, 1);
        for (const rSym of chosenReaders.length > 0 ? chosenReaders : rf.symbols.slice(0, 1)) {
          if (rSym && rSym.zone === "prod") {
            if (!st.readers.includes(rSym.id)) st.readers.push(rSym.id);
            recordSymStateKey(rSym.id, st.key);
          }
        }
      }
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
          (wSym.lang === "ts" && rSym.lang === "vue") ||
          (wSym.lang === "java" && rSym.lang === "kotlin") ||
          (wSym.lang === "kotlin" && rSym.lang === "java");
        if (!sameLang) continue;
        if (
          st.scope ||
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

  // 6. Reconcile Polymorphic Contracts, Subclassed Base Hooks, `#[cfg]` Platform Twins, and Callback Dispatch Signatures
  const origUnusedBySym = new Map();
  const prodFnsByFile = new Map();
  const prodFnsByDir = new Map();
  for (const s of symbolById.values()) {
    if (s.zone !== "prod" || (s.kind !== "function" && s.kind !== "method")) continue;
    origUnusedBySym.set(s.id, new Set(s.unusedParams));
    if (!prodFnsByFile.has(s.file)) prodFnsByFile.set(s.file, []);
    prodFnsByFile.get(s.file).push(s);
    const sDir = path.dirname(s.file);
    if (!prodFnsByDir.has(sDir)) prodFnsByDir.set(sDir, []);
    prodFnsByDir.get(sDir).push(s);
  }

  for (const sym of symbolById.values()) {
    if (sym.zone !== "prod" || (sym.kind !== "function" && sym.kind !== "method")) continue;
    const isSubclassedBaseMethod =
      Boolean(sym.parentContainerName && subclassesByBase.has(sym.parentContainerName)) &&
      !sym.name.startsWith("_");
    const isConstructorName = /^(?:constructor|__init__|__construct|initialize|init|new)$/.test(sym.name);
    const peers = (symbolsByName.get(sym.name) || []).filter(
      (p) =>
        p.id !== sym.id &&
        p.zone === "prod" &&
        p.params.length === sym.params.length &&
        p.params.length > 0 &&
        (!isConstructorName ||
          Boolean(sym.parentContainerName && p.parentContainerName === sym.parentContainerName) ||
          Boolean(sym.baseTypes && sym.baseTypes.includes(p.parentContainerName)) ||
          Boolean(p.baseTypes && p.baseTypes.includes(sym.parentContainerName)))
    );

    if (sym.unusedParams.length > 0) {
      const stillUnused = [];
      const reserved = [];
      const handlerPrefixMatch = sym.name.match(/^(bind|register|handle|on|cmd_|f_)[A-Za-z0-9_]/);
      const handlerPrefix = handlerPrefixMatch ? handlerPrefixMatch[1] : null;
      const sameFileFns = prodFnsByFile.get(sym.file) || [];
      const sameDirFns = handlerPrefix ? prodFnsByDir.get(path.dirname(sym.file)) || [] : [];

      for (const pName of sym.unusedParams) {
        const pIdx = sym.params.indexOf(pName);
        const consumingPeer =
          pIdx >= 0
            ? peers.find((peer) => {
                const peerParam = peer.params[pIdx];
                return peerParam && !origUnusedBySym.get(peer.id)?.has(peerParam);
              })
            : null;

        let dispatchConsumingPeer = null;
        if (!consumingPeer && pIdx >= 0) {
          if (sym.isReferencedInFile) {
            const cbPeers = sameFileFns.filter(
              (p) => p.id !== sym.id && p.isReferencedInFile && p.params[pIdx] === pName
            );
            if (cbPeers.length >= 2) {
              dispatchConsumingPeer = cbPeers.find((p) => !origUnusedBySym.get(p.id)?.has(pName)) || null;
            }
          }
          if (!dispatchConsumingPeer && handlerPrefix) {
            const prefixPeers = sameDirFns.filter(
              (p) =>
                p.id !== sym.id &&
                p.name.startsWith(handlerPrefix) &&
                p.params.length === sym.params.length &&
                p.params[pIdx] === pName
            );
            if (prefixPeers.length >= 2) {
              dispatchConsumingPeer = prefixPeers.find((p) => !origUnusedBySym.get(p.id)?.has(pName)) || null;
            }
          }
        }

        let interfaceContractPeers = [];
        if (!consumingPeer && !dispatchConsumingPeer && pIdx >= 0 && sym.parentContainerName && !isConstructorName) {
          interfaceContractPeers = peers.filter(
            (p) =>
              p.parentContainerName &&
              p.parentContainerName !== sym.parentContainerName &&
              p.params[pIdx] === pName
          );
        }

        if (consumingPeer) {
          const peerLabel = consumingPeer.parentContainerName
            ? `${consumingPeer.parentContainerName}.${consumingPeer.name}`
            : `${path.basename(consumingPeer.file)}:${consumingPeer.name}`;
          reserved.push({
            param: pName,
            kind: "POLYMORPHIC_OR_PLATFORM_TWIN",
            peer: `${consumingPeer.file}:${consumingPeer.startLine} (${peerLabel})`
          });
        } else if (dispatchConsumingPeer) {
          reserved.push({
            param: pName,
            kind: "CALLBACK_DISPATCH_SIGNATURE",
            peer: `${dispatchConsumingPeer.file}:${dispatchConsumingPeer.startLine} (${dispatchConsumingPeer.name})`
          });
        } else if (interfaceContractPeers.length >= 2) {
          const samplePeer = interfaceContractPeers[0];
          reserved.push({
            param: pName,
            kind: "INTERFACE_CONTRACT_SIGNATURE",
            peer: `${samplePeer.file}:${samplePeer.startLine} (${samplePeer.parentContainerName}.${samplePeer.name})`
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
    stateKeysBySymbol,
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
