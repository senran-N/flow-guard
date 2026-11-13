export function resolveArchitectureFocus(model, input) {
  if (typeof input !== 'string' || !input.trim()) throw new TypeError('Architecture focus must be a nonempty string');
  const { nodes, symbols, prodFiles, project, level, domainFor } = model;
  const focus = input.replace(/\\/g, '/').replace(/^\.\//, '');
  if (nodes.has(focus)) return [focus];
  const exactSymbol = symbols.filter(s => s.id === focus || `symbol:${s.id}` === focus);
  if (exactSymbol.length) return [...new Set(exactSymbol.map(project))];
  const files = prodFiles.filter(f => [f.file, `file:${f.file}`, domainFor(f.file), `module:${domainFor(f.file)}`].includes(focus));
  if (files.length) {
    const paths = new Set(files.map(f => f.file));
    return level === 'symbol' ? symbols.filter(s => paths.has(s.file)).map(project)
      : [...new Set(files.map(f => level === 'file' ? `file:${f.file}` : `module:${domainFor(f.file)}`))];
  }
  const named = symbols.filter(s => s.kind !== 'module' && (s.name === focus || (s.parentContainerName &&
    [`${s.parentContainerName}.${s.name}`, `${s.parentContainerName}::${s.name}`].includes(focus))));
  if (named.length > 1) throw new Error(`Ambiguous architecture focus: ${focus}; use one of: ${named.slice(0, 10).map(s => `symbol:${s.id}`).join(', ')}`);
  if (named.length === 1) return [project(named[0])];
  const special = [...nodes.values()].filter(n => n.kind !== 'SYMBOL' && n.label === focus);
  if (special.length > 1) throw new Error(`Ambiguous architecture focus: ${focus}; use an exact node ID`);
  if (special.length === 1) return [special[0].id];
  throw new Error(`Architecture focus not found: ${input}`);
}
