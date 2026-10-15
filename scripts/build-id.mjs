import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const commit = process.env.GITHUB_SHA || git('rev-parse', 'HEAD');
if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('Build commit must be a full Git SHA.');

let version;
try {
  version = git('describe', '--tags', '--match', 'v[0-9]*', '--abbrev=0', commit).replace(/^v/, '');
} catch {
  // A repository without version tags can still build before its first release.
  version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}
if (!/^[0-9][0-9A-Za-z.-]*$/.test(version)) throw new Error(`Invalid build version: ${version}`);
export const buildId = `${version}-${commit.slice(0, 7)}`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(buildId);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `build-id=${buildId}\n`);
}
