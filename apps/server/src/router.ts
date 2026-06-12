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
const PinKind = z.enum(['panel', 'worktree', 'repo'])

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
    continue: t.procedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.continueSession(input)),
  }),
  pins: t.router({
    list: t.procedure.query(({ ctx }) => ctx.registry.listPins()),
    set: t.procedure
      .input(z.object({ kind: PinKind, id: z.string(), pinned: z.boolean() }))
      .mutation(({ ctx, input }) => {
        try {
          ctx.registry.setPin(input.kind, input.id, input.pinned)
        } catch (e) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: e instanceof Error ? e.message : String(e),
          })
        }
        return ctx.registry.listPins()
      }),
  }),
  tabs: t.router({
    listOrders: t.procedure.query(({ ctx }) => ctx.registry.listTabOrders()),
    setOrder: t.procedure
      .input(z.object({ worktree: z.string(), sessionIds: z.array(z.string()) }))
      .mutation(({ ctx, input }) => {
        try {
          ctx.registry.setTabOrder(input.worktree, input.sessionIds)
        } catch (e) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: e instanceof Error ? e.message : String(e),
          })
        }
        return ctx.registry.listTabOrders()
      }),
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
    // Persist a selected set in one call (the scan-and-select flow). Each path is
    // added independently so one bad entry doesn't drop the rest; failures are reported.
    addMany: t.procedure
      .input(z.object({ paths: z.array(z.string()) }))
      .mutation(async ({ ctx, input }) => {
        const failed: { path: string; message: string }[] = []
        for (const path of input.paths) {
          try {
            await ctx.repos.add(path)
          } catch (e) {
            failed.push({ path, message: e instanceof Error ? e.message : String(e) })
          }
        }
        return { repos: ctx.repos.list(), failed }
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
  hosts: t.router({
    // Who owns the used memory right now. Roots are derived server-side — the
    // registered repos plus their worktrees (worktrees often live OUTSIDE the
    // repo path as siblings, so the repo path alone would miss their dev servers).
    memoryBreakdown: t.procedure.mutation(async ({ ctx }) => {
      const { repositories } = await ctx.registry.scanRepos(ctx.repos.list(), {
        includeHome: false,
        maxDepth: 0,
      })
      const roots = [
        ...new Set(repositories.flatMap((r) => [r.path, ...r.worktrees.map((w) => w.path)])),
      ]
      const breakdown = await ctx.registry.memoryBreakdown(roots)
      if (!breakdown) {
        throw new TRPCError({
          code: 'TIMEOUT',
          message: 'no daemon answered the memory breakdown request',
        })
      }
      return breakdown
    }),
  }),
  discovery: t.router({
    scan: t.procedure.mutation(({ ctx }) => ctx.registry.scan()),
    // Load path: enrich only the already-registered repos with branch/worktree metadata.
    // maxDepth:0 inspects each registered root in place, so this never walks the
    // filesystem and stays fast regardless of how many repos live under $HOME.
    refreshRepos: t.procedure.mutation(({ ctx }) =>
      ctx.registry.scanRepos(ctx.repos.list(), { includeHome: false, maxDepth: 0 }),
    ),
    // Discovery path: walk a user-picked folder (never all of $HOME) to a bounded
    // depth and return candidates for the selection screen.
    scanFolder: t.procedure
      .input(z.object({ path: z.string(), maxDepth: z.number().int().positive().optional() }))
      .mutation(({ ctx, input }) =>
        ctx.registry.scanRepos([input.path], {
          includeHome: false,
          maxDepth: input.maxDepth ?? 6,
        }),
      ),
  }),
})

export type AppRouter = typeof appRouter
