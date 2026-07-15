import type { ModelCatalogSnapshot } from './model-catalog'
import { didYouMean } from './similarity'

/**
 * Spawn-time validation of an explicit model/effort selection against the live
 * ModelCatalog [spec:SP-cc60]. Every session-creation entry point (agent spawn,
 * issue start, issue add-session) runs this before creating a session or mutating
 * issue-start state, so a typo'd or retired slug is caught with a "did you mean"
 * suggestion instead of silently spawning an agent that falls back to a CLI default.
 *
 * Pure and catalog-in: the caller supplies the persisted snapshot (which also carries
 * `fetchedAt`, the source freshness reported in the error) so this stays trivially
 * testable and never itself shells out.
 */

/** A selection value that means "no explicit choice" — never validated. `auto` is
 *  the settings/issue sentinel for "let the CLI default decide". */
function isExplicit(value: string | undefined): value is string {
  return value !== undefined && value !== '' && value !== 'auto'
}

export interface ModelSelection {
  agentKind: string
  model?: string
  effort?: string
  /** Deliberate unlisted model slug: bypasses the unknown-MODEL rejection only.
   *  Never bypasses effort validation (efforts are a fixed ladder, not extensible). */
  force?: boolean
}

export interface ModelValidationProblem {
  /** Which dimension failed — drives the message and which list was suggested over. */
  kind: 'model' | 'effort'
  harness: string
  /** The rejected model or effort value. */
  requested: string
  /** For an effort problem, the resolved model whose effort list was consulted. */
  model?: string
  /** Epoch ms of the catalog's last successful probe (0 = never) — source freshness. */
  fetchedAt: number
  /** Ranked closest matches (up to three), may be empty. */
  suggestions: string[]
}

export type ModelValidationResult =
  | { ok: true; forced: boolean }
  | { ok: false; problem: ModelValidationProblem }

/** Valid efforts to check an explicit effort against, or `undefined` when the source
 *  reports none authoritatively (grok/cursor/opencode) ⇒ effort is not validated. */
function effortUniverse(
  models: { value: string; efforts?: string[] }[],
  modelChoice: { efforts?: string[] } | undefined,
  hasExplicitModel: boolean,
): string[] | undefined {
  // A known model carries its own effort list (`[]` = supports none → any explicit
  // effort is invalid; `undefined` = source doesn't report → skip).
  if (modelChoice) return modelChoice.efforts
  // An explicit-but-unknown model (forced) has unknowable efforts → skip.
  if (hasExplicitModel) return undefined
  // No explicit model: validate against the union of every effort the agent's models
  // report. If not one reports efforts, we can't validate → skip.
  const union = new Set<string>()
  let anyDefined = false
  for (const m of models) {
    if (m.efforts === undefined) continue
    anyDefined = true
    for (const e of m.efforts) union.add(e)
  }
  return anyDefined ? [...union] : undefined
}

/**
 * Validate an explicit model/effort selection against the catalog. Returns `ok` with
 * whether a force actually bypassed an unknown model (so callers can record it), or a
 * structured problem to surface. An empty/absent catalog for the agent (cold or failed
 * probe) can't be validated against, so it passes — never reject a spawn because the
 * source wasn't fresh.
 */
export function validateModelSelection(
  catalog: ModelCatalogSnapshot | null | undefined,
  selection: ModelSelection,
): ModelValidationResult {
  const model = isExplicit(selection.model) ? selection.model : undefined
  const effort = isExplicit(selection.effort) ? selection.effort : undefined
  if (!model && !effort) return { ok: true, forced: false }

  const harness = selection.agentKind
  const fetchedAt = catalog?.fetchedAt ?? 0
  const models = catalog?.byAgent?.[harness]
  // No catalog data for this agent ⇒ nothing to validate against; allow.
  if (!models || models.length === 0) return { ok: true, forced: false }

  let forced = false
  let modelChoice: { value: string; efforts?: string[] } | undefined
  if (model) {
    modelChoice = models.find((m) => m.value === model)
    if (!modelChoice) {
      if (selection.force) forced = true
      else
        return {
          ok: false,
          problem: {
            kind: 'model',
            harness,
            requested: model,
            fetchedAt,
            suggestions: didYouMean(
              model,
              models.map((m) => m.value),
            ),
          },
        }
    }
  }

  if (effort) {
    const validEfforts = effortUniverse(models, modelChoice, model !== undefined)
    if (validEfforts && !validEfforts.includes(effort)) {
      return {
        ok: false,
        problem: {
          kind: 'effort',
          harness,
          requested: effort,
          ...(modelChoice ? { model: modelChoice.value } : {}),
          fetchedAt,
          suggestions: didYouMean(effort, validEfforts),
        },
      }
    }
  }

  return { ok: true, forced }
}

/** Human-readable age of the catalog (its source freshness) for the error message. */
function freshness(fetchedAt: number, now: number): string {
  if (fetchedAt <= 0) return 'the model catalog has never been probed'
  const ms = Math.max(0, now - fetchedAt)
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'the model catalog was refreshed just now'
  if (mins < 60) return `the model catalog was refreshed ${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `the model catalog was refreshed ${hours}h ago`
  return `the model catalog was refreshed ${Math.floor(hours / 24)}d ago`
}

function quotedList(values: string[]): string {
  return values.map((v) => `"${v}"`).join(', ')
}

/** The clear, actionable error message for a rejected selection [spec:SP-cc60]:
 *  requested harness/model/effort, catalog freshness, and a "did you mean" line. */
export function formatModelValidationProblem(
  problem: ModelValidationProblem,
  now: number = Date.now(),
): string {
  const fresh = freshness(problem.fetchedAt, now)
  const suggestion = problem.suggestions.length
    ? ` Did you mean ${quotedList(problem.suggestions)}?`
    : ''
  if (problem.kind === 'model') {
    return (
      `${problem.harness}: unknown model "${problem.requested}" — not in the model catalog ` +
      `(${fresh}).${suggestion} Pass --force-unknown-model to spawn with it anyway.`
    )
  }
  const modelCtx = problem.model ? ` for model "${problem.model}"` : ''
  const tail = problem.suggestions.length
    ? suggestion
    : ` That model supports no reasoning-effort levels.`
  return (
    `${problem.harness}: unknown effort "${problem.requested}"${modelCtx} — not in the model ` +
    `catalog (${fresh}).${tail}`
  )
}

/** Error thrown at an entry point when a selection is rejected. Carries the structured
 *  problem so callers/tests can inspect it; `.message` is the formatted string. */
export class ModelValidationError extends Error {
  constructor(readonly problem: ModelValidationProblem) {
    super(formatModelValidationProblem(problem))
    this.name = 'ModelValidationError'
  }
}

/**
 * Assert a selection is valid, throwing {@link ModelValidationError} otherwise.
 * Returns `{ forced }` — true when a `--force-unknown-model` actually bypassed an
 * unknown model, so the caller can record the forcing in provenance/events.
 */
export function assertModelSelectionValid(
  catalog: ModelCatalogSnapshot | null | undefined,
  selection: ModelSelection,
): { forced: boolean } {
  const result = validateModelSelection(catalog, selection)
  if (!result.ok) throw new ModelValidationError(result.problem)
  return { forced: result.forced }
}
