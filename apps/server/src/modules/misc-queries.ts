/**
 * THE SMALL READ-ONLY SURFACES (POD-314) — `search`, `git`, `usage`, `quota`,
 * `features`, and the remaining reads of `superagent`, `specs`, `settings` and
 * `automations`.
 *
 * ONE FILE, and the grouping is by SHAPE rather than by feature: every table
 * below belongs to a router that serves reads only, or whose writes some other
 * issue already derived. None of them warranted a module directory of its own —
 * `usage` and `quota` are one procedure each — and scattering nine one-entry
 * files would have made the surface harder to read, not easier.
 *
 * NOT CONTRACTS. A `visibility` class describes what a command WRITES and these
 * write nothing. The family audits check procedure TYPE, so a write cannot join
 * them by being spelled as a query.
 *
 * THE `git` AND `files` SURFACES SHARE A GATE, deliberately: both run the repo
 * root allowlist, and `git` imports the same `assertAllowedRoot` the file family
 * declares rather than restating the check. Three procedures that each spelled
 * out `isAllowedRoot(...)` was the shape this replaces.
 */

import {
  AutomationIdField,
  asThreadId,
  asUserId,
  IssueIdField,
  type MachineId,
  MachineIdField,
  type SessionId,
  type TaskCostComparisonWire,
  ThreadIdField,
} from '@podium/model'
import { loadConfig } from '@podium/runtime/config'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { getFeatureStates } from '../features'
import { CostService } from './cost/service'
import type { FamilyState } from './derived-family'
import { assertReadableRoot } from './files/registry'
import { defineQuery } from './query-table'
import { QUOTA_HISTORY_DEFAULT_DAYS, recordQuotaSamples } from './quota-history/service'
import { specsInputs } from './specs/service'
import { readUsageSummary, UsageAttributionUnavailable } from './usage-summary'

const q = defineQuery<FamilyState>()
const noInput = z.object({}).passthrough().optional()

/** The file family's state shape, built from the bundle so `git` runs the
 *  IDENTICAL allowlist rather than a second copy of it. */
const fileState = (s: FamilyState) => ({
  rpc: s.modules.rpc,
  artifacts: s.modules.issueArtifacts,
  repos: s.repos,
  access: s.privateAccess,
})

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export const SEARCH_QUERIES = {
  /** Omni-search (docs/spec/search-v1.md §2.4): one ranked, typed result list
   *  across transcripts/issues/conversations/sessions/settings. Wire shape:
   *  SearchResultWire (@podium/protocol). */
  query: q(
    z.object({
      text: z.string().min(1).max(256),
      limit: z.number().int().positive().max(100).optional(),
    }),
    async (s, input) =>
      await s.modules.memory.search({ kind: 'user', id: asUserId(s.caller.userId) }, input),
  ),
} as const

// ---------------------------------------------------------------------------
// git — read-only checkout inspection for the web RightDock [POD-114]
// ---------------------------------------------------------------------------

/** Working-tree status, recent commits, one file's diff. Same repo-root
 *  allowlist gate as `files`; each query maps to a fixed lock-free daemon repo
 *  op (never a shell string). */
type GitPanelOp = 'statusProbe' | 'logPanel' | 'diffFile' | 'commitFiles' | 'commitDiffFile'

/** Which extra arguments each op forwards to the daemon — one table rather than
 *  a chain of per-op conditionals, so adding the commit ops [POD-1289] states
 *  what they need instead of restating the branching twice. */
const REPO_OP_ARGS: Record<GitPanelOp, ReadonlyArray<'path' | 'sha'>> = {
  statusProbe: [],
  logPanel: [],
  diffFile: ['path'],
  commitFiles: ['sha'],
  commitDiffFile: ['sha', 'path'],
}

const repoOp = (op: GitPanelOp) => {
  const needs = REPO_OP_ARGS[op]
  return q(
    z.object({
      machineId: MachineIdField.optional(),
      root: z.string(),
      ...(needs.includes('path') ? { path: z.string() } : {}),
      // A sha is an object name, never a user-typed ref: hex only, so nothing
      // that could parse as a git OPTION reaches the daemon's argv (which
      // guards it a second time — this is the outer of the two gates).
      ...(needs.includes('sha') ? { sha: z.string().regex(/^[0-9a-f]{7,40}$/) } : {}),
      // Five ops, one schema, so the shape is asserted rather than inferred. The
      // INPUT parameter is spelled out and stays a bare `string`: a zod brand is
      // an OUTPUT-side type, and tRPC types a procedure's argument as `z.input`.
      // Collapsing this to the one-parameter form would publish `MachineId` as
      // what a CALLER must pass, which no caller can construct — and `store.tsx`
      // says so, since apps/web constrains the live client to `PodiumClientApi`.
    }) as z.ZodType<
      { machineId?: MachineId | undefined; root: string; path?: string; sha?: string },
      z.ZodTypeDef,
      { machineId?: MachineId | undefined; root: string; path?: string; sha?: string }
    >,
    async (s, input) => {
      // A checkout is private to the people who may run on its machine (POD-6284).
      const machineId = input.machineId ?? (await s.modules.rpc.answeringMachineId(input.root))
      await assertReadableRoot(fileState(s), input.root, machineId)
      const args: Record<string, string> = {}
      if (needs.includes('path')) args.path = input.path as string
      if (needs.includes('sha')) args.sha = input.sha as string
      return await s.modules.rpc.repoOp(
        op,
        input.root,
        needs.length > 0 ? args : undefined,
        machineId,
      )
    },
  )
}

