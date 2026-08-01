/**
 * Agent / harness identity vocabulary — the ONE definition site (POD-303).
 *
 * Relocated from `@podium/protocol`'s `messages/terminal.ts` and
 * `messages/harness.ts`: the enums at POD-300, and `HarnessId` /
 * `BuiltinHarnessKind` here at POD-303, so the whole vocabulary lives at L0 with
 * nothing above it holding a second copy. `@podium/protocol` re-exports these
 * names verbatim, so every existing import site keeps working.
 *
 * This file is the IDENTITY half of harness identity. The BEHAVIOUR half —
 * per-kind capability flags and launch commands — deliberately stays out of L0:
 * it lives in `@podium/harness`'s `AgentManifest` registry, which is what the
 * architecture manifest's harness axiom enforces.
 *
 * ## Open on the wire, closed in-repo
 *
 * Two names, because there are two different jobs:
 *
 * | Name | Openness | Job |
 * |---|---|---|
 * | {@link HarnessId} | OPEN — any non-empty string | the canonical cross-layer and wire identity |
 * | {@link BuiltinHarnessKind} | CLOSED — this build's five | compile-time totality of the manifest registry |
 *
 * Narrow from the first to the second ONLY through
 * {@link isBuiltinHarnessKind} (or a lookup that returns `undefined`), never with
 * a cast and never with a fallback entry.
 */

import { z } from 'zod'

export const AgentKind = z.enum(['claude-code', 'codex', 'grok', 'opencode', 'cursor', 'shell'])
export type AgentKind = z.infer<typeof AgentKind>

/** Type guard for the wire kind (superagent metadata, hook payloads, …). */
export function isAgentKind(v: unknown): v is AgentKind {
  return typeof v === 'string' && (AgentKind.options as readonly string[]).includes(v)
}

/** The non-interactive harness surfaces the daemon can drive (AgentKind minus 'shell'). */
export const HarnessAgent = z.enum(['claude-code', 'codex', 'grok', 'opencode', 'cursor'])
export type HarnessAgent = z.infer<typeof HarnessAgent>

/**
 * The OPEN, canonical cross-layer and wire identity of a harness: "what software
 * is this?" Any non-empty string is a valid `HarnessId`, because a newer peer may
 * name a harness this build has never heard of, and the older side must degrade
 * gracefully rather than reject the frame. On the wire a `HarnessId` always
 * travels with a serialized capability descriptor so a consumer can render a
 * harness it cannot name.
 *
 * NOT A PRINCIPAL. `HarnessId` answers "what software is this"; it never answers
 * "who is acting, and for whom". That second question is the ADR 9 D5 agent
 * PRINCIPAL — `(agentIdentity, onBehalfOf: UserId, scope)`, whose effective
 * rights are its scope intersected with its human's CURRENT rights resolved live
 * at every apply, and whose lifecycle is `SessionBinding` (POD-323, Phase 5). The
 * two are different things that would otherwise share the phrase "agent identity"
 * and get wired together by someone who read only one of them. Accordingly,
 * neither `HarnessId` nor `AgentManifest` (@podium/harness) carries an owner, a
 * delegation reference, a visibility class, or any other authorization concept —
 * and neither should ever grow one. Authorization over harnesses is a fact about
 * a MACHINE, not about the software: see below.
 *
 * NOT AN AVAILABILITY ANSWER EITHER. A `HarnessId` says a harness exists as a
 * concept; it says nothing about whether it can be run anywhere. "claude-code is
 * installed on machine X, at this version, logged in as whom" is a PER-MACHINE
 * FACT, and per readiness §3.1.1/§3.1.4 (and ADR 1 Amendment 1 D13.5) every fact
 * about a machine is **owned compute** that inherits that machine's scoping
 * rather than carrying its own. The two halves are deliberately separate types in
 * separate places:
 *   - STATIC, tenant-wide, totality-checked: `AgentManifest` keyed by
 *     {@link BuiltinHarnessKind} (@podium/harness) — in-repo code, identical for
 *     everyone, principal-free.
 *   - RESOLVED, per-machine, scoped: `AgentInventory` / `Inventory` inside
 *     `MachineWire` (./machine.ts), and the availability projection over them in
 *     ../predicates/machine-selection.ts.
 * Collapsing them into one table makes that scoping unexpressible; keep them two.
 */
export const HarnessId = z.string().min(1).brand<'HarnessId'>()
export type HarnessId = z.infer<typeof HarnessId>

/**
 * The CLOSED set of harnesses this build ships a manifest for. It exists for
 * exactly ONE reason: compile-time totality of the builtin manifest registry
 * (`Record<BuiltinHarnessKind, AgentManifest>` in @podium/harness), so adding a
 * harness without declaring its manifest is a compile error. It is deliberately
 * NOT the wire type — third-party runtime plugin registration is not a goal, but
 * receiving an unknown harness name from a newer peer very much is.
 *
 * Today it is an ALIAS of {@link HarnessAgent} — there is no second copy to
 * drift. It is named separately because the two have different JOBS: when the
 * registry and the wire vocabulary diverge, this is the name the registry keeps.
 *
 * `'shell'` is deliberately ABSENT, and that asymmetry with {@link AgentKind} is
 * load-bearing rather than an oversight: a shell IS a spawnable kind, and is NOT
 * a harness (no CLI conventions, no transcript, no resume kind, no observer).
 * Giving `shell` an all-unsupported manifest to "tidy" this reads reasonable and
 * is wrong — it would admit a non-harness to every registry totality check.
 */
export type BuiltinHarnessKind = HarnessAgent

/** The closed set as values, for iteration and totality tests. */
export const BUILTIN_HARNESS_KINDS: readonly BuiltinHarnessKind[] = HarnessAgent.options

/**
 * The narrowing gate between the open wire type and the closed registry. EVERY
 * lookup of a wire-supplied harness name must pass through this (or through the
 * registry's own `undefined`-returning lookup) so an unknown harness degrades to
 * "no manifest, capabilities unknown" instead of falling through to a default
 * that silently behaves like some other CLI.
 *
 * Degradation, not rejection, and not a throw. A closed `switch` with no default,
 * or a helper that throws on an unrecognized id, converts "silently mishandles an
 * unknown harness" into "crashes on it" — which is not an improvement.
 */
export function isBuiltinHarnessKind(id: string): id is BuiltinHarnessKind {
  return (BUILTIN_HARNESS_KINDS as readonly string[]).includes(id)
}
