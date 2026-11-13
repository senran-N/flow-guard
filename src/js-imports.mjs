import fs from "node:fs";
import path from "node:path";

const JS_EXTENSIONS = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;

function toPosix(value) {
  return value.replace(/\\/g, "/");
}

function stripJsonCommentsAndTrailingCommas(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
      out += text[i] || "";
    } else if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += char;
    }
  }
  let normalized = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < out.length; i++) {
    const char = out[i];
    if (inString) {
      normalized += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      normalized += char;
      continue;
    }
    if (char === ",") {
      let next = i + 1;
      while (/\s/.test(out[next] || "")) next++;
      if (out[next] === "}" || out[next] === "]") continue;
    }
    normalized += char;
  }
  return normalized;
}

function readJsonc(file) {
  try {
    return JSON.parse(stripJsonCommentsAndTrailingCommas(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")));
  } catch {
    return null;
  }
}

function withinWorkspace(root, candidate) {
  const relative = path.relative(root, candidate);
  return !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function findNearestConfig(workspaceRoot, fromFile, configFiles) {
  let current = path.dirname(path.resolve(workspaceRoot, fromFile));
  while (current === workspaceRoot || current.startsWith(`${workspaceRoot}${path.sep}`)) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = path.join(current, name);
      configFiles.add(candidate);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    // A nested package without its own project config must not inherit aliases from
    // the parent workspace. It is a distinct package-resolution boundary.
    if (current !== workspaceRoot && fs.existsSync(path.join(current, "package.json"))) break;
    if (current === workspaceRoot) break;
    current = path.dirname(current);
  }
  return null;
}

function createConfigLoader(configFiles, limitations) {
  const loaded = new Map();
  const probe = (file) => {
    configFiles.add(file);
    try { return fs.statSync(file).isFile(); } catch { return false; }
  };
  const resolveBase = (specifier, directory) => {
    const fileAt = (candidate) => {
      for (const file of [candidate, ...(candidate.endsWith('.json') ? [] : [`${candidate}.json`])]) {
        if (probe(file)) return file;
      }
      return null;
    };
    if (specifier.startsWith('.') || path.isAbsolute(specifier)) return fileAt(path.resolve(directory, specifier));
    let current = directory;
    while (true) {
      const candidate = path.join(current, 'node_modules', specifier);
      const direct = fileAt(candidate);
      if (direct) return direct;
      const manifest = path.join(candidate, 'package.json');
      if (probe(manifest)) {
        const entry = readJsonc(manifest)?.tsconfig;
        if (typeof entry === 'string') {
          const target = fileAt(path.resolve(candidate, entry));
          if (target) return target;
        }
      }
      const fallback = fileAt(path.join(candidate, 'tsconfig.json'));
      if (fallback) return fallback;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return null;
  };
  const load = (file, ancestors = new Set()) => {
    if (ancestors.has(file) || ancestors.size >= 128) {
      limitations.set(file, '循环或过深的配置继承');
      return null;
    }
    if (loaded.has(file)) return loaded.get(file);
    configFiles.add(file);
    const config = readJsonc(file);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      limitations.set(file, '配置文件无法解析');
      return null;
    }
    const chain = new Set(ancestors).add(file);
    let result = {};
    const bases = config.extends === undefined ? [] : Array.isArray(config.extends) ? config.extends : [config.extends];
    for (const base of bases) {
      const target = typeof base === 'string' && base ? resolveBase(base, path.dirname(file)) : null;
      const inherited = target && load(target, chain);
      if (!inherited) {
        limitations.set(file, `无法完整加载继承配置: ${String(base)}`);
        loaded.set(file, null);
        return null;
      }
      result = { ...result, ...inherited };
    }
    const options = config.compilerOptions;
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) {
      limitations.set(file, 'compilerOptions 格式无效');
      return null;
    }
    if (options && Object.hasOwn(options, 'baseUrl')) {
      if (typeof options.baseUrl !== 'string') {
        limitations.set(file, 'baseUrl 格式无效');
        return null;
      }
      result.baseUrl = path.resolve(path.dirname(file), options.baseUrl);
    }
    if (options && Object.hasOwn(options, 'paths')) {
      result.paths = options.paths;
      result.pathsOrigin = path.dirname(file);
    }
    loaded.set(file, result);
    return result;
  };
  return load;
}

function createPathMappings(workspaceRoot, fromFile, configFiles, loadConfig) {
  const configFile = findNearestConfig(workspaceRoot, fromFile, configFiles);
  if (!configFile) return { configured: false };
  const compilerOptions = loadConfig(configFile);
  if (!compilerOptions) return { configured: true };
  const configDir = path.dirname(configFile);
  if (compilerOptions.baseUrl !== undefined && typeof compilerOptions.baseUrl !== "string") return { configured: true };
  const hasBaseUrl = Object.prototype.hasOwnProperty.call(compilerOptions, "baseUrl");
  const baseUrl = compilerOptions.baseUrl || compilerOptions.pathsOrigin || configDir;
  if (!withinWorkspace(workspaceRoot, baseUrl)) return { configured: true };
  if (compilerOptions.paths === undefined) return { configured: true, baseUrl, hasBaseUrl, mappings: [] };
  if (!compilerOptions.paths || typeof compilerOptions.paths !== "object" || Array.isArray(compilerOptions.paths)) {
    return { configured: true, baseUrl, hasBaseUrl, mappings: [] };
  }

  const mappings = [];
  for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
    if (typeof pattern !== "string" || !Array.isArray(targets) || !targets.every((target) => typeof target === "string")) continue;
    if ((pattern.match(/\*/g) || []).length > 1) continue;
    const patternHasStar = pattern.includes("*");
    const supportedTargets = targets.filter((target) =>
      (target.match(/\*/g) || []).length <= 1 && !path.isAbsolute(target) && !(target.includes("*") && !patternHasStar)
    );
    if (supportedTargets.length) mappings.push({ pattern, targets: supportedTargets, baseUrl });
  }
  return { configured: true, baseUrl, hasBaseUrl, mappings };
}

