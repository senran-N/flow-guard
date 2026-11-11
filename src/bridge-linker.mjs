/**
 * Resolve the innermost enclosing function/method/container symbol at a 1-based line number.
 */
function findSymbolAtLine(fileObj, line, preferDecoratedTarget = false) {
  if (!fileObj || !fileObj.symbols || fileObj.symbols.length === 0) return null;
  if (!line) return fileObj.symbols[0];

  let bestFn = null;
  let bestContainer = null;
  let decoratedFn = null;
  for (const s of fileObj.symbols) {
    if (s.startLine <= line && line <= s.endLine) {
      const span = s.endLine - s.startLine;
      if (s.kind === "function" || s.kind === "method") {
        if (!bestFn || span <= bestFn.endLine - bestFn.startLine) bestFn = s;
      } else if (!bestContainer || span <= bestContainer.endLine - bestContainer.startLine) {
        bestContainer = s;
      }
    } else if (
      preferDecoratedTarget &&
      (s.kind === "function" || s.kind === "method") &&
      s.startLine > line &&
      s.startLine <= line + 12
    ) {
      if (!decoratedFn || s.startLine < decoratedFn.startLine) decoratedFn = s;
    }
  }
  if (bestFn) return bestFn;
  if (decoratedFn) return decoratedFn;
  if (bestContainer) return bestContainer;
  // If line is in top-level script / IIFE listener outside named functions, attribute to the file's primary prod entry/router symbol rather than a tiny utility helper or inline test
  const candidates =
    fileObj.zone === "prod" ? fileObj.symbols.filter((s) => s.zone === "prod") : fileObj.symbols;
  return (
    candidates.find((s) => s.isEntrySource) ||
    candidates.find((s) => /^(?:send|dispatch|postMessage|onMessage|route|main|init|setup|App)$/i.test(s.name)) ||
    candidates[0] ||
    null
  );
}

function formatCandidateLoc(sym) {
  const label = sym.parentContainerName ? `${sym.parentContainerName}.${sym.name}` : sym.name;
  return `${sym.file}:${sym.startLine} (${label})`;
}

