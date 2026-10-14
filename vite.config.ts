import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig(({ command }) => ({
  base: process.env.GITHUB_PAGES === 'true' ? `/${process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'loch.js'}/` : '/',
  plugins: [VitePWA({ registerType: 'autoUpdate', includeAssets: ['sample/demo.lox'], manifest: { name: 'loch.js', short_name: 'loch.js', start_url: '.', display: 'standalone', background_color: '#09131c', theme_color: '#162531', icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }] }, workbox: { globPatterns: ['**/*.{js,css,html,svg,lox}'] } })],
  server: { port: 1420, strictPort: true }, clearScreen: false,
}));
