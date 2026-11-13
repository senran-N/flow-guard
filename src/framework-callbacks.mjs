import { rustAttributeBodies } from './rust-imports.mjs';

// These facts describe host exposure, never an executed call or runtime root.
export function parseFrameworkCallbackFacts(clean, quoted, symbols, imports, lang, file) {
  const facts = [];
  if (lang === 'rust') {
    for (const match of clean.matchAll(/#\s*\[/g)) {
      let end = match.index + match[0].length, depth = 1;
      for (; end < clean.length && depth; end++) {
        if (clean[end] === '[') depth++;
        if (clean[end] === ']') depth--;
      }
      if (depth) continue;
      const attribute = rustAttributeBodies(quoted.slice(match.index, end))[0];
      if (!/^serde\s*\(/.test(attribute || '')) continue;
      const line = clean.slice(0, match.index).split('\n').length;
      for (const ref of attribute.matchAll(/\b(serialize_with|deserialize_with|skip_serializing_if|default)\s*=\s*"([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)"/g)) {
        facts.push({ path: ref[2], line, reason: `Serde 属性 ${ref[1]} 的函数引用（宏执行未验证）` });
      }
    }
  }
  if (lang === 'ts') {
    const widgets = imports.filter(b => b.source === '@codemirror/view' && b.imported === 'WidgetType' && !b.typeOnly);
    for (const container of symbols.filter(s => s.kind === 'class' && widgets.some(b => s.baseTypes.includes(b.local)))) {
      const name = container.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`\\bwidget\\s*:\\s*new\\s+${name}\\s*\\(`).test(clean)) continue;
      for (const method of symbols.filter(s => s.parentContainerId === container.id && ['eq', 'toDOM', 'updateDOM', 'destroy', 'ignoreEvent', 'coordsAt'].includes(s.name))) {
        facts.push({ symbolId: method.id, line: method.startLine, reason: 'CodeMirror WidgetType 实例作为 widget 传入的宿主回调候选（执行未验证）' });
      }
    }
  }
  if (lang === 'ruby' && /(?:^|\/)(?:brew|Formula)\//.test(file)) {
    for (const match of clean.matchAll(/\bclass\s+([A-Za-z_]\w*)\s*<\s*Formula\b/g)) {
      for (const method of symbols.filter(s => s.parentContainerName === match[1] && s.name === 'install')) {
        facts.push({ symbolId: method.id, line: method.startLine, reason: 'Homebrew Formula install 宿主安装回调（安装未执行）' });
      }
    }
  }
  return facts;
}
