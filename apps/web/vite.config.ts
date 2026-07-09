import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Hosts permitted by Vite's host check, comma-separated via PODIUM_ALLOWED_HOSTS. localhost and
// IP-literal hosts are always allowed by Vite, so plain `localhost` dev needs nothing here; the
// default keeps the maintainer's tailscale node working for the live instance.
const allowedHosts = process.env.PODIUM_ALLOWED_HOSTS?.split(',')
  .map((h) => h.trim())
  .filter(Boolean) ?? []

// The app origin binds :55556 (plain http). `tailscale serve` terminates TLS on :55555 and
// proxies here, so the primary URL is https://<host>:55555 — a secure context, which the
// mobile clipboard/paste API requires — with http://<host>:55556 as a plain fallback. It
// proxies the API + WebSockets to the backend (relay + agent daemon) on localhost, so the
// browser talks to one origin and the web app derives its ws:// + tRPC URLs from
// window.location (see src/trpc.ts serverConfig); the TLS hop is transparent to that, and
// HMR is left at its default (client derives host/port/proto from location, correct for both).
// PODIUM_PORT must match scripts/host.ts (both default to 18787 — an uncommon internal port).
const BACKEND_PORT = process.env.PODIUM_PORT ?? '18787'
// The web origin's port. Override with PODIUM_WEB_PORT when 55556 is taken (strictPort means
// Vite hard-fails rather than silently picking another port).
const WEB_PORT = Number(process.env.PODIUM_WEB_PORT ?? 55556)
const BACKEND = `http://localhost:${BACKEND_PORT}`
const BACKEND_WS = `ws://localhost:${BACKEND_PORT}`
const proxy = {
  '/health': { target: BACKEND, changeOrigin: true },
  '/trpc': { target: BACKEND, changeOrigin: true },
  // Backend HTTP route that streams sandboxed file bytes (e.g. markdown-preview
  // relative images). Same-origin from the browser, so it must reach the backend.
  '/files': { target: BACKEND, changeOrigin: true },
  // Backend setup/config route the SetupGate probes (GET) and SetupView saves (POST).
  // Same-origin fetch from the browser, so it must reach the backend rather than the SPA.
  '/setup': { target: BACKEND, changeOrigin: true },
  // Login endpoints: LoginGate probes /auth/status; login/logout set the session cookie.
  // MUST reach the backend, or a set password locks everyone out (login can't get a cookie).
  '/auth': { target: BACKEND, changeOrigin: true },
  '/client': { target: BACKEND_WS, ws: true, changeOrigin: true },
  '/daemon': { target: BACKEND_WS, ws: true, changeOrigin: true },
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
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
        // SPA fallback for navigations — but never shadow the live API/WS routes
        // or the dedicated Expo mobile SPA served by the backend under /mobile.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [
          /^\/trpc/,
          /^\/health/,
          /^\/mobile/,
          /^\/files/,
          /^\/setup/,
          /^\/auth/,
          /^\/client/,
          /^\/daemon/,
        ],
      },
      // Keep the service worker out of `npm run dev` (it fights HMR); it only
      // ships in the built bundle served by `vite preview`.
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@podium/protocol': fileURLToPath(
        new URL('../../packages/protocol/src/index.ts', import.meta.url),
      ),
      '@podium/terminal-client': fileURLToPath(
        new URL('../../packages/terminal-client/src/index.ts', import.meta.url),
      ),
    },
    conditions: ['@podium/source'],
    // apps/mobile pins react-dom 19.2.3, which bun hoists to the repo root;
    // without dedupe, root-hoisted libs (base-ui, testing-library) resolve that
    // copy while our sources get 19.2.7 and react-dom hard-errors on mismatch.
    dedupe: ['react', 'react-dom'],
  },
  server: { host: '0.0.0.0', port: WEB_PORT, strictPort: true, allowedHosts, proxy },
  preview: { host: '0.0.0.0', port: WEB_PORT, strictPort: true, allowedHosts, proxy },
})
