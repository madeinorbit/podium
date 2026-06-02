import { initTRPC } from '@trpc/server'
import type { RelayHub, SessionInfo } from './relay'

export interface Context {
  hub: RelayHub
}

const t = initTRPC.context<Context>().create()

export const appRouter = t.router({
  session: t.router({
    info: t.procedure.query(({ ctx }): SessionInfo => ctx.hub.info()),
  }),
})

export type AppRouter = typeof appRouter
