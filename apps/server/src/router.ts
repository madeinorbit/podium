import { PodiumSettings } from '@podium/core'
import { loadConfig } from '@podium/core/config'
import {
  applyJoin,
  applyMode,
  applySetup,
  getUpdateChannel,
  NETWORK_OPTIONS,
  networkOptionCommand,
  setUpdateChannel,
  validatePublicUrl,
} from '@podium/core/setup'
import { AgentKind, IssueStage, IssueType, ResumeRef, WorkState } from '@podium/protocol'
import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import { clearPassword, hasPassword, setPassword, verifyPassword } from './auth-store'
import { PROC_MIN_ROLE, ROLE_RANK, type Role } from './issue-roles'
import { readMaintainerToken } from './local-machine'
import { buildJoinCommand } from './machines-join'
import type { SessionRegistry } from './relay'
import { browseDirectories, type RepoRegistry } from './repo-registry'
import { isAllowedRoot } from './root-allowlist'
import type { SuperagentService } from './superagent'

export interface Context {
  registry: SessionRegistry
  repos: RepoRegistry
  superagent: SuperagentService
  role: Role
}

const t = initTRPC.context<Context>().create()
const PinKind = z.enum(['panel', 'worktree', 'repo'])

/** Enforce the per-procedure minimum role for every issues.* call. The middleware `path`
 *  is e.g. "issues.create"; its last segment is the proc name, looked up in PROC_MIN_ROLE
 *  (unlisted ⇒ 'reader'). Insufficient role ⇒ FORBIDDEN. */
const issueRoleGuard = t.middleware(({ ctx, path, next }) => {
  const proc = path.split('.').pop() ?? ''
  const need = PROC_MIN_ROLE[proc] ?? 'reader'
  if (ROLE_RANK[ctx.role] < ROLE_RANK[need]) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `role '${ctx.role}' may not '${proc}' (needs '${need}')`,
    })
  }
  return next()
})
const issueProc = t.procedure.use(issueRoleGuard)

