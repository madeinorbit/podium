/**
 * WHAT THE STATUS STRIP NEEDS, AND NOTHING ELSE (POD-2190).
 *
 * The indicator's four states are shared between the eager half of the update
 * surface (the strip cell, the store it reads) and the deferred half (the view
 * model that decides which of the four it is). They live in their own module so
 * the eager half depends on NOTHING in the deferred half — not even by a type.
 *
 * That is a structural guarantee rather than a lucky one. `import type` is erased
 * by the bundler, so the strip importing this from `operation-view.ts` cost
 * nothing today; but it is one careless edit — dropping the `type` keyword, or
 * reaching for a constant that happens to sit beside it — from pulling 33 KB of
 * view model back onto the first paint. That is exactly how the eager budget went
 * red in the first place. There is no value in this file to reach for.
 */

/** No update; an offer waiting; an operation running; something needs a person. */
export type IndicatorState = 'none' | 'idle-dot' | 'animating' | 'attention'
