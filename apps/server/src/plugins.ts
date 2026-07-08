import type { PodiumConfig } from '@podium/runtime/config'
import type { Hono } from 'hono'
import type { EventBus } from './modules/bus'
import type { RegistryModules } from './relay'
import type { ServerRoleConfig } from './roles'

/**
 * The build-time extension seam for the private `cloud` module
 * (docs/offline-sync-architecture.md §4, issue #157): the OSS server ships NO
 * plugins and never references cloud code by path (lint-enforced — see
 * roles.ts). A private build entrypoint calls
 * `startServer({ plugins: [cloudPlugin] })`; everything cloud needs crosses
 * this one typed surface.
 *
 * Deliberately minimal — exactly what §4 requires (route/module registration
 * hooks), nothing speculative:
 *  - `hono`     — mount HTTP routes/middleware. Plugins register after the core
 *    routes and BEFORE the static SPA catch-alls, so plugin paths are reachable
 *    but can't shadow core surfaces.
 *  - `modules`  — the composed service set (the same typed seam router procs
 *    use via ctx.modules).
 *  - `bus`      — the in-process event bus, for subscribing to module signals.
 *  - `config` / `role` — the deployment identity the process booted with.
 *
 * tRPC router extension is intentionally absent: `appRouter` is a static type
 * (clients compile against it), so cloud procs mount their own endpoint via
 * `hono` instead of mutating the core router.
 */
export interface PodiumPluginHooks {
  /** The server's Hono app — register routes/middleware here. */
  hono: Hono
  /** The composed module set (ctx.modules equivalent). */
  modules: RegistryModules
  /** The typed in-process event bus (modules/bus.ts). */
  bus: EventBus
  /** The loaded config.json this process booted with. */
  config: PodiumConfig
  /** The resolved runtime role (roles.ts). */
  role: ServerRoleConfig
}

/** One composable server extension. `register` runs once during startServer,
 *  awaited in order, after core routes exist and before the server listens. */
export interface PodiumPlugin {
  /** Diagnostic name (logs/errors); e.g. 'podium-cloud'. */
  name: string
  register(hooks: PodiumPluginHooks): void | Promise<void>
}
