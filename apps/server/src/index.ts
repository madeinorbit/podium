/**
 * @podium/server — session registry + Hono/ws/tRPC server. Exports the tRPC AppRouter type.
 */
export * from './relay'
export type { AppRouter } from './router'
export type { ServerHandle } from './server'
export { startServer } from './server'
export * from './session'
