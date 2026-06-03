import { AgentKind, ResumeRef } from '@podium/protocol'
import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import type { SessionRegistry } from './relay'

export interface Context {
  registry: SessionRegistry
}

const t = initTRPC.context<Context>().create()

export const appRouter = t.router({
  sessions: t.router({
    list: t.procedure.query(({ ctx }) => ctx.registry.listSessions()),
    create: t.procedure
      .input(z.object({ agentKind: AgentKind, cwd: z.string(), title: z.string().optional() }))
      .mutation(({ ctx, input }) => ctx.registry.createSession(input)),
    resume: t.procedure
      .input(
        z.object({
          agentKind: AgentKind,
          cwd: z.string(),
          resume: ResumeRef,
          conversationId: z.string(),
          title: z.string().optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.registry.resumeSession(input)),
    kill: t.procedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.killSession(input)),
  }),
  discovery: t.router({
    scan: t.procedure.query(({ ctx }) => ctx.registry.scan()),
  }),
})

export type AppRouter = typeof appRouter