export const appRouter = t.router({
  // Hand the operator's browser its issue-tracker credential at runtime. The server also
  // injects this same token into index.html (static-web.ts), but the live web is served by
  // Vite preview + cached by the PWA service worker, so that injection never reaches the
  // browser — the web fetches it here at boot instead and presents it as x-podium-issue-token
  // (see web makeTrpc / issueAuthHeaders). Ungated by design: it's the bootstrap that grants
  // the human UI maintainer, exactly like the HTML injection it backs up. Agent access stays
  // gated by cwd/worker-token (hardening tracked in bd podium-hi7.6).
  issueToken: t.procedure.query(() => readMaintainerToken() ?? null),
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
    // On-demand transcript window for the chat view — a pure disk read via the
    // daemon (disk = source of truth). `anchor` is a cursor; `direction` reads the
    // `limit` items before (older) or after (newer) it. No anchor = the latest
    // window. Serves both initial load and scroll-to-top paging, for live AND parked
    // sessions alike — independent of the server's recent-delta cache.
    transcriptRead: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          anchor: z.string().optional(),
          direction: z.enum(['before', 'after']),
          limit: z.number().int().positive().max(2000),
        }),
      )
      .query(({ ctx, input }) => ctx.registry.readTranscript(input)),
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
    clear: t.procedure.input(z.object({ sessionId: z.string() })).mutation(({ ctx, input }) => {
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
    telegramSetupStart: t.procedure.mutation(({ ctx }) => ctx.registry.startTelegramSetup()),
    telegramSetupPoll: t.procedure
      .input(z.object({ setupId: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.pollTelegramSetup(input.setupId)),
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
    // cwd → repo inference for the CLI: longest registered root that contains `path`.
    inferFromPath: t.procedure
      .input(z.object({ path: z.string() }))
      .query(({ ctx, input }) => ({ repoPath: ctx.repos.inferFromPath(input.path) ?? null })),
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
    pairingCode: t.procedure.mutation(({ ctx }) => {
      const code = ctx.registry.mintPairingCode()
      const publicUrl = loadConfig().publicUrl
      return {
        code,
        joinCommand: publicUrl ? buildJoinCommand({ publicUrl, pairCode: code }) : null,
      }
    }),
  }),
  // First-run "make this instance reachable" flow (Tailscale-first). The web setup screen
  // reaches these instead of importing @podium/core/setup directly, which would pull node:fs
  // (via ./config) into the browser bundle.
  setup: t.router({
    options: t.procedure.query(() => NETWORK_OPTIONS),
    commandFor: t.procedure
      .input(
        z.object({
          option: z.enum(['tailscale-funnel', 'tailscale-serve', 'cloudflare-tunnel', 'manual']),
          port: z.number(),
        }),
      )
      .query(({ input }) => networkOptionCommand(input.option, input.port)),
    complete: t.procedure
      // password is optional: making the instance reachable strongly suggests setting one
      // (the UI defaults to it), but the user can opt out and run open.
      .input(z.object({ publicUrl: z.string(), password: z.string().optional() }))
      .mutation(async ({ input }) => {
        const v = validatePublicUrl(input.publicUrl)
        if (!v.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: v.error })
        const cfg = applySetup({ publicUrl: v.normalized })
        if (input.password?.trim()) await setPassword(input.password)
        return cfg
      }),
    // Daemon onboarding: one pasted join code (server URL + pairing code) → daemon config.
    // Same core `applyJoin` the CLI uses, so the web and terminal flows stay identical.
    join: t.procedure.input(z.object({ code: z.string() })).mutation(({ input }) => {
      try {
        return applyJoin(input.code.trim())
      } catch (e) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (e as Error).message })
      }
    }),
    // Modes with no reachability flow: all-in-one ("skip"), client (remote URL), server-only.
    // Replaces the legacy POST /setup/config — one tRPC surface for every setup write.
    connect: t.procedure
      .input(
        z.object({
          mode: z.enum(['all-in-one', 'client', 'server']),
          serverUrl: z.string().optional(),
        }),
      )
      .mutation(({ input }) => {
        try {
          return applyMode(input)
        } catch (e) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: (e as Error).message })
        }
      }),
    channel: t.procedure.query(() => getUpdateChannel()),
    setChannel: t.procedure
      .input(z.object({ channel: z.enum(['stable', 'edge']) }))
      .mutation(({ input }) => setUpdateChannel(input.channel)),
  }),
  // Manage the human-client login password on an already-configured instance. These run
  // under the same /trpc guard, so once a password is set you must be logged in to reach
  // them; we ALSO require the current password for a change/disable (defends against a
  // hijacked session). In open mode (no password) the current check is skipped — bootstrap.
  auth: t.router({
    status: t.procedure.query(() => ({ enabled: hasPassword() })),
    setPassword: t.procedure
      .input(z.object({ current: z.string().optional(), next: z.string().min(1) }))
      .mutation(async ({ input }) => {
        if (hasPassword() && !(input.current && (await verifyPassword(input.current)))) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'current password is incorrect' })
        }
        await setPassword(input.next)
        return { enabled: true }
      }),
    clearPassword: t.procedure
      .input(z.object({ current: z.string() }))
      .mutation(async ({ input }) => {
        if (hasPassword() && !(await verifyPassword(input.current))) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'current password is incorrect' })
        }
        clearPassword()
        return { enabled: false }
      }),
  }),
  issues: t.router({
    list: issueProc
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.list(input.repoPath)),
    ready: issueProc
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.readyList(input.repoPath)),
    blocked: issueProc
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.blockedList(input.repoPath)),
    graph: issueProc
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.graph(input.repoPath)),
    epicStatus: issueProc
      .input(z.object({ id: z.string() }))
      .query(({ ctx, input }) => ctx.registry.issues.epicStatus(input.id)),
    closeEligibleEpics: issueProc
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.closeEligibleEpics(input.repoPath)),
    findDuplicates: issueProc
      .input(z.object({ repoPath: z.string().optional(), threshold: z.number().optional() }))
      .query(({ ctx, input }) =>
        ctx.registry.issues.findDuplicates(input.repoPath, input.threshold),
      ),
    stale: issueProc
      .input(z.object({ repoPath: z.string().optional(), days: z.number().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.staleList(input.repoPath, input.days)),
    lint: issueProc
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.lint(input.repoPath)),
    doctor: issueProc
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.doctor(input.repoPath)),
    preflight: issueProc
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.preflight(input.repoPath)),
    search: issueProc
      .input(
        z.object({
          repoPath: z.string().optional(),
          text: z.string().optional(),
          status: z.enum(['open', 'closed', 'ready', 'blocked', 'deferred']).optional(),
          stage: IssueStage.optional(),
          priority: z.number().int().optional(),
          type: IssueType.optional(),
          assignee: z.string().optional(),
          label: z.string().optional(),
          parentId: z.string().optional(),
        }),
      )
      .query(({ ctx, input }) => ctx.registry.issues.search(input)),
    count: issueProc
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.count(input.repoPath)),
    stats: issueProc
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.stats(input.repoPath)),
    orphans: issueProc
      .input(z.object({ repoPath: z.string() }))
      .query(({ ctx, input }) => ctx.registry.issues.orphans(input.repoPath)),
    get: issueProc
      .input(z.object({ id: z.string() }))
      .query(({ ctx, input }) => ctx.registry.issues.get(input.id)),
    create: issueProc
      .input(
        z.object({
          repoPath: z.string(),
          title: z.string().min(1),
          description: z.string().optional(),
          parentBranch: z.string().optional(),
          defaultAgent: z.string().optional(),
          startNow: z.boolean(),
          linear: z
            .object({ id: z.string().optional(), identifier: z.string(), url: z.string() })
            .optional(),
          priority: z.number().int().min(0).max(4).optional(),
          type: IssueType.optional(),
          assignee: z.string().optional(),
          labels: z.array(z.string()).optional(),
          parentId: z.string().optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.registry.issues.createAndMaybeStart(input)),
    start: issueProc
      .input(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.start(input.id)),
    update: issueProc
      .input(
        z.object({
          id: z.string(),
          patch: z.object({
            title: z.string().optional(),
            description: z.string().optional(),
            stage: IssueStage.optional(),
            parentBranch: z.string().optional(),
            defaultAgent: z.string().optional(),
            archived: z.boolean().optional(),
            priority: z.number().int().min(0).max(4).optional(),
            type: IssueType.optional(),
            assignee: z.string().optional(),
            parentId: z.string().optional(),
            design: z.string().optional(),
            acceptance: z.string().optional(),
            notes: z.string().optional(),
            dueAt: z.string().optional(),
            deferUntil: z.string().optional(),
            closedReason: z.string().optional(),
            pinned: z.boolean().optional(),
            estimateMin: z.number().int().optional(),
          }),
        }),
      )
      .mutation(({ ctx, input }) => ctx.registry.issues.update(input.id, input.patch)),
    archive: issueProc
      .input(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.archive(input.id)),
    delete: issueProc
      .input(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.delete(input.id)),
    action: issueProc
      .input(z.object({ id: z.string(), kind: z.enum(['rebase', 'pr', 'merge']) }))
      .mutation(({ ctx, input }) => ctx.registry.issues.action(input.id, input.kind)),
    addSession: issueProc
      .input(z.object({ id: z.string(), agentKind: z.string().optional() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.addSession(input.id, input.agentKind)),
    addShell: issueProc
      .input(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.addShell(input.id)),
    applySuggestion: issueProc
      .input(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.applySuggestion(input.id)),
    dismissSuggestion: issueProc
      .input(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.dismissSuggestion(input.id)),
    refreshAssistant: issueProc
      .input(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.refreshAssistant(input.id)),
    setLabels: issueProc
      .input(z.object({ id: z.string(), labels: z.array(z.string()) }))
      .mutation(({ ctx, input }) => ctx.registry.issues.setLabels(input.id, input.labels)),
    addComment: issueProc
      .input(z.object({ id: z.string(), author: z.string(), body: z.string().min(1) }))
      .mutation(({ ctx, input }) =>
        ctx.registry.issues.addComment(input.id, input.author, input.body),
      ),
    depAdd: issueProc
      .input(z.object({ fromId: z.string(), toId: z.string(), type: z.string().optional() }))
      .mutation(({ ctx, input }) =>
        ctx.registry.issues.addDep(input.fromId, input.toId, input.type),
      ),
    depRemove: issueProc
      .input(z.object({ fromId: z.string(), toId: z.string(), type: z.string().optional() }))
      .mutation(({ ctx, input }) =>
        ctx.registry.issues.removeDep(input.fromId, input.toId, input.type),
      ),
    defer: issueProc
      .input(z.object({ id: z.string(), until: z.string().nullable() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.defer(input.id, input.until)),
    reparent: issueProc
      .input(z.object({ id: z.string(), parentId: z.string().nullable() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.reparent(input.id, input.parentId)),
    claim: issueProc
      .input(z.object({ id: z.string(), assignee: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.claim(input.id, input.assignee)),
    close: issueProc
      .input(z.object({ id: z.string(), reason: z.string().optional() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.close(input.id, input.reason)),
    supersede: issueProc
      .input(z.object({ oldId: z.string(), newId: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.supersede(input.oldId, input.newId)),
    duplicate: issueProc
      .input(z.object({ id: z.string(), canonicalId: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.duplicate(input.id, input.canonicalId)),
    linearSearch: issueProc
      .input(z.object({ query: z.string() }))
      .query(({ ctx, input }) => ctx.registry.issues.linearSearch(input.query)),
  }),
  files: t.router({
    read: t.procedure
      .input(
        z.union([
          z.object({ sessionId: z.string(), path: z.string() }),
          z.object({ machineId: z.string().optional(), root: z.string(), path: z.string() }),
        ]),
      )
      .query(({ ctx, input }) => {
        if ('root' in input && !isAllowedRoot(ctx.repos.list(), input.root)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'root is not a known repository path' })
        }
        return ctx.registry.readFile(input)
      }),
    write: t.procedure
      .input(
        z.union([
          z.object({
            sessionId: z.string(),
            path: z.string(),
            content: z.string(),
            baseHash: z.string().optional(),
          }),
          z.object({
            machineId: z.string().optional(),
            root: z.string(),
            path: z.string(),
            content: z.string(),
            baseHash: z.string().optional(),
          }),
        ]),
      )
      .mutation(({ ctx, input }) => {
        if ('root' in input && !isAllowedRoot(ctx.repos.list(), input.root)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'root is not a known repository path' })
        }
        return ctx.registry.writeFile(input)
      }),
    list: t.procedure
      .input(
        z.object({
          machineId: z.string().optional(),
          root: z.string(),
          path: z.string().optional(),
        }),
      )
      .query(({ ctx, input }) => {
        if (!isAllowedRoot(ctx.repos.list(), input.root)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'root is not a known repository path' })
        }
        return ctx.registry.listDir(input)
      }),
  }),
})

export type AppRouter = typeof appRouter
