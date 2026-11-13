import fs from "node:fs";
import path from "node:path";
import { scanTokensAndScopes } from "./lexer.mjs";

const jsLanguages = new Set(["ts", "vue"]);
const read = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };
const section = (text, name) => text.match(new RegExp(`^\\[${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, "m"))?.[1] || "";

function exportPaths(value, output = []) {
  if (typeof value === "string" && value.startsWith("./")) output.push(value.slice(2));
  else if (Array.isArray(value)) value.forEach((v) => exportPaths(v, output));
  else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) if (key !== "types") exportPaths(v, output);
  }
  return output;
}

// Inspect ancestors of parsed source files only. A nearer package controls its own
// files; a private workspace root does not turn its published child libraries into apps.
export function inferPackageBoundaries(workspaceRoot, files) {
  const directories = new Set([""]);
  for (const file of files) {
    let dir = path.posix.dirname(file.file);
    while (dir !== ".") { directories.add(dir); dir = path.posix.dirname(dir); }
  }
  const scopes = [];
  const entryPatterns = [];
  const frameworkEntryFiles = new Map();
  for (const directory of directories) {
    const absolute = path.join(workspaceRoot, directory);
    const prefix = directory ? directory + "/" : "";
    const alembic = section(read(path.join(absolute, "alembic.ini")), "alembic");
    const scriptLocation = alembic.match(/^script_location\s*=\s*([^\r\n]+)/m)?.[1].trim();
    if (scriptLocation && !/^version_locations\s*=/m.test(alembic)) {
      const scriptRoot = path.resolve(absolute, scriptLocation.replace(/%\(here\)s/g, absolute));
      const versions = path.relative(workspaceRoot, path.join(scriptRoot, "versions")).replace(/\\/g, "/") + "/";
      if (!versions.startsWith("../") && !path.isAbsolute(versions)) {
        for (const file of files) if (file.lang === "python" && file.file.startsWith(versions) && file.isAlembicRevision) {
          frameworkEntryFiles.set(file.file, prefix + "alembic.ini");
        }
      }
    }
    const pubspec = read(path.join(absolute, "pubspec.yaml"));
    if (/^name\s*:/m.test(pubspec)) {
      const application = /^flutter\s*:/m.test(pubspec) && fs.existsSync(path.join(absolute, "lib", "main.dart"));
      scopes.push({ prefix, languages: new Set(["dart"]), mode: application ? "application" : "dart-package", manifest: prefix + "pubspec.yaml" });
    }
    const gradleFile = ["build.gradle.kts", "build.gradle"].find((file) => fs.existsSync(path.join(absolute, file)));
    if (gradleFile) {
      const gradle = scanTokensAndScopes(read(path.join(absolute, gradleFile)), "kotlin").commentlessCode;
      // A JavaExec code-generation task's mainClass does not make its library an application.
      const application = /\b(?:id\s*\(?\s*["'](?:com\.android\.application|application|org\.springframework\.boot)["']|application\s*\{)/.test(gradle);
      const library = /["'](?:java-library|maven-publish|java-gradle-plugin|com\.android(?:\.kotlin\.multiplatform)?\.library)["']|\bkotlin\s*\(\s*["']multiplatform["']/.test(gradle);
      scopes.push({ prefix, languages: new Set(["kotlin", "java"]), mode: application ? "application" : library ? "library" : "hybrid", manifest: prefix + gradleFile });
    }
    let gemspecs = [];
    try { gemspecs = fs.readdirSync(absolute).filter((file) => file.endsWith(".gemspec")); } catch { /* directory disappeared */ }
    for (const gemspec of gemspecs) {
      const gem = read(path.join(absolute, gemspec));
      if (!/Gem::Specification\.new/.test(gem)) continue;
      const paths = gem.match(/\.require_paths\s*=\s*\[([^\]]+)\]/)?.[1];
      const requirePaths = paths ? [...paths.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]) : ["lib"];
      scopes.push({ prefix, languages: new Set(["ruby"]), mode: "ruby-package", requirePaths, manifest: prefix + gemspec });
    }
    const pkgText = read(path.join(absolute, "package.json"));
    if (pkgText) try {
      const pkg = JSON.parse(pkgText);
      const hasExports = Boolean(pkg.exports || (!pkg.private && (pkg.main || pkg.module || pkg.svelte)));
      const hasExecutable = Boolean(pkg.bin);
      // React Email packages are discovered and rendered by the framework's
      // `email` CLI. Their template modules are framework inputs, not missing
      // application-entry exports, even though these internal packages are private.
      const isReactEmailTemplate = pkg.private === true &&
        (pkg.dependencies?.["react-email"] || pkg.devDependencies?.["react-email"]) &&
        Object.values(pkg.scripts || {}).some((script) => typeof script === "string" && /\bemail\s+(?:build|dev|export)\b/.test(script));
      const mode = hasExports ? "library" : pkg.private || hasExecutable ? "application" : "hybrid";
      const templateDirectories = isReactEmailTemplate ? Object.values(pkg.scripts || {})
        .filter((script) => typeof script === 'string' && /\bemail\s+(?:build|dev|export)\b/.test(script))
        .map((script) => script.match(/\s--dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/)?.slice(1).find(Boolean) || 'emails')
        .filter((directory) => !path.isAbsolute(directory) && !directory.split(/[\\/]/).includes('..'))
        .map((directory) => directory.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') + '/') : [];
      scopes.push({ prefix, languages: jsLanguages, mode, templateDirectories, manifest: prefix + "package.json" });
      for (const raw of [...exportPaths(pkg.exports), ...[pkg.main, pkg.module, pkg.svelte].filter((p) => typeof p === "string").map((p) => p.replace(/^\.\//, ""))]) {
        if (raw.startsWith("../") || path.isAbsolute(raw)) continue;
        const stem = raw.replace(/\.(?:c?js|mjs|[cm]?ts)$/, "");
        const mapped = stem.replace(/^(?:dist|build|lib|out)\//, "src/");
        const stems = new Set([stem, mapped, "src/" + stem]);
        if (pkg.svelte) stems.add(stem.replace(/^(?:dist|build)\//, "src/lib/"));
        entryPatterns.push(prefix + raw);
        for (const candidate of stems) for (const ext of [".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx", ".svelte"]) entryPatterns.push(prefix + candidate + ext);
      }
    } catch { /* malformed manifest is not evidence of a library */ }
    const goMod = read(path.join(absolute, "go.mod"));
    if (/^module\s+/m.test(goMod)) {
      scopes.push({ prefix, languages: new Set(["go"]), mode: "go-package", manifest: prefix + "go.mod" });
    }
    const pyproject = read(path.join(absolute, "pyproject.toml"));
    if (pyproject) {
      const projectName = section(pyproject, "project").match(/^name\s*=\s*["']([^"']+)["']/m)?.[1];
      const moduleName = section(pyproject, "tool.flit.module").match(/^name\s*=\s*["']([^"']+)["']/m)?.[1] || projectName?.replace(/-/g, "_");
      const app = /^\[tool\.(?:fastapi|django)\]/m.test(pyproject);
      const packaged = /build-backend\s*=/.test(section(pyproject, "build-system")) && moduleName &&
        [moduleName + "/__init__.py", "src/" + moduleName + "/__init__.py", moduleName + ".py", "src/" + moduleName + ".py"].some((p) => fs.existsSync(path.join(absolute, p)));
      if (app || packaged) scopes.push({ prefix, languages: new Set(["python"]), mode: app ? "application" : "python-package", moduleName, manifest: prefix + "pyproject.toml" });
    }
  }
  scopes.sort((a, b) => b.prefix.length - a.prefix.length);
  const libraryFiles = new Set();
  const applicationFiles = new Set();
  const fileModes = new Map();
  for (const file of files) {
    const scope = scopes.find((s) => file.file.startsWith(s.prefix) && s.languages.has(file.lang));
    if (!scope) continue;
    let mode = scope.mode;
    const relative = file.file.slice(scope.prefix.length);
    if (scope.templateDirectories?.some((directory) => relative.startsWith(directory))) mode = 'library';
    if (mode === "dart-package") mode = relative.startsWith("lib/") ? "library" : relative.startsWith("bin/") ? "application" : "hybrid";
    if (mode === "ruby-package") mode = scope.requirePaths.some((p) => relative.startsWith(p.replace(/\/$/, "") + "/")) ? "library" : /^(?:bin|exe)\//.test(relative) ? "application" : "hybrid";
    if (mode === "go-package") mode = file.packageName && file.packageName !== "main" ? "library" : "application";
    if (mode === "python-package") {
      mode = [scope.moduleName + "/", "src/" + scope.moduleName + "/"].some((p) => relative.startsWith(p)) ||
        [scope.moduleName + ".py", "src/" + scope.moduleName + ".py"].includes(relative) ? "library" : "hybrid";
    }
    fileModes.set(file.file, mode);
    if (mode === "library") libraryFiles.add(file.file);
    if (mode === "application") applicationFiles.add(file.file);
  }
  const patterns = entryPatterns.map((p) => new RegExp("^" + p.split("*").map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"));
  const packageEntryFiles = new Set(files.filter((f) => patterns.some((p) => p.test(f.file))).map((f) => f.file));
  return { libraryFiles, applicationFiles, fileModes, packageEntryFiles, frameworkEntryFiles, manifests: [...new Set(scopes.map((s) => s.manifest))] };
}
