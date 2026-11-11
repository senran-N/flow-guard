/**
 * Character-stream lexer & block-scope tree builder.
 * Handles:
 * - Line comments (`//`, `#`) and block comments (`/* ... * /`)
 * - Double/single strings, Python triple-quoted docstrings (`"""`, `'''`), Rust raw strings (`r#*"..."#*`), C# verbatim strings (`@"..."`)
 * - Regex literals in JS/TS (including `/` inside `[...]` character classes)
 * - Template literals (`...`) and string interpolations (`${...}`, `{ident}`) preserved as live code tokens
 * - Balanced `( ... )` parameter spans and `{ ... }` block scope trees
 */
/**
 * Universal string interpolation preserver across all string literal flavors:
 * - `{ident}` / `{ident()}` (Python f-strings, Rust format!/raw strings, C# $"..."/$@"...")
 * - `$ident` / `${ident}` (Kotlin "$foo", JS/TS/Bash/PHP)
 */
function preserveSwiftParenInterpolation(content, i, len, cleanChars) {
  let depth = 1;
  let k = i + 2;
  const limit = Math.min(len, i + 160);
  while (k < limit && content[k] !== "\n" && content[k] !== "\r") {
    if (content[k] === "(") depth++;
    else if (content[k] === ")") {
      depth--;
      if (depth === 0) {
        cleanChars[i + 1] = " ";
        for (let p = i + 2; p < k; p++) {
          cleanChars[p] = /[A-Za-z0-9_$().+\-*/%?:,\s]/.test(content[p]) ? content[p] : " ";
        }
        cleanChars[k] = " ";
        return k - i;
      }
    }
    k++;
  }
  return 0;
}

function scanBalancedBraceExpr(content, openBraceIdx, len, maxSpan, cleanChars) {
  let depth = 1;
  let k = openBraceIdx + 1;
  let inQuote = null;
  const limit = Math.min(len, openBraceIdx + maxSpan);
  while (k < limit && content[k] !== "\n" && content[k] !== "\r") {
    const c = content[k];
    if (inQuote) {
      if (c === "\\" && k + 1 < limit) {
        k += 2;
        continue;
      }
      if (c === inQuote) inQuote = null;
    } else if (c === '"' || c === "'") {
      inQuote = c;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        let q = null;
        for (let p = openBraceIdx + 1; p < k; p++) {
          const pc = content[p];
          if (q) {
            cleanChars[p] = " ";
            if (pc === "\\" && p + 1 < k) {
              cleanChars[p + 1] = " ";
              p++;
              continue;
            }
            if (pc === q) q = null;
          } else if (pc === '"' || pc === "'") {
            q = pc;
            cleanChars[p] = " ";
          } else {
            cleanChars[p] = /[A-Za-z0-9_$@().+\-*/%?:,\s]/.test(pc) ? pc : " ";
          }
        }
        cleanChars[k] = " ";
        return k - openBraceIdx;
      }
    }
    k++;
  }
  return 0;
}

function tryPreserveInterpolation(content, i, len, cleanChars, isBraceInterpolated = false) {
  const ch = content[i];
  const next = i + 1 < len ? content[i + 1] : "";
  if (ch === "{" && next === "{") {
    cleanChars[i + 1] = " ";
    return 1;
  }
  if (ch === "{" && next !== "{") {
    const sub = content.slice(i + 1, Math.min(len, i + 64));
    const interpM = sub.match(
      /^(\$?[a-zA-Z_][a-zA-Z0-9_.]*(?:->[a-zA-Z_][a-zA-Z0-9_]*)*(?:\(\))?)(?:[[!:?,\s][^}\n]*)?\}/
    );
    if (interpM) {
      const ident = interpM[1];
      for (let k = 0; k < ident.length; k++) cleanChars[i + 1 + k] = ident[k];
      return ident.length;
    }
    if (isBraceInterpolated) {
      const adv = scanBalancedBraceExpr(content, i, len, 240, cleanChars);
      if (adv > 0) return adv;
    }
  } else if ((ch === "#" || ch === "$") && next === "{") {
    cleanChars[i + 1] = " ";
    const adv = scanBalancedBraceExpr(content, i + 1, len, 200, cleanChars);
    if (adv > 0) return adv + 1;
  } else if (ch === "$" && /[a-zA-Z_]/.test(next)) {
    const sub = content.slice(i + 1, Math.min(len, i + 64));
    const interpM = sub.match(/^([a-zA-Z_][a-zA-Z0-9_]*(?:->[a-zA-Z_][a-zA-Z0-9_]*)?)/);
    if (interpM) {
      cleanChars[i] = "$";
      const ident = interpM[1];
      for (let k = 0; k < ident.length; k++) cleanChars[i + 1 + k] = ident[k];
      return ident.length;
    }
  }
  return 0;
}

