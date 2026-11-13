// Bounded nominal type flow. Unsupported syntax returns no fact, never a
// same-named fallback. Strings/comments have already been masked by the lexer.
const ident = /^[A-Za-z_]\w*/;
export function splitRustTypes(text) {
  const parts = []; let start = 0, depth = 0;
  for (let i = 0; i <= text.length; i++) {
    if ('<([{'.includes(text[i]) && text[i]) depth++;
    if ('>)]}'.includes(text[i]) && text[i]) depth--;
    if (i === text.length || (text[i] === ',' && depth === 0)) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  return parts.filter(Boolean);
}
export function rustType(text) {
  text = text.trim().replace(/^&\s*(?:'\w+\s*)?(?:mut\s+)?/, '').replace(/\s*::\s*/g, '::');
  const match = text.match(/^([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)(?:\s*<([\s\S]*)>)?$/);
  if (!match) return null;
  const args = match[2] === undefined ? [] : splitRustTypes(match[2]).map(rustType);
  return args.every(Boolean) ? { path: match[1], args } : null;
}
const skip = (code, i) => { while (/\s/.test(code[i] || '') && i < code.length) i++; return i; };
function generic(code, start) {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    if (code[i] === '<') depth++;
    if (code[i] === '>' && --depth === 0) return { text: code.slice(start + 1, i), end: i + 1 };
  }
  return null;
}
function head(code, offset) {
  let i = offset, name = '', args = [], lastHasArgs = false;
  for (;;) {
    const word = code.slice(i).match(ident)?.[0]; if (!word) return null;
    name += word; i = skip(code, i + word.length); lastHasArgs = false;
    if (code.slice(i, i + 3) === '::<') {
      const part = generic(code, i + 2); if (!part) return null;
      args = splitRustTypes(part.text).map(rustType); if (!args.every(Boolean)) return null;
      lastHasArgs = true;
      i = skip(code, part.end);
    }
    if (code.slice(i, i + 2) !== '::') return { path: name, args, lastHasArgs, end: i };
    name += '::'; i = skip(code, i + 2);
  }
}
export function parseRustTypeFlow(code, braces, parens, symbols) {
  const lines = [0]; for (let i = 0; i < code.length; i++) if (code[i] === '\n') lines.push(i + 1);
  const lineAt = offset => { let lo = 0, hi = lines.length; while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (lines[mid] <= offset) lo = mid; else hi = mid; } return lo + 1; };
  const close = new Map(parens.map(p => [p.openOffset, p.closeOffset]));
  const containers = new Map(), expressions = new Map(), returns = new Map();
  for (const symbol of symbols) {
    const start = lines[symbol.startLine - 1] || 0, end = lines[symbol.endLine] ?? code.length;
    const text = code.slice(start, end);
    const nested = symbols.filter(s => s.parentFunctionId === symbol.id);
    if (symbol.kind === 'struct') {
      const declaration = text.match(/\bstruct\s+\w+\s*(?:<([^>{}]*)>)?[^{};]*\{/);
      if (!declaration) continue;
      const params = splitRustTypes(declaration[1] || '').map(p => p.match(ident)?.[0]);
      if (!params.every(Boolean)) continue;
      const bodyStart = start + declaration.index + declaration[0].length;
      const body = braces.find(b => b.openOffset === bodyStart - 1);
      if (!body) continue;
      const fields = new Map();
      for (const field of splitRustTypes(code.slice(bodyStart, body.closeOffset))) {
        const match = field.match(/^(?:pub(?:\([^)]*\))?\s+)?([A-Za-z_]\w*)\s*:\s*([\s\S]+)$/);
        if (match) fields.set(match[1], rustType(match[2]));
      }
      containers.set(symbol.id, { params, fields });
    }
    if (!['function', 'method'].includes(symbol.kind)) continue;
    const fn = text.match(/\bfn\s+\w+(?:\s*<[^{};]*>)?\s*\(/);
    if (fn) {
      const opening = start + fn.index + fn[0].lastIndexOf('('), closing = close.get(opening);
      if (closing !== undefined) {
        const tail = code.slice(closing + 1, end).match(/^\s*->\s*([^{};]+?)(?=\s*\{|\s*;)/);
        returns.set(symbol.id, tail ? rustType(tail[1]) : null);
      }
    }
    const sites = [];
    const candidates = /\b[A-Za-z_]\w*/g; candidates.lastIndex = start;
    let match;
    while ((match = candidates.exec(code)) && match.index < end) {
      const offset = match.index;
      if (/[\w.:$]/.test(code[offset - 1] || '') || nested.some(s => lineAt(offset) >= s.startLine && lineAt(offset) <= s.endLine)) continue;
      const root = head(code, offset); if (!root) continue;
      let cursor = root.end, expression = { kind: 'root', path: root.path, args: root.args, lastHasArgs: root.lastHasArgs };
      if (code[cursor] === '(' && close.has(cursor)) {
        expression = { kind: 'call', receiver: expression, name: null };
        cursor = skip(code, close.get(cursor) + 1);
      }
      let steps = 0;
      while (code[cursor] === '.' && code[cursor + 1] !== '.' && steps++ < 24) {
        const at = skip(code, cursor + 1), member = head(code, at); if (!member || member.path.includes('::')) break;
        if (member.path === 'await') { cursor = member.end; continue; }
        if (code[member.end] === '(' && close.has(member.end)) {
          sites.push({ name: member.path, line: lineAt(at), column: at - lines[lineAt(at) - 1], receiver: expression,
            argumentCount: splitRustTypes(code.slice(member.end + 1, close.get(member.end))).length });
          expression = { kind: 'call', receiver: expression, name: member.path, typeArgs: member.args };
          cursor = skip(code, close.get(member.end) + 1);
        } else { expression = { kind: 'field', receiver: expression, name: member.path }; cursor = member.end; }
      }
    }
    expressions.set(symbol.id, sites);
  }
  return { containers, expressions, returns };
}
