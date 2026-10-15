import { readdirSync, renameSync } from 'node:fs';
import { extname, join } from 'node:path';

const commit = process.env.GITHUB_SHA;
if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) {
  throw new Error('GITHUB_SHA must contain the full build commit SHA.');
}

const root = process.argv[2] || 'src-tauri/target/release/bundle';
const extensions = new Set(['.exe', '.msi', '.deb', '.appimage', '.dmg']);
let installers = 0;

function nameInstallers(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // macOS application bundles contain executables and resources, not installers.
      if (!entry.name.endsWith('.app')) nameInstallers(path);
    } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
      const extension = extname(entry.name);
      const stem = entry.name.slice(0, -extension.length);
      const name = stem.endsWith(`_${commit}`) ? entry.name : `${stem}_${commit}${extension}`;
      if (name !== entry.name) renameSync(path, join(directory, name));
      console.log(join(directory, name));
      installers++;
    }
  }
}

nameInstallers(root);
if (!installers) throw new Error(`No installers found in ${root}.`);
