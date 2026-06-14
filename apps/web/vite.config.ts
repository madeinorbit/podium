import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const allowedHosts = ['podium-host.example.com']

// The app origin binds :55556 (plain http). `tailscale serve` terminates TLS on :55555 and
// proxies here, so the primary URL is https://<host>:55555 — a secure context, which the
// mobile clipboard/paste API requires — with http://<host>:55556 as a plain fallback. It
// proxies the API + WebSockets to the backend (relay + agent daemon) on localhost, so the
// browser talks to one origin and the web app derives its ws:// + tRPC URLs from
// window.location (see src/trpc.ts serverConfig); the TLS hop is transparent to that, and
// HMR is left at its default (client derives host/port/proto from location, correct for both).
// PODIUM_PORT must match scripts/host.ts (both default to 18787 — an uncommon internal port).
const BACKEND_PORT = process.env.PODIUM_PORT ?? '18787'
const BACKEND = `http://localhost:${BACKEND_PORT}`
const BACKEND_WS = `ws://localhost:${BACKEND_PORT}`
const proxy = {
  '/health': { target: BACKEND, changeOrigin: true },
  '/trpc': { target: BACKEND, changeOrigin: true },
  '/client': { target: BACKEND_WS, ws: true, changeOrigin: true },
  '/daemon': { target: BACKEND_WS, ws: true, changeOrigin: true },
}

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'prompt',
      // Generate icons + apple-touch-icon + favicon from one source SVG
      // (see pwa-assets.config.ts); inject head links + manifest icons.
      pwaAssets: { config: true },
      manifest: {
        name: 'Podium',
        short_name: 'Podium',
        description: 'Podium — agent workspace',
        theme_color: '#0e0e12',
        background_color: '#0e0e12',
        display: 'standalone',
        start_url: '/',
      },
      workbox: {
        // Precache the built shell so an installed app cold-starts instantly.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // SPA fallback for navigations — but never shadow the live API/WS
        // routes, which must always reach the backend through the proxy.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/trpc/, /^\/health/, /^\/client/, /^\/daemon/],
      },
      // Keep the service worker out of `npm run dev` (it fights HMR); it only
      // ships in the built bundle served by `vite preview`.
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@podium/protocol': fileURLToPath(
        new URL('../../packages/protocol/src/index.ts', import.meta.url),
      ),
      '@podium/terminal-client': fileURLToPath(
        new URL('../../packages/terminal-client/src/index.ts', import.meta.url),
      ),
    },
    conditions: ['@podium/source'],
  },
  server: { host: '0.0.0.0', port: 55556, strictPort: true, allowedHosts, proxy },
  preview: { host: '0.0.0.0', port: 55556, strictPort: true, allowedHosts, proxy },
})
