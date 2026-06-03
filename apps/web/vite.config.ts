import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const allowedHosts = ['podium-host.example.com']

// The dev server is the single public origin on :55555. It proxies the API + WebSockets to the
// backend (relay server + agent daemon) on localhost, so the browser talks to one port and the
// web app derives its ws:// + tRPC URLs from window.location (see src/trpc.ts serverConfig).
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
  server: { host: '0.0.0.0', port: 55555, strictPort: true, allowedHosts, proxy },
  preview: { host: '0.0.0.0', port: 55555, strictPort: true, allowedHosts, proxy },
})
