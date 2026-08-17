/**
 * Structural client API seam (arch-v2 P3, issue #192): the slice of the
 * server's tRPC router that the SHARED store/actions layer calls. Hand-written
 * — packages must never import apps (boundary rule 4), so client-core cannot
 * see the server's AppRouter type even type-only. Instead each app hands its
 * own typed client in:
 *
 *  - apps/web passes its AppRouter-typed tRPC client (assignability to this
 *    interface is checked by web's tsc, so drift fails the web typecheck);
 *  - apps/mobile's hand-written MobileTrpc intersects this interface with its
 *    mobile-only extras.
 *
 * The store is generic over `TApi extends PodiumClientApi`, so an app keeps
 * its own richer procedure types on `store.trpc` while the shared code only
 * relies on what's declared here. Outputs are typed only where the shared
 * store reads them; inputs match exactly what it sends.
 */

import type { IssueUpdatePatch, SuperagentUserFocus } from '@podium/commands'
import type {
  AgentKind,
  ArtifactId,
  GitDiscoveryDiagnosticWire,
  GitRepositoryWire,
  HarnessAgent,
  IssueId,
  LayoutSnapshot,
  MachineId,
  MachineQuotaWire,
  MutationId,
  ReadPositionSnapshot,
  SessionId,
  ThreadId,
  UsageBucketWire,
  WorkState,
} from '@podium/model'
import type { LockWire, SyncChangesSinceResult } from '@podium/protocol'
import type { PodiumSettings } from '@podium/runtime'
import type { SuperThreadView } from './viewmodels/slices/superagent'
import type { PinKind, PinState } from './viewmodels/types'

export interface ApiQuery<I, O> {
  query(input: I): Promise<O>
}

export interface ApiMutation<I, O = unknown> {
  mutate(input: I): Promise<O>
}

/** Outboxed mutations replay with a stable id so the server dedupes. */
type WithMutationId<T> = T & { mutationId?: MutationId }

/**
 * THE ID MEMBERS BELOW ARE BRANDED, AND THE PAIR MOVED TOGETHER (POD-1192).
 *
 * This interface is a hand-written MIRROR of the real tRPC router, and
 * `apps/web/src/app/store.tsx` constrains the LIVE `TRPCClient` to it — so the
 * real router must structurally satisfy it. That is why branding either half
 * alone is a compile break rather than an improvement: POD-363 measured exactly
 * that, branding this side while the server's inputs were bare `z.string()` and
 * getting TS2344/TS2322 at four `store.tsx` sites.
 *
 * The server half is branded with the shared brand-only `…Field` schemas —
 * `SessionIdField`/`IssueIdField`/`ArtifactIdField`, never the `.min(1)`
 * boundary schemas, because at least one producer sends an empty string
 * (POD-361's rule, pinned in `packages/model/src/ids/brands.test.ts`). The
 * schemas live in `packages/commands` (`sessions/command-plane.ts`,
 * `sessions/session-state-commands.ts`, `files/contracts.ts`) and
 * `apps/server/src/modules/files/queries.ts`; branding this mirror to match is
 * what makes the drift visible to web's tsc again.
 *
 * The mirror stays hand-written rather than derived from the router's inferred
 * types: boundary rule 4 forbids a package importing an app, so client-core
 * cannot see `AppRouter` even type-only (see the header comment).
 *
 * `machineId` STAYS `string`, and POD-1361 measured why it may. That sweep bound
 * every machine-id field in the server's command and query schemas to
 * `MachineIdField` and did NOT have to touch this file, because a tRPC
 * procedure's argument type is `z.input` of its schema (`derived-family.ts`:
 * `input: z.input<Q[N]['input']>`) while a zod brand lives on the OUTPUT side —
 * `z.input<typeof MachineIdField>` is a bare `string` however branded the field
 * is. So branding a server input narrows what a HANDLER receives, never what a
 * caller may pass, and the members here are free to move on their own schedule.
 *
 * The direction that DOES break this constraint is a server input whose declared
 * type makes input and output the same branded thing — a `z.ZodType<T>` cast
 * spelled with one parameter. `apps/server/src/modules/misc-queries.ts` carries
 * the note; the fix is the three-parameter form, whose third parameter is the
 * caller-facing input type this mirror must match.
 */
