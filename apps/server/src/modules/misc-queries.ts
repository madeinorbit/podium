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

import { z } from 'zod'
import { getFeatureStates } from '../features'
import { loadConfig } from '@podium/runtime/config'
import { searchAll } from '../search'
import type { FamilyState } from './derived-family'
import { assertAllowedRoot } from './files/registry'
import { defineQuery } from './query-table'
import { specsInputs } from './specs/service'
import { AutomationIdField, ThreadIdField, asThreadId, asUserId } from '@podium/model'

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
    (s, input) =>
      searchAll(
        s.store,
        { listSessions: () => s.modules.sessions.listSessions(), issues: s.modules.issues },
        input,
      ),
  ),
} as const

// ---------------------------------------------------------------------------
// git — read-only checkout inspection for the web RightDock [POD-114]
// ---------------------------------------------------------------------------

/** Working-tree status, recent commits, one file's diff. Same repo-root
 *  allowlist gate as `files`; each query maps to a fixed lock-free daemon repo
 *  op (never a shell string). */
const repoOp = (op: 'statusProbe' | 'logPanel' | 'diffFile') =>
  q(
    z.object({
      machineId: z.string().optional(),
      root: z.string(),
      ...(op === 'diffFile' ? { path: z.string() } : {}),
    }) as z.ZodType<{ machineId?: string | undefined; root: string; path?: string }>,
    (s, input) => {
      assertAllowedRoot(fileState(s), input.root)
      return s.modules.rpc.repoOp(
        op,
        input.root,
        op === 'diffFile' ? { path: input.path as string } : undefined,
        input.machineId,
      )
    },
  )

export const GIT_QUERIES = {
  status: repoOp('statusProbe'),
  log: repoOp('logPanel'),
  diffFile: repoOp('diffFile'),
} as const

// ---------------------------------------------------------------------------
// usage · quota · features
// ---------------------------------------------------------------------------

export const USAGE_QUERIES = {
  /** Hour×model token buckets for the last 7 days, harvested from harness
   *  transcripts on the dev machine. Window math (5h/weekly/cost) is
   *  client-side. */
  summary: q(noInput, (s) => s.modules.rpc.usage()),
} as const

export const QUOTA_QUERIES = {
  /** Per-agent plan-quota (5h/weekly % used + reset times), read live on the
   *  daemon host from each agent's own usage endpoint. Fans out to every online
   *  machine (each runs its agents under its own account) — one entry per
   *  machine. Distinct from `usage`, which is transcript-harvested token-cost
   *  analytics. */
  summary: q(noInput, (s) => s.modules.rpc.agentQuotaAll()),
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
