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
import { authorize, type Capability, PROC_ACTION } from './issue-authz'
import { buildJoinCommand } from './machines-join'
import type { SessionRegistry } from './relay'
import { browseDirectories, type RepoRegistry } from './repo-registry'
import { isAllowedRoot } from './root-allowlist'
import type { SuperagentService } from './superagent'

export interface Context {
  registry: SessionRegistry
  repos: RepoRegistry
  superagent: SuperagentService
  /** What this caller may do with issues (authz, distinct from the login authn on /trpc).
   *  Every HTTP caller is the OPERATOR today; the in-process MCP passes its own. */
  capability: Capability
  /** Set by the daemon relay when an agent passed --outside-scope, allowing a knowing
   *  write outside its subtree. Undefined for the operator (/trpc) and the superagent. */
  overrideScope?: boolean
}

const t = initTRPC.context<Context>().create()
const PinKind = z.enum(['panel', 'worktree', 'repo'])

/** proc name → how to read the target EXISTING issue id from its input. The scope gate runs
 *  ONLY for procs listed here, so every write/manage proc that mutates an existing issue must
 *  appear (create/linearSearch are additive / not-an-issue). router.issues.test.ts ties this
 *  set to PROC_ACTION so a new write/manage proc can't silently escape the subtree check. */
export const SCOPED_TARGET: Record<string, (i: Record<string, unknown>) => string | undefined> = {
  // write — target = the issue being worked on
  claim: (i) => i.id as string,
  update: (i) => i.id as string,
  close: (i) => i.id as string,
  defer: (i) => i.id as string,
  setNeedsHuman: (i) => i.id as string,
  clearNeedsHuman: (i) => i.id as string,
  addComment: (i) => i.id as string,
  action: (i) => i.id as string,
  applySuggestion: (i) => i.id as string,
  dismissSuggestion: (i) => i.id as string,
  refreshAssistant: (i) => i.id as string,
  start: (i) => i.id as string,
  addSession: (i) => i.id as string,
  addShell: (i) => i.id as string,
  depAdd: (i) => i.fromId as string,
  // manage — target = the mutated subject issue (verified against each resolver's input)
  archive: (i) => i.id as string,
  delete: (i) => i.id as string,
  setLabels: (i) => i.id as string,
  reparent: (i) => i.id as string,
  depRemove: (i) => i.fromId as string,
  supersede: (i) => i.oldId as string,
  duplicate: (i) => i.id as string,
}

/** Authorize every issues.* call against the caller's capability. The middleware `path`
 *  is e.g. "issues.create"; its last segment is the proc name, mapped to the action it needs
 *  (PROC_ACTION, unlisted ⇒ 'read'). Two gates: (1) a role gate — `authorize` with no issue
 *  denies if the role can't perform the action (⇒ FORBIDDEN); (2) a scope gate — for a
 *  constrained (non-'all') capability writing an EXISTING target issue, resolve the target +
 *  its ancestors and `authorize` against the subtree. Out-of-subtree ⇒ PRECONDITION_FAILED
 *  (the caller may knowingly override via --outside-scope → ctx.overrideScope). Reads and
 *  create (additive, no existing target) are never scope-restricted. */
