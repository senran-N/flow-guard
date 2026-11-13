import fs from 'node:fs';
import path from 'node:path';
import { inferFileDomain } from './arch-vision.mjs';

const CONFIG = '.flowguard-architecture.json';
const MANIFESTS = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'pubspec.yaml', 'build.gradle.kts', 'build.gradle'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function validateConfig(raw) {
  if (!plain(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.modules) || Object.keys(raw).some(k => !['schemaVersion', 'modules'].includes(k)))
    throw new Error(`${CONFIG}: expected schemaVersion 1 and modules array`);
  const ids = new Set(), prefixes = new Set();
  for (const module of raw.modules) {
    if (!plain(module) || typeof module.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(module.id) || module.id.split('/').includes('..') || ids.has(module.id) ||
      !Array.isArray(module.paths) || !module.paths.length || Object.keys(module).some(k => !['id', 'name', 'paths', 'layer'].includes(k)) ||
      (module.name !== undefined && (typeof module.name !== 'string' || !module.name.trim())) ||
      (module.layer !== undefined && (typeof module.layer !== 'string' || !module.layer.trim()))) throw new Error(`${CONFIG}: invalid or duplicate module`);
    ids.add(module.id);
    for (const prefix of module.paths) {
      if (typeof prefix !== 'string' || !prefix || prefix.includes('\\') || prefix.startsWith('/') || /[:*?]/.test(prefix) ||
        prefix.split('/').some(p => !p || p === '.' || p === '..') || prefixes.has(prefix)) throw new Error(`${CONFIG}: invalid or conflicting path prefix ${prefix}`);
      prefixes.add(prefix);
    }
  }
  return raw;
}

export function loadArchitectureGrouping(graph) {
  const root = graph.workspaceRoot;
  let config = { schemaVersion: 1, modules: [] };
  if (root && fs.existsSync(path.join(root, CONFIG))) {
    config = validateConfig(JSON.parse(fs.readFileSync(path.join(root, CONFIG), 'utf8')));
  }
  const rules = config.modules.flatMap(module => module.paths.map(prefix => ({ prefix, module }))).sort((a, b) => b.prefix.length - a.prefix.length);
  const matchedRule = file => rules.find(r => file === r.prefix || file.startsWith(r.prefix + '/'));
  const configuredIds = new Set(config.modules.map(m => m.id));
  const domainFor = file => {
    const rule = matchedRule(file);
    if (rule) return rule.module.id;
    const fallback = inferFileDomain(file);
    if (configuredIds.has(fallback)) throw new Error(`${CONFIG}: configured module ${fallback} collides with unmapped directory ${file}; include its path explicitly`);
    return fallback;
  };
  const directoryPackages = new Map();
  function packageFor(file) {
    if (!root) return null;
    let directory = path.posix.dirname(file);
    const visited = [];
    while (true) {
      if (directoryPackages.has(directory)) break;
      visited.push(directory);
      const manifest = MANIFESTS.find(name => fs.existsSync(path.join(root, directory === '.' ? '' : directory, name)));
      if (manifest) { directoryPackages.set(directory, { directory: directory === '.' ? '' : directory, manifest: path.posix.join(directory, manifest) }); break; }
      if (directory === '.') { directoryPackages.set(directory, null); break; }
      directory = path.posix.dirname(directory);
    }
    const result = directoryPackages.get(directory);
    for (const dir of visited) directoryPackages.set(dir, result);
    return result;
  }
  return { domainFor, packageFor, configuration: config,
    describe: file => {
      const rule = matchedRule(file);
      return rule ? { grouping: 'EXPLICIT_CONFIG', label: rule.module.name || rule.module.id, configuredLayer: rule.module.layer,
        groupingEvidence: { file: CONFIG, pathPrefix: rule.prefix } }
        : { grouping: 'DIRECTORY_HEURISTIC', label: inferFileDomain(file), groupingEvidence: { file } };
    } };
}
