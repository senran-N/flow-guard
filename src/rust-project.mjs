import path from "node:path";

const normalize = (value) => value.replace(/\\/g, "/").replace(/^\.\//, "");
const crateName = (name) => name?.replace(/-/g, "_") || null;
const withinWorkspace = (value) => value && !path.posix.isAbsolute(value) && value !== ".." && !value.startsWith("../");

function quoted(source, key) {
  return source.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']\\s*$`, "m"))?.[1] || null;
}

function tableBlocks(content, header) {
  const matches = [...content.matchAll(new RegExp(`^\\s*${header}\\s*$`, "gm"))];
  return matches.map((match) => tableBody(content, match.index + match[0].length));
}

function tableBody(content, start) {
  const nextTable = /^\s*\[/m.exec(content.slice(start));
  return content.slice(start, nextTable ? start + nextTable.index : undefined);
}

function explicitTargets(content, rootDir, packageName, sourceSet) {
  const targets = [];
  for (const block of tableBlocks(content, "\\[\\[bin\\]\\]")) {
    const name = quoted(block, "name");
    const targetPath = quoted(block, "path");
    if (!name && !targetPath) continue;
    // Cargo maps a package-named bin to src/main.rs. Other named bins use
    // src/bin/<name>.rs when no path is declared. A path-only target retains
    // its basename as a label, but path is the only source-location evidence.
    const conventional = name === packageName && sourceSet.has(normalize(path.posix.join(rootDir, "src/main.rs")))
      ? "src/main.rs" : `src/bin/${name || path.posix.basename(targetPath, ".rs")}.rs`;
    targets.push({ kind: "bin", name: name || path.posix.basename(targetPath, ".rs"), path: normalize(targetPath || conventional), explicit: true });
  }
  const libBlock = tableBlocks(content, "\\[lib\\]")[0];
  if (libBlock) {
    const name = quoted(libBlock, "name");
    const targetPath = quoted(libBlock, "path");
    targets.push({ kind: "lib", name: crateName(name), path: normalize(targetPath || "src/lib.rs"), explicit: true });
  }
  return targets.map((target) => ({ ...target, file: normalize(path.posix.normalize(path.posix.join(rootDir, target.path))) }))
    .filter((target) => withinWorkspace(target.file));
}

function dependencyEntries(body, condition = null) {
  const dependencies = [];
  // This deliberately accepts only inline tables: dotted tables, workspace
  // inheritance and build scripts remain unresolved rather than guessed.
  for (const match of body.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*\{([^}\n]*)\}\s*$/gm)) {
    const [, localName, config] = match;
    const relPath = config.match(/\bpath\s*=\s*["']([^"']+)["']/)?.[1];
    if (!relPath) continue;
    const optional = /\boptional\s*=\s*true\b/.test(config);
    dependencies.push({
      localName,
      crateName: crateName(localName),
      package: config.match(/\bpackage\s*=\s*["']([^"']+)["']/)?.[1] || localName,
      packageCrateName: crateName(config.match(/\bpackage\s*=\s*["']([^"']+)["']/)?.[1] || localName),
      path: normalize(relPath),
      condition,
      optional,
      // No host/feature selection is performed in this light-weight parser.
      // Callers must opt in with a compiler-accurate context before linking a
      // conditional dependency.
      active: !optional && !condition
    });
  }
  return dependencies;
}

/**
 * Read the small, statically reliable Cargo subset needed for Rust path
 * resolution. `manifests` are `{ file, content }`; `sourceFiles` are
 * workspace-relative Rust paths. The result intentionally preserves target
 * cfg conditions rather than selecting a host target or inventing edges.
 */
export function analyzeCargoProject(manifests, sourceFiles = []) {
  const sourceSet = new Set(sourceFiles.map(normalize));
  const packages = [];
  for (const manifest of manifests.filter((item) => path.posix.basename(normalize(item.file)) === "Cargo.toml")) {
    const file = normalize(manifest.file);
    const rootDir = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
    const packageBlock = tableBlocks(manifest.content, "\\[package\\]")[0];
    const name = packageBlock && quoted(packageBlock, "name");
    if (!name) continue; // virtual workspace manifests have no crate root.
    const autobins = !/^\s*autobins\s*=\s*false\s*$/m.test(packageBlock);
    const autolib = !/^\s*autolib\s*=\s*false\s*$/m.test(packageBlock);
    const targets = explicitTargets(manifest.content, rootDir, name, sourceSet);
    if (autolib && !targets.some((target) => target.kind === "lib")) {
      const filePath = normalize(path.posix.join(rootDir, "src/lib.rs"));
      if (sourceSet.has(filePath)) targets.push({ kind: "lib", name: crateName(name), path: "src/lib.rs", file: filePath, explicit: false });
    }
    const mainPath = normalize(path.posix.join(rootDir, "src/main.rs"));
    if (autobins && !targets.some((target) => target.kind === "bin" && target.file === mainPath) && sourceSet.has(mainPath)) {
      targets.push({ kind: "bin", name, path: "src/main.rs", file: mainPath, explicit: false });
    }
    if (autobins) for (const source of sourceSet) {
      const prefix = rootDir ? `${rootDir}/src/bin/` : "src/bin/";
      if (!source.startsWith(prefix) || !source.endsWith(".rs")) continue;
      const nested = source.slice(prefix.length);
      const binName = nested.match(/^([^/]+)\.rs$/)?.[1] || nested.match(/^([^/]+)\/main\.rs$/)?.[1];
      if (binName && !targets.some((target) => target.file === source)) targets.push({ kind: "bin", name: binName, path: source.slice((rootDir ? `${rootDir}/` : "").length), file: source, explicit: false });
    }
    const dependencies = [
      ...dependencyEntries(tableBlocks(manifest.content, "\\[dependencies\\]")[0] || ""),
      ...[...manifest.content.matchAll(/^\s*\[target\.'cfg\((.+)\)'\.dependencies\]\s*$/gm)]
        .flatMap((match) => dependencyEntries(tableBody(manifest.content, match.index + match[0].length), `cfg(${match[1]})`))
    ];
    packages.push({ name, crateName: crateName(name), manifest: file, rootDir, autobins, autolib, targets, dependencies });
  }
  const packageByManifest = new Map(packages.map((pkg) => [pkg.manifest, pkg]));
  for (const pkg of packages) for (const dependency of pkg.dependencies) {
    const manifest = normalize(path.posix.normalize(path.posix.join(pkg.rootDir, dependency.path, "Cargo.toml")));
    dependency.packageManifest = withinWorkspace(manifest) && packageByManifest.has(manifest) ? manifest : null;
    dependency.resolution = !withinWorkspace(manifest) ? "OUTSIDE_WORKSPACE" : dependency.optional ? "OPTIONAL_UNSELECTED" : dependency.condition ? "TARGET_CONDITIONAL" : dependency.packageManifest ? "LOCAL_PATH" : "UNRESOLVED_PATH";
  }
  const libraryFiles = [...new Set(packages.flatMap((pkg) => pkg.targets.filter((target) => target.kind === "lib").map((target) => target.file)))];
  const entryRoots = [...new Set(packages.flatMap((pkg) => pkg.targets.filter((target) => target.kind === "bin").map((target) => target.file)))];
  return { packages, packageByManifest, libraryFiles, entryRoots };
}
