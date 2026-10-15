import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
let commit = process.env.GITHUB_SHA || 'unknown';
if (commit === 'unknown') {
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { /* Source archives may not contain Git metadata. */ }
}
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const desktop = Boolean(process.env.TAURI_ENV_PLATFORM);

export default defineConfig(({ command }) => ({
  define: { __BUILD_INFO__: JSON.stringify({ version, commit, builtAt: new Date().toISOString() }) },
  base: process.env.GITHUB_PAGES === 'true' ? `/${process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'loch.js'}/` : '/',
  plugins: desktop ? [] : [VitePWA({ registerType: 'autoUpdate', includeAssets: ['sample/demo.lox'], manifest: { name: 'loch.js', short_name: 'loch.js', start_url: '.', display: 'standalone', background_color: '#09131c', theme_color: '#162531', icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }] }, workbox: { globPatterns: ['**/*.{js,css,html,svg,lox}'] } })],
  server: { port: 1420, strictPort: true }, clearScreen: false,
}));
