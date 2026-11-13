// Conditions attached to declarations, not arbitrary directives inside their bodies.
export function conditionalContexts(commentlessCode, lang) {
  const lines = commentlessCode.split(/\r?\n/);
  const contexts = lines.map(() => []);
  if (["cpp", "csharp", "swift"].includes(lang)) {
    const stack = [];
    for (let i = 0; i < lines.length; i++) {
      const directive = lines[i].match(/^\s*#\s*(if|ifdef|ifndef|elif|elseif|else|endif)\b(.*)/);
      if (directive) {
        const [, op, tail] = directive;
        if (["if", "ifdef", "ifndef"].includes(op)) {
          stack.push({ group: i + 1, branch: 0, expression: op === "ifndef" ? `!(${tail.trim()})` : tail.trim() });
        } else if (op === "endif") stack.pop();
        else if (stack.length) {
          const prior = stack[stack.length - 1];
          stack[stack.length - 1] = { group: prior.group, branch: prior.branch + 1, expression: op === "else" ? "else" : tail.trim() };
        }
      }
      contexts[i] = stack.map((condition) => ({ ...condition }));
    }
  }
  if (lang === "rust") {
    let pending = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      if (/^\s*#\[/.test(lines[i])) {
        let attribute = lines[i];
        let balance = (attribute.match(/\[/g) || []).length - (attribute.match(/\]/g) || []).length;
        while (balance > 0 && i + 1 < lines.length) {
          attribute += "\n" + lines[++i];
          balance += (lines[i].match(/\[/g) || []).length - (lines[i].match(/\]/g) || []).length;
        }
        const cfg = attribute.match(/^\s*#\[\s*cfg\s*\(([\s\S]*)\)\s*\]/);
        if (cfg) pending.push({ expression: cfg[1].replace(/\s+/g, " ").trim() });
        continue;
      }
      contexts[i] = pending;
      pending = [];
    }
  }
  return contexts;
}

function conjuncts(expression) {
  const value = expression.replace(/\s+/g, "");
  if (/^all\(/.test(value)) {
    const inner = value.slice(4, -1);
    let depth = 0, start = 0;
    const parts = [];
    for (let i = 0; i <= inner.length; i++) {
      if (i === inner.length || (inner[i] === "," && depth === 0)) {
        parts.push(...conjuncts(inner.slice(start, i))); start = i + 1;
      } else if (inner[i] === "(") depth++;
      else if (inner[i] === ")") depth--;
    }
    return parts;
  }
  if (/^any\(/.test(value) || value === "else") return [];
  return value ? [value.replace(/^defined\((\w+)\)$/, "$1")] : [];
}

export function mutuallyExclusiveConditions(left, right) {
  for (const a of left) for (const b of right) {
    if (a.group !== undefined && a.group === b.group && a.branch !== b.branch) return true;
  }
  const aTerms = left.flatMap((c) => conjuncts(c.expression));
  const bTerms = right.flatMap((c) => conjuncts(c.expression));
  for (const a of aTerms) for (const b of bTerms) {
    if ((a === "unix" && b === "windows") || (a === "windows" && b === "unix")) return true;
    if ([`not(${a})`, `!(${a})`, `!${a}`].includes(b) || [`not(${b})`, `!(${b})`, `!${b}`].includes(a)) return true;
    const av = a.match(/^(target_os|target_arch|target_env|target_family)="([^"]+)"$/);
    const bv = b.match(/^(target_os|target_arch|target_env|target_family)="([^"]+)"$/);
    if (av && bv && av[1] === bv[1] && av[2] !== bv[2]) return true;
  }
  return false;
}
