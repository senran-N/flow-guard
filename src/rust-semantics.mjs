import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Opt-in compiler semantics for the current checkout. Never reuse this analysis
// for a Git reconstruction: Cargo and macro expansion must see matching files.
export function collectRustSemantics(root, files, options = {}) {
  const timeoutMs = options.rustSemanticTimeoutMs ?? 120000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new TypeError('rustSemanticTimeoutMs must be 1..3600000');
  for (const name of ['rustSemantic', 'rustBuildScripts', 'rustNoDefaultFeatures']) {
    if (options[name] !== undefined && typeof options[name] !== 'boolean') throw new TypeError(`${name} must be boolean`);
  }
  for (const name of ['rustFeatures', 'rustTarget']) {
    if (options[name] !== undefined && typeof options[name] !== 'string') throw new TypeError(`${name} must be string`);
  }
  const features = (options.rustFeatures || '').split(',').map(s => s.trim()).filter(Boolean).sort();
  const settings = { cargo: { allTargets: false, features, noDefaultFeatures: Boolean(options.rustNoDefaultFeatures),
    ...(options.rustTarget ? { target: options.rustTarget } : {}), buildScripts: { enable: Boolean(options.rustBuildScripts) } },
    procMacro: { enable: Boolean(options.rustBuildScripts) }, checkOnSave: false, check: { enable: false } };
  const queries = [], macros = [], hashes = {};
  for (const file of ['Cargo.toml', 'Cargo.lock', '.cargo/config.toml', '.cargo/config', 'rust-toolchain.toml', 'rust-toolchain']) {
    const absolute = path.resolve(root, file);
    hashes[file] = fs.existsSync(absolute) ? crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') : null;
  }
  for (const file of files.filter(f => f.lang === 'rust')) {
    const absolute = path.resolve(root, file.file), content = fs.readFileSync(absolute, 'utf8');
    hashes[file.file] = crypto.createHash('sha256').update(content).digest('hex');
    if (file.contentHash && file.contentHash !== hashes[file.file]) return {
      outcome: 'STALE', reason: 'Source changed after lexical parsing', results: [], settings
    };
    const lines = content.split('\n');
    // Local crate manifests are build inputs too; Cargo path dependencies may
    // change inference without changing a source file in the caller crate.
    let directory = path.dirname(absolute);
    while (directory.startsWith(path.resolve(root))) {
      const manifest = path.join(directory, 'Cargo.toml');
      if (fs.existsSync(manifest)) hashes[path.relative(root, manifest)] = crypto.createHash('sha256').update(fs.readFileSync(manifest)).digest('hex');
      if (directory === path.resolve(root)) break;
      directory = path.dirname(directory);
    }
    for (const invocation of file.rustMacroTypes?.invocations || []) {
      const before = content.slice(0, invocation.offset), line = before.split('\n').length - 1;
      macros.push({ file: file.file, uri: pathToFileURL(absolute).href, name: invocation.path,
        position: { line, character: invocation.offset - (before.lastIndexOf('\n') + 1) } });
    }
    for (const sym of file.symbols.filter(s => ['function', 'method'].includes(s.kind) && s.zone === 'prod')) {
      const escaped = sym.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (let index = sym.startLine - 1; index < Math.min(sym.endLine, sym.startLine + 12); index++) {
        const match = lines[index]?.match(new RegExp(`\\bfn\\s+(?:r#)?(${escaped})\\b`));
        if (!match) continue;
        queries.push({ id: sym.id, uri: pathToFileURL(absolute).href,
          position: { line: index, character: match.index + match[0].lastIndexOf(match[1]) } });
        break;
      }
    }
  }
  const provenance = { sourceHashes: hashes, settings, queries: queries.length,
    macroInvocations: macros.length, macroExpansionsTruncated: macros.length > 512,
    coverage: 'SUPPLEMENTAL_REFERENCES', completeCallGraph: false,
    limitation: 'Compiler-resolved call references are static evidence. Dynamic trait receivers identify a trait declaration, not the concrete runtime implementation. Macro-generated declarations without a unique source symbol remain unmapped.' };
  if (!queries.length) return { ...provenance, outcome: 'NOT_APPLICABLE', results: [] };
  if (queries.length > 2000) return { ...provenance, outcome: 'INCOMPLETE', reason: 'More than 2000 production Rust functions; split the workspace for semantic analysis', results: [] };
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./rust-semantic-process.mjs', import.meta.url))], {
    cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    input: JSON.stringify({ root: path.resolve(root), timeoutMs, settings, queries, macros: macros.slice(0, 512) })
  });
  let report;
  try {
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `Runner exited ${result.status}`);
    report = JSON.parse(result.stdout);
  } catch (error) { report = { outcome: 'EXECUTION_ERROR', reason: error.message, results: [] }; }
  // A concurrent edit invalidates all semantic locations, including Cargo config.
  for (const [file, hash] of Object.entries(hashes)) {
    // Cargo may create its first lockfile. Treat that as a changed build input
    // and ask the caller to rerun against the now-stable checkout.
    const absolute = path.resolve(root, file);
    const current = fs.existsSync(absolute) ? crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') : null;
    if (current !== hash) {
      return { ...provenance, outcome: 'STALE', reason: 'Rust sources changed during semantic analysis', results: [] };
    }
  }
  return { ...provenance, ...report };
}

