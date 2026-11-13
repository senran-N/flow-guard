import { rustType, splitRustTypes } from './rust-type-flow.mjs';
import { createMacroTypeResolver } from './rust-macro-types.mjs';
const TYPE = /^(?:&\s*(?:'\w+\s+)?(?:mut\s+)?)?((?:r#)?[A-Za-z_]\w*(?:::(?:r#)?[A-Za-z_]\w*)*)$/;
const typePath = (text) => text.trim().match(TYPE)?.[1] || null;

// Keep only small declaration facts, using lexical scopes from the lexer. An
// untyped shadowing declaration deliberately hides an older known type.
export function parseRustReceiverFacts(code, spans, symbols) {
  const lines = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') lines.push(i + 1);
  const lineAt = (offset) => {
    let low = 0, high = lines.length;
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (lines[mid] <= offset) low = mid; else high = mid; }
    return low + 1;
  };
  const facts = new Map();
  for (const symbol of symbols) {
    if (!['function', 'method'].includes(symbol.kind)) continue;
    const start = lines[symbol.startLine - 1] || 0;
    const end = lines[symbol.endLine] ?? code.length;
    const text = code.slice(start, end);
    const isOwnOffset = offset => !symbols.some(inner => inner.parentFunctionId === symbol.id &&
      lineAt(start + offset) >= inner.startLine && lineAt(start + offset) <= inner.endLine);
    const signature = text.match(/\bfn\s+(?:r#)?[A-Za-z_]\w*(?:\s*<[^{};]*>)?\s*\(([^{};]*?)\)\s*(?:->\s*([^{};]+))?/);
    const bindings = [];
    if (signature) for (const param of splitRustTypes(signature[1])) {
      const match = param.trim().match(/^(?:mut\s+)?([A-Za-z_]\w*)\s*:\s*(.+)$/);
      if (match) bindings.push({ name: match[1], type: typePath(match[2]), nominalType: rustType(match[2]), line: symbol.startLine, endLine: symbol.endLine, scope: start, parameter: true });
    }
    for (const match of text.matchAll(/\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\b([^;\n]*)/g)) {
      const offset = start + match.index;
      if (symbols.some((inner) => inner.parentFunctionId === symbol.id && lineAt(offset) >= inner.startLine && lineAt(offset) <= inner.endLine)) continue;
      const scope = spans.filter((span) => span.openOffset < offset && span.closeOffset > offset).sort((a, b) => b.openOffset - a.openOffset)[0];
      const tail = match[2];
      const annotation = tail.match(/^\s*:\s*([^=]+)\s*=/)?.[1];
      const literal = tail.match(/^\s*=\s*((?:r#)?[A-Za-z_]\w*(?:::(?:r#)?[A-Za-z_]\w*)*)\s*\{/)?.[1];
      bindings.push({ name: match[1], type: typePath(annotation || literal || ''), nominalType: rustType(annotation || literal || ''), line: lineAt(offset), endLine: scope?.closeLine || symbol.endLine, scope: scope?.openOffset ?? start });
    }
    // Only zero-argument fluent chains have an unambiguous lexical structure
    // here. Nested calls, closures and generic dispatch stay unresolved.
    const chains = [...text.matchAll(/\b([A-Za-z_]\w*)((?:\s*\.\s*[A-Za-z_]\w*\s*\(\s*\)){2,})/g)].filter(match => isOwnOffset(match.index))
      .map((match) => ({ root: match[1], methods: [...match[2].matchAll(/\.\s*([A-Za-z_]\w*)\s*\(/g)].map((part) => part[1]), line: lineAt(start + match.index) }));
    const chainContinuations = [...text.matchAll(/\)\s*\.\s*([A-Za-z_]\w*)\s*\(/g)].filter(match => isOwnOffset(match.index))
      .map((match) => ({ name: match[1], line: lineAt(start + match.index + match[0].lastIndexOf(match[1])) }));
    // A concrete associated factory may return a different type. Resolve its
    // declared return type rather than assuming Type::factory() returns Type.
    const factoryChains = [...text.matchAll(/\b([A-Za-z_]\w*(?:::[A-Za-z_]\w*)+)\s*\(\s*\)\s*\.\s*([A-Za-z_]\w*)\s*\(/g)].filter(match => isOwnOffset(match.index))
      .map(match => ({ factory: match[1], name: match[2], line: lineAt(start + match.index + match[0].lastIndexOf(match[2])) }));
    const hasComplexBindings = /\blet\s+(?:mut\s+)?[([{]|\|[^|\n]*\b[A-Za-z_]\w*[^|\n]*\||\b(?:for|if\s+let|while\s+let)\s+/.test(text);
    facts.set(symbol.id, { bindings, chains, factoryChains, chainContinuations, hasComplexBindings, returnType: typePath(signature?.[2] || '') });
  }
  return facts;
}

export function createRustReceiverResolver(files, resolvePath, cargoProject) {
  const fileByPath = new Map(files.filter((file) => file.lang === 'rust').map((file) => [file.file, file]));
  const byId = new Map([...fileByPath.values()].flatMap((file) => file.symbols.map((symbol) => [symbol.id, symbol])));
  for (const symbol of byId.values()) delete symbol.rustReceiverCandidates;
  const methods = new Map();
  for (const symbol of byId.values()) if (symbol.parentContainerId) {
    const key = `${symbol.parentContainerId}:${symbol.name}`;
    if (!methods.has(key)) methods.set(key, []);
    methods.get(key).push(symbol);
  }
  const limitations = new Map();
  const methodsByName = new Map();
  for (const symbol of byId.values()) if (symbol.parentContainerName && ['function', 'method'].includes(symbol.kind)) {
    if (!methodsByName.has(symbol.name)) methodsByName.set(symbol.name, []);
    methodsByName.get(symbol.name).push(symbol);
  }
  const ownerOf = (file) => (cargoProject?.packages || []).filter((pkg) => !pkg.rootDir || file.startsWith(`${pkg.rootDir}/`))
    .sort((a, b) => b.rootDir.length - a.rootDir.length)[0]?.manifest;
  const macroReturn = createMacroTypeResolver(files, resolvePath, ownerOf);
  const resolveType = (symbol, type, line) => type === 'Self'
    ? [byId.get(symbol.parentContainerId)].filter(Boolean)
    : resolvePath(symbol, { rustPath: type, rawCallee: type.split('::').at(-1), line })
      .filter((target) => ['struct', 'class', 'enum'].includes(target.kind));
  const variableTypes = (symbol, name, line) => {
    const facts = fileByPath.get(symbol.file)?.rustReceiverFacts?.get(symbol.id);
    if (facts?.hasComplexBindings) return [];
    const bindings = (facts?.bindings || [])
      .filter((binding) => binding.name === name && binding.line <= line && binding.endLine >= line)
      .sort((a, b) => b.scope - a.scope || b.line - a.line);
    const binding = bindings[0];
    if (!binding?.type || (bindings[1] && !binding.parameter && binding.line === bindings[1].line && binding.scope === bindings[1].scope)) return [];
    return resolveType(symbol, binding.type, line);
  };
  const nominal = (context, type, line, substitutions = new Map(), depth = 0) => {
    if (!type || depth > 16) return null;
    if (substitutions.has(type.path)) return substitutions.get(type.path);
    const owners = resolveType(context, type.path, line);
    const args = type.args.map(arg => nominal(context, arg, line, substitutions, depth + 1));
    if (!args.every(Boolean)) return null;
    if (owners.length === 1) return { owner: owners[0], args };
    if (owners.length > 1) return null;
    if (/^(?:bool|char|str|[ui](?:8|16|32|64|128|size)|f(?:32|64))$/.test(type.path) && !type.args.length) return { builtin: type.path, args: [] };
    const file = fileByPath.get(context.file), pieces = type.path.split('::');
    const imports = (file.rustImports?.uses || []).filter(u => u.local === pieces[0] && line >= u.scopeStart && line <= u.scopeEnd && u.line <= line);
    const canonical = imports.length === 1 ? [...imports[0].path, ...pieces.slice(1)].join('::') : imports.length ? '' : type.path;
    const standard = new Set(['std::cell::RefCell', 'core::cell::RefCell', 'std::cell::Ref', 'std::cell::RefMut',
      'std::sync::Arc', 'std::rc::Rc', 'std::boxed::Box', 'alloc::boxed::Box', 'std::sync::Mutex', 'std::sync::RwLock',
      'std::sync::MutexGuard', 'std::sync::RwLockReadGuard', 'std::sync::RwLockWriteGuard', 'std::option::Option', 'std::result::Result']);
    const prelude = ['Box', 'Option', 'Result'].includes(canonical) ? canonical : null;
    return (standard.has(canonical) || prelude) && args.length ? { builtin: canonical.split('::').at(-1), args } : null;
  };
  const typeEnvironment = value => new Map((fileByPath.get(value.owner?.file)?.rustTypeFlow?.containers.get(value.owner?.id)?.params || [])
    .map((name, i) => [name, value.args[i] || null]));
  const dereference = value => ['Box', 'Arc', 'Rc', 'Ref', 'RefMut', 'MutexGuard', 'RwLockReadGuard', 'RwLockWriteGuard'].includes(value?.builtin) ? value.args[0] : value;
  const methodTargets = (value, name) => {
    for (let i = 0; value && i < 12; i++, value = dereference(value) === value ? null : dereference(value)) {
      if (value.owner) return { targets: methods.get(`${value.owner.id}:${name}`) || [], value };
    }
    return { targets: [], value: null };
  };
  const returnValue = (target, receiver, line) => resolvePath.isConditional?.(target) || /\basync\s+fn\b/.test(target.snippet?.split('{')[0] || '') ? null : nominal(target,
    fileByPath.get(target.file)?.rustTypeFlow?.returns.get(target.id), line, new Map([...typeEnvironment(receiver), ['Self', receiver]]));
  const expressionType = (symbol, expression, line, depth = 0) => {
    if (!expression || depth > 24) return null;
    const facts = fileByPath.get(symbol.file)?.rustReceiverFacts.get(symbol.id);
    if (expression.kind === 'root') {
      if (expression.path === 'self' || expression.path === 'Self') return byId.get(symbol.parentContainerId) ? { owner: byId.get(symbol.parentContainerId), args: [] } : null;
      const bindings = (facts?.bindings || []).filter(b => b.name === expression.path && b.line <= line && b.endLine >= line)
        .sort((a, b) => b.scope - a.scope || b.line - a.line);
      if (bindings.length) return facts?.hasComplexBindings || (bindings[1]?.scope === bindings[0].scope && bindings[1]?.line === bindings[0].line) ? null
        : nominal(symbol, bindings[0].nominalType, line);
      return null;
    }
    if (expression.kind === 'field') {
      const receiver = dereference(expressionType(symbol, expression.receiver, line, depth + 1));
      if (!receiver?.owner) return null;
      const type = fileByPath.get(receiver.owner.file)?.rustTypeFlow?.containers.get(receiver.owner.id)?.fields.get(expression.name);
      return nominal(receiver.owner, type, receiver.owner.startLine, typeEnvironment(receiver));
    }
    if (!expression.name && expression.receiver.kind === 'root') {
      const root = expression.receiver, segments = root.path.split('::'), name = segments.pop();
      if (!segments.length || root.lastHasArgs) return null;
      const owner = nominal(symbol, { path: segments.join('::'), args: root.args }, line);
      if (!owner) return null;
      const { targets } = methodTargets(owner, name);
      if (targets.length === 1) return returnValue(targets[0], owner, targets[0].startLine);
      const generated = targets.length === 0 && owner.owner ? macroReturn(owner.owner, name) : null;
      return generated ? nominal(generated.context, generated.type, generated.line) : null;
    }
    let value = expressionType(symbol, expression.receiver, line, depth + 1);
    if (!value) return null;
    for (let i = 0; i < 12 && dereference(value) !== value; i++) value = dereference(value);
    if (value.builtin === 'RefCell' && ['borrow', 'borrow_mut'].includes(expression.name)) return { builtin: expression.name === 'borrow' ? 'Ref' : 'RefMut', args: value.args };
    if (['Option', 'Result'].includes(value.builtin) && ['unwrap', 'expect'].includes(expression.name)) return value.args[0];
    if (['Mutex', 'RwLock'].includes(value.builtin) && ['lock', 'read', 'write'].includes(expression.name)) return { builtin: 'Result', args: [{ builtin: 'MutexGuard', args: value.args }] };
    if (['Box', 'Arc', 'Rc'].includes(value.builtin) && expression.name === 'as_ref') return value.args[0];
    const selected = methodTargets(value, expression.name);
    return selected.targets.length === 1 ? returnValue(selected.targets[0], selected.value, selected.targets[0].startLine) : null;
  };
  const resolver = (symbol, site) => {
    const methodName = site.rawCallee || site.callee;
    const typedSites = (fileByPath.get(symbol.file)?.rustTypeFlow?.expressions.get(symbol.id) || [])
      .filter(s => s.line === site.line && s.name === methodName);
    if (typedSites.length === 1) {
      const value = expressionType(symbol, typedSites[0].receiver, site.line);
      const selected = methodTargets(value, methodName).targets
        .filter(t => ownerOf(symbol.file) === ownerOf(t.file) || resolvePath.isPublicApi?.(t));
      if (selected.length === 1) return selected;
    }
    let types = [];
    if (site.rustPath?.includes('::')) {
      types = resolveType(symbol, site.rustPath.split('::').slice(0, -1).join('::'), site.line);
    } else if (site.receiver === 'self') types = [byId.get(symbol.parentContainerId)].filter(Boolean);
    else if (site.receiver) {
      types = variableTypes(symbol, site.receiver, site.line);
    } else {
      const facts = fileByPath.get(symbol.file)?.rustReceiverFacts?.get(symbol.id);
      const uniqueContinuation = (facts?.chainContinuations || []).filter(c => c.line === site.line && c.name === methodName).length <= 1;
      const factories = (facts?.factoryChains || [])
        .filter(chain => chain.line === site.line && chain.name === methodName);
      if (factories.length === 1 && uniqueContinuation && !facts?.hasComplexBindings) {
        const factory = factories[0];
        const owners = resolveType(symbol, factory.factory.split('::').slice(0, -1).join('::'), site.line);
        const targets = owners.flatMap(type => methods.get(`${type.id}:${factory.factory.split('::').at(-1)}`) || []);
        if (targets.length === 1 && !resolvePath.isConditional?.(targets[0])) {
          const target = targets[0], returned = fileByPath.get(target.file)?.rustReceiverFacts?.get(target.id)?.returnType;
          types = returned ? resolveType(target, returned, target.startLine) : [];
        }
      }
      const chains = (fileByPath.get(symbol.file)?.rustReceiverFacts?.get(symbol.id)?.chains || [])
        .filter((chain) => chain.line === site.line && chain.methods.at(-1) === methodName);
      if (chains.length === 1 && uniqueContinuation) {
        const chain = chains[0];
        types = chain.root === 'self' ? [byId.get(symbol.parentContainerId)].filter(Boolean) : variableTypes(symbol, chain.root, site.line);
        for (const previous of chain.methods.slice(0, -1)) {
          const targets = types.flatMap((type) => methods.get(`${type.id}:${previous}`) || []);
          if (targets.length !== 1) { types = []; break; }
          const target = targets[0], returned = fileByPath.get(target.file)?.rustReceiverFacts?.get(target.id)?.returnType;
          types = returned ? resolveType(target, returned, target.startLine) : [];
        }
      }
    }
    const targets = [...new Map(types.flatMap((type) => methods.get(`${type.id}:${methodName}`) || [])
      .filter((target) => ownerOf(symbol.file) === ownerOf(target.file) || resolvePath.isPublicApi?.(target))
      .map((target) => [target.id, target])).values()];
    if (targets.length === 1) return targets;
    if ((site.receiver && !site.rustPath?.includes('::')) || resolver.isChainSite(symbol, site)) {
      limitations.set(symbol.file, { kind: 'RUST_RECEIVER_TYPE_UNRESOLVED', file: symbol.file,
        reason: '部分方法接收者缺少可静态确定的具体类型，未按方法名称猜测调用' });
      // An unresolved spelling is only a candidate, never an executable edge.
      // Preserve it so missing type inference is not reported as proven absence.
      for (const target of types.length === 0 ? methodsByName.get(methodName) || [] : []) {
        if (ownerOf(symbol.file) !== ownerOf(target.file) && !resolvePath.isPublicApi?.(target)) continue;
        const evidence = { file: symbol.file, line: site.line, reason: `未解析 Rust 接收者候选: ${methodName}` };
        target.rustReceiverCandidates ||= [];
        if (!target.rustReceiverCandidates.some((item) => item.file === evidence.file && item.line === evidence.line)) target.rustReceiverCandidates.push(evidence);
      }
    }
    return [];
  };
  resolver.isChainSite = (symbol, site) => (fileByPath.get(symbol.file)?.rustReceiverFacts?.get(symbol.id)?.chainContinuations || [])
    .some((continuation) => continuation.name === (site.rawCallee || site.callee) && continuation.line === site.line);
  Object.defineProperty(resolver, 'limitations', { get: () => [...limitations.values()] });
  return resolver;
}
