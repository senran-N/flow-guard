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

export function linkCrossBoundaryBridges(files, tauriCommands, addSymEdge, symbolsByName = new Map()) {
  const crossBridges = [];
  const prodFiles = files.filter((f) => f.zone === "prod");

  // 1. Tauri IPC: invoke("cmd") / __TAURI_INVOKE("cmd") -> #[tauri::command] / #[command] fn cmd
  for (const f of prodFiles) {
    for (const item of f.bridgeSignals.tauriInvokes || []) {
      const cmdName = typeof item === "string" ? item : item.cmd;
      const line = typeof item === "object" ? item.line : 1;
      const callerSym = findSymbolAtLine(f, line);
      if (callerSym && callerSym.zone !== "prod") continue;
      const rustTarget = tauriCommands.get(cmdName);
      if (rustTarget && rustTarget.zone === "prod" && callerSym) {
        addSymEdge(callerSym.id, rustTarget.id);
        crossBridges.push({
          kind: "TAURI_IPC",
          fromFile: f.file,
          fromSymbol: callerSym.name,
          contract: `invoke("${cmdName}")`,
          toFile: rustTarget.file,
          toSymbol: rustTarget.name,
          status: "CONNECTED"
        });
      } else if (!rustTarget) {
        crossBridges.push({
          kind: "TAURI_IPC",
          fromFile: f.file,
          fromSymbol: callerSym ? callerSym.name : f.file,
          contract: `invoke("${cmdName}")`,
          toFile: null,
          toSymbol: cmdName,
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
      const candidates = [
        ...(symbolsByName.get(pascalMethod) || []),
        ...(symbolsByName.get(snakeMethod) || [])
      ].filter((s) => s.zone === "prod" && s.file !== f.file && s.lang !== f.lang);

      if (candidates.length > 0) {
        // Prefer primary service implementation (`APIService`, `*Service`, `*Server`, `*Handler`)
        const primary =
          candidates.find((c) => c.parentContainerName && /Service$/i.test(c.parentContainerName)) ||
          candidates.find((c) => c.parentContainerName && /Handler|Server$/i.test(c.parentContainerName)) ||
          candidates[0];
        for (const targetSym of candidates) {
          addSymEdge(callerSym.id, targetSym.id);
        }
        crossBridges.push({
          kind: "RPC_SERVICE",
          fromFile: f.file,
          fromSymbol: callerSym.name,
          contract: `${rpc.client}.${rpc.method}()`,
          toFile: primary.file,
          toSymbol: primary.parentContainerName ? `${primary.parentContainerName}.${primary.name}` : primary.name,
          status: "CONNECTED"
        });
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
      map.get(ev.topic).push({ file: f.file, sym });
    }
  }
  for (const [topic, emitters] of eventEmitters.entries()) {
    const listeners = eventListeners.get(topic) || [];
    for (const em of emitters) {
      for (const li of listeners) {
        if (em.file !== li.file) {
          addSymEdge(em.sym.id, li.sym.id);
          crossBridges.push({
            kind: "EVENT_BUS_BRIDGE",
            fromFile: em.file,
            fromSymbol: em.sym.name,
            contract: topic,
            toFile: li.file,
            toSymbol: li.sym.name,
            status: "CONNECTED"
          });
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
      electronHandlers.set(ch, { fileObj: f, sym });
    }
  }
  for (const f of prodFiles) {
    for (const item of f.bridgeSignals.electronSends || []) {
      const ch = typeof item === "string" ? item : item.channel;
      const line = typeof item === "object" ? item.line : 1;
      const callerSym = findSymbolAtLine(f, line);
      if (callerSym && callerSym.zone !== "prod") continue;
      const target = electronHandlers.get(ch);
      if (target && callerSym && target.sym) {
        addSymEdge(callerSym.id, target.sym.id);
        crossBridges.push({
          kind: "ELECTRON_IPC",
          fromFile: f.file,
          fromSymbol: callerSym.name,
          contract: `ipc("${ch}")`,
          toFile: target.fileObj.file,
          toSymbol: target.sym.name,
          status: "CONNECTED"
        });
      } else if (!target) {
        crossBridges.push({
          kind: "ELECTRON_IPC",
          fromFile: f.file,
          fromSymbol: callerSym ? callerSym.name : f.file,
          contract: `ipc("${ch}")`,
          toFile: null,
          toSymbol: ch,
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
      const entry = { method, fileObj: f, sym, rawRoute: rt };
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
      const callerSym = findSymbolAtLine(f, line);
      if (callerSym && callerSym.zone !== "prod") continue;
      const normCall = normalizeHttpRoute(apiPath);
      const exactList = routeHandlers.get(apiPath) || [];
      const normList = routeHandlers.get(normCall) || [];
      let candidates = exactList.length > 0 ? exactList : normList;
      if (candidates.length === 0) {
        const strippedCall = stripApiPrefix(normCall);
        if (strippedCall && strippedCall.length > 1) {
          candidates = routeHandlers.get(strippedCall) || strippedRouteHandlers.get(strippedCall) || [];
        }
      }
      const matchedHandlers = candidates.filter(
        (h) => h.method === callMethod || h.method === "ANY" || callMethod === "ANY"
      );
      for (const target of matchedHandlers) {
        if (callerSym && target.sym) {
          addSymEdge(callerSym.id, target.sym.id);
          crossBridges.push({
            kind: "HTTP_REST_API",
            fromFile: f.file,
            fromSymbol: callerSym.name,
            contract: `${callMethod} ${apiPath}`,
            toFile: target.fileObj.file,
            toSymbol: target.sym.name,
            status: "CONNECTED"
          });
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
      map.get(c.file).push({ file: f.file, sym });
    }
  }
  for (const [contractKey, wEntries] of writers.entries()) {
    const rEntries = readers.get(contractKey) || [];
    for (const w of wEntries) {
      for (const r of rEntries) {
        if (w.file !== r.file) {
          addSymEdge(w.sym.id, r.sym.id);
          crossBridges.push({
            kind: contractKey.startsWith("ENV:") ? "ENV_VAR_BRIDGE" : "SHARED_CONFIG_BRIDGE",
            fromFile: w.file,
            fromSymbol: w.sym.name,
            contract: contractKey,
            toFile: r.file,
            toSymbol: r.sym.name,
            status: "CONNECTED"
          });
        }
      }
    }
  }

  return crossBridges;
}