export const GIT_QUERIES = {
  status: repoOp('statusProbe'),
  log: repoOp('logPanel'),
  diffFile: repoOp('diffFile'),
  /** Unfolding a commit row [POD-1289]: its files, then one file's diff. */
  commitFiles: repoOp('commitFiles'),
  commitDiffFile: repoOp('commitDiffFile'),
} as const

// ---------------------------------------------------------------------------
// usage · quota · features
// ---------------------------------------------------------------------------

export const USAGE_QUERIES = {
  /** Hour×model token buckets for the last 7 days, harvested from harness
   *  transcripts on the dev machine. Window math (5h/weekly/cost) is
   *  client-side.
   *
   *  Also folds per-task cost on the way out; see `usage-summary.ts`. Clients
   *  with topics get the same answer pushed on `account.quota` (POD-5798). */
  summary: q(noInput, async (s) => {
    try {
      return await readUsageSummary({
        rpc: s.modules.rpc,
        store: s.store,
        privateAccess: s.privateAccess,
        userId: s.caller.userId,
      })
    } catch (err) {
      if (err instanceof UsageAttributionUnavailable) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message })
      }
      throw err
    }
  }),
} as const

// ---------------------------------------------------------------------------
// cost — what a task cost (POD-1858)
// ---------------------------------------------------------------------------

/** A task's cost breakdown names each session that spent: the caller is shown
 *  only its OWN sessions' lines (POD-6284). The task's totals are the task's. */
async function ownSessionCostsOnly<T extends { sessions: Array<{ sessionId: SessionId | null }> }>(
  s: FamilyState,
  task: T,
): Promise<T> {
  const own = await Promise.all(
    task.sessions.map(
      async (line) =>
        line.sessionId !== null && (await s.privateAccess.ownsSession(line.sessionId)),
    ),
  )
  return { ...task, sessions: task.sessions.filter((_, index) => own[index] === true) }
}

export const COST_QUERIES = {
  /** One task's accounting: own cost, rollup over ALL descendants, descendant
   *  count, the per-session breakdown, and which of the four states it is in.
   *  Own and rollup are returned separately because the UI draws a labelled
   *  split and cannot derive one from the other.
   *
   *  Tokens are priced through the shared model/cost-pricing table. A pure DB read: it opens no transcript, so a
   *  panel can call it on first paint. */
  task: q(
    z.object({ issueId: IssueIdField }),
    async (s, input) =>
      await ownSessionCostsOnly(s, await new CostService(s.store).task(input.issueId)),
  ),
  /** One task total plus its all-time own-cost comparison, on request. */
  taskComparison: q(
    z.object({
      issueId: IssueIdField,
      includeSessions: z.boolean().optional(),
    }),
    async (s, input): Promise<TaskCostComparisonWire> => {
      const comparison = await new CostService(s.store).taskComparison(
        input.issueId,
        input.includeSessions,
      )
      return { ...comparison, task: await ownSessionCostsOnly(s, comparison.task) }
    },
  ),
  /** Every task with a stored figure — the sheet's ranked table, and the cohort
   *  the "×median" rate is computed against. OWN cost per task, not rolled up:
   *  a rolled-up parent beside its own children counts the same money twice
   *  down one column. */
  tasks: q(noInput, async (s) => await new CostService(s.store).tasks()),
} as const

/** The machines the caller looks after: their native logins are the caller's. */
async function custodyMachines(s: FamilyState): Promise<ReadonlySet<MachineId>> {
  const standing = await s.privateAccess.machineStanding()
  return new Set([...standing].filter(([, kind]) => kind === 'custody').map(([id]) => id))
}

