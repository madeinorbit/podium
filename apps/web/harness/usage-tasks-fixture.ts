/**
 * THE MEASURED TOP OF THE RANKING (POD-1861), shared by both usage harnesses.
 *
 * The dollar figures are the real ones from the POD-1604 design doc; the TOKENS
 * are solved backwards from them through the one price table, so the ranking,
 * the rail lengths and the concentration reading all have the spread the live
 * corpus actually has. An invented set is exactly how a layout comes out looking
 * fine in a harness and arrives with three rows of identical length.
 */

import { modelTotalCostUsd } from '@podium/client-core/viewmodels'
import type { CostModelTotalWire, TaskCostRowWire } from '@podium/model'

/** A cache-heavy agent hour, in the proportions the sheet's own composition
 *  section measures: cache reads dominate the tokens and not the bill. */
const SHAPE: CostModelTotalWire = {
  model: 'claude-opus-5',
  inputTokens: 40_000,
  outputTokens: 60_000,
  cacheReadTokens: 4_000_000,
  cacheCreationTokens: 300_000,
  cacheCreation1hTokens: 0,
  messages: 0,
}

const UNIT_USD = modelTotalCostUsd(SHAPE)

/** Solve the shape backwards to a target dollar figure. Pricing is linear in
 *  tokens, so one multiplier lands the total exactly. */
function models(usd: number, messages: number): CostModelTotalWire[] {
  const k = usd / UNIT_USD
  return [
    {
      model: SHAPE.model,
      inputTokens: Math.round(SHAPE.inputTokens * k),
      outputTokens: Math.round(SHAPE.outputTokens * k),
      cacheReadTokens: Math.round(SHAPE.cacheReadTokens * k),
      cacheCreationTokens: Math.round(SHAPE.cacheCreationTokens * k),
      cacheCreation1hTokens: 0,
      messages,
    },
  ]
}

function task(
  seq: number,
  title: string,
  stage: string,
  usd: number,
  sessionCount: number,
  messages: number,
  over: Partial<TaskCostRowWire> = {},
): TaskCostRowWire {
  // Roughly two fifths of the corpus's spend fell inside the harvest window,
  // which is what puts the attribution reading well below the all-time totals
  // ranked beneath it — the seam the section's note exists to name.
  const share = 0.42
  return {
    issueId: `iss_${seq}`,
    seq,
    title,
    stage,
    models: models(usd, messages),
    messages,
    windowModels: models(usd * share, Math.round(messages * share)),
    windowMessages: Math.round(messages * share),
    sessionCount,
    floor: 'none',
    harnesses: ['claude-code'],
    ...over,
  } as TaskCostRowWire
}

export const TASK_ROWS: TaskCostRowWire[] = [
  task(1574, 'Cross-issue artifact gallery', 'in_progress', 225.81, 10, 1_178),
  task(1402, 'Web Frontend Performance', 'review', 142.09, 6, 1_775),
  task(1403, 'Expo Motion Performance', 'review', 88.55, 3, 1_128),
  task(1376, 'Stable Chat Rendering', 'done', 88.16, 2, 1_078),
  task(1253, 'Sidebar 3a design fidelity', 'done', 78.94, 1, 366),
  task(1422, 'Stable Dynamic Issue Chips', 'done', 70.41, 1, 910),
  // A wholly-Codex task: the floor mark, with one harness behind it.
  task(1484, 'Harness rollout linkage', 'planning', 41.02, 4, 520, {
    floor: 'partial',
    harnesses: ['codex'],
  }),
  // ...and the case an enum could not have carried: Codex AND Grok, where "all
  // Codex" would have been a lie on screen.
  task(1201, 'Grok session sizing', 'backlog', 27.38, 2, 240, {
    floor: 'partial',
    harnesses: ['codex', 'grok'],
  }),
  task(1472, 'Explorer scope', 'done', 12.13, 2, 380),
  task(1660, 'Fold test typecheck', 'done', 12.06, 1, 300),
  task(1589, 'Offer links', 'done', 8.63, 1, 210),
  // Below the rate cohort's entry bar: it holds a place in the total ranking and
  // withholds a multiple, because four replies is noise rather than a rate.
  task(1799, 'One-shot copy fix', 'done', 6.4, 1, 4),
]
