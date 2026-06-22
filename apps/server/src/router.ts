import { PodiumSettings } from '@podium/core'
import { AgentKind, ResumeRef, WorkState } from '@podium/protocol'
import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { SessionRegistry } from './relay'
import { browseDirectories, type RepoRegistry } from './repo-registry'
import type { SuperagentService } from './superagent'

export interface Context {
  registry: SessionRegistry
  repos: RepoRegistry
  superagent: SuperagentService
}

const t = initTRPC.context<Context>().create()
const PinKind = z.enum(['panel', 'worktree', 'repo'])

export const appRouter = t.router({
  sessions: t.router({
    list: t.procedure.query(({ ctx }) => ctx.registry.listSessions()),
    create: t.procedure
      .input(
        z.object({
          // Omitted = the settings default decides which harness to start.
          agentKind: AgentKind.optional(),
          cwd: z.string(),
          title: z.string().optional(),
          // Which machine to spawn on. Omitted = resolved by repo affinity / the sole
          // online machine (single-machine behavior is unchanged).
          machineId: z.string().optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.registry.createSession(input)),
    resume: t.procedure
      .input(
        z.object({
          agentKind: AgentKind,
          cwd: z.string(),
          resume: ResumeRef,
          conversationId: z.string(),
          title: z.string().optional(),
          machineId: z.string().optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.registry.resumeSession(input)),
    kill: t.procedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.killSession(input)),
    continue: t.procedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.continueSession(input)),
    // Chat-view send path: routes around controller gating on purpose — a chat
    // message is an explicit user act, not a competing keyboard.
    sendText: t.procedure
      .input(z.object({ sessionId: z.string(), text: z.string().min(1).max(32_768) }))
      .mutation(({ ctx, input }) => ctx.registry.sendText(input)),
    // Chat-view answer to a live AskUserQuestion prompt: type the chosen option
    // number(s) into the agent's native menu (the native terminal is unmounted in
    // chat mode). One entry per question, each with its 1-based option indices.
    answerAskUserQuestion: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          choices: z
            .array(z.object({ optionIndices: z.array(z.number().int().min(1).max(9)).min(1) }))
            .min(1),
        }),
      )
      .mutation(({ ctx, input }) => ctx.registry.answerAskUserQuestion(input)),
    // Chat compose for a parked session: wake it if needed, then deliver the
    // message once the resumed CLI is ready (auto-resume on submit).
    resumeAndSend: t.procedure
      .input(z.object({ sessionId: z.string(), text: z.string().min(1).max(32_768) }))
      .mutation(({ ctx, input }) => ctx.registry.resumeAndSend(input)),
    // On-demand transcript for the chat view — recovers a parked session's history
    // (hibernated/exited) that isn't in the live stream / server buffer.
    transcript: t.procedure
      .input(z.object({ sessionId: z.string() }))
      .query(({ ctx, input }) => ctx.registry.readTranscript(input)),
    // Scroll-to-top paging: the page of OLDER items before the client's window.
    // `fromEnd` = how many items the client already holds counted from the END of
    // the full on-disk transcript (0 = latest). Returns up to `limit` items just
    // before that, plus `hasMore` so the client stops at the head of the file.
    transcriptPage: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          fromEnd: z.number().int().nonnegative(),
          limit: z.number().int().positive().max(2000).default(400),
        }),
      )
      .query(({ ctx, input }) => ctx.registry.transcriptPage(input)),
    hibernate: t.procedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.hibernateSession(input)),
    resurrect: t.procedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.resurrectSession(input)),
    rename: t.procedure
      .input(z.object({ sessionId: z.string(), name: z.string().max(120) }))
      .mutation(({ ctx, input }) => ctx.registry.renameSession(input)),
    setArchived: t.procedure
      .input(z.object({ sessionId: z.string(), archived: z.boolean() }))
      .mutation(({ ctx, input }) => ctx.registry.setArchived(input)),
    setWorkState: t.procedure
      .input(z.object({ sessionId: z.string(), workState: WorkState.nullable() }))
      .mutation(({ ctx, input }) => ctx.registry.setWorkState(input)),
    // Image upload: the client sends a base64-encoded image; the daemon writes
    // it to ~/.podium/uploads/<sessionId>/<uuid>.<ext> and returns the absolute
    // path so it can be inserted into a prompt. Claude Code reads images by path.
    uploadImage: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          filename: z.string().max(255),
          mimeType: z.string().max(100),
          dataBase64: z.string().max(10 * 1024 * 1024), // ~7.5 MB decoded
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const result = await ctx.registry.uploadImage(input)
        if (result.error) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: result.error,
          })
        }
        if (!result.path) {
          throw new TRPCError({
            code: 'TIMEOUT',
            message: 'no daemon answered the image upload request',
          })
        }
        return result
      }),
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
  snoozes: t.router({
    list: t.procedure.query(({ ctx }) => ctx.registry.listSnoozes()),
    // until === null => "until next message"; ISO string => timed.
    set: t.procedure
      .input(z.object({ sessionId: z.string(), until: z.string().nullable() }))
      .mutation(({ ctx, input }) => {
        ctx.registry.setSnooze(input)
        return ctx.registry.listSnoozes()
      }),
    clear: t.procedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(({ ctx, input }) => {
        ctx.registry.clearSnooze(input.sessionId)
        return ctx.registry.listSnoozes()
      }),
  }),
  superagent: t.router({
    // The global orchestrator thread plus per-session 'btw' threads.
    listThreads: t.procedure.query(({ ctx }) => ctx.superagent.listThreads()),
    history: t.procedure
      .input(z.object({ threadId: z.string().default('global') }))
      .query(({ ctx, input }) => ctx.superagent.history(input.threadId)),
    // Runs the full tool loop server-side; resolves with this turn's new messages.
    send: t.procedure
      .input(
        z.object({ threadId: z.string().default('global'), text: z.string().min(1).max(32_768) }),
      )
      .mutation(({ ctx, input }) => ctx.superagent.send(input.threadId, input.text)),
    clear: t.procedure
      .input(z.object({ threadId: z.string().default('global') }))
      .mutation(({ ctx, input }) => ctx.superagent.clear(input.threadId)),
    // Spin up (or re-open) a btw thread seeded from a chat session's transcript.
    startBtw: t.procedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(({ ctx, input }) => ctx.superagent.startBtw(input)),
  }),
  conversations: t.router({
    // Keyword search over the durable index (FTS5 where available). Empty query
    // browses by recency. projectPath narrows to a repo/worktree subtree.
    search: t.procedure
      .input(
        z.object({
          query: z.string().optional(),
          projectPath: z.string().optional(),
          limit: z.number().int().positive().max(200).optional(),
        }),
      )
      .query(({ ctx, input }) => ctx.registry.searchConversations(input)),
    // Curation written by the command center (user rename / work-LLM summary).
    setMeta: t.procedure
      .input(
        z.object({
          id: z.string(),
          name: z.string().max(200).optional(),
          summary: z.string().max(2000).optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.registry.setConversationMeta(input)),
  }),
  settings: t.router({
    get: t.procedure.query(({ ctx }) => ctx.registry.getSettings()),
    // Whole-object set: the client always round-trips the full blob, so there is
    // no partial-merge ambiguity. PodiumSettings fills defaults for missing keys.
    set: t.procedure
      .input(PodiumSettings)
      .mutation(({ ctx, input }) => ctx.registry.setSettings(input)),
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
    add: t.procedure
      .input(z.object({ path: z.string(), machineId: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        try {
          await ctx.repos.add(input.path, input.machineId)
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
      .input(z.object({ paths: z.array(z.string()), machineId: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        const failed: { path: string; message: string }[] = []
        for (const path of input.paths) {
          try {
            await ctx.repos.add(path, input.machineId)
          } catch (e) {
            failed.push({ path, message: e instanceof Error ? e.message : String(e) })
          }
        }
        return { repos: ctx.repos.list(), failed }
      }),
    remove: t.procedure
      .input(z.object({ path: z.string(), machineId: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        await ctx.repos.remove(input.path, input.machineId)
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
  usage: t.router({
    // Hour×model token buckets for the last 7 days, harvested from harness
    // transcripts on the dev machine. Window math (5h/weekly/cost) is client-side.
    summary: t.procedure.query(({ ctx }) => ctx.registry.usage()),
  }),
  quota: t.router({
    // Per-agent plan-quota (5h/weekly % used + reset times), read live on the
    // daemon host from each agent's own usage endpoint. Distinct from `usage`,
    // which is transcript-harvested token-cost analytics.
    summary: t.procedure.query(({ ctx }) => ctx.registry.agentQuota()),
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
    // Fans out to each online machine; each result is stamped with its machineId.
    // Single-machine: identical to the old scanRepos(list()) path (maxDepth:0 inspects
    // each registered root in place, never walking the filesystem), just with machineId added.
    refreshRepos: t.procedure.mutation(({ ctx }) => ctx.repos.scanReposAll()),
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
  machines: t.router({
    // Registered machines (online flag + last-seen), shown in Settings → Machines and
    // the machine dropdown. Single-machine: just the one 'local' machine.
    list: t.procedure.query(({ ctx }) => ctx.registry.listMachines()),
    rename: t.procedure
      .input(z.object({ id: z.string(), name: z.string().min(1).max(80) }))
      .mutation(({ ctx, input }) => {
        ctx.registry.renameMachine(input.id, input.name)
        return ctx.registry.listMachines()
      }),
    revoke: t.procedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => {
      ctx.registry.revokeMachine(input.id)
      return ctx.registry.listMachines()
    }),
    // Mint a short-lived pairing code the user types into a new machine's daemon to
    // join it to this server.
    pairingCode: t.procedure.mutation(({ ctx }) => ({ code: ctx.registry.mintPairingCode() })),
  }),
  files: t.router({
    read: t.procedure
      .input(z.object({ sessionId: z.string(), path: z.string() }))
      .query(({ ctx, input }) => ctx.registry.readFile(input)),
    write: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          path: z.string(),
          content: z.string(),
          baseHash: z.string().optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.registry.writeFile(input)),
  }),
})

export type AppRouter = typeof appRouter
