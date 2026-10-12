import { resolveRole, type PodiumSettings } from '@podium/runtime'
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
  /** For an effort problem, the whole valid set that was consulted. Efforts are a
   *  short fixed ladder, so the message prints it outright: `didYouMean` needs an
   *  0.85 similarity to fire, and a value that resembles nothing valid ("banana")
   *  is exactly the case where a caller most needs to be told what IS valid. */
  valid?: string[]
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
          valid: validEfforts,
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
  // Print the whole valid ladder, not just a "did you mean" — a rejected effort is
  // most often one nothing resembles, and the caller's next move is to pick a real
  // one. Only when the set is genuinely empty does the "supports none" wording hold.
  const valid = problem.valid ?? []
  const tail = valid.length
    ? ` Valid efforts${modelCtx}: ${quotedList(valid)}.${suggestion}`
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

/** One half of a launch selection, as the caller holds it. */
export interface SelectionValues {
  model?: string
  effort?: string
}

export interface VettedSelection {
  /** The model to launch with; `'auto'` when none survives. */
  model: string
  /** The effort to launch with; `'auto'` when none survives. */
  effort: string
  /** True when a force actually let an unknown explicit model through. */
  forced: boolean
  /** Inherited values the catalog did not know, dropped to `'auto'`. */
  dropped: Array<'model' | 'effort'>
}

/**
 * A DEFAULT NEVER BLOCKS A LAUNCH (POD-3911, POD-3218).
 *
 * A launch carries two kinds of model and effort. EXPLICIT values were chosen
 * for this launch — a CLI flag, a picker — and are checked exactly as before: an
 * unknown one refuses the launch with a "did you mean", because the person who
 * typed it is right there to fix it. INHERITED values came from somewhere else —
 * the issue's stored profile, the Settings default — possibly weeks ago, possibly
 * written by an agent. When the catalog does not know one, it is dropped to
 * `'auto'` and the launch goes ahead: the harness then picks its own default.
 *
 * Before this, both kinds went through one assert, so a stale `Codex` sitting in
 * Settings → Model refused every new task, from every surface, with no control
 * on screen that showed it.
 *
 * Model first, then effort against the model that survived: an inherited effort
 * that the chosen model does not take is dropped too. An explicit value wins over
 * an inherited one of the same kind. `force` keeps an unknown model of either
 * kind, matching `--force-unknown-model`; it never keeps an unknown effort.
 */
export function vetLaunchSelection(
  catalog: ModelCatalogSnapshot | null | undefined,
  input: {
    agentKind: string
    explicit?: SelectionValues
    inherited?: SelectionValues
    force?: boolean
  },
): VettedSelection {
  const pick = (kind: keyof SelectionValues): { value?: string; explicit: boolean } => {
    const explicit = input.explicit?.[kind]
    if (isExplicit(explicit)) return { value: explicit, explicit: true }
    const inherited = input.inherited?.[kind]
    return isExplicit(inherited) ? { value: inherited, explicit: false } : { explicit: false }
  }
  const dropped: VettedSelection['dropped'] = []
  const force = input.force === true

  const model = pick('model')
  let modelValue = model.value
  let forced = false
  if (modelValue !== undefined) {
    const result = validateModelSelection(catalog, {
      agentKind: input.agentKind,
      model: modelValue,
      force,
    })
    if (!result.ok) {
      if (model.explicit) throw new ModelValidationError(result.problem)
      modelValue = undefined
      dropped.push('model')
    } else {
      forced = result.forced
    }
  }

  const effort = pick('effort')
  let effortValue = effort.value
  if (effortValue !== undefined) {
    const result = validateModelSelection(catalog, {
      agentKind: input.agentKind,
      ...(modelValue !== undefined ? { model: modelValue } : {}),
      effort: effortValue,
      force,
    })
    if (!result.ok) {
      if (effort.explicit) throw new ModelValidationError(result.problem)
      effortValue = undefined
      dropped.push('effort')
    }
  }

  return { model: modelValue ?? 'auto', effort: effortValue ?? 'auto', forced, dropped }
}

export type LaunchSelectionSource = 'explicit' | 'issue' | 'settings' | 'auto'

export interface ResolvedLaunchSelection extends VettedSelection {
  /** The surviving layer; a rejected inherited value has source `auto`. */
  source: Record<'model' | 'effort', LaunchSelectionSource>
}

/** One pure answer for a new launch. Catalog data is supplied by the server's
 * persisted machine row; resolving never contacts a daemon. `auto` means unset
 * in every layer. Settings apply only to the coding harness [spec:SP-7ff1]. */
export function resolveLaunchSelection(input: {
  agentKind: string
  explicit?: SelectionValues
  issueProfile?: SelectionValues & { agentKind: string }
  settings: PodiumSettings
  catalog: ModelCatalogSnapshot | null | undefined
  force?: boolean
}): ResolvedLaunchSelection {
  const coding = resolveRole(input.settings, 'coding')
  const source: ResolvedLaunchSelection['source'] = { model: 'auto', effort: 'auto' }
  const inherited: SelectionValues = {}
  for (const field of ['model', 'effort'] as const) {
    const explicit = input.explicit?.[field] ?? 'auto'
    const issue = input.issueProfile?.agentKind === input.agentKind
      ? input.issueProfile[field] ?? 'auto'
      : 'auto'
    const setting = input.agentKind === coding.harness ? coding[field] : 'auto'
    if (isExplicit(explicit)) source[field] = 'explicit'
    else if (isExplicit(issue)) {
      inherited[field] = issue
      source[field] = 'issue'
    } else if (isExplicit(setting)) {
      inherited[field] = setting
      source[field] = 'settings'
    }
  }
  const vetted = vetLaunchSelection(input.catalog, {
    agentKind: input.agentKind,
    explicit: input.explicit,
    inherited,
    force: input.force,
  })
  // A forced unlisted model cannot establish an effort ladder of its own.
  // Force still cannot bypass the harness's authoritative effort vocabulary.
  if (vetted.forced && isExplicit(input.explicit?.effort)) {
    assertModelSelectionValid(input.catalog, {
      agentKind: input.agentKind,
      effort: input.explicit.effort,
    })
  }
  for (const field of vetted.dropped) source[field] = 'auto'
  return { ...vetted, source }
}
