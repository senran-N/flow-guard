import path from 'node:path';

export function parsePythonDependencies(code, symbols) {
  const imports = [];
  for (const match of code.matchAll(/^[ \t]*from\s+([.\w]+)\s+import\s+(?:\(([^)]*)\)|([^\n]+))/gm)) {
    for (const entry of (match[2] || match[3] || '').split(',')) {
      const item = entry.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/);
      if (item) imports.push({ source: match[1], imported: item[1], local: item[2] || item[1] });
    }
  }
  const dependencyNames = imports.filter((binding) => binding.source === 'fastapi' && ['Depends', 'Security'].includes(binding.imported)).map((binding) => binding.local);
  const routers = imports.filter((binding) => binding.source === 'fastapi' && ['FastAPI', 'APIRouter'].includes(binding.imported)).map((binding) => binding.local);
  const lines = code.split('\n');
  const references = [];
  if (!dependencyNames.length || !routers.length) return { imports, references };
  const routerVariables = new Set();
  for (const match of code.matchAll(/^[ \t]*([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\(/gm)) {
    if (routers.includes(match[2])) routerVariables.add(match[1]);
  }
  const isShadowed = (name, before) => new RegExp(`^[ \\t]*(?:(?:async\\s+)?def|class)\\s+${name}\\b|^[ \\t]*${name}\\s*(?::[^=\\n]+)?=`, 'm').test(before);
  const hasLiveRouterBinding = (name, before) => {
    const assignments = [...before.matchAll(new RegExp(`^[ \\t]*${name}\\s*(?::[^=\\n]+)?=\\s*([^\\n]+)$`, 'gm'))];
    const latest = assignments.at(-1);
    const constructor = latest?.[1].match(/^([A-Za-z_]\w*)\s*\(/)?.[1];
    return Boolean(constructor && routers.includes(constructor) && !isShadowed(constructor, before.slice(0, latest.index)));
  };
  const argsAt = (text, open) => {
    let depth = 0;
    for (let index = open; index < text.length; index++) {
      if (text[index] === '(') depth++;
      else if (text[index] === ')' && --depth === 0) return text.slice(open + 1, index);
    }
    return null;
  };
  for (const symbol of symbols) {
    if (symbol.kind !== 'function' || symbol.parentFunctionId || symbol.parentContainerName) continue;
    const previousEnd = Math.max(0, ...symbols.filter((other) => other.endLine < symbol.startLine).map((other) => other.endLine));
    const context = lines.slice(previousEnd, symbol.startLine - 1).join('\n');
    for (const route of context.matchAll(/^[ \t]*@([A-Za-z_]\w*)\.(?:get|post|put|patch|delete|options|head|api_route|websocket)\s*\(/gm)) {
      if (!routerVariables.has(route[1])) continue;
      const before = lines.slice(0, previousEnd).join('\n') + '\n' + context.slice(0, route.index);
      if (!hasLiveRouterBinding(route[1], before)) continue;
      const open = route.index + route[0].lastIndexOf('(');
      const decorator = argsAt(context, open);
      if (decorator === null) continue;
      for (const match of decorator.matchAll(/\b([A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*)\s*(?:,|\))/g)) {
        if (!dependencyNames.includes(match[1]) || isShadowed(match[1], before)) continue;
        references.push({ callerId: symbol.id, name: match[2], local: isShadowed(match[2], before), line: previousEnd + context.slice(0, open + 1 + match.index).split('\n').length });
      }
    }
  }
  return { imports, references };
}

export function linkPythonDependencies(files, addEdge) {
  const python = files.filter((file) => file.lang === 'python');
  for (const file of python) for (const reference of file.pythonDependencies?.references || []) {
    const binding = reference.local ? null : file.pythonDependencies.imports.find((item) => item.local === reference.name);
    let targets = [];
    if (!binding) targets = file.symbols.filter((symbol) => symbol.name === reference.name && !symbol.parentFunctionId && !symbol.parentContainerName);
    else {
      let modulePath;
      if (binding.source.startsWith('.')) {
        const dots = binding.source.match(/^\.+/)[0].length;
        modulePath = path.posix.normalize(path.posix.join(path.posix.dirname(file.file), ...Array(dots - 1).fill('..'), binding.source.slice(dots).replace(/\./g, '/')));
      } else {
        const segments = binding.source.split('.');
        const origin = file.file.split('/').lastIndexOf(segments[0]);
        if (origin >= 0) modulePath = [...file.file.split('/').slice(0, origin), ...segments].join('/');
        else modulePath = segments.join('/');
      }
      for (const targetFile of python.filter((item) => item.file === `${modulePath}.py` || item.file === `${modulePath}/__init__.py`)) {
        targets.push(...targetFile.symbols.filter((symbol) => symbol.name === binding.imported && !symbol.parentFunctionId && !symbol.parentContainerName));
      }
    }
    for (const target of targets) addEdge(reference.callerId, target.id, {
      kind: 'REGISTRATION', evidence: { file: file.file, line: reference.line, reason: `FastAPI 路由依赖: ${reference.name}`, returnFlow: 'REGISTERED_REF' },
      resolution: { mode: 'FASTAPI_DEPENDENCY', confidence: targets.length === 1 ? 'HIGH' : 'AMBIGUOUS' }
    });
  }
}
