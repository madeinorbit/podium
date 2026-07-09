/**
 * Backend for the single-origin dev host: relay server + live agent daemon in one process.
 *
 * The Vite dev server (apps/web, on :55556) is the app origin and proxies /trpc, /health,
 * /client and /daemon here; `tailscale serve` fronts it with TLS on :55555. The daemon connects
 * to the server directly on localhost (not through
 * the proxy) and spawns the real `claude`/`codex` CLIs via @podium/agent-bridge.
 *
 * Single dev process combining server + daemon; production runs them split (scripts/server.ts
 * + scripts/daemon.ts). Run under Bun from source — no build step, because the `@podium/source`
 * condition resolves the workspace packages to their `src`. The PTY backend is selected at
 * runtime (@podium/agent-bridge): Bun.Terminal under Bun, node-pty under Node — so the native
 * addon is never loaded on Bun. For the full app incl. the web UI use `bun run host`; backend only:
 *   bun --conditions=@podium/source --watch scripts/host.ts   (== `bun run host:backend`)
 * No starter session — sessions are created from the Live UI.
 *
 * Boot/shutdown semantics live in the shared kernel (@podium/runtime/boot): crash net,
 * boot watchdog (under host memory pressure startup can wedge mid-init — alive but never
 * serving, invisible to Restart=always), systemd watchdog pet, and bounded close.
 */
import { bootProcess } from '@podium/runtime/boot'
import { startDaemon } from '../apps/daemon/src/daemon'
import { LOCAL_MACHINE_ID } from '../apps/server/src/local-machine'
import { startServer } from '../apps/server/src/server'

await bootProcess({
  name: 'host',
  start: async () => {
    // Uncommon internal port; the Vite proxy in apps/web/vite.config.ts uses the same PODIUM_PORT.
    const server = await startServer({ port: Number(process.env.PODIUM_PORT ?? 18787) })
    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${server.port}`,
      bootstrapToken: server.bootstrapToken,
      machineId: LOCAL_MACHINE_ID, // attach to the machine the server adopted '__local__' rows onto
      installCodexHooks: true,
    })
    return {
      port: server.port,
      close: async () => {
        await daemon.close()
        await server.close()
      },
    }
  },
  readyMessage: (h) => `podium backend up: relay + daemon on ws://localhost:${h.port}`,
})