export function scanTokensAndScopes(content, lang) {
  const len = content.length;
  let state = "CODE"; // CODE | LINE_COMMENT | BLOCK_COMMENT | DOUBLE_STR | SINGLE_STR | TRIPLE_DOUBLE_STR | TRIPLE_SINGLE_STR | BACKTICK_STR | REGEX_STR | RUST_RAW_STR
  let regexInCharClass = false;
  let rustRawHashes = 0;
  let isCsharpVerbatim = false;
  let isBraceInterpolated = false;
  let line = 1;
  let lastNonSpaceChar = ";";

  const hasPyFStringPrefix = (pos) => {
    if (lang !== "python" || pos <= 0) return false;
    let p = pos - 1;
    let sawF = false;
    let count = 0;
    while (p >= 0 && count < 2 && /[rRfFbBuU]/.test(content[p])) {
      if (content[p] === "f" || content[p] === "F") sawF = true;
      p--;
      count++;
    }
    return sawF && (p < 0 || !/[A-Za-z0-9_]/.test(content[p]));
  };
  const hasCsharpInterpPrefix = (pos) =>
    lang === "csharp" &&
    pos > 0 &&
    (content[pos - 1] === "$" ||
      (pos > 1 &&
        ((content[pos - 2] === "$" && content[pos - 1] === "@") ||
          (content[pos - 2] === "@" && content[pos - 1] === "$"))));

  const cleanChars = new Array(len);
  const commentlessChars = new Array(len);
  for (let idx = 0; idx < len; idx++) commentlessChars[idx] = content[idx];
  const lineStartOffsets = [0];
  const parenSpans = [];
  const braceSpans = [];
  const parenStack = [];
  const braceStack = [];
  const templateBraceDepthStack = [];

  for (let i = 0; i < len; i++) {
    const ch = content[i];
    const next = i + 1 < len ? content[i + 1] : "";
    const next2 = i + 2 < len ? content[i + 2] : "";

    if (ch === "\n") {
      line++;
      lineStartOffsets.push(i + 1);
      cleanChars[i] = "\n";
      if (
        state === "LINE_COMMENT" ||
        state === "REGEX_STR" ||
        state === "SINGLE_STR" ||
        (state === "DOUBLE_STR" && !isCsharpVerbatim && lang !== "rust")
      ) {
        state = "CODE";
        regexInCharClass = false;
        isBraceInterpolated = false;
      }
      continue;
    }
    if (ch === "\r") {
      cleanChars[i] = "\r";
      continue;
    }

    if (state === "LINE_COMMENT") {
      cleanChars[i] = " ";
      commentlessChars[i] = " ";
      continue;
    }

    if (state === "BLOCK_COMMENT") {
      cleanChars[i] = " ";
      commentlessChars[i] = " ";
      if (ch === "*" && next === "/") {
        cleanChars[i + 1] = " ";
        commentlessChars[i + 1] = " ";
        i++;
        state = "CODE";
      }
      continue;
    }

    if (state === "TRIPLE_DOUBLE_STR") {
      cleanChars[i] = " ";
      if (lang === "swift" && ch === "\\" && next === "(") {
        const adv = preserveSwiftParenInterpolation(content, i, len, cleanChars);
        if (adv > 0) {
          i += adv;
          continue;
        }
      }
      if (ch === "\\" && i + 1 < len) {
        cleanChars[i + 1] = content[i + 1] === "\n" ? "\n" : " ";
        if (content[i + 1] === "\n") {
          line++;
          lineStartOffsets.push(i + 2);
        }
        i++;
      } else if (ch === '"' && next === '"' && next2 === '"') {
        cleanChars[i] = '"';
        cleanChars[i + 1] = " ";
        cleanChars[i + 2] = " ";
        i += 2;
        state = "CODE";
        isBraceInterpolated = false;
        lastNonSpaceChar = '"';
      } else {
        i += tryPreserveInterpolation(content, i, len, cleanChars, isBraceInterpolated);
      }
      continue;
    }

    if (state === "TRIPLE_SINGLE_STR") {
      cleanChars[i] = " ";
      if (ch === "\\" && i + 1 < len) {
        cleanChars[i + 1] = content[i + 1] === "\n" ? "\n" : " ";
        if (content[i + 1] === "\n") {
          line++;
          lineStartOffsets.push(i + 2);
        }
        i++;
      } else if (ch === "'" && next === "'" && next2 === "'") {
        cleanChars[i] = "'";
        cleanChars[i + 1] = " ";
        cleanChars[i + 2] = " ";
        i += 2;
        state = "CODE";
        isBraceInterpolated = false;
        lastNonSpaceChar = "'";
      } else {
        i += tryPreserveInterpolation(content, i, len, cleanChars, isBraceInterpolated);
      }
      continue;
    }

    if (state === "RUST_RAW_STR") {
      cleanChars[i] = " ";
      const adv = tryPreserveInterpolation(content, i, len, cleanChars);
      if (adv > 0) {
        i += adv;
        continue;
      }
      if (ch === '"') {
        let matched = true;
        for (let h = 1; h <= rustRawHashes; h++) {
          if (content[i + h] !== "#") {
            matched = false;
            break;
          }
        }
        if (matched) {
          cleanChars[i] = '"';
          for (let h = 1; h <= rustRawHashes; h++) cleanChars[i + h] = " ";
          i += rustRawHashes;
          state = "CODE";
          lastNonSpaceChar = '"';
        }
      }
      continue;
    }

    if (state === "DOUBLE_STR") {
      cleanChars[i] = " ";
      if (lang === "swift" && ch === "\\" && next === "(") {
        const adv = preserveSwiftParenInterpolation(content, i, len, cleanChars);
        if (adv > 0) {
          i += adv;
          continue;
        }
      }
      if (!isCsharpVerbatim && ch === "\\" && i + 1 < len) {
        cleanChars[i + 1] = content[i + 1] === "\n" ? "\n" : " ";
        if (content[i + 1] === "\n") {
          line++;
          lineStartOffsets.push(i + 2);
        }
        i++;
        continue;
      }
      if (isCsharpVerbatim && ch === '"' && next === '"') {
        cleanChars[i + 1] = " ";
        i++;
        continue;
      }
      const adv = tryPreserveInterpolation(content, i, len, cleanChars, isBraceInterpolated);
      if (adv > 0) {
        i += adv;
        continue;
      }
      if (ch === '"') {
        cleanChars[i] = '"';
        state = "CODE";
        isCsharpVerbatim = false;
        isBraceInterpolated = false;
        lastNonSpaceChar = '"';
      }
      continue;
    }

    if (state === "SINGLE_STR") {
      cleanChars[i] = " ";
      if (ch === "\\" && i + 1 < len) {
        cleanChars[i + 1] = content[i + 1] === "\n" ? "\n" : " ";
        if (content[i + 1] === "\n") {
          line++;
          lineStartOffsets.push(i + 2);
        }
        i++;
      } else if (ch === "'") {
        cleanChars[i] = "'";
        state = "CODE";
        isBraceInterpolated = false;
        lastNonSpaceChar = "'";
      } else {
        i += tryPreserveInterpolation(content, i, len, cleanChars, isBraceInterpolated);
      }
      continue;
    }

    if (state === "REGEX_STR") {
      cleanChars[i] = " ";
      if (ch === "\\" && i + 1 < len) {
        cleanChars[i + 1] = " ";
        i++;
      } else if (ch === "[") {
        regexInCharClass = true;
      } else if (ch === "]") {
        regexInCharClass = false;
      } else if (ch === "/" && !regexInCharClass) {
        cleanChars[i] = "/";
        state = "CODE";
        lastNonSpaceChar = "/";
      }
      continue;
    }

    if (state === "BACKTICK_STR") {
      if ((lang === "ts" || lang === "vue") && ch === "\\" && i + 1 < len) {
        cleanChars[i] = " ";
        cleanChars[i + 1] = content[i + 1] === "\n" ? "\n" : " ";
        if (content[i + 1] === "\n") {
          line++;
          lineStartOffsets.push(i + 2);
        }
        i++;
        continue;
      }
      if ((lang === "ts" || lang === "vue") && ch === "$" && next === "{") {
        cleanChars[i] = " ";
        cleanChars[i + 1] = "(";
        templateBraceDepthStack.push(braceStack.length);
        i++;
        state = "CODE";
        lastNonSpaceChar = "(";
        continue;
      }
      if (ch === "`") {
        cleanChars[i] = "`";
        state = "CODE";
        lastNonSpaceChar = "`";
        continue;
      }
      cleanChars[i] = " ";
      continue;
    }

    // In CODE state:
    if (ch === "/" && next === "/") {
      cleanChars[i] = " ";
      cleanChars[i + 1] = " ";
      commentlessChars[i] = " ";
      commentlessChars[i + 1] = " ";
      i++;
      state = "LINE_COMMENT";
      continue;
    }
    if ((lang === "python" || lang === "ruby" || (lang === "php" && next !== "[")) && ch === "#") {
      cleanChars[i] = " ";
      commentlessChars[i] = " ";
      state = "LINE_COMMENT";
      continue;
    }
    if (ch === "/" && next === "*") {
      cleanChars[i] = " ";
      cleanChars[i + 1] = " ";
      commentlessChars[i] = " ";
      commentlessChars[i + 1] = " ";
      i++;
      state = "BLOCK_COMMENT";
      continue;
    }

    // Python / Swift / Dart triple-quoted strings
    if ((lang === "python" || lang === "swift" || lang === "dart") && ch === '"' && next === '"' && next2 === '"') {
      isBraceInterpolated = hasPyFStringPrefix(i);
      cleanChars[i] = '"';
      cleanChars[i + 1] = " ";
      cleanChars[i + 2] = " ";
      i += 2;
      state = "TRIPLE_DOUBLE_STR";
      continue;
    }
    if ((lang === "python" || lang === "dart") && ch === "'" && next === "'" && next2 === "'") {
      isBraceInterpolated = hasPyFStringPrefix(i);
      cleanChars[i] = "'";
      cleanChars[i + 1] = " ";
      cleanChars[i + 2] = " ";
      i += 2;
      state = "TRIPLE_SINGLE_STR";
      continue;
    }

    // Rust raw string literal `r#*"..."#*`
    if (lang === "rust" && ch === "r" && (next === '"' || next === "#")) {
      const prevCh = i > 0 ? content[i - 1] : " ";
      if (!/[a-zA-Z0-9_]/.test(prevCh) || (prevCh === "b" && (i < 2 || !/[a-zA-Z0-9_]/.test(content[i - 2])))) {
        let hashes = 0;
        let k = i + 1;
        while (k < len && content[k] === "#") {
          hashes++;
          k++;
        }
        if (k < len && content[k] === '"') {
          for (let c = i; c < k; c++) cleanChars[c] = " ";
          cleanChars[k] = '"';
          rustRawHashes = hashes;
          i = k;
          state = "RUST_RAW_STR";
          continue;
        }
      }
    }

    if (ch === '"') {
      isCsharpVerbatim = lang === "csharp" && i > 0 && (content[i - 1] === "@" || (i > 1 && content[i - 2] === "@" && content[i - 1] === "$"));
      isBraceInterpolated = hasCsharpInterpPrefix(i) || hasPyFStringPrefix(i);
      cleanChars[i] = '"';
      state = "DOUBLE_STR";
      continue;
    }
    if (ch === "'") {
      if (lang === "rust" && next !== "\\" && content[i + 2] !== "'") {
        cleanChars[i] = ch;
        lastNonSpaceChar = ch;
        continue;
      }
      isBraceInterpolated = hasPyFStringPrefix(i);
      cleanChars[i] = "'";
      state = "SINGLE_STR";
      continue;
    }
    if (ch === "`") {
      cleanChars[i] = "`";
      state = "BACKTICK_STR";
      continue;
    }
    if ((lang === "ts" || lang === "vue") && ch === "/" && next !== ">") {
      const prevNonSpaceIsArrow = lastNonSpaceChar === ">" && i >= 2 && content.slice(Math.max(0, i - 6), i).trimEnd().endsWith("=>");
      if (/^[=(,:!&|?{};~+\-*%^]$/.test(lastNonSpaceChar) || prevNonSpaceIsArrow) {
        cleanChars[i] = "/";
        state = "REGEX_STR";
        regexInCharClass = false;
        continue;
      }
    }

    if (
      templateBraceDepthStack.length > 0 &&
      ch === "}" &&
      braceStack.length === templateBraceDepthStack[templateBraceDepthStack.length - 1]
    ) {
      templateBraceDepthStack.pop();
      cleanChars[i] = ")";
      state = "BACKTICK_STR";
      continue;
    }

    cleanChars[i] = ch;
    if (!/\s/.test(ch)) lastNonSpaceChar = ch;

    if (ch === "(") {
      parenStack.push({ openOffset: i, openLine: line });
    } else if (ch === ")" && parenStack.length > 0) {
      const top = parenStack.pop();
      parenSpans.push({
        openOffset: top.openOffset,
        closeOffset: i,
        openLine: top.openLine,
        closeLine: line
      });
    } else if (ch === "{") {
      const parentIdx = braceStack.length > 0 ? braceStack[braceStack.length - 1] : -1;
      const idx = braceSpans.length;
      braceSpans.push({
        openOffset: i,
        closeOffset: -1,
        openLine: line,
        closeLine: line,
        parentIdx
      });
      braceStack.push(idx);
    } else if (ch === "}" && braceStack.length > 0) {
      const idx = braceStack.pop();
      braceSpans[idx].closeOffset = i;
      braceSpans[idx].closeLine = line;
    }
  }

  parenSpans.sort((a, b) => a.openOffset - b.openOffset);
  return {
    cleanCode: cleanChars.join(""),
    commentlessCode: commentlessChars.join(""),
    lineStartOffsets,
    parenSpans,
    braceSpans
  };
}

/**
 * Skip balanced `< ... >` generic parameter lists starting at `startOffset` if the first non-space char is `<`.
 */
function skipBalancedGenericSpan(cleanCode, startOffset, maxOffset) {
  let p = startOffset;
  while (p < maxOffset && /\s/.test(cleanCode[p])) p++;
  if (cleanCode[p] !== "<") return startOffset;

  let depth = 0;
  let parenDepth = 0;
  for (let i = p; i < maxOffset; i++) {
    const ch = cleanCode[i];
    const prev = i > 0 ? cleanCode[i - 1] : "";
    if (ch === "(") parenDepth++;
    else if (ch === ")" && parenDepth > 0) parenDepth--;
    else if (parenDepth === 0) {
      if (ch === "<") depth++;
      else if (ch === ">" && prev !== "-" && prev !== "=") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
  }
  return startOffset;
}

export function resolveSymbolBounds(
  cleanCode,
  cleanLines,
  lineStartOffsets,
  declLineIdx,
  decl,
  lang,
  parenSpans,
  braceSpans
) {
  const declLine1 = declLineIdx + 1;
  const maxHeaderLine = Math.min(cleanLines.length, declLine1 + 14);
  const lineStart = lineStartOffsets[declLineIdx] || 0;
  const maxHeaderOffset =
    maxHeaderLine < lineStartOffsets.length ? lineStartOffsets[maxHeaderLine] : cleanCode.length;

  // Locate declared symbol name offset on the declaration line (after Go receiver or Rust `pub(crate)`)
  const lineText = cleanLines[declLineIdx] || "";
  let nameSearchStart = 0;
  if (lang === "go" && decl.receiverType) {
    const closeRecv = lineText.indexOf(")");
    if (closeRecv >= 0) nameSearchStart = closeRecv + 1;
  } else if (lang === "rust") {
    const fnPos = lineText.search(/\bfn\b/);
    if (fnPos >= 0) nameSearchStart = fnPos + 2;
  }
  const nameEsc = decl.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameLeftBound = decl.name.startsWith("#") || decl.name.startsWith("$") ? "(?<![A-Za-z0-9_$#])" : "\\b";
  const nameRightBound = decl.name.endsWith("$") ? "(?![A-Za-z0-9_$])" : "\\b";
  const nameRelMatch = lineText.slice(nameSearchStart).match(new RegExp(`${nameLeftBound}${nameEsc}${nameRightBound}`));
  const nameEndOffset = nameRelMatch
    ? lineStart + nameSearchStart + nameRelMatch.index + decl.name.length
    : lineStart;

  // Skip any generic `<...>` right after symbol name (e.g. `fn map<U, F: FnOnce(T) -> U>(...)` or `class Hono<E = Env, S = {}>`)
  const afterGenericOffset = skipBalancedGenericSpan(cleanCode, nameEndOffset, maxHeaderOffset);

  let paramSpan = null;
  if (decl.kind === "function" || decl.kind === "method") {
    for (const ps of parenSpans) {
      if (ps.openOffset >= afterGenericOffset && ps.openLine >= declLine1 && ps.openLine <= maxHeaderLine) {
        const between = cleanCode.slice(afterGenericOffset, ps.openOffset);
        if ((lang === "ruby" || lang === "python") && (ps.openLine !== declLine1 || between.includes("\n"))) {
          break;
        }
        if (
          !between.includes("{") &&
          !between.includes("}") &&
          !between.includes(";") &&
          !/\b(?:end|def|fn|func|fun|class|struct|protocol|interface)\b/.test(between)
        ) {
          paramSpan = ps;
        }
        break;
      }
    }
  }

  const searchFromOffset = paramSpan ? paramSpan.closeOffset + 1 : afterGenericOffset;
  const searchFromLine = paramSpan ? paramSpan.closeLine : declLine1;

  // Abstract methods or TypeScript overload signatures without body
  if ((decl.kind === "function" || decl.kind === "method") && /\babstract\b/.test(lineText)) {
    return { paramSpan, endLine: searchFromLine, hasBraceBody: false, isExpressionBody: false };
  }

  // Check for expression-bodied arrow functions / C# `=> expr` / Dart `=> expr` / Kotlin `= expr` methods without `{ ... }` body
  if (
    (decl.kind === "function" || decl.kind === "method") &&
    (lang === "ts" || lang === "vue" || lang === "csharp" || lang === "kotlin" || lang === "java" || lang === "dart")
  ) {
    const tailSlice = cleanCode.slice(searchFromOffset, Math.min(cleanCode.length, searchFromOffset + 240));
    const arrowMatch =
      tailSlice.match(/=>\s*(\S)/) ||
      (lang === "kotlin" ? tailSlice.match(/(?<![=!<>])=(?![=>])\s*(\S)/) : null);
    if (arrowMatch) {
      const beforeArrow = tailSlice.slice(0, arrowMatch.index);
      if (!beforeArrow.includes("{") && !beforeArrow.includes(";")) {
        const firstTokAfterArrow = arrowMatch[1];
        if (firstTokAfterArrow !== "{") {
          const exprStartOffset = searchFromOffset + arrowMatch.index + arrowMatch[0].length - 1;
          // If wrapped in `(...)`, span to matching `)` unless it is a curried parameter list `(...) => ...` or chained call
          for (const ps of parenSpans) {
            if (ps.openOffset === exprStartOffset) {
              const afterParen = cleanCode.slice(ps.closeOffset + 1, Math.min(cleanCode.length, ps.closeOffset + 120));
              const curriedBraceM = afterParen.match(/^\s*(?::[^={;]+)?=>\s*\{/);
              if (curriedBraceM) {
                const braceOpenOff = ps.closeOffset + 1 + curriedBraceM[0].lastIndexOf("{");
                const bs = braceSpans.find((b) => b.openOffset === braceOpenOff && b.closeOffset > b.openOffset);
                if (bs) {
                  return {
                    paramSpan,
                    endLine: bs.closeLine,
                    hasBraceBody: true,
                    isExpressionBody: false,
                    braceSpan: bs
                  };
                }
              }
              if (!/^\s*(?:(?::[^={;]+)?=>|\.|\[|\+|\-|\*|\?|&&|\|\|)/.test(afterParen)) {
                return {
                  paramSpan,
                  endLine: ps.closeLine,
                  hasBraceBody: false,
                  isExpressionBody: true,
                  exprStartOffset
                };
              }
              break;
            }
          }
          // Otherwise expression-bodied arrow/method ending at statement semicolon (respecting balanced parens, brackets, and braces)
          const arrowNewlines = (arrowMatch[0].match(/\n/g) || []).length;
          let exprEndLine = searchFromLine + arrowNewlines;
          let pDepth = 0;
          let bDepth = 0;
          let cDepth = 0;
          let inBacktick = false;
          for (let k = exprStartOffset; k < Math.min(cleanCode.length, exprStartOffset + 1600); k++) {
            const c = cleanCode[k];
            if (c === "`") inBacktick = !inBacktick;
            else if (c === "(") pDepth++;
            else if (c === ")" && pDepth > 0) pDepth--;
            else if (c === "[") bDepth++;
            else if (c === "]" && bDepth > 0) bDepth--;
            else if (c === "{") cDepth++;
            else if (c === "}" && cDepth > 0) cDepth--;
            else if (c === "\n") {
              if (!inBacktick && pDepth === 0 && bDepth === 0 && cDepth === 0 && (lang === "ts" || lang === "vue" || lang === "kotlin")) {
                const currLineText = (cleanLines[exprEndLine - 1] || "").trim();
                const nextLineText = (cleanLines[exprEndLine] || "").trim();
                const continuesAtEnd = /[+\-*?:,&|=(.[{]$|=>$/.test(currLineText);
                const continuesAtStart = /^[.?+&:|-]|^=>/.test(nextLineText);
                if (currLineText && !continuesAtEnd && !continuesAtStart) break;
              }
              exprEndLine++;
            } else if (c === ";" && !inBacktick && pDepth === 0 && bDepth === 0 && cDepth === 0) {
              break;
            }
          }
          return {
            paramSpan,
            endLine: Math.min(cleanLines.length, exprEndLine),
            hasBraceBody: false,
            isExpressionBody: true,
            exprStartOffset
          };
        }
      }
    }
  }

  const hasTsReturnTypeColon =
    (lang === "ts" || lang === "vue") &&
    (decl.kind === "function" || decl.kind === "method") &&
    /^\s*:/.test(cleanCode.slice(searchFromOffset, Math.min(cleanCode.length, searchFromOffset + 40)));
  const startsCppCtorInit =
    lang === "cpp" &&
    (decl.kind === "function" || decl.kind === "method") &&
    /^\s*:/.test(cleanCode.slice(searchFromOffset, Math.min(cleanCode.length, searchFromOffset + 40)));
  let cursorOffset = searchFromOffset;
  let inCppCtorInit = false;

  for (const bs of braceSpans) {
    if (bs.openLine >= searchFromLine && bs.openOffset >= cursorOffset && bs.closeOffset > bs.openOffset) {
      const betweenCode = cleanCode.slice(cursorOffset, bs.openOffset);
      if (betweenCode.includes(";") || (!hasTsReturnTypeColon && betweenCode.includes("}"))) {
        return { paramSpan, endLine: searchFromLine, hasBraceBody: false, isExpressionBody: false };
      }
      // Skip `{...}` nested inside parenthesized expressions in C++ ctor initializers (`: pimpl(new impl{}) {`) or return types
      if (lang === "cpp" || hasTsReturnTypeColon) {
        const enclosingPs = parenSpans.find(
          (ps) => ps.openOffset >= searchFromOffset && ps.openOffset < bs.openOffset && ps.closeOffset > bs.closeOffset
        );
        if (enclosingPs) {
          if (startsCppCtorInit) inCppCtorInit = true;
          cursorOffset = enclosingPs.closeOffset + 1;
          continue;
        }
      }
      // C++ constructor member brace-initializers (`: types_{...}, named_args_{}, parse_funcs_{...} {`)
      if (
        lang === "cpp" &&
        (inCppCtorInit ? /^\s*,/.test(betweenCode) : /^\s*:/.test(betweenCode)) &&
        /[A-Za-z0-9_>]\s*$/.test(betweenCode)
      ) {
        const afterInitClose = cleanCode.slice(bs.closeOffset + 1, Math.min(cleanCode.length, bs.closeOffset + 80));
        if (/^\s*[,{]/.test(afterInitClose)) {
          inCppCtorInit = true;
          cursorOffset = bs.closeOffset + 1;
          continue;
        }
      }
      // TypeScript return type object literal (`: Promise<{ a: number; b: string }> {`, `: { a: number; b: string } | null {`)
      if (hasTsReturnTypeColon) {
        const afterClose = cleanCode.slice(bs.closeOffset + 1, Math.min(cleanCode.length, bs.closeOffset + 160));
        if (/^\s*(?:;|[,>|&\[]\s*[^;{]*;)/.test(afterClose)) {
          return { paramSpan, endLine: bs.closeLine, hasBraceBody: false, isExpressionBody: false };
        }
        if (/^\s*(?:[,>|&\[?]|is\b|\{|=>)/.test(afterClose)) {
          cursorOffset = bs.closeOffset + 1;
          continue;
        }
      }
      // Ensure bodyless declarations (Swift protocol / Kotlin interface / TS semi-less) never steal a subsequent declaration's `{`
      if (
        bs.openLine > searchFromLine &&
        /^\s*(?:public|private|internal|open|fileprivate|protected|override|static|mutating|async|inline|suspend|export|const|let|var|function|fun|func|fn|def|class|struct|enum|protocol|extension|interface|impl|trait)\b/m.test(
          betweenCode
        )
      ) {
        return { paramSpan, endLine: searchFromLine, hasBraceBody: false, isExpressionBody: false };
      }
      return {
        paramSpan,
        endLine: bs.closeLine,
        hasBraceBody: true,
        isExpressionBody: false,
        braceSpan: bs
      };
    }
  }

  for (let ln = searchFromLine - 1; ln < Math.min(cleanLines.length, searchFromLine + 6); ln++) {
    if (cleanLines[ln].includes(";")) {
      return { paramSpan, endLine: ln + 1, hasBraceBody: false, isExpressionBody: false };
    }
  }

  // Self-healing fallback: if a declaration line clearly opened a `{` block whose closing `}` was lost (e.g. C/C++ `#ifdef` unbalanced braces), mark `isTruncatedOrUncertain: true`
  const headerSlice = cleanLines.slice(declLineIdx, Math.min(cleanLines.length, searchFromLine + 2)).join("\n");
  const isTruncatedOrUncertain = lang !== "python" && lang !== "ruby" && /\{\s*$/.test(headerSlice.trim());

  return { paramSpan, endLine: searchFromLine, hasBraceBody: false, isExpressionBody: false, isTruncatedOrUncertain };
}
