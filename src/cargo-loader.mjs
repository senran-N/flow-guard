import fs from 'node:fs';
import path from 'node:path';
import { analyzeCargoProject } from './rust-project.mjs';

export function loadCargoProject(workspaceRoot, files) {
  const rustFiles = files.filter((file) => file.lang === 'rust').map((file) => file.file);
  const directories = new Set();
  for (const file of rustFiles) {
    let directory = path.posix.dirname(file);
    while (true) {
      directories.add(directory);
      if (directory === '.') break;
      const parent = path.posix.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const manifests = [];
  for (const directory of directories) {
    const file = path.posix.join(directory, 'Cargo.toml');
    try { manifests.push({ file, content: fs.readFileSync(path.join(workspaceRoot, file), 'utf8') }); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  return analyzeCargoProject(manifests, rustFiles);
}