export function linkCrossBoundaryBridges(files, tauriCommands, addSymEdge, symbolsByName = new Map()) {
  const crossBridges = [];
  const unmatchedEventEmitters = [];
  const prodFiles = files.filter((f) => f.zone === "prod");

  const recordBridgeEdge = (fromSym, toSym, meta) => {
    addSymEdge(fromSym.id, toSym.id, {
      kind: "PROTOCOL_BRIDGE",
      evidence: {
        file: meta.fromFile,
        line: meta.fromLine || fromSym.startLine,
        reason: `${meta.kind} 跨界协议桥接: ${meta.contract}`,
        contract: meta.contract,
        payloadFields: meta.payloadFields || []
      },
      resolution: {
        mode: "PROTOCOL_CONTRACT",
        confidence: meta.confidence || "HIGH",
        candidates: meta.candidates || undefined
      }
    });
  };

  // 1. Tauri IPC: invoke("cmd") / __TAURI_INVOKE("cmd") -> #[tauri::command] / #[command] fn cmd
  for (const f of prodFiles) {
    for (const item of f.bridgeSignals.tauriInvokes || []) {
      const cmdName = typeof item === "string" ? item : item.cmd;
      const line = typeof item === "object" ? item.line : 1;
      const payloadFields = (typeof item === "object" && item.payloadFields) || [];
      const callerSym = findSymbolAtLine(f, line);
      if (callerSym && callerSym.zone !== "prod") continue;
      const rustTarget = tauriCommands.get(cmdName);
      if (rustTarget && rustTarget.zone === "prod" && callerSym) {
        const bridgeObj = {
          kind: "TAURI_IPC",
          fromFile: f.file,
          fromSymbol: callerSym.name,
          fromLine: line,
          contract: `invoke("${cmdName}")`,
          payloadFields,
          toFile: rustTarget.file,
          toSymbol: rustTarget.name,
          toLine: rustTarget.startLine,
          confidence: "HIGH",
          status: "CONNECTED"
        };
        recordBridgeEdge(callerSym, rustTarget, bridgeObj);
        crossBridges.push(bridgeObj);
      } else if (!rustTarget) {
        crossBridges.push({
          kind: "TAURI_IPC",
          fromFile: f.file,
          fromSymbol: callerSym ? callerSym.name : f.file,
          fromLine: line,
          contract: `invoke("${cmdName}")`,
          payloadFields,
          toFile: null,
          toSymbol: cmdName,
          toLine: null,
          confidence: "HIGH",
          status: "BROKEN_TARGET"
        });
      }
    }
  }

  // 2. ConnectRPC / gRPC / Protobuf Service Bridge: *ServiceClient.camelMethod() -> Backend Service.PascalMethod()
  for (const f of prodFiles) {
    for (const rpc of f.bridgeSignals.rpcCalls || []) {
      const callerSym = findSymbolAtLine(f, rpc.line);
      if (!callerSym || callerSym.zone !== "prod") continue;
      const pascalMethod = rpc.method[0].toUpperCase() + rpc.method.slice(1);
      const snakeMethod = rpc.method.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      const rawCandidates = [
        ...(symbolsByName.get(pascalMethod) || []),
        ...(symbolsByName.get(snakeMethod) || [])
      ].filter((s) => s.zone === "prod" && s.file !== f.file && s.lang !== f.lang);

      if (rawCandidates.length > 0) {
        const clientPrefix = String(rpc.client || "")
          .replace(/(?:ServiceClient|AuthClient|RpcClient|Client)$/i, "")
          .toLowerCase();
        const exactPrefixMatches = clientPrefix
          ? rawCandidates.filter((c) => {
              const contLow = (c.parentContainerName || "").toLowerCase();
              const fileLow = c.file.toLowerCase();
              return (
                (contLow && (contLow.startsWith(clientPrefix) || contLow.includes(clientPrefix))) ||
                fileLow.includes(`/${clientPrefix}.`) ||
                fileLow.includes(`/${clientPrefix}_`)
              );
            })
          : [];

        const narrowed = exactPrefixMatches.length > 0 ? exactPrefixMatches : rawCandidates;
        const serviceShaped = narrowed.filter(
          (c) => c.parentContainerName && /(?:Service|Handler|Server|Controller)$/i.test(c.parentContainerName)
        );
        const effectivePool = serviceShaped.length > 0 ? serviceShaped : narrowed;
        const primary =
          effectivePool.find((c) => c.parentContainerName && /Service$/i.test(c.parentContainerName)) ||
          effectivePool[0];
        const isAmbiguous = effectivePool.length > 1;
        const confidence =
          exactPrefixMatches.length === 1
            ? "HIGH"
            : !isAmbiguous
              ? "MEDIUM"
              : "AMBIGUOUS";
        const candidateLocs = isAmbiguous ? effectivePool.map(formatCandidateLoc) : undefined;

        const bridgeObj = {
          kind: "RPC_SERVICE",
          fromFile: f.file,
          fromSymbol: callerSym.name,
          fromLine: rpc.line,
          contract: `${rpc.client}.${rpc.method}()`,
          payloadFields: rpc.payloadFields || [],
          toFile: primary.file,
          toSymbol: primary.parentContainerName ? `${primary.parentContainerName}.${primary.name}` : primary.name,
          toLine: primary.startLine,
          confidence,
          ...(candidateLocs ? { candidates: candidateLocs } : {}),
          status: "CONNECTED"
        };
        for (const targetSym of effectivePool) {
          recordBridgeEdge(callerSym, targetSym, bridgeObj);
        }
        crossBridges.push(bridgeObj);
      }
    }
  }

  // 3. Cross-Language Event Bus / Custom URI Topic Bridge (`"verge://..."` & Socket.io emit <-> listen)
  const eventEmitters = new Map();
  const eventListeners = new Map();
  for (const f of prodFiles) {
    for (const ev of f.bridgeSignals.eventTouches || []) {
      const sym = findSymbolAtLine(f, ev.line);
      if (!sym || sym.zone !== "prod") continue;
      const map = ev.mode === "emit" ? eventEmitters : eventListeners;
      if (!map.has(ev.topic)) map.set(ev.topic, []);
      map.get(ev.topic).push({ file: f.file, sym, line: ev.line });
    }
  }
  for (const [topic, emitters] of eventEmitters.entries()) {
    const listeners = eventListeners.get(topic) || [];
    if (listeners.length === 0) {
      for (const em of emitters) {
        unmatchedEventEmitters.push({
          topic,
          contract: topic,
          fromFile: em.file,
          fromSymbol: em.sym.name,
          fromLine: em.line
        });
      }
      continue;
    }
    for (const em of emitters) {
      for (const li of listeners) {
        if (em.file !== li.file) {
          const bridgeObj = {
            kind: "EVENT_BUS_BRIDGE",
            fromFile: em.file,
            fromSymbol: em.sym.name,
            fromLine: em.line,
            contract: topic,
            payloadFields: [],
            toFile: li.file,
            toSymbol: li.sym.name,
            toLine: li.line,
            confidence: "HIGH",
            status: "CONNECTED"
          };
          recordBridgeEdge(em.sym, li.sym, bridgeObj);
          crossBridges.push(bridgeObj);
        }
      }
    }
  }

  // 4. Electron IPC: ipcRenderer.invoke/send("ch") -> ipcMain.handle/on("ch")
  const electronHandlers = new Map();
  for (const f of prodFiles) {
    for (const item of f.bridgeSignals.electronHandles || []) {
      const ch = typeof item === "string" ? item : item.channel;
      const line = typeof item === "object" ? item.line : 1;
      const sym = findSymbolAtLine(f, line);
      if (sym && sym.zone !== "prod") continue;
      electronHandlers.set(ch, { fileObj: f, sym, line });
    }
  }
  for (const f of prodFiles) {
    for (const item of f.bridgeSignals.electronSends || []) {
      const ch = typeof item === "string" ? item : item.channel;
      const line = typeof item === "object" ? item.line : 1;
      const payloadFields = (typeof item === "object" && item.payloadFields) || [];
      const callerSym = findSymbolAtLine(f, line);
      if (callerSym && callerSym.zone !== "prod") continue;
      const target = electronHandlers.get(ch);
      if (target && callerSym && target.sym) {
        const bridgeObj = {
          kind: "ELECTRON_IPC",
          fromFile: f.file,
          fromSymbol: callerSym.name,
          fromLine: line,
          contract: `ipc("${ch}")`,
          payloadFields,
          toFile: target.fileObj.file,
          toSymbol: target.sym.name,
          toLine: target.line,
          confidence: "HIGH",
          status: "CONNECTED"
        };
        recordBridgeEdge(callerSym, target.sym, bridgeObj);
        crossBridges.push(bridgeObj);
      } else if (!target) {
        crossBridges.push({
          kind: "ELECTRON_IPC",
          fromFile: f.file,
          fromSymbol: callerSym ? callerSym.name : f.file,
          fromLine: line,
          contract: `ipc("${ch}")`,
          payloadFields,
          toFile: null,
          toSymbol: ch,
          toLine: null,
          confidence: "HIGH",
          status: "BROKEN_TARGET"
        });
      }
    }
  }

  // 5. HTTP REST API: fetch/axios("/api/...") -> Backend Route ("/api/...") with HTTP Method + dynamic param + sub-router mount matching
  const normalizeHttpRoute = (p) =>
    String(p || "")
      .replace(/\$\{[^}]+\}|:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_:]*\}|<[^>]+>/g, ":param")
      .replace(/\/+$/, "");
  const stripApiPrefix = (p) => String(p || "").replace(/^\/api(?:\/v\d+)?(?=\/)/i, "");

  const routeHandlers = new Map();
  const strippedRouteHandlers = new Map();
  const pushToRouteMap = (map, key, entry) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    const list = map.get(key);
    if (!list.some((e) => e.sym?.id === entry.sym?.id && e.method === entry.method)) {
      list.push(entry);
    }
  };

  for (const f of prodFiles) {
    for (const item of f.bridgeSignals.httpRoutes || []) {
      const rt = typeof item === "string" ? item : item.path;
      const method = (typeof item === "object" && item.method ? item.method : "ANY").toUpperCase();
      const line = typeof item === "object" ? item.line : 1;
      const sym = findSymbolAtLine(f, line, true);
      if (sym && sym.zone !== "prod") continue;
      const entry = { method, fileObj: f, sym, rawRoute: rt, line };
      const normRt = normalizeHttpRoute(rt);
      pushToRouteMap(routeHandlers, rt, entry);
      pushToRouteMap(routeHandlers, normRt, entry);
      const strippedRt = stripApiPrefix(normRt);
      if (strippedRt && strippedRt.length > 1) {
        pushToRouteMap(strippedRouteHandlers, strippedRt, entry);
      }
    }
  }
  for (const f of prodFiles) {
    for (const item of f.bridgeSignals.httpCalls || []) {
      const apiPath = typeof item === "string" ? item : item.path;
      const callMethod = (typeof item === "object" && item.method ? item.method : "GET").toUpperCase();
      const line = typeof item === "object" ? item.line : 1;
      const payloadFields = (typeof item === "object" && item.payloadFields) || [];
      const callerSym = findSymbolAtLine(f, line);
      if (callerSym && callerSym.zone !== "prod") continue;
      const normCall = normalizeHttpRoute(apiPath);
      const exactList = routeHandlers.get(apiPath) || [];
      const normList = routeHandlers.get(normCall) || [];
      let usedPrefixStrip = false;
      let candidates = exactList.length > 0 ? exactList : normList;
      if (candidates.length === 0) {
        const strippedCall = stripApiPrefix(normCall);
        if (strippedCall && strippedCall.length > 1) {
          candidates = routeHandlers.get(strippedCall) || strippedRouteHandlers.get(strippedCall) || [];
          usedPrefixStrip = candidates.length > 0;
        }
      }
      const matchedHandlers = candidates.filter(
        (h) => h.method === callMethod || h.method === "ANY" || callMethod === "ANY"
      );
      const confidence =
        matchedHandlers.length > 1
          ? "AMBIGUOUS"
          : usedPrefixStrip
            ? "MEDIUM"
            : "HIGH";
      const candidateLocs =
        matchedHandlers.length > 1 ? matchedHandlers.filter((h) => h.sym).map((h) => formatCandidateLoc(h.sym)) : undefined;
      for (const target of matchedHandlers) {
        if (callerSym && target.sym) {
          const bridgeObj = {
            kind: "HTTP_REST_API",
            fromFile: f.file,
            fromSymbol: callerSym.name,
            fromLine: line,
            contract: `${callMethod} ${apiPath}`,
            payloadFields,
            toFile: target.fileObj.file,
            toSymbol: target.sym.name,
            toLine: target.line,
            confidence,
            ...(candidateLocs ? { candidates: candidateLocs } : {}),
            status: "CONNECTED"
          };
          recordBridgeEdge(callerSym, target.sym, bridgeObj);
          crossBridges.push(bridgeObj);
        }
      }
    }
  }

  // 6. Shared Config Files & Environment Variable Bridges
  const writers = new Map();
  const readers = new Map();
  for (const f of prodFiles) {
    for (const c of f.bridgeSignals.configTouches || []) {
      const sym = findSymbolAtLine(f, c.line);
      if (!sym || sym.zone !== "prod") continue;
      const map = c.mode === "write" ? writers : readers;
      if (!map.has(c.file)) map.set(c.file, []);
      map.get(c.file).push({ file: f.file, sym, line: c.line });
    }
  }
  for (const [contractKey, wEntries] of writers.entries()) {
    const rEntries = readers.get(contractKey) || [];
    for (const w of wEntries) {
      for (const r of rEntries) {
        if (w.file !== r.file) {
          const bridgeObj = {
            kind: contractKey.startsWith("ENV:") ? "ENV_VAR_BRIDGE" : "SHARED_CONFIG_BRIDGE",
            fromFile: w.file,
            fromSymbol: w.sym.name,
            fromLine: w.line,
            contract: contractKey,
            payloadFields: [],
            toFile: r.file,
            toSymbol: r.sym.name,
            toLine: r.line,
            confidence: "MEDIUM",
            status: "CONNECTED"
          };
          recordBridgeEdge(w.sym, r.sym, bridgeObj);
          crossBridges.push(bridgeObj);
        }
      }
    }
  }

  // 7. WebView2 Host <-> Frontend Message Channel (`chrome.webview.postMessage` <-> `WebMessageReceived`)
  const wv2Senders = [];
  const wv2Listeners = [];
  for (const f of prodFiles) {
    for (const wv of f.bridgeSignals.webview2Touches || []) {
      const sym = findSymbolAtLine(f, wv.line);
      if (!sym || sym.zone !== "prod") continue;
      const entry = { file: f.file, sym, side: wv.side, line: wv.line, payloadFields: wv.payloadFields || [] };
      if (wv.mode === "send") wv2Senders.push(entry);
      else wv2Listeners.push(entry);
    }
  }
  for (const s of wv2Senders) {
    const oppositeListeners = wv2Listeners.filter((l) => l.side !== s.side);
    if (oppositeListeners.length > 0) {
      const confidence = oppositeListeners.length === 1 ? "HIGH" : "AMBIGUOUS";
      const candidateLocs = oppositeListeners.length > 1 ? oppositeListeners.map((l) => formatCandidateLoc(l.sym)) : undefined;
      for (const l of oppositeListeners) {
        const bridgeObj = {
          kind: "WEBVIEW2_IPC",
          fromFile: s.file,
          fromSymbol: s.sym.name,
          fromLine: s.line,
          contract: `WebView2(${s.side} -> ${l.side})`,
          payloadFields: s.payloadFields,
          toFile: l.file,
          toSymbol: l.sym.name,
          toLine: l.line,
          confidence,
          ...(candidateLocs ? { candidates: candidateLocs } : {}),
          status: "CONNECTED"
        };
        recordBridgeEdge(s.sym, l.sym, bridgeObj);
        crossBridges.push(bridgeObj);
      }
    } else {
      crossBridges.push({
        kind: "WEBVIEW2_IPC",
        fromFile: s.file,
        fromSymbol: s.sym.name,
        fromLine: s.line,
        contract: `WebView2(${s.side} -> missing_listener)`,
        payloadFields: s.payloadFields,
        toFile: null,
        toSymbol: "WebMessageReceived",
        toLine: null,
        confidence: "HIGH",
        status: "BROKEN_TARGET"
      });
    }
  }

  // 8. Named Shared Memory Segment Bridge (`CreateFileMapping`/`shm_open` <-> `OpenFileMapping`/`SharedMemory`)
  const shmWriters = new Map();
  const shmReaders = new Map();
  for (const f of prodFiles) {
    for (const shm of f.bridgeSignals.sharedMemoryTouches || []) {
      const sym = findSymbolAtLine(f, shm.line);
      if (!sym || sym.zone !== "prod") continue;
      const normSeg = String(shm.segment || "").replace(/\\\\/g, "\\").replace(/^\//, "");
      const map = shm.mode === "write" ? shmWriters : shmReaders;
      if (!map.has(normSeg)) map.set(normSeg, []);
      map.get(normSeg).push({ file: f.file, sym, line: shm.line });
    }
  }
  for (const [seg, wList] of shmWriters.entries()) {
    const rList = shmReaders.get(seg) || [];
    for (const w of wList) {
      for (const r of rList) {
        if (w.file !== r.file || w.sym.id !== r.sym.id) {
          const bridgeObj = {
            kind: "SHARED_MEMORY_IPC",
            fromFile: w.file,
            fromSymbol: w.sym.name,
            fromLine: w.line,
            contract: `shm("${seg}")`,
            payloadFields: [],
            toFile: r.file,
            toSymbol: r.sym.name,
            toLine: r.line,
            confidence: "HIGH",
            status: "CONNECTED"
          };
          recordBridgeEdge(w.sym, r.sym, bridgeObj);
          crossBridges.push(bridgeObj);
        }
      }
    }
  }

  Object.defineProperty(crossBridges, "unmatchedEventEmitters", {
    value: unmatchedEventEmitters,
    enumerable: false
  });
  return crossBridges;
}