function matchPathMapping(specifier, pattern) {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier ? "" : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function applyPathMapping(specifier, mapping) {
  const match = matchPathMapping(specifier, mapping.pattern);
  if (match === null || typeof mapping.target !== "string") return null;
  return mapping.target.includes("*") ? mapping.target.replace("*", match) : mapping.target;
}

/**
 * Resolves JS/TS relative imports and explicitly configured TypeScript path aliases.
 * It intentionally leaves bare package imports unresolved unless a local `paths` rule
 * matches them, so package scopes never turn into guessed workspace files.
 */
export function createJsImportResolver(workspaceRoot, files) {
  const root = path.resolve(workspaceRoot);
  const configFiles = new Set();
  const limitations = new Map();
  const loadConfig = createConfigLoader(configFiles, limitations);
  const configByFromDirectory = new Map();
  const normalizedFiles = (files || []).map((file) => typeof file === "string" ? file : file?.file).filter(Boolean)
    .map(toPosix);
  const exactFiles = new Set(normalizedFiles);
  const noExtFiles = new Map();
  for (const file of normalizedFiles) {
    if (!JS_EXTENSIONS.test(file)) continue;
    const noExt = file.replace(JS_EXTENSIONS, "");
    const entries = noExtFiles.get(noExt) || [];
    entries.push(file);
    noExtFiles.set(noExt, entries);
  }

  const matchesFor = (absoluteCandidate) => {
    const results = new Set();
    if (!withinWorkspace(root, absoluteCandidate)) return;
    const relative = toPosix(path.relative(root, absoluteCandidate));
    if (exactFiles.has(relative)) results.add(relative);
    if (JS_EXTENSIONS.test(relative)) return [...results].sort();
    for (const suffix of ["", "/index"]) {
      for (const match of noExtFiles.get(relative.replace(JS_EXTENSIONS, "") + suffix) || []) results.add(match);
    }
    return [...results].sort();
  };

  const configFor = (fromFile) => {
    if (typeof fromFile !== "string") return { configured: false };
    const fromDirectory = path.dirname(path.resolve(root, fromFile));
    if (!configByFromDirectory.has(fromDirectory)) {
      configByFromDirectory.set(fromDirectory, createPathMappings(root, fromFile, configFiles, loadConfig));
    }
    return configByFromDirectory.get(fromDirectory);
  };

  const resolve = (fromFile, specifier) => {
    if (typeof fromFile !== "string" || typeof specifier !== "string" || !specifier) return [];
    const results = new Set();
    if (specifier.startsWith(".")) {
      for (const match of matchesFor(path.resolve(root, path.posix.dirname(toPosix(fromFile)), specifier)) || []) results.add(match);
    } else {
      const config = configFor(fromFile);
      if (!config.configured || !config.baseUrl) return [];
      const exact = config.mappings.filter((mapping) => !mapping.pattern.includes("*") && mapping.pattern === specifier);
      const wildcard = config.mappings.filter((mapping) => mapping.pattern.includes("*") && matchPathMapping(specifier, mapping.pattern) !== null)
        .sort((left, right) => right.pattern.indexOf("*") - left.pattern.indexOf("*") || right.pattern.length - left.pattern.length);
      const selected = exact.length ? exact : wildcard.length ? [wildcard[0]] : [];
      for (const mapping of selected) {
        for (const target of mapping.targets) {
          const mapped = applyPathMapping(specifier, { ...mapping, target });
          const matches = mapped === null ? [] : matchesFor(path.resolve(mapping.baseUrl, mapped)) || [];
          if (matches.length) return matches;
        }
      }
      if (selected.length) return [];
      // Only an explicit baseUrl authorizes bare local-module resolution. A config
      // containing only `paths` must not turn package imports into local guesses.
      if (config.hasBaseUrl) {
        for (const match of matchesFor(path.resolve(config.baseUrl, specifier)) || []) results.add(match);
      }
    }
    return [...results].sort();
  };
  Object.defineProperty(resolve, "configFiles", {
    enumerable: true,
    get: () => [...configFiles].sort()
  });
  Object.defineProperty(resolve, "isConfigured", {
    enumerable: true,
    value: (fromFile) => configFor(fromFile).configured === true
  });
  Object.defineProperty(resolve, "limitations", {
    enumerable: true,
    get: () => [...limitations].map(([file, reason]) => ({ file: toPosix(path.relative(root, file)), reason, kind: 'TSCONFIG' }))
  });
  return resolve;
}
