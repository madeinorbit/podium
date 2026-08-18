/**
 * WHAT PODIUM PICKS WHEN NOBODY HAS PICKED — the superagent's harness, model and
 * effort, chosen from the CLIs the fleet actually carries (POD-1313).
 *
 * A fresh install resolves `roles.superagent` through `DEFAULT_ACCOUNT` in
 * ./settings.ts, which names `native:claude-code` because a default has to name
 * SOMETHING. On a machine without Claude Code that default is not merely
 * suboptimal — the first superagent turn fails to spawn, and the person who has
 * never opened Settings has no reason to suspect Settings is where the answer
 * lives. This module is the other half: the ORDER Podium prefers, and the
 * model+effort each pick rides with.
 *
 * PURE, AND IT DOES NOT READ THE FLEET. Availability is a per-machine fact
 * (`AgentInventory` on `MachineWire`, projected by
 * `@podium/model`'s machine-selection predicates), and per readiness §3.1.1 a
 * fact about a machine inherits that machine's scoping. So the caller resolves
 * "which harnesses can this person actually run" against the machines it is
 * allowed to see and hands the answer in; nothing here can widen it.
 *
 * SEEDING, NOT A READ-TIME FALLBACK, and the distinction is load-bearing. A
 * silent fallback inside `resolveRole` would make Settings display one harness
 * while every turn ran another — the exact failure `SuperagentService` calls out
 * on its own model fall-through. The pick is written to the person's preference
 * rows instead (see `SuperagentDefaultSeeder` in apps/server), so what Settings
 * shows is what runs, and changing it is an ordinary edit rather than a fight
 * with a heuristic.
 */
import type { AccountId, HarnessAgent, RoleBackend } from '@podium/model'
import { nativeAccountId } from './settings'

/**
 * The order Podium prefers when it is choosing for you.
 *
 * Not a quality ranking of the CLIs and not derived from one: it is the order
 * the superagent's own tool surface has been exercised in. `opencode` and
 * `cursor` are deliberately ABSENT rather than appended — an absent harness
 * means "Podium will not pick this for you", which is a weaker claim than "this
 * harness is worse" and the only claim this table is entitled to make. Someone
 * who wants either still selects it in Settings, and that choice is never
 * overwritten.
 */
export const SUPERAGENT_HARNESS_PRIORITY: readonly HarnessAgent[] = ['codex', 'grok', 'claude-code']

/** The model + reasoning effort a picked harness rides with. */
export interface HarnessRunDefault {
  model: string
  effort: string
}

/**
 * What each pick runs at. Verified against the CLIs themselves rather than
 * against the web's static fallback catalog, which is curated and lags:
 * `codex debug models` reports `gpt-5.6-luna` with `max` among its
 * `supported_reasoning_levels`, and `grok models` reports `grok-4.6`.
 *
 * A model named here that the installed CLI does not carry is not a crash — the
 * spawn passes the slug through and the CLI refuses it — so this table is
 * revised when a CLI's catalog moves, not defended by a validator that would
 * need its own copy of the catalog to be right.
 */
export const SUPERAGENT_HARNESS_DEFAULTS: Readonly<Record<HarnessAgent, HarnessRunDefault>> = {
  codex: { model: 'gpt-5.6-luna', effort: 'max' },
  grok: { model: 'grok-4.6', effort: 'medium' },
  'claude-code': { model: 'opus', effort: 'medium' },
  // Never picked automatically (see SUPERAGENT_HARNESS_PRIORITY); present so the
  // table is total and a harness added to the priority list cannot compile
  // without an answer here.
  opencode: { model: 'auto', effort: 'auto' },
  cursor: { model: 'auto', effort: 'auto' },
}

/** One harness as the caller's fleet reports it. */
export interface HarnessCandidate {
  harness: HarnessAgent
  /** Installed on at least one machine the caller may place work on. */
  installed: boolean
  /** …and that machine reports a live login for it (never `'out'`). */
  loggedIn: boolean
}

/** A pick, in the shape the `superagent` role stores. */
export interface SuperagentDefault {
  accountId: AccountId
  harness: HarnessAgent
  model: string
  effort: string
}

/** The role backend for a named harness — the pick, once the harness is decided. */
export function superagentDefaultFor(harness: HarnessAgent): SuperagentDefault {
  const run = SUPERAGENT_HARNESS_DEFAULTS[harness]
  return { accountId: nativeAccountId(harness), harness, model: run.model, effort: run.effort }
}

/**
 * The harness Podium would choose, or `undefined` when it would rather choose
 * nothing.
 *
 * TWO PASSES, LOGGED-IN FIRST. A harness that is installed but logged out can
 * still be the right answer — credential detection is a heuristic per harness,
 * and `login.state` is `'unknown'` for CLIs with no detector — but it must never
 * outrank a harness that is demonstrably ready. So the first pass wants a live
 * login and the second settles for installed. Returning `undefined` when neither
 * pass finds anything is the honest outcome: the fleet has reported no harness
 * this build will pick, and leaving the role at its declared default is better
 * than seeding a harness nobody has.
 */
export function pickSuperagentDefault(
  candidates: Iterable<HarnessCandidate>,
): SuperagentDefault | undefined {
  const byHarness = new Map<HarnessAgent, HarnessCandidate>()
  for (const candidate of candidates) byHarness.set(candidate.harness, candidate)
  const ready = SUPERAGENT_HARNESS_PRIORITY.find((h) => byHarness.get(h)?.loggedIn === true)
  const installed = SUPERAGENT_HARNESS_PRIORITY.find((h) => byHarness.get(h)?.installed === true)
  const picked = ready ?? installed
  return picked ? superagentDefaultFor(picked) : undefined
}

/**
 * Has this person left the superagent's backend entirely to Podium?
 *
 * `accountId === ''` is the DOCUMENTED "no opinion" value (see `RoleBackend` in
 * @podium/model), and `harness` is the explicit override that rides beside it.
 * Both absent is the only state a seed may write into: anything else is a choice
 * someone made, including a choice that happens to match what we would have
 * picked. Model and effort are checked by the seeder itself, leaf by leaf, so a
 * person who set only a model keeps it.
 */
export function superagentBackendIsUnset(backend: RoleBackend): boolean {
  return backend.accountId === '' && backend.harness === undefined
}
