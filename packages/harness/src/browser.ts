/**
 * `@podium/harness/browser` — THE BROWSER-REACHABLE HALF (POD-2206).
 *
 * ---------------------------------------------------------------------------
 * WHY A SECOND ENTRYPOINT, WHEN `./metadata` ALREADY EXISTS
 * ---------------------------------------------------------------------------
 *
 * `@podium/harness/metadata` is the OPEN entrypoint: anyone may import it,
 * because everything it exports is a fact about software rather than an action
 * on a host. That is a statement about the SURFACE, and its own docblock says so
 * — the check behind it (`manifest-open-entrypoint`) deliberately does not walk
 * the closure, because the manifests legitimately reach `node:child_process` and
 * a transitive walk would refuse the whole surface and prove nothing.
 *
 * "Anyone may import it" and "a browser may bundle it" are therefore different
 * claims, and POD-2176 is what it costs to conflate them. `./metadata`
 * re-exports `./registry.js`, which holds `AGENT_MANIFESTS`, which pulls all five
 * manifests, `@podium/transcript`, and `@podium/runtime`'s sqlite modules — and
 * those evaluate `createRequire(import.meta.url)` at MODULE SCOPE. In a browser
 * `node:module` is a stub, so `createRequire` is not a function and the chunk
 * dies while it is still being evaluated. One `import` in a settings file
 * (091f4f80b) put 42 harness sources, 14 transcript sources and the five sqlite
 * modules into the SettingsView chunk: 652 KB of the chunk's 868 KB of source,
 * and every route under /settings crashed in any built bundle.
 *
 * So this module is the half a bundler may have. It imports NOTHING at runtime —
 * one type import, erased at build — which is the property that makes it safe,
 * and the property `manifest-browser-reach` now holds it to: `packages/harness`
 * is tagged `neutral` and this file is its declared browser entrypoint, so the
 * closure walk in scripts/check-boundaries.ts fails the build if anything here
 * ever grows an import of `node:`, `bun:`, or a node-only workspace.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FACT IS DECLARED HERE AND NOT READ OFF THE MANIFESTS
 * ---------------------------------------------------------------------------
 *
 * `harnessSupportsNoTools` used to read `manifestFor(kind)?.headless`, which is
 * why the browser could not have it without the whole registry. Reading a
 * one-bit static fact should not require loading five process-driving adapters,
 * so the predicate is DEFINED here, over a literal table, and `./registry.ts`
 * re-exports it — there is exactly one implementation and no call site changed.
 *
 * The manifests still declare `headless.noTools` themselves: that is where a
 * person adding a harness writes down what their CLI can do, and moving it out
 * of the manifest would scatter the adapter's self-description. Two statements
 * of one fact would ordinarily be a drift hazard, so it is a TESTED identity
 * rather than a convention: `browser.test.ts` asserts, for every
 * `BuiltinHarnessKind`, that this table agrees with what that harness's manifest
 * declares. Flip a manifest without flipping the table and that test fails and
 * names the harness.
 */

import type { AgentKind, BuiltinHarnessKind } from '@podium/model'

/**
 * Which harnesses have a NATIVE all-tools-off mechanism.
 *
 * Exhaustive over {@link BuiltinHarnessKind} by type, so adding a harness is a
 * compile error here until someone states its answer — the same totality
 * contract `AGENT_MANIFESTS` carries, for the same reason: a harness that
 * silently defaults would borrow another CLI's behavior.
 */
export const HARNESS_NO_TOOLS: Record<BuiltinHarnessKind, boolean> = {
  'claude-code': true,
  codex: false,
  cursor: false,
  grok: false,
  opencode: false,
}

/**
 * True only when the adapter has a native all-tools-off mechanism. Unknown and
 * merely sandboxed harnesses fail closed.
 *
 * FAILING CLOSED IS THE WHOLE POINT, and it is why this takes a `string` rather
 * than a `BuiltinHarnessKind`: callers hold OPEN wire ids (a newer peer may name
 * a harness this build has never heard of) and the honest answer for one of
 * those is "no", not "probably like claude-code". `Record` lookup on an unknown
 * key yields `undefined`, and `=== true` turns that into `false` rather than
 * letting it through as truthy.
 */
export function harnessSupportsNoTools(kind: AgentKind | string): boolean {
  return HARNESS_NO_TOOLS[kind as BuiltinHarnessKind] === true
}
