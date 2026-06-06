import { AgentKind, ResumeRef } from '@podium/protocol'
import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { SessionRegistry } from './relay'
import { browseDirectories, type RepoRegistry } from './repo-registry'

export interface Context {
  registry: SessionRegistry
  repos: RepoRegistry
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
  repos: t.router({
    list: t.procedure.query(({ ctx }) => ctx.repos.list()),
    add: t.procedure.input(z.object({ path: z.string() })).mutation(async ({ ctx, input }) => {
      try {
        await ctx.repos.add(input.path)
      } catch (e) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: e instanceof Error ? e.message : String(e),
        })
      }
      return ctx.repos.list()
    }),
    remove: t.procedure.input(z.object({ path: z.string() })).mutation(async ({ ctx, input }) => {
      await ctx.repos.remove(input.path)
      return ctx.repos.list()
    }),
    browse: t.procedure
      .input(
        z.object({ path: z.string().optional(), includeHidden: z.boolean().optional() }).optional(),
      )
      .query(async ({ input }) => {
        try {
          return await browseDirectories(input?.path, { includeHidden: input?.includeHidden })
        } catch (e) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: e instanceof Error ? e.message : String(e),
          })
        }
      }),
  }),
  discovery: t.router({
    scan: t.procedure.mutation(({ ctx }) => ctx.registry.scan()),
    scanRepos: t.procedure.mutation(({ ctx }) => ctx.registry.scanRepos(ctx.repos.list())),
  }),
})

export type AppRouter = typeof appRouter