export const QUOTA_QUERIES = {
  /** Per-agent plan-quota (5h/weekly % used + reset times), read live on the
   *  daemon host from each agent's own usage endpoint. Fans out to every online
   *  machine (each runs its agents under its own account) — one entry per
   *  machine. Distinct from `usage`, which is transcript-harvested token-cost
   *  analytics.
   *
   *  ALSO WRITES (POD-1571), and deliberately: every reading served here is
   *  folded into the window ledger on the way out, so an open tab adds
   *  resolution the 15-minute sampler alone would miss. It stays a `query`
   *  because the write is a fold of what was just read — no caller input reaches
   *  it, nothing is created, and the same fold runs whether or not anyone asks.
   *  Best-effort: a failed fold never fails the read. */
  summary: q(noInput, async (s) => {
    const machines = await s.modules.rpc.agentQuotaAll()
    await recordQuotaSamples(
      s.store.quotaHistory,
      machines,
      undefined,
      async (machineId) => await s.store.machines.custodian(machineId),
    )
    // A machine's plan quota is the quota of its native logins, and those
    // belong to the person who looks after the machine (POD-6300; design
    // §4.6). Every reading is folded into the ledger above, but the caller is
    // shown only the machines in its own custody: a `use` grant on someone
    // else's machine does not make that person's plan the caller's.
    const custody = await custodyMachines(s)
    return machines.filter((machine) => custody.has(machine.machineId))
  }),
  /** The window ledger: one entry per run of a plan window, oldest first, over
   *  the requested lookback. `peakPercent` is what a window came to before it
   *  reset — the whole point of the series. See `viewmodels/quota-history`. */
  history: q(
    z.object({ days: z.number().int().positive().max(365).optional() }).optional(),
    async (s, input) => {
      const days = input?.days ?? QUOTA_HISTORY_DEFAULT_DAYS
      const now = Date.now()
      // A window ledger row is keyed by the provider account, not by machine
      // (POD-6284's seam), so it records its owner when it opens: the custodian
      // of the machine that reported it (POD-6300). It stays theirs after the
      // login or the machine is gone, and nobody else's.
      return await s.store.quotaHistory.listFor(
        asUserId(s.caller.userId),
        now - days * 24 * 60 * 60 * 1000,
        now,
      )
    },
  ),
} as const

export const FEATURE_QUERIES = {
  /** Experimental feature flags [spec:SP-f4b9] — same auth as settings.get. */
  state: q(noInput, async (s) =>
    getFeatureStates(await s.modules.settings.getSettings(), loadConfig()),
  ),
} as const

// ---------------------------------------------------------------------------
// The reads of families whose WRITES another issue already derived
// ---------------------------------------------------------------------------

/** POD-383 derived the seven superagent writes; these reads stayed
 *  hand-written because a read writes nothing. */
export const SUPERAGENT_QUERIES = {
  /** The global orchestrator thread plus per-session 'btw' threads. */
  listThreads: q(noInput, async (s) => await s.superagent.listThreads(asUserId(s.caller.userId))),
  history: q(
    z.object({ threadId: ThreadIdField.default(asThreadId('global')) }),
    async (s, input) => await s.superagent.history(asUserId(s.caller.userId), input.threadId),
  ),
  /** The thread's most recent durable turn failure for post-reload restoration
   *  (POD-4806): a typed `{inputId, userText, error, at}` or null — selected
   *  server-side by column, so clients never match prose to find it. */
  latestTurnFailure: q(
    z.object({ threadId: ThreadIdField.default(asThreadId('global')) }),
    async (s, input) =>
      await s.superagent.latestTurnFailure(asUserId(s.caller.userId), input.threadId),
  ),
} as const

/** POD-386 derived `create · save · remove`; these three reads carry no contract
 *  and are authorized by the identical `requireRepoRoot` call inside the
 *  service. */
export const SPEC_QUERIES = {
  list: q(specsInputs.list, (s, input) => s.modules.specs.list(input)),
  get: q(specsInputs.get, (s, input) => s.modules.specs.get(input)),
  search: q(specsInputs.search, (s, input) => s.modules.specs.search(input)),
} as const

/** POD-420 derived the four settings writes. `get` is a READ, and what it
 *  RETURNS changes shape under POD-419 and POD-421 — which is the other reason
 *  it carries no contract. */
export const SETTINGS_QUERIES = {
  /**
   * THE INSTANCE SETTINGS (POD-6673). A caller's personal preferences are their
   * synced `userPreferences` record, so this read answers the instance tier only:
   * every personal leaf here is its default, never anybody's choice. POD-6677
   * makes the instance tier a synced record too.
   */
  get: q(noInput, async (s) => await s.modules.settings.getSettings()),
} as const

/** POD-735 derived the four automation writes; these two reads stayed
 *  hand-written for the same reason. */
export const AUTOMATION_QUERIES = {
  list: q(noInput, async (s) => await s.modules.automations.listForUser(asUserId(s.caller.userId))),
  runs: q(
    z.object({
      automationId: z.string().min(1).pipe(AutomationIdField),
      limit: z.number().int().optional(),
    }),
    async (s, input) =>
      await s.modules.automations.runsForUser(
        asUserId(s.caller.userId),
        input.automationId,
        input.limit,
      ),
  ),
} as const