const issueCapabilityGuard = t.middleware(async ({ ctx, path, next, getRawInput }) => {
  const proc = path.split('.').pop() ?? ''
  const action = PROC_ACTION[proc] ?? 'read'

  // Role gate (no input needed): authorize with no issue = role decision.
  if (authorize(ctx.capability, action) === 'forbidden') {
    throw new TRPCError({ code: 'FORBIDDEN', message: `not allowed to '${proc}' issues` })
  }

  // Scope gate: only for constrained caps writing an existing target issue.
  const extract = ctx.capability.scope.kind !== 'all' ? SCOPED_TARGET[proc] : undefined
  if (extract) {
    const targetId = extract((await getRawInput()) as Record<string, unknown>)
    if (targetId && ctx.registry.issues.get(targetId)) {
      const ancestorIds = ctx.registry.issues.ancestorIds(targetId)
      const decision = authorize(
        ctx.capability,
        action,
        { id: targetId, ancestorIds },
        { override: ctx.overrideScope },
      )
      if (decision === 'confirm-required') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `issue ${targetId} is outside your subtree; re-run with --outside-scope to confirm`,
        })
      }
      if (decision === 'forbidden') {
        throw new TRPCError({ code: 'FORBIDDEN', message: `not allowed to '${proc}' issues` })
      }
    }
  }
  return next()
})
const issueProc = t.procedure.use(issueCapabilityGuard)

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
      .input(
        z.object({
          sessionId: z.string(),
          text: z.string().min(1).max(32_768),
          // Idempotency key (docs/spec/outbox-write-path.md §2.1): a replayed send
          // must NOT double-type into the PTY.
          mutationId: z.string().max(128).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        ctx.registry.withMutation(input.mutationId, 'sessions.sendText', () =>
          ctx.registry.sendText(input),
        ),
      ),
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
      .input(
        z.object({
          sessionId: z.string(),
          text: z.string().min(1).max(32_768),
          mutationId: z.string().max(128).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        ctx.registry.withMutation(input.mutationId, 'sessions.resumeAndSend', () =>
          ctx.registry.resumeAndSend(input),
        ),
      ),
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
      .input(
        z.object({
          sessionId: z.string(),
          name: z.string().max(120),
          mutationId: z.string().max(128).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        ctx.registry.withMutation(input.mutationId, 'sessions.rename', () =>
          ctx.registry.renameSession(input),
        ),
      ),
    setArchived: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          archived: z.boolean(),
          mutationId: z.string().max(128).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        ctx.registry.withMutation(input.mutationId, 'sessions.setArchived', () =>
          ctx.registry.setArchived(input),
        ),
      ),
    setWorkState: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          workState: WorkState.nullable(),
          mutationId: z.string().max(128).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        ctx.registry.withMutation(input.mutationId, 'sessions.setWorkState', () =>
          ctx.registry.setWorkState(input),
        ),
      ),
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
  sync: t.router({
    // Metadata-oplog catch-up (docs/spec/oplog-read-path.md): null cursor = bootstrap
    // snapshot; a valid cursor = the changes after it; a compacted/future cursor
    // falls back to snapshot. The client heals every WS (re)connect through this.
    changesSince: t.procedure
      .input(z.object({ cursor: z.number().int().nonnegative().nullable() }))
      .query(({ ctx, input }) => ctx.registry.syncChangesSince(input.cursor)),
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
      .input(
        z.object({
          sessionId: z.string(),
          until: z.string().nullable(),
          mutationId: z.string().max(128).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        ctx.registry.withMutation(input.mutationId, 'snoozes.set', () => {
          ctx.registry.setSnooze(input)
          return ctx.registry.listSnoozes()
        }),
      ),
    clear: t.procedure
      .input(z.object({ sessionId: z.string(), mutationId: z.string().max(128).optional() }))
      .mutation(({ ctx, input }) =>
        ctx.registry.withMutation(input.mutationId, 'snoozes.clear', () => {
          ctx.registry.clearSnooze(input.sessionId)
          return ctx.registry.listSnoozes()
        }),
      ),
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
      // password is optional: making the instance reachable strongly suggests setting one.
      // Blank password is still supported, but must be an explicit, auditable opt-out.
      .input(
        z.object({
          publicUrl: z.string(),
          password: z.string().optional(),
          acknowledgeNoPassword: z.literal(true).optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const v = validatePublicUrl(input.publicUrl)
        if (!v.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: v.error })
        const password = input.password?.trim()
        if (!password && !input.acknowledgeNoPassword) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Confirm running without a login password.',
          })
        }
        const cfg = applySetup({ publicUrl: v.normalized })
        if (password) await setPassword(password)
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
      .input(z.object({ current: z.string(), acknowledgeNoPassword: z.literal(true).optional() }))
      .mutation(async ({ input }) => {
        if (!input.acknowledgeNoPassword) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Confirm running without a login password.',
          })
        }
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
    prime: issueProc
      .input(z.object({ repoPath: z.string().optional() }).optional())
      .query(({ ctx, input }) =>
        ctx.registry.issues.prime({
          repoPath: input?.repoPath,
          boundIssueId:
            ctx.capability.scope.kind === 'subtree' ? ctx.capability.scope.rootId : null,
        }),
      ),
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
          mutationId: z.string().max(128).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        ctx.registry.withMutation(input.mutationId, 'issues.create', () =>
          ctx.registry.issues.createAndMaybeStart(input),
        ),
      ),
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
          mutationId: z.string().max(128).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        ctx.registry.withMutation(input.mutationId, 'issues.update', () =>
          ctx.registry.issues.update(input.id, input.patch),
        ),
      ),
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
      .input(
        z.object({
          id: z.string(),
          author: z.string(),
          body: z.string().min(1),
          mutationId: z.string().max(128).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        ctx.registry.withMutation(input.mutationId, 'issues.addComment', () =>
          ctx.registry.issues.addComment(input.id, input.author, input.body),
        ),
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
    setNeedsHuman: issueProc
      .input(z.object({ id: z.string(), question: z.string().optional() }))
      .mutation(({ ctx, input }) =>
        ctx.registry.issues.setNeedsHuman(input.id, input.question ?? null),
      ),
    clearNeedsHuman: issueProc
      .input(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.clearNeedsHuman(input.id)),
    reparent: issueProc
      .input(z.object({ id: z.string(), parentId: z.string().nullable() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.reparent(input.id, input.parentId)),
    claim: issueProc
      .input(z.object({ id: z.string(), assignee: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.claim(input.id, input.assignee)),
    close: issueProc
      .input(
        z.object({
          id: z.string(),
          reason: z.string().optional(),
          mutationId: z.string().max(128).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        ctx.registry.withMutation(input.mutationId, 'issues.close', () =>
          ctx.registry.issues.close(input.id, input.reason),
        ),
      ),
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
