import { splitRustTypes, rustType } from './rust-type-flow.mjs';
import { rustAttributesBefore, rustCompilationAttributes } from './rust-imports.mjs';

// Extract only zero-argument nominal return signatures from simple, local
// declarative macro arms. No macro body is executed and unsupported arms are
// rejected. This is a signature proof, not general Rust macro expansion.
const balanced = (code, offset, open, close) => {
  let depth = 1;
  for (let i = offset + 1; i < code.length; i++) {
    if (code[i] === open) depth++;
    if (code[i] === close && --depth === 0) return i;
  }
  return null;
};
export function parseRustMacroTypes(code, imports, braces = []) {
  const definitions = [], invocations = [];
  for (const definition of imports.macroDefinitions || []) {
    const text = code.slice(definition.startOffset, definition.endOffset), arms = [];
    const pattern = /\(([^()]*)\)\s*=>\s*\{/g;
    let arm;
    while ((arm = pattern.exec(text))) {
      const opening = arm.index + arm[0].lastIndexOf('{'), end = balanced(text, opening, '{', '}');
      if (end === null) break;
      const parameters = splitRustTypes(arm[1]).map(p => p.match(/^\$([A-Za-z_]\w*)\s*:\s*(ty|ident|expr)$/));
      const body = text.slice(opening + 1, end), methods = [];
      if (parameters.every(Boolean) && !/#\s*\[/.test(body)) {
        for (const impl of body.matchAll(/\bimpl\s+\$([A-Za-z_]\w*)\s*\{/g)) {
          const implStart = impl.index + impl[0].lastIndexOf('{'), implEnd = balanced(body, implStart, '{', '}');
          if (implEnd === null) continue;
          const implBody = body.slice(implStart + 1, implEnd);
          for (const method of implBody.matchAll(/\bpub\s+fn\s+([A-Za-z_]\w*)\s*\(\s*\)\s*->\s*([^{};]+)\{/g)) {
            const before = implBody.slice(0, method.index);
            if ((before.match(/\{/g) || []).length !== (before.match(/\}/g) || []).length) continue;
            const returned = method[2].trim();
            if (/^(?:&\s*(?:'\w+\s*)?)?\$[A-Za-z_]\w*$/.test(returned)) methods.push({ owner: impl[1], name: method[1], returned });
          }
        }
      }
      arms.push({ parameters: parameters.every(Boolean) ? parameters.map(p => ({ name: p[1], kind: p[2] })) : null, methods });
      pattern.lastIndex = end + 1;
    }
    const attributes = rustAttributesBefore(code, code, definition.startOffset);
    const scope = braces.filter(b => b.openOffset < definition.startOffset && b.closeOffset > definition.endOffset)
      .sort((a, b) => b.openOffset - a.openOffset)[0];
    definitions.push({ name: definition.name, line: definition.startLine,
      scopeStart: scope?.openOffset ?? -1, scopeEnd: scope?.closeOffset ?? Infinity,
      conditional: Boolean(rustCompilationAttributes(attributes)),
      supported: (text.match(/=>/g) || []).length === arms.length && arms.every(a => a.parameters),
      exported: /#\s*\[\s*macro_export\s*\]/.test(attributes), arms });
  }
  for (const match of code.matchAll(/\b([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)!\s*\(/g)) {
    if ((imports.macroDefinitions || []).some(d => match.index >= d.startOffset && match.index < d.endOffset)) continue;
    const opening = match.index + match[0].lastIndexOf('('), end = balanced(code, opening, '(', ')');
    if (end !== null) invocations.push({ path: match[1], line: code.slice(0, match.index).split('\n').length,
      offset: match.index,
      conditional: Boolean(rustCompilationAttributes(rustAttributesBefore(code, code, match.index))),
      args: splitRustTypes(code.slice(opening + 1, end)) });
  }
  return { definitions, invocations };
}
export function createMacroTypeResolver(files, resolvePath, packageOwner) {
  const returns = new Map();
  for (const file of files.filter(f => f.lang === 'rust' && f.zone === 'prod')) {
    for (const invocation of file.rustMacroTypes?.invocations || []) {
      if (invocation.conditional || resolvePath.isConditionalAt?.(file.file, invocation.line)) continue;
      const pieces = invocation.path.split('::'), name = pieces.at(-1);
      const uses = (file.rustImports?.uses || []).filter(u => u.local === name && invocation.line >= u.scopeStart && invocation.line <= u.scopeEnd);
      const definitions = files.filter(f => packageOwner(f.file) === packageOwner(file.file) && f.zone === 'prod')
        .flatMap(f => (f.rustMacroTypes?.definitions || []).filter(d => d.name === name &&
          ((f.file === file.file && d.line < invocation.line && invocation.offset > d.scopeStart && invocation.offset < d.scopeEnd) ||
           (d.exported && (pieces[0] === 'crate' || uses.some(u => u.path.join('::') === `crate::${name}`)))))
          .map(d => ({ ...d, file: f })));
      if (definitions.length !== 1 || !definitions[0].supported || definitions[0].conditional ||
          resolvePath.isConditionalAt?.(definitions[0].file.file, definitions[0].line) || definitions[0].file.symbols.some(s => s.isConditionalCompilation) ||
          /cfg/.test(definitions[0].file.rustImports?.innerAttributes || '')) continue;
      const arms = definitions[0].arms.filter(a => a.parameters?.length === invocation.args.length);
      if (arms.length !== 1) continue;
      const arm = arms[0], bindings = new Map(arm.parameters.map((p, i) => [p.name, invocation.args[i]]));
      if (arm.parameters.some(p => p.kind === 'ident' && !/^[A-Za-z_]\w*$/.test(bindings.get(p.name)))) continue;
      const context = { file: file.file, startLine: invocation.line, endLine: invocation.line, name: '<macro invocation>', id: `${file.file}:macro:${invocation.line}` };
      if (!context) continue;
      for (const method of arm.methods) {
        const ownerPath = bindings.get(method.owner), returnedText = method.returned.replace(/\$([A-Za-z_]\w*)/g, (_, n) => bindings.get(n) || '?');
        if (!ownerPath || !rustType(returnedText)) continue;
        const owners = resolvePath(context, { rustPath: ownerPath, rawCallee: ownerPath.split('::').at(-1), line: invocation.line });
        if (owners.length !== 1 || owners[0].isConditionalCompilation || file.symbols.some(s => s.startLine <= invocation.line && s.endLine >= invocation.line && s.isConditionalCompilation)) continue;
        const key = `${owners[0].id}:${method.name}`;
        const entry = { context, type: rustType(returnedText), line: invocation.line, macroFile: definitions[0].file.file };
        returns.set(key, returns.has(key) ? null : entry);
      }
    }
  }
  return (owner, method) => returns.get(`${owner.id}:${method}`) || null;
}
