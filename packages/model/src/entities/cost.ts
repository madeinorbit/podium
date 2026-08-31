/**
 * WHAT A TASK COST — the read path's wire shapes and the rules that decide what
 * a figure MEANS before anyone renders it (POD-1858, foundation of POD-1604).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO DOLLARS CROSS THIS BOUNDARY, AND THAT IS THE DESIGN
 * ─────────────────────────────────────────────────────────────────────────────
 * Every figure here is TOKENS. The one price table lives in
 * `client-core/viewmodels/usage.ts` and its header records why there must never
 * be a second copy: two tables quote two dollar figures for the same tokens the
 * first time a model id lands on a different row. The server has no dependency
 * on client-core and must not grow one, so it ships token totals and the client
 * prices them — exactly what the usage sheet already does with hour×model
 * buckets ("Window math (5h/weekly/cost) is client-side").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE STATES ARE THE POINT
 * ─────────────────────────────────────────────────────────────────────────────
 * A cost read has four outcomes and only one of them is a number. Collapsing the
 * other three to `0` is the failure this type exists to prevent: POD-1608 is the
 * live case — 126 files changed and a truthful zero, because the agent that did
 * the work was bound to another issue. A confident `$0.00` there would be a lie
 * about the work, not a fact about the money.
 *
 *   `costed`        at least one transcript was read and priced.
 *   `no-sessions`   no session ever ran on this task. Renders "No sessions".
 *   `not-recorded`  sessions ran; no transcript survives for any of them.
 *                   A DIFFERENT FACT FROM ZERO, and a common one.
 *   `pending`       transcripts exist and the walk has not reached them yet.
 *                   The cold state the layout draws Unfilled slots for; it is
 *                   never a zero and never a claim about the money.
 *
 * `provisional` and `floor` are orthogonal MARKS on a `costed` figure, not
 * states: a running task's figure is real and still moving, and a Codex figure
 * is real and a lower bound.
 */

import { z } from 'zod'
import { IssueIdField, MachineIdField, SessionIdField } from '../ids/brands'

/** Which harness wrote a transcript. Same three the usage scan knows. */
export const CostHarness = z.enum(['claude-code', 'codex', 'grok'])
export type CostHarness = z.infer<typeof CostHarness>

/** Token totals for one model, the unit every figure below is built from. */
export const CostModelTotalWire = z.object({
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  cacheCreation1hTokens: z.number().int().nonnegative(),
  /** Replies — the denominator of the rate, so it travels with the tokens. */
  messages: z.number().int().nonnegative(),
})
export type CostModelTotalWire = z.infer<typeof CostModelTotalWire>

export const TaskCostState = z.enum(['costed', 'no-sessions', 'not-recorded', 'pending'])
export type TaskCostState = z.infer<typeof TaskCostState>

/**
 * HOW COMPLETE THE ATTRIBUTION IS, keyed off HARNESS and nothing else.
 *
 * Measured on this machine: every Claude transcript that carries usage has a
 * conversation-segment row, including the `subagents/` files a session's
 * delegates write — so a task whose sessions are all Claude is fully counted and
 * prints a plain figure. Codex rollouts are not all linked (a `guardian`
 * subagent rollout has no Podium session at all), so any Codex participation
 * makes the figure a LOWER BOUND.
 *
 * Keyed off harness rather than a per-task gap check on purpose: a per-task
 * check can only see what it found, so a task whose every Codex rollout went
 * unlinked would look complete precisely when it is most wrong.
 *
 * TWO FIELDS, NOT A THREE-ARMED ENUM. `floor` is the mark — is this figure a
 * lower bound — and `harnesses` is what the reader needs to say WHY ("all
 * Codex", "Claude + Codex"). Folding both into one enum meant inventing an arm
 * for every future harness and pretending Grok is Codex, which the label on
 * screen would have printed as a fact.
 */
export const CostFloor = z.enum(['none', 'partial'])
export type CostFloor = z.infer<typeof CostFloor>

/** One transcript's contribution, as the task-detail disclosure lists it. */
export const SessionCostWire = z.object({
  sessionId: SessionIdField.nullable(),
  /** The session's title at read time; null for a transcript with no session. */
  title: z.string().nullable(),
  harness: CostHarness,
  /** The session is live/starting — its figure is still moving. */
  running: z.boolean(),
  models: z.array(CostModelTotalWire),
  firstTsMs: z.number().int().nonnegative(),
  lastTsMs: z.number().int().nonnegative(),
})
export type SessionCostWire = z.infer<typeof SessionCostWire>

/** One side of the rollup split: a task's own cost, or its descendants'. */
export const CostTotalsWire = z.object({
  models: z.array(CostModelTotalWire),
  messages: z.number().int().nonnegative(),
  /** Distinct sessions behind the figure — the "over 10" in the section meta. */
  sessionCount: z.number().int().nonnegative(),
})
export type CostTotalsWire = z.infer<typeof CostTotalsWire>

export const TaskCostWire = z.object({
  issueId: IssueIdField,
  state: TaskCostState,
  /**
   * OWN AND ROLLUP ARE RETURNED SEPARATELY AND NEITHER IS DERIVABLE FROM THE
   * OTHER. The UI draws a two-segment bar labelled with both figures, and the
   * three real shapes on this machine are different objects: a task with no
   * children (no split drawn at all), a task that outspent all 32 of its
   * children, and a task with no sessions of its own whose whole figure is its
   * 33 descendants'. Sending only the total would render that last one free.
   */
  own: CostTotalsWire,
  rollup: CostTotalsWire,
  /** Descendants at any depth, whether or not they cost anything. */
  descendantCount: z.number().int().nonnegative(),
  /** Any session under the rollup is still running. */
  provisional: z.boolean(),
  floor: CostFloor,
  /** Which harnesses the rolled-up figure was read from, alphabetical. What the
   *  floor mark is explained WITH: "≥ floor · all Codex". */
  harnesses: z.array(CostHarness),
  /** Own sessions, dearest first. Descendants are not listed here. */
  sessions: z.array(SessionCostWire),
})
export type TaskCostWire = z.infer<typeof TaskCostWire>

