// Consume the parser's existing lexer output, preserving SFC script boundaries.
export function extractJsModuleReferences(cleanCode, commentlessCode) {
  const pattern = /\b(import|export)\s+(?:type\s+)?(?:[^;'"()]*?\bfrom\s*)?(['"])([^'"\r\n]+)\2|\b(import|require)\s*\(\s*(['"])([^'"\r\n]+)\5\s*\)/g;
  const lineStarts = [0], references = [];
  for (let i = 0; i < commentlessCode.length; i++) if (commentlessCode[i] === '\n') lineStarts.push(i + 1);
  let lineIndex = 0;
  for (const match of commentlessCode.matchAll(pattern)) {
    const keyword = match[1] || match[4];
    if (cleanCode.slice(match.index, match.index + keyword.length) !== keyword) continue;
    while (lineIndex + 1 < lineStarts.length && lineStarts[lineIndex + 1] <= match.index) lineIndex++;
    references.push({ line: lineIndex + 1, specifier: match[3] || match[6],
      form: match[4] ? keyword === 'import' ? 'DYNAMIC_LITERAL_IMPORT' : 'REQUIRE_LITERAL'
        : keyword === 'export' ? 'RE_EXPORT' : 'STATIC_IMPORT' });
  }
  return references;
}
