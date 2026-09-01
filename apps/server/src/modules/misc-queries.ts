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

import { createLogger } from '@podium/logger'
import {
  AutomationIdField,
  asThreadId,
  asUserId,
  IssueIdField,
  type MachineId,
  MachineIdField,
  ThreadIdField,
} from '@podium/model'
import { loadConfig } from '@podium/runtime/config'
import { z } from 'zod'
import { getFeatureStates } from '../features'
import { CostService } from './cost/service'
import type { FamilyState } from './derived-family'
import { assertAllowedRoot } from './files/registry'
import { defineQuery } from './query-table'
import { QUOTA_HISTORY_DEFAULT_DAYS, recordQuotaSamples } from './quota-history/service'
import { specsInputs } from './specs/service'

const log = createLogger('cost')

/** The usage harvest's window — the daemon's own default, restated because the
 *  cost fold must record which window its per-file totals were taken over. */
const USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const q = defineQuery<FamilyState>()
const noInput = z.object({}).passthrough().optional()

/** The file family's state shape, built from the bundle so `git` runs the
 *  IDENTICAL allowlist rather than a second copy of it. */
const fileState = (s: FamilyState) => ({
  rpc: s.modules.rpc,
  artifacts: s.modules.issueArtifacts,
  repos: s.repos,
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
    (s, input) => s.modules.memory.search({ kind: 'user', id: asUserId(s.caller.userId) }, input),
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
    (s, input) => {
      assertAllowedRoot(fileState(s), input.root)
      const args: Record<string, string> = {}
      if (needs.includes('path')) args.path = input.path as string
      if (needs.includes('sha')) args.sha = input.sha as string
      return s.modules.rpc.repoOp(
        op,
        input.root,
        needs.length > 0 ? args : undefined,
        input.machineId,
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
   *  ALSO WRITES (POD-1858), on the same terms `quota.summary` below sets out:
   *  the daemon returns the per-FILE half of the walk it just did, and it is
   *  folded into the per-task cost rows on the way out. No caller input reaches
   *  the fold and no second scan happens — attributing the walk that ALREADY
   *  runs is the whole architecture of the cost read path, because a second walk
   *  of the same 4GB would land on the daemon loop that carries PTY traffic.
   *
   *  `sources` is STRIPPED before the payload is returned: it is an order of
   *  magnitude larger than the buckets and no client reads it. Best-effort — a
   *  failed fold never fails the usage read. */
  summary: q(noInput, async (s) => {
    // The daemon's own default window, restated here because the fold has to
    // record WHICH window its per-file totals cover — see `window_since_ms`.
    const sinceMs = Date.now() - USAGE_WINDOW_MS
    const { sources, sourcesSinceMs, ...usage } = await s.modules.rpc.usage(sinceMs, true)
    if (sources && sources.length > 0) {
      try {
        // The MEMO's window, not ours. The daemon may serve a fold it computed
        // against an older `sinceMs`; stamping it with the newer one re-dates
        // last window's numbers as current and keeps a transcript that has
        // since fallen out of the window contributing to "attributed".
        const foldSinceMs = sourcesSinceMs ?? sinceMs
        new CostService(s.store).ingest(s.modules.rpc.answeringMachineId(), sources, foldSinceMs)
      } catch (err) {
        log.warn('cost fold failed — usage buckets unaffected', { err })
      }
    }
    return usage
  }),
} as const

// ---------------------------------------------------------------------------
// cost — what a task cost (POD-1858)
// ---------------------------------------------------------------------------

export const COST_QUERIES = {
  /** One task's accounting: own cost, rollup over ALL descendants, descendant
   *  count, the per-session breakdown, and which of the four states it is in.
   *  Own and rollup are returned separately because the UI draws a labelled
   *  split and cannot derive one from the other.
   *
   *  TOKENS, NEVER DOLLARS — the one price table lives in client-core and the
   *  server does not import it. A pure DB read: it opens no transcript, so a
   *  panel can call it on first paint. */
  task: q(z.object({ issueId: IssueIdField }), (s, input) =>
    new CostService(s.store).task(input.issueId),
  ),
  /** Every task with a stored figure — the sheet's ranked table, and the cohort
   *  the "×median" rate is computed against. OWN cost per task, not rolled up:
   *  a rolled-up parent beside its own children counts the same money twice
   *  down one column. */
  tasks: q(noInput, (s) => new CostService(s.store).tasks()),
} as const

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
    recordQuotaSamples(s.store.quotaHistory, machines)
    return machines
  }),
  /** The window ledger: one entry per run of a plan window, oldest first, over
   *  the requested lookback. `peakPercent` is what a window came to before it
   *  reset — the whole point of the series. See `viewmodels/quota-history`. */
  history: q(
    z.object({ days: z.number().int().positive().max(365).optional() }).optional(),
    (s, input) => {
      const days = input?.days ?? QUOTA_HISTORY_DEFAULT_DAYS
      const now = Date.now()
      return s.store.quotaHistory.list(now - days * 24 * 60 * 60 * 1000, now)
    },
  ),
} as const

export const FEATURE_QUERIES = {
  /** Experimental feature flags [spec:SP-f4b9] — same auth as settings.get. */
  state: q(noInput, (s) => getFeatureStates(s.modules.settings.getSettings(), loadConfig())),
} as const

// ---------------------------------------------------------------------------
// The reads of families whose WRITES another issue already derived
// ---------------------------------------------------------------------------

/** POD-383 derived the seven superagent writes; these two reads stayed
 *  hand-written because a read writes nothing. */
export const SUPERAGENT_QUERIES = {
  /** The global orchestrator thread plus per-session 'btw' threads. */
  listThreads: q(noInput, (s) => s.superagent.listThreads(asUserId(s.caller.userId))),
  history: q(z.object({ threadId: ThreadIdField.default(asThreadId('global')) }), (s, input) =>
    s.superagent.history(asUserId(s.caller.userId), input.threadId),
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
   * THE SETTINGS AS THIS CALLER SEES THEM (POD-1213).
   *
   * `getSettingsFor(caller)`, never `getSettings()`. Until this issue the read
   * served the whole instance blob — so one person's roles, sidebar order,
   * autoContinue dismissal, ntfy topic and Telegram chat id were served to every
   * other authenticated client, which is the cross-user leak POD-352's exit audit
   * names. The caller's identity is already on `FamilyState` for exactly this
   * class of read.
   */
  get: q(noInput, (s) => s.modules.settings.getSettingsFor(asUserId(s.caller.userId))),
} as const

/** POD-735 derived the four automation writes; these two reads stayed
 *  hand-written for the same reason. */
export const AUTOMATION_QUERIES = {
  list: q(noInput, (s) => s.modules.automations.listForUser(asUserId(s.caller.userId))),
  runs: q(
    z.object({
      automationId: z.string().min(1).pipe(AutomationIdField),
      limit: z.number().int().optional(),
    }),
    (s, input) =>
      s.modules.automations.runsForUser(asUserId(s.caller.userId), input.automationId, input.limit),
  ),
} as const