/**
 * One task's aggregate, for the sheet's ranked table and for the rate cohort.
 * Deliberately not the full `TaskCostWire`: the sheet ranks 226 tasks and does
 * not want 226 session lists.
 */
export const TaskCostRowWire = z.object({
  issueId: IssueIdField,
  seq: z.number().int().nonnegative(),
  title: z.string(),
  stage: z.string(),
  /** Everything this task has ever cost, as far as the harvest has read. */
  models: z.array(CostModelTotalWire),
  messages: z.number().int().nonnegative(),
  /**
   * THE SAME TASK, RESTRICTED TO THE LATEST HARVEST'S WINDOW — and the reason
   * both are here. The usage sheet's stats row compares "attributed to a task"
   * against the host's own 7-day total; comparing an all-time per-task figure
   * against a 7-day host total reads as over 100% attributed, which is not a
   * rounding error but a category error. The panel wants all-time, the sheet's
   * window section wants this, and neither can be derived from the other.
   */
  windowModels: z.array(CostModelTotalWire),
  windowMessages: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  floor: CostFloor,
  harnesses: z.array(CostHarness),
})
export type TaskCostRowWire = z.infer<typeof TaskCostRowWire>

/** What the daemon read from one transcript, as the server stores it. */
export const TranscriptCostWire = z.object({
  machineId: MachineIdField,
  nativeId: z.string(),
  path: z.string(),
  harness: CostHarness,
  scannedBytes: z.number().int().nonnegative(),
  firstTsMs: z.number().int().nonnegative(),
  lastTsMs: z.number().int().nonnegative(),
  models: z.array(CostModelTotalWire),
})
export type TranscriptCostWire = z.infer<typeof TranscriptCostWire>

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

const EMPTY_TOTAL = (model: string): CostModelTotalWire => ({
  model,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cacheCreation1hTokens: 0,
  messages: 0,
})

/** Sum model totals across any number of sources, one row per model id. */
export function foldModelTotals(sources: Iterable<CostModelTotalWire[]>): CostModelTotalWire[] {
  const byModel = new Map<string, CostModelTotalWire>()
  for (const list of sources) {
    for (const m of list) {
      let acc = byModel.get(m.model)
      if (!acc) {
        acc = EMPTY_TOTAL(m.model)
        byModel.set(m.model, acc)
      }
      acc.inputTokens += m.inputTokens
      acc.outputTokens += m.outputTokens
      acc.cacheReadTokens += m.cacheReadTokens
      acc.cacheCreationTokens += m.cacheCreationTokens
      acc.cacheCreation1hTokens += m.cacheCreation1hTokens
      acc.messages += m.messages
    }
  }
  return [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model))
}

export const totalTokensOf = (m: CostModelTotalWire): number =>
  m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens

/** Replies across a model fold — the rate's denominator. */
export const messagesOf = (models: CostModelTotalWire[]): number =>
  models.reduce((n, m) => n + m.messages, 0)

/**
 * The floor mark for a set of harnesses. Empty reads `none`: a task with nothing
 * to count is not a lower bound, it is one of the three cold states.
 */
export function floorOf(harnesses: Iterable<CostHarness>): CostFloor {
  for (const h of harnesses) if (h !== 'claude-code') return 'partial'
  return 'none'
}

/**
 * Which of the four outcomes this task is in.
 *
 * ORDER IS THE RULE. Any counted token makes it `costed`, whatever else is
 * missing — a task with nine pruned sessions and one read one has a real, if
 * partial, figure. Then no sessions at all, which outranks the two "we have
 * sessions but no numbers" cases because it is a statement about the WORK.
 * Between the last two, `pending` wins: a transcript that is on disk and simply
 * unread must never print "not recorded", which is a claim that it is gone.
 */
export function taskCostState(input: {
  /** Sessions attributed to this task (own + descendants), at any depth. */
  sessionCount: number
  /** Of those, how many have a cost row with at least one counted reply. */
  costedSessionCount: number
  /** Of those, how many have a transcript on disk that has not been read yet. */
  pendingSessionCount: number
}): TaskCostState {
  if (input.costedSessionCount > 0) return 'costed'
  if (input.sessionCount === 0) return 'no-sessions'
  if (input.pendingSessionCount > 0) return 'pending'
  return 'not-recorded'
}

/**
 * A parent's cost is its own plus ALL descendants', recursively.
 *
 * Iterative rather than recursive, and it carries a visited set: `parent_id` is
 * a plain self-reference with no cycle constraint in SQLite, and a reparent that
 * closes a loop would otherwise take out the whole read path instead of one
 * task's figure. Each issue contributes once even if the graph reaches it twice.
 */
export function descendantsOf(
  issueId: string,
  childrenByParent: ReadonlyMap<string, readonly string[]>,
): string[] {
  const out: string[] = []
  const seen = new Set<string>([issueId])
  const queue = [...(childrenByParent.get(issueId) ?? [])]
  while (queue.length > 0) {
    const next = queue.pop()
    if (next === undefined || seen.has(next)) continue
    seen.add(next)
    out.push(next)
    for (const child of childrenByParent.get(next) ?? []) if (!seen.has(child)) queue.push(child)
  }
  return out
}
