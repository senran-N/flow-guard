import { createJsImportResolver } from './js-imports.mjs';

const cache = new WeakMap();
export function architectureDependencies(graph) {
  if (cache.has(graph)) return cache.get(graph);
  const files = graph.files.filter(f => f.zone === 'prod' && ['ts', 'vue'].includes(f.lang) && Array.isArray(f.moduleReferences));
  const resolve = createJsImportResolver(graph.workspaceRoot || process.cwd(), graph.files);
  const records = [];
  for (const file of files) {
    for (const reference of file.moduleReferences || []) {
      const { specifier, form, line } = reference;
      const targets = resolve(file.file, specifier);
      records.push({ file: file.file, line, specifier, form, targets,
        status: targets.length > 1 ? 'AMBIGUOUS' : targets.length ? 'RESOLVED' : specifier.startsWith('.') ? 'UNRESOLVED_LOCAL' : 'EXTERNAL_OR_UNRESOLVED' });
    }
  }
  const result = { records, limitations: resolve.limitations };
  cache.set(graph, result);
  return result;
}