export interface PodiumClientApi {
  sync: {
    changesSince: ApiQuery<{ cursor: number | null }, SyncChangesSinceResult>
  }
  /**
   * Advisory named locks are deliberately queried rather than replicated: the
   * read performs the authority's lazy-expiry sweep and returns FIFO order.
   */
  lock: {
    status: ApiQuery<{ repoPath: string; name?: string }, LockWire[]>
  }
  discovery: {
    refreshRepos: ApiMutation<
      void,
      { repositories: GitRepositoryWire[]; diagnostics: GitDiscoveryDiagnosticWire[] }
    >
  }
  sessions: {
    create: ApiMutation<
      {
        sessionId?: SessionId
        agentKind?: AgentKind
        cwd: string
        title?: string
        issueId?: IssueId
        draftIssue?: { repoPath: string; issueId?: IssueId }
        machineId?: MachineId
        /** First prompt; argv harnesses get it on launch (POD-549). */
        initialPrompt?: string
        /** Per-spawn model/effort overrides. `'auto'` is omitted by callers. */
        model?: string
        effort?: string
        mutationId?: MutationId
      },
      { sessionId: SessionId }
    >
    resumeAndSend: ApiMutation<WithMutationId<{ sessionId: SessionId; text: string }>>
    rename: ApiMutation<WithMutationId<{ sessionId: SessionId; name: string }>>
    setArchived: ApiMutation<WithMutationId<{ sessionId: SessionId; archived: boolean }>>
    setWorkState: ApiMutation<WithMutationId<{ sessionId: SessionId; workState: WorkState | null }>>
    markRead: ApiMutation<WithMutationId<{ sessionId: SessionId }>>
    markUnread: ApiMutation<WithMutationId<{ sessionId: SessionId }>>
    /** Decline one named offer [spec:SP-c7f1]. `offerCreatedAt` is the guard, not
     *  a courtesy: it names the offer the user was looking at, so a replacement
     *  posted between render and press survives instead of being swallowed. */
    dismissOffer: ApiMutation<WithMutationId<{ sessionId: SessionId; offerCreatedAt: string }>>
    kill: ApiMutation<{ sessionId: SessionId }>
    continue: ApiMutation<{ sessionId: SessionId }>
    hibernate: ApiMutation<{ sessionId: SessionId }>
    /** Clean end [spec:SP-9904] — stop the process, free the issue worktree,
     *  keep branch + transcript + row. REFUSES rather than throws (POD-379), so
     *  `ok: false` carries a reason an unsaved tree can be forced past. Present
     *  on the command plane since POD-382; POD-1077 gave it a client caller. */
    stop: ApiMutation<
      { sessionId: SessionId; force?: boolean },
      { ok: boolean; reason?: string; worktreeFreed?: boolean; deferredKill?: boolean }
    >
    resurrect: ApiMutation<{ sessionId: SessionId }, { ok: boolean; reason?: string }>
  }
  snoozes: {
    set: ApiMutation<WithMutationId<{ sessionId: SessionId; until: string | null }>>
    clear: ApiMutation<WithMutationId<{ sessionId: SessionId }>>
  }
  issues: {
    markRead: ApiMutation<WithMutationId<{ id: string }>>
    markUnread: ApiMutation<WithMutationId<{ id: string }>>
    /** Tuck-away dismissal (POD-333) — server-side, global, outboxed. */
    setTucked: ApiMutation<WithMutationId<{ id: string; tucked: boolean }>>
    /**
     * THE CURATION WRITES, outboxed since POD-781 — the sidebar's rename,
     * dismiss and delete no longer wait on a round trip.
     *
     * `patch` is `IssueUpdatePatch`, imported as a TYPE from `@podium/commands`
     * and inferred from the contract's own zod schema. Type-only, so nothing of
     * the command registry reaches the browser bundle (`audit:browser-reach`),
     * and a key added to the contract is queueable the same day rather than
     * after someone remembers to copy it here.
     */
    update: ApiMutation<WithMutationId<{ id: string; patch: IssueUpdatePatch }>>
    archive: ApiMutation<WithMutationId<{ id: string }>>
    delete: ApiMutation<WithMutationId<{ id: string }>>
    /**
     * THE FOUR CURATION COMMANDS THAT ARE NOT `issues.update` (POD-781 group 2).
     *
     * Each is here because it is its own contract, not because it writes its own
     * field: `close` stamps a reason AND settles the stage (and emits
     * `issue.closed` with the acting session), `undefer` backdates rather than
     * clearing, and `setLabels` rewrites a whole set under `manage` authority.
     * Routing any of them through `update` would re-author the write under a
     * contract the server gates differently.
     */
    close: ApiMutation<WithMutationId<{ id: string; reason?: string }>>
    defer: ApiMutation<WithMutationId<{ id: string; until: string | null }>>
    undefer: ApiMutation<WithMutationId<{ id: string }>>
    setLabels: ApiMutation<WithMutationId<{ id: string; labels: string[] }>>
    /**
     * THE LAST TWO (POD-781 group 3), and neither is expressible as a patch.
     * `setPlacement` writes an ordered PAIR — the provenance edge and the parent
     * link — and `restore` un-tombstones the issue together with the sessions its
     * delete took, in one ledger transaction.
     */
    setPlacement: ApiMutation<
      WithMutationId<{ id: string; placement: 'own' | 'mission'; originId: string }>
    >
    restore: ApiMutation<WithMutationId<{ id: string }>>
  }
  pins: {
    list: ApiQuery<void, PinState>
    set: ApiMutation<WithMutationId<{ kind: PinKind; id: string; pinned: boolean }>, PinState>
  }
  tabs: {
    listOrders: ApiQuery<void, Record<string, string[]>>
    setOrder: ApiMutation<
      WithMutationId<{ worktree: string; sessionIds: SessionId[] }>,
      Record<string, string[]>
    >
  }
  /** Per-user event-stream read positions (POD-1380). `advance` is monotonic —
   *  the server clamps to max(stored, proposed) — and returns the caller's whole
   *  snapshot, never anyone else's. */
  readPosition: {
    get: ApiQuery<void, ReadPositionSnapshot>
    advance: ApiMutation<
      WithMutationId<{ streamId: string; lastEventId: number; seenAt?: string | null }>,
      ReadPositionSnapshot
    >
  }
  layout: {
    get: ApiQuery<void, LayoutSnapshot>
    set: ApiMutation<WithMutationId<{ values: Record<string, unknown> }>, LayoutSnapshot>
    clear: ApiMutation<WithMutationId<{ keys: string[] }>, LayoutSnapshot>
  }
  /**
   * `read` and `write` mirror the server's inputs as UNIONS, not as one flat
   * object with everything optional, because that is what the router declares
   * (`FILE_QUERIES.read`, `filesWriteInput`) — and it is the shape `FileScope`
   * already branches on. A flat optional object only ever passed by accident:
   * `query`/`mutate` are METHODS, so their parameters check bivariantly, and the
   * flat form satisfied that check in the router→mirror direction only while the
   * ids were plain `string`. Branding removes that escape hatch (`string` is not
   * assignable to `SessionId`) and the mirror→router direction then fails on
   * `root: string | undefined`. Mirroring the union makes the shapes align in
   * both directions, so the seam no longer depends on bivariance to hold.
   *
   * `machineId` stays plain `string` here (POD-318 carve-out) even though the
   * server binds `MachineIdField` — the router→mirror direction still holds.
   */
  files: {
    read: ApiQuery<
      | { sessionId: SessionId; path: string }
      // Artifact-snapshot reads ([spec:SP-0fc9] #441).
      | { issueId: IssueId; artifactId: ArtifactId; path: string }
      | { machineId?: MachineId; root: string; path: string },
      unknown
    >
    write: ApiMutation<
      | { sessionId: SessionId; path: string; content: string; baseHash?: string }
      | { machineId?: MachineId; root: string; path: string; content: string; baseHash?: string }
    >
    list: ApiQuery<{ machineId?: MachineId; root: string; path?: string }, unknown>
  }
  /** Git dock panel [POD-114] — raw output of fixed read-only repo ops. */
  git: {
    status: ApiQuery<{ machineId?: MachineId; root: string }, { ok: boolean; output: string }>
    log: ApiQuery<{ machineId?: MachineId; root: string }, { ok: boolean; output: string }>
    diffFile: ApiQuery<
      { machineId?: MachineId; root: string; path: string },
      { ok: boolean; output: string }
    >
  }
  settings: {
    get: ApiQuery<void, PodiumSettings>
    updatePersonal: ApiMutation<WithMutationId<{ values: Record<string, unknown> }>, PodiumSettings>
  }
  /** Hour×model token buckets for the last 7 days, harvested from harness
   *  transcripts. All window/cost math is client-side — see `viewmodels/usage`. */
  usage: {
    summary: ApiQuery<void, { hostname: string; buckets: UsageBucketWire[] }>
  }
  /** Plan rate-limit windows, read live from each agent's own quota endpoint,
   *  one entry per online machine. Distinct from `usage`, which is harvested
   *  token-cost analytics — see `viewmodels/quota`. */
  quota: {
    summary: ApiQuery<void, MachineQuotaWire[]>
  }
  superagent: {
    /** The signed-in principal's own threads. The authority scopes this to the
     *  caller (doc §3.1.6 S2: superagent state is per-user and private), so the
     *  client never asks for "a user's" threads — only for its own. */
    listThreads: ApiQuery<void, SuperThreadView[]>
    /** `superagent.startBtw` is NOT declared here. The server still serves it —
     *  it mints a `btw_<sessionId>` thread, which MCP and the CLI can still use
     *  — but no client calls it since POD-1069 folded "Ask superagent (BTW)"
     *  into `sendTurn`'s `attachSessionId`. A binding for a procedure nothing
     *  sends is a live-looking path back to the thread the web cannot render. */
    sendTurn: ApiMutation<
      {
        threadId?: ThreadId
        text: string
        focus?: SuperagentUserFocus
        /** "Ask superagent (BTW)" (POD-1069): one session's transcript digested
         *  onto THIS turn. One-shot — the server stores nothing. */
        attachSessionId?: SessionId
        /** Prompt-box backend (POD-782). Omitted leaves the thread's choice. */
        model?: string
        effort?: string
        /** `HarnessAgent`, NOT `AgentKind` — a turn runs a HARNESS, so `'shell'`
         *  is deliberately absent (see `AgentKind` vs `BuiltinHarnessKind` in
         *  @podium/model: a shell is spawnable but is not a harness — no
         *  transcript, no resume, no observer). `sessions.create` above rightly
         *  takes the wider `AgentKind` because spawning a shell IS a real thing;
         *  sending it a turn is not, and the server's contract rejects it. This
         *  mirror said `AgentKind` and so promised a call the server would refuse
         *  at runtime, which is what made `TRPCClient` fail to satisfy
         *  `PodiumClientApi` and left apps/web red for the whole epic (POD-2109). */
        agentKind?: HarnessAgent
      },
      { threadId: ThreadId; podiumSessionId?: SessionId }
    >
    /** Mint the thread's headless session without running a turn (POD-782), so
     *  the pane can mount the ordinary chat before the first message. */
    ensureSession: ApiMutation<
      { threadId: ThreadId },
      { threadId: ThreadId; podiumSessionId?: SessionId }
    >
  }
}