export function mapRustSemanticCalls(root, files, report) {
  const edges = [], unmapped = [];
  if (report.outcome !== 'COMPLETED' || report.statuses?.at(-1)?.health !== 'ok') return { edges, unmapped };
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const byFile = new Map(files.map(file => [normalize(path.resolve(root, file.file)), file]));
  for (const result of report.results || []) {
    for (const call of result.calls || []) {
      let absolute;
      try { absolute = fileURLToPath(call.to.uri); } catch { unmapped.push({ caller: result.id, target: call.to, reason: 'Virtual or expanded source' }); continue; }
      const file = byFile.get(normalize(absolute));
      if (!file) continue; // Third-party/std references remain in the raw report.
      const line = call.to.selectionRange.start.line + 1;
      const matches = file.symbols.filter(sym => sym.name === call.to.name && sym.startLine <= line && sym.endLine >= line && ['function', 'method'].includes(sym.kind));
      if (matches.length !== 1) {
        unmapped.push({ caller: result.id, target: call.to, implementations: call.implementations,
          reason: 'No unique parsed source declaration (may be macro-generated or a trait signature); implementations are runtime candidates only' });
        for (const implementation of call.implementations || []) {
          let candidateFile;
          try { candidateFile = byFile.get(normalize(fileURLToPath(implementation.targetUri || implementation.uri))); } catch { continue; }
          const at = (implementation.targetSelectionRange || implementation.range)?.start.line + 1;
          const candidates = candidateFile?.symbols.filter(sym => sym.name === call.to.name && sym.startLine <= at && sym.endLine >= at && ['function', 'method'].includes(sym.kind)) || [];
          if (candidates.length === 1) for (const range of call.fromRanges || []) edges.push({ fromId: result.id, toId: candidates[0].id,
            kind: 'BRANCH_DISPATCH', evidence: { file: files.find(f => f.symbols.some(s => s.id === result.id))?.file,
              line: range.start.line + 1, reason: 'rust-analyzer trait implementation candidate; concrete runtime receiver not proven' },
            resolution: { mode: 'RUST_COMPILER_TRAIT_CANDIDATE', confidence: 'MEDIUM' } });
        }
        continue;
      }
      const target = matches[0];
      // Trait declarations, including default bodies, cannot establish which
      // implementation a dyn receiver selects. Concrete impls have a struct.
      const concrete = target.kind === 'function' || file.symbols.some(sym =>
        sym.kind === 'struct' && sym.name === target.parentContainerName);
      for (const range of call.fromRanges || []) edges.push({ fromId: result.id, toId: target.id,
        kind: 'SEQ_CALL', evidence: { file: files.find(f => f.symbols.some(s => s.id === result.id))?.file,
          line: range.start.line + 1, column: range.start.character, reason: 'rust-analyzer call hierarchy (selected Cargo configuration)' },
        resolution: { mode: 'RUST_COMPILER_REFERENCE', confidence: concrete ? 'HIGH' : 'MEDIUM' } });
    }
  }
  return { edges, unmapped };
}
