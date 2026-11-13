import { classifyZone } from './fingerprint.mjs';
import { rustModuleCandidates, rustCompilationAttributes } from './rust-imports.mjs';

// Classify test-only compilation without selecting any actual Cargo features.
// Unknown cfg syntax never establishes a production path for a *_test.rs file.
export function rustTestCondition(expression) {
  const text = expression.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/\s+/g, '');
  if (text === 'test') return 'test';
  if (text === 'not(test)') return 'prod';
  if (!/\btest\b/.test(text) && !/\bcfg_attr\b/.test(text)) return 'prod';
  const group = text.match(/^(all|any)\(([\s\S]*)\)$/);
  if (!group) return 'unknown';
  let depth = 0, start = 0;
  const parts = [];
  for (let i = 0; i <= group[2].length; i++) {
    const char = group[2][i];
    if (i === group[2].length || (char === ',' && depth === 0)) { if (i > start) parts.push(rustTestCondition(group[2].slice(start, i))); start = i + 1; }
    else if (char === '(') depth++;
    else if (char === ')') depth--;
  }
  if (group[1] === 'all' && parts.includes('test')) return 'test';
  if (group[1] === 'any' && parts.length && parts.every((part) => part === 'test')) return 'test';
  if (parts.length && parts.every((part) => part === 'prod')) return 'prod';
  return 'unknown';
}

export const rustAttributesZone = (attributes = '') => {
  attributes = rustCompilationAttributes(attributes);
  if (/\bcfg_attr\s*\(/.test(attributes)) return 'unknown';
  const conditions = [...attributes.matchAll(/#\s*!?\s*\[\s*cfg\s*\(([\s\S]*?)\)\s*\]/g)]
    .map((match) => rustTestCondition(match[1]));
  return conditions.includes('test') ? 'test' : conditions.includes('unknown') ? 'unknown' : 'prod';
};
const combine = (parent, child) => parent === 'test' || child === 'test' ? 'test'
  : parent === 'unknown' || child === 'unknown' ? 'unknown' : 'prod';

export function classifyRustModuleZones(files, cargoProject) {
  const rustFiles = new Map(files.filter((file) => file.lang === 'rust').map((file) => [file.file, file]));
  const contexts = new Map();
  const visit = (file, scopeOffset, inlineNames, isRoot, state, ancestors, range = null) => {
    const key = `${file.file}:${scopeOffset}:${state}`;
    if (ancestors.has(key)) return;
    const next = new Set(ancestors); next.add(key);
    state = combine(state, rustAttributesZone(file.rustImports?.innerAttributes));
    if (!contexts.has(file.file)) contexts.set(file.file, []);
    contexts.get(file.file).push({ state, range, scopeOffset });
    for (const mod of file.rustImports?.modules || []) {
      if (mod.scopeOffset !== scopeOffset) continue;
      const childState = combine(state, rustAttributesZone((mod.attributes || '') + (mod.innerAttributes || '')));
      if (mod.inline) visit(file, mod.bodyOffset, [...inlineNames, { name: mod.name, path: mod.path }], isRoot, childState, next,
        { start: mod.bodyStart, end: mod.endLine });
      else {
        const matches = rustModuleCandidates(file.file, mod, isRoot, inlineNames).filter((candidate) => rustFiles.has(candidate));
        if (matches.length === 1) visit(rustFiles.get(matches[0]), -1, [], false, childState, next);
      }
    }
  };
  const roots = [...new Set([...(cargoProject.entryRoots || []), ...(cargoProject.libraryFiles || [])])];
  for (const root of roots) {
    const file = rustFiles.get(root);
    if (file && classifyZone(root.replace(/_tests?\.rs$/i, '_source.rs')) === 'prod') visit(file, -1, [], true, 'prod', new Set());
  }
  for (const file of rustFiles.values()) {
    const baseline = classifyZone(file.file);
    const eligible = baseline === 'prod' || (/_tests?\.rs$/i.test(file.file) && classifyZone(file.file.replace(/_tests?\.rs$/i, '_source.rs')) === 'prod');
    const occurrences = contexts.get(file.file) || [];
    const fileContexts = occurrences.filter((context) => !context.range);
    const fileState = fileContexts.some((context) => context.state === 'prod') ? 'prod'
      : fileContexts.length && fileContexts.every((context) => context.state === 'test') ? 'test' : null;
    file.zone = eligible && fileState ? fileState : baseline;
    for (const symbol of file.symbols) {
      const containing = occurrences.filter((context) => !context.range ||
        (symbol.startLine > context.range.start && symbol.endLine <= context.range.end));
      const inner = containing.filter((context) => !containing.some((other) => other.scopeOffset > context.scopeOffset));
      const symbolState = inner.some((context) => context.state === 'prod') ? 'prod'
        : inner.length && inner.every((context) => context.state === 'test') ? 'test' : null;
      symbol.zone = symbol.rustTestOnly ? 'test' : eligible && symbolState ? symbolState : file.zone;
    }
  }
}
