/**
 * @podium/server — session registry + Hono/ws/tRPC server. Exports the tRPC AppRouter type.
 */
export type { PodiumPlugin, PodiumPluginHooks } from './plugins'
export * from './relay'
export type { ServerRoleConfig } from './roles'
export type { AppRouter } from './router'
export type { ServerHandle } from './server'
export { startServer } from './server'
