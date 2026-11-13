import path from "node:path";

export function rustAttributeBodies(attributes = '') {
  const bodies = [];
  const start = /#\s*!?\s*\[/g;
  let match;
  while ((match = start.exec(attributes))) {
    let depth = 1, quoted = false, cursor = start.lastIndex;
    for (; cursor < attributes.length && depth; cursor++) {
      const char = attributes[cursor];
      if (quoted) { if (char === '\\') cursor++; else if (char === '"') quoted = false; continue; }
      if (char === '"') quoted = true;
      else if (char === '[') depth++;
      else if (char === ']') depth--;
    }
    if (!depth) { bodies.push(attributes.slice(start.lastIndex, cursor - 1).trim()); start.lastIndex = cursor; }
  }
  return bodies;
}

export function rustCompilationAttributes(attributes = '') {
  return rustAttributeBodies(attributes).map((attribute) => {
    if (/^cfg\s*\(/.test(attribute)) return `#[${attribute}]`;
    const conditional = attribute.match(/^cfg_attr\s*\(([\s\S]*)\)\s*$/);
    if (!conditional) return '';
    const body = conditional[1];
    const parts = [];
    let depth = 0, start = 0, quoted = false;
    for (let i = 0; i <= body.length; i++) {
      const char = body[i];
      if (quoted) { if (char === '\\') i++; else if (char === '"') quoted = false; continue; }
      if (char === '"') { quoted = true; continue; }
      if (char === '(' || char === '[' || char === '{') depth++;
      else if (char === ')' || char === ']' || char === '}') depth--;
      else if (i === body.length || (char === ',' && depth === 0)) { parts.push(body.slice(start, i).trim()); start = i + 1; }
    }
    const applied = parts.slice(1).filter(Boolean);
    return applied.length && applied.every((part) => /^(?:allow|warn|deny|forbid|expect|doc|feature|windows_subsystem)\b/.test(part)) ? '' : `#[${attribute}]`;
  }).join('\n');
}

export function rustAttributesBefore(cleanCode, commentlessCode, offset) {
  const parts = [];
  let cursor = offset - 1;
  while (cursor >= 0) {
    while (cursor >= 0 && /\s/.test(cleanCode[cursor])) cursor--;
    if (cleanCode[cursor] !== "]") break;
    const end = cursor + 1;
    let depth = 1;
    while (--cursor >= 0 && depth) {
      if (cleanCode[cursor] === "]") depth++;
      else if (cleanCode[cursor] === "[") depth--;
    }
    while (cursor >= 0 && /\s/.test(cleanCode[cursor])) cursor--;
    if (depth || cleanCode[cursor] !== "#") break;
    parts.unshift(commentlessCode.slice(cursor, end));
    cursor--;
  }
  return parts.join("\n");
}

// One candidate rule for module resolution and module-zone classification.
export function rustModuleCandidates(file, mod, isCrateRoot, inlineNames = []) {
  let directory = path.posix.dirname(file);
  if (!isCrateRoot && !/^(?:main|lib|mod)\.rs$/.test(path.posix.basename(file))) directory = file.replace(/\.rs$/, "");
  // A path on the first inline module overrides the non-mod-rs stem prefix.
  if (inlineNames[0]?.path) directory = path.posix.dirname(file);
  const components = inlineNames.map((part) => typeof part === 'string' ? part : part.path || part.name);
  const base = path.posix.join(directory, ...components, mod.name);
  return mod.path ? [path.posix.normalize(path.posix.join(components.length ? directory : path.posix.dirname(file), ...components, mod.path))]
    : [base + ".rs", base + "/mod.rs"];
}

// Parse use trees from lexer-cleaned text. Keep block/module scope and the full
// path; a matching filename anywhere in the workspace is not import evidence.
export function parseRustImports(cleanCode, braceSpans, commentlessCode = cleanCode) {
  const modules = [], uses = [], externalPublicSymbols = new Set();
  const lineAt = (offset) => cleanCode.slice(0, offset).split("\n").length;
  const scopeAt = (offset) => {
    let enclosing = null;
    for (const span of braceSpans) if (span.openOffset < offset && span.closeOffset > offset &&
      (!enclosing || span.openOffset > enclosing.openOffset)) enclosing = span;
    return { scopeStart: enclosing?.openLine || 0, scopeEnd: enclosing?.closeLine || Infinity,
      scopeOffset: enclosing?.openOffset ?? -1, scopeEndOffset: enclosing?.closeOffset ?? Infinity };
  };
  for (const match of cleanCode.matchAll(/\b(pub(?:\s*\([^)]*\))?\s+)?mod\s+(r#)?([A-Za-z_][A-Za-z0-9_]*)\s*([;{])/g)) {
    const span = match[4] === "{" ? braceSpans.find((b) => b.openOffset === match.index + match[0].length - 1) : null;
    const attributes = rustAttributesBefore(cleanCode, commentlessCode, match.index);
    const visibility = match[1]?.trim() || null;
    modules.push({ name: match[3], public: Boolean(visibility), externalPublic: visibility === "pub", line: lineAt(match.index),
      path: attributes.match(/#\[\s*path\s*=\s*"([^"\n]+)"\s*\]/)?.[1] || null,
      attributes,
      inline: match[4] === "{", bodyStart: span?.openLine, endLine: span?.closeLine,
      bodyOffset: span?.openOffset, endOffset: span?.closeOffset, ...scopeAt(match.index) });
  }
  const expand = (tree, prefix = []) => {
    let depth = 0, start = 0;
    const parts = [];
    for (let i = 0; i <= tree.length; i++) {
      if (i === tree.length || (tree[i] === "," && depth === 0)) { parts.push(tree.slice(start, i).trim()); start = i + 1; }
      else if (tree[i] === "{") depth++; else if (tree[i] === "}") depth--;
    }
    return parts.flatMap((part) => {
      if (!part) return [];
      const group = part.indexOf("{");
      if (group >= 0 && part.endsWith("}")) {
        const head = part.slice(0, group).replace(/::$/, "").split("::").filter(Boolean);
        return expand(part.slice(group + 1, -1), [...prefix, ...head]);
      }
      const binding = part.match(/^((?:::)?(?:r#)?[A-Za-z_][A-Za-z0-9_]*(?:::(?:(?:r#)?[A-Za-z_][A-Za-z0-9_]*|\*))*(?:::\*)?|\*)(?:\s+as\s+((?:r#)?[A-Za-z_][A-Za-z0-9_]*))?$/);
      if (!binding || binding[2] === "_") return [];
      const segments = [...prefix, ...binding[1].split("::").filter(Boolean)].map((s) => s.replace(/^r#/, ""));
      if (segments.at(-1) === "self" && segments.length > 1) segments.pop();
      return [{ path: segments, local: binding[2]?.replace(/^r#/, "") || segments.at(-1), absolute: binding[1].startsWith("::") }];
    });
  };
  for (const match of cleanCode.matchAll(/\b(pub(?:\s*\([^)]*\))?\s+)?use\s+([^;]+);/g)) {
    const visibility = match[1]?.trim() || null;
    for (const binding of expand(match[2].replace(/\s*::\s*/g, "::"))) uses.push({ ...binding,
      public: Boolean(visibility), externalPublic: visibility === "pub", line: lineAt(match.index), offset: match.index, ...scopeAt(match.index) });
  }
  // `pub(crate)` is public to the current crate only. Keep this declaration
  // fact separate from the generic parser's `isPublicApi`, which intentionally
  // treats crate-visible items as public for same-crate analysis.
  for (const match of cleanCode.matchAll(/^[ \t]*(pub(?:\s*\([^)]*\))?\s+)?(?:const\s+)?(?:unsafe\s+)?(?:async\s+)?(?:extern\s+(?:"[^"]*"\s+)?)?(?:fn|struct|enum|trait)\s+(?:r#)?([A-Za-z_][A-Za-z0-9_]*)\b/gm)) {
    if (match[1]?.trim() === "pub") externalPublicSymbols.add(`${lineAt(match.index)}:${match[2]}`);
  }
  const macroInvocations = [...cleanCode.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)!\s*(?:[({\[])/g)]
    .filter((match) => match[1] !== "macro_rules")
    .map((match) => ({ name: match[1], line: lineAt(match.index) }));
  const macroDefinitions = [...cleanCode.matchAll(/\bmacro_rules!\s*([A-Za-z_]\w*)\s*\{/g)]
    .map((match) => {
      const offset = match.index + match[0].lastIndexOf('{');
      const span = braceSpans.find((candidate) => candidate.openOffset === offset);
      return span ? { name: match[1], startLine: lineAt(match.index), endLine: span.closeLine,
        startOffset: match.index, endOffset: span.closeOffset + 1 } : null;
    }).filter(Boolean);
  const isTemplateLine = (line) => macroDefinitions.some((definition) => line >= definition.startLine && line <= definition.endLine);
  const innerAttributes = [];
  for (const match of cleanCode.matchAll(/#!\s*\[/g)) {
    const scope = scopeAt(match.index).scopeOffset;
    let depth = 1, cursor = match.index + match[0].length;
    for (; cursor < cleanCode.length && depth; cursor++) {
      if (cleanCode[cursor] === '[') depth++;
      else if (cleanCode[cursor] === ']') depth--;
    }
    if (!depth) {
      const attribute = commentlessCode.slice(match.index, cursor);
      if (scope === -1) innerAttributes.push(attribute);
      else {
        const mod = modules.find((candidate) => candidate.bodyOffset === scope);
        if (mod) mod.innerAttributes = [mod.innerAttributes, attribute].filter(Boolean).join('\n');
      }
    }
  }
  return { modules: modules.filter((item) => !isTemplateLine(item.line)), uses: uses.filter((item) => !isTemplateLine(item.line)),
    externalPublicSymbols, macroInvocations, macroDefinitions, innerAttributes: innerAttributes.join('\n') };
}

export function createRustResolver(files, cargoProject = null) {
  const rustFiles = new Map(files.filter((f) => f.lang === "rust").map((f) => [f.file, f]));
  const nodesByFile = new Map();
  const conventionalRoots = [...rustFiles.keys()].filter((file) => /(?:^|\/)(?:main|lib)\.rs$/.test(file) || /(?:^|\/)src\/bin\/[^/]+\.rs$/.test(file));
  const cargoRoots = [...new Set([...(cargoProject?.entryRoots || []), ...(cargoProject?.libraryFiles || [])])]
    .filter((file) => rustFiles.has(file));
  const roots = [...new Set([...conventionalRoots, ...cargoRoots])];
  const packageForFile = (file) => (cargoProject?.packages || [])
    .filter((pkg) => !pkg.rootDir || file.startsWith(`${pkg.rootDir}/`))
    .sort((a, b) => b.rootDir.length - a.rootDir.length)[0] || null;
  const isExternallyPublic = (symbol) => rustFiles.get(symbol.file)?.rustImports?.externalPublicSymbols
    ?.has(`${symbol.startLine}:${symbol.name}`) || false;
  const rawLimits = [];
  for (const pkg of cargoProject?.packages || []) for (const dependency of pkg.dependencies || []) {
    if (!dependency.active) rawLimits.push({ kind: dependency.optional ? "CARGO_OPTIONAL_DEPENDENCY_UNSELECTED" : "CARGO_TARGET_CONDITION_UNSELECTED", file: pkg.manifest, reason: `${dependency.localName}${dependency.condition ? ` (${dependency.condition})` : ""}` });
  }
  for (const file of rustFiles.values()) for (const mod of file.rustImports?.modules || []) {
    if (/\b(?:cfg|cfg_attr)\s*\(/.test(rustCompilationAttributes((mod.attributes || "") + (mod.innerAttributes || "")))) rawLimits.push({ kind: "RUST_CFG_MODULE_UNRESOLVED", file: file.file, reason: `module ${mod.name} at line ${mod.line}` });
  }
  for (const file of rustFiles.values()) if (file.symbols.some((symbol) => symbol.conditionalContext?.length)) {
    rawLimits.push({ kind: "RUST_CFG_ITEM_UNRESOLVED", file: file.file, reason: "conditional declaration(s) require selected cfg/features" });
  }
  function visit(file, parent = null, name = "", inline = null, ancestors = new Set(), isCrateRoot = false, conditional = false) {
    if (!inline && ancestors.has(file.file)) return null;
    const node = { file, parent, name, start: inline?.bodyStart || 0, end: inline?.endLine || Infinity,
      offset: inline?.bodyOffset ?? -1, endOffset: inline?.endOffset ?? Infinity, children: new Map(), symbols: [], isCrateRoot, conditional,
      directoryComponent: { name, path: inline?.path || null } };
    node.conditional ||= /\b(?:cfg|cfg_attr)\s*\(/.test(rustCompilationAttributes(file.rustImports?.innerAttributes));
    node.root = parent?.root || node;
    if (!nodesByFile.has(file.file)) nodesByFile.set(file.file, []);
    nodesByFile.get(file.file).push(node);
    const imports = file.rustImports || { modules: [], uses: [] };
    const descendants = new Set(ancestors); descendants.add(file.file);
    for (const mod of imports.modules.filter((m) => m.scopeOffset === node.offset)) {
      let child = null;
      const conditionalChild = node.conditional || /\b(?:cfg|cfg_attr)\s*\(/.test(rustCompilationAttributes((mod.attributes || "") + (mod.innerAttributes || "")));
      if (mod.inline) child = visit(file, node, mod.name, mod, ancestors, false, conditionalChild);
      else {
        const inlineNames = [];
        for (let p = node; p.parent && p.file === p.parent.file; p = p.parent) inlineNames.unshift(p.directoryComponent);
        const candidates = rustModuleCandidates(file.file, mod, isCrateRoot || (node.root.isCrateRoot && node.root.file === file), inlineNames);
        const matches = candidates.filter((candidate) => rustFiles.has(candidate));
        if (matches.length === 1) child = visit(rustFiles.get(matches[0]), node, mod.name, null, descendants, false, conditionalChild);
      }
      if (child) { child.public = mod.public; child.externalPublic = mod.externalPublic; node.children.set(mod.name, node.children.has(mod.name) ? null : child); }
    }
    node.uses = imports.uses.filter((u) => u.offset > node.offset && u.offset < node.endOffset &&
      ![...node.children.values()].some((child) => child && child.file === file && u.offset > child.offset && u.offset < child.endOffset));
    node.symbols = file.symbols.filter((s) => !s.parentContainerName && !s.parentFunctionId && s.kind !== "module" &&
      s.startLine >= node.start && s.endLine <= node.end &&
      ![...node.children.values()].some((child) => child && child.file === file && s.startLine > child.start && s.endLine < child.end));
    return node;
  }
  for (const file of roots) visit(rustFiles.get(file), null, "", null, new Set(), true);
  // Standalone examples/tests and unreferenced source files still have local
  // lexical scopes; this does not make them reachable from another crate.
  for (const file of rustFiles.values()) if (!nodesByFile.has(file.file)) visit(file);
  const unique = (values) => [...new Map(values.map((value) => [value.id, value])).values()];
  const crateRootFor = (pkg) => {
    const rootFile = pkg?.targets?.find((target) => target.kind === "lib")?.file;
    return rootFile ? (nodesByFile.get(rootFile) || []).find((node) => node.isCrateRoot) || null : null;
  };
  function externalCrate(node, name) {
    const owner = packageForFile(node.root.file.file);
    const dependency = (owner?.dependencies || []).find((dep) => dep.active && dep.packageManifest && dep.crateName === name);
    if (!dependency) return [];
    const target = (cargoProject?.packageByManifest || new Map()).get(dependency.packageManifest);
    const root = crateRootFor(target);
    if (!root) {
      rawLimits.push({ kind: "CARGO_LOCAL_DEPENDENCY_WITHOUT_SCANNED_LIBRARY_ROOT", file: owner.manifest, reason: name });
      return [];
    }
    return [root];
  }
  // A package can build both a binary crate and its sibling library crate.
  // `use package_crate_name::api` from the bin addresses that library target,
  // but it is not listed as a Cargo dependency. Resolve only the package's
  // actual lib target (including an explicit `[lib] name`), and enter through
  // the external/public visibility boundary just like any other crate.
  function siblingLibraryCrate(node, name) {
    const owner = packageForFile(node.root.file.file);
    const target = owner?.targets?.find((candidate) => candidate.kind === "lib" && candidate.name === name);
    if (!target) return [];
    const root = (nodesByFile.get(target.file) || []).find((candidate) => candidate.isCrateRoot) || null;
    return root ? [root] : [];
  }
  function resolve(node, segments, line, visited = new Map(), exported = false) {
    if (!node || !segments.length) return [];
    const key = `${node.root.file.file}:${node.file.file}:${node.offset}:${segments.join("::")}:${exported}`;
    if (visited.has(key)) return [];
    const seen = new Map(visited); seen.set(key, true);
    const [head, ...tail] = segments;
    if (head === "crate") return resolve(node.root, tail, Infinity, seen);
    if (head === "self") return resolve(node, tail, line, seen);
    if (head === "super") return resolve(node.parent, tail, Infinity, seen);
    const siblingRoots = siblingLibraryCrate(node, head);
    if (siblingRoots.length && tail.length) return unique(siblingRoots.flatMap((root) => resolve(root, tail, Infinity, seen, true)));
    const externalRoots = externalCrate(node, head);
    if (externalRoots.length && tail.length) return unique(externalRoots.flatMap((root) => resolve(root, tail, Infinity, seen, true)));
    const child = node.children.get(head);
    // `pub use crate::private_module::item as public_name` is legal Rust.
    // Keep the original boundary requirement while descending: a same-crate
    // lookup may traverse private implementation modules, while a resolver
    // that starts from another crate must keep every segment public. The old
    // code changed this to `true` for every child and consequently rejected
    // ripgrep's crate-qualified aliases at its first private module.
    if (child && tail.length && (!exported || child.externalPublic)) return resolve(child, tail, Infinity, seen, exported);
    const local = !tail.length ? node.symbols.filter((s) => s.name === head && (!exported || isExternallyPublic(s))) : [];
    if (local.length) return local;
    const bindings = node.uses.filter((u) => !u.absolute && (!exported || u.externalPublic) &&
      (u.scopeOffset === node.offset || (line >= u.scopeStart && line <= u.scopeEnd)));
    const explicit = bindings.filter((u) => u.local === head);
    const matches = [];
    for (const use of explicit.length ? explicit : bindings.filter((u) => u.local === "*")) {
      const target = use.local === "*" ? [...use.path.slice(0, -1), ...segments] : [...use.path, ...tail];
      const importKey = `use:${node.root.file.file}:${node.file.file}:${use.offset}`;
      const previousLength = seen.get(importKey);
      // A recursive glob can keep growing the path forever. Reusing an alias is
      // valid only when it consumes more of the requested path on each visit.
      if (typeof previousLength === "number" && target.length >= previousLength) continue;
      const imported = new Map(seen); imported.set(importKey, target.length);
      // A public re-export is itself the visibility boundary. Its target may
      // live below private implementation modules, but the final item still
      // has to be bare `pub` before another crate may receive it.
      const throughPublicReExport = exported && use.externalPublic;
      const resolved = resolve(node, target, use.line, imported, throughPublicReExport ? false : exported);
      matches.push(...(throughPublicReExport ? resolved.filter(isExternallyPublic) : resolved));
    }
    return unique(matches);
  }
  const resolver = (symbol, site) => {
    if (!site.receiver && !site.rustPath?.includes("::")) {
      const file = rustFiles.get(symbol.file);
      let scope = symbol;
      while (scope) {
        const local = file.symbols.filter((s) => s.parentFunctionId === scope.id && s.name === (site.rawCallee || site.callee));
        if (local.length) return local;
        scope = file.symbols.find((s) => s.id === scope.parentFunctionId);
      }
    }
    const nodes = (nodesByFile.get(symbol.file) || []).filter((node) => symbol.startLine >= node.start && symbol.endLine <= node.end);
    const inner = nodes.filter((node) => !nodes.some((other) => other !== node && other.root === node.root && other.start > node.start && other.end < node.end));
    const segments = (site.rustPath?.replace(/^::/, "").split("::") || [site.rawCallee || site.callee]);
    return unique(inner.flatMap((node) => resolve(node, segments, site.line)));
  };
  const limitations = new Map();
  for (const limit of rawLimits) limitations.set(`${limit.kind}:${limit.file}:${limit.reason}`, limit);
  // Declarative/procedural macro expansion is not modeled. State the boundary
  // once per Rust file rather than emitting a warning for each invocation.
  for (const file of rustFiles.values()) if (file.rustImports?.macroInvocations?.length || file.rustImports?.macroDefinitions?.length) {
    const limit = { kind: "RUST_MACRO_EXPANSION_UNRESOLVED", file: file.file, reason: "macro invocation may create items or calls" };
    limitations.set(`${limit.kind}:${limit.file}`, limit);
  }
  const publicApiSymbolIds = new Set();
  const conditionalSymbolIds = new Set();
  for (const nodes of nodesByFile.values()) for (const node of nodes) {
    if (!node.conditional) continue;
    for (const symbol of node.file.symbols) if (symbol.startLine >= node.start && symbol.endLine <= node.end) conditionalSymbolIds.add(symbol.id);
  }
  for (const file of rustFiles.values()) for (const symbol of file.symbols) {
    if (symbol.conditionalContext?.length) conditionalSymbolIds.add(symbol.id);
  }
  const addPublicSymbol = (symbol) => {
    if (!symbol || !isExternallyPublic(symbol)) return;
    publicApiSymbolIds.add(symbol.id);
    if (!["struct", "class", "trait", "enum"].includes(symbol.kind)) return;
    for (const method of rustFiles.get(symbol.file)?.symbols || []) {
      if (method.parentContainerId === symbol.id && isExternallyPublic(method)) publicApiSymbolIds.add(method.id);
    }
  };
  const collectPublicApi = (node, externallyVisible = true, visited = new Set()) => {
    if (!node || !externallyVisible || visited.has(`${node.file.file}:${node.offset}`)) return;
    visited.add(`${node.file.file}:${node.offset}`);
    const publicContainers = new Set();
    for (const symbol of node.symbols) {
      if (symbol.parentFunctionId) continue;
      if (!symbol.parentContainerName && isExternallyPublic(symbol)) {
        addPublicSymbol(symbol);
        if (["struct", "class", "trait", "enum"].includes(symbol.kind)) publicContainers.add(symbol.id);
      }
    }
    // Methods inherit external availability only from an externally visible
    // public container. `pub(crate)` methods never pass isExternallyPublic.
    for (const symbol of node.symbols) {
      if (!symbol.parentContainerName) continue;
      if (publicContainers.has(symbol.parentContainerId) && isExternallyPublic(symbol)) addPublicSymbol(symbol);
    }
    for (const child of node.children.values()) if (child?.externalPublic) collectPublicApi(child, true, visited);
  };
  const resolveModuleInternally = (node, segments, visited = new Set()) => {
    if (!node || !segments.length) return [node].filter(Boolean);
    const key = `${node.root.file.file}:${node.file.file}:${node.offset}:${segments.join("::")}`;
    if (visited.has(key)) return [];
    const next = new Set(visited).add(key);
    const [head, ...tail] = segments;
    if (head === "crate") return resolveModuleInternally(node.root, tail, next);
    if (head === "self") return resolveModuleInternally(node, tail, next);
    if (head === "super") return resolveModuleInternally(node.parent, tail, next);
    const child = node.children.get(head);
    return child ? resolveModuleInternally(child, tail, next) : [];
  };
  const collectPublicGlob = (node, prefix, visited = new Set()) => {
    const key = `${node.root.file.file}:${prefix.join("::")}`;
    if (visited.has(key)) return;
    const next = new Set(visited).add(key);
    for (const target of resolveModuleInternally(node, prefix)) {
      // The glob itself supplied the external visibility. The implementation
      // module may be private, but only bare-pub symbols are surfaced.
      for (const symbol of target.symbols) addPublicSymbol(symbol);
      for (const child of target.children.values()) if (child?.externalPublic) collectPublicApi(child, true);
      for (const nested of target.uses.filter((use) => use.externalPublic && use.local === "*")) {
        collectPublicGlob(target, nested.path.slice(0, -1), next);
      }
    }
  };
  for (const pkg of cargoProject?.packages || []) {
    const root = crateRootFor(pkg);
    if (!root) continue;
    collectPublicApi(root);
    for (const binding of root.uses.filter((use) => use.externalPublic)) {
      if (binding.local === "*") collectPublicGlob(root, binding.path.slice(0, -1));
      else for (const symbol of resolve(root, [binding.local], binding.line, new Map(), true)) addPublicSymbol(symbol);
    }
  }
  // Consumers must surface these as uncertainty; neither cfg/macro expansion
  // nor feature/target selection is silently treated as proof.
  resolver.limitations = [...limitations.values()];
  resolver.isPublicApi = (symbol) => Boolean(symbol) && publicApiSymbolIds.has(symbol.id);
  resolver.publicApiSymbolIds = publicApiSymbolIds;
  resolver.isConditional = (symbol) => Boolean(symbol) && conditionalSymbolIds.has(symbol.id);
  resolver.isConditionalAt = (file, line) => (nodesByFile.get(file) || []).some(node => node.conditional && line >= node.start && line <= node.end);
  resolver.conditionalSymbolIds = conditionalSymbolIds;
  return resolver;
}
