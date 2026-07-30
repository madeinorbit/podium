/**
 * WIRE-INPUT ALIASES — the adapter shapes that keep POD-361 from becoming
 * POD-362 and POD-363.
 *
 * A branded field is branded on the schema's OUTPUT side only: the value a
 * producer hands to `parse` is a plain `string`. These aliases name that side,
 * so a caller that builds a payload out of plain strings — a fixture builder, an
 * optimistic client-side placeholder, an adapter over untyped tRPC input —
 * states which side of the boundary it is on instead of casting field by field.
 *
 * WHY THEY EXIST AT ALL. This issue's contract is that NO consumer package
 * adopts the brands: the adoption sweeps are POD-362 (server + daemon) and
 * POD-363 (clients + CLI, audit to zero). Without a name for the input side,
 * "keep the repo green" would have meant editing every fixture literal in every
 * consumer — i.e. doing both sweeps here, badly, and mostly inside test files.
 *
 * WHAT THEY ARE NOT. They are not a way to keep an id unbranded. POD-362 and
 * POD-363 have both landed, and every marked edge cast they inherited is gone:
 * the remaining consumers are FIXTURE BUILDERS that construct a wire shape out
 * of string constants, which is a construction site rather than an adapter.
 * A NEW use in production code is a bug — the fix is a real parse (see
 * `optimisticIssuePatch` in packages/sync, which parses each branded key with
 * its shared field schema) or a branded producer, never this alias.
 *
 * WHAT {@link UnbrandIds} DELIBERATELY DOES NOT WIDEN: closed enums and literal
 * unions. `status: 'live' | 'exited'` stays exactly that, so a fixture with a
 * misspelled status still fails to compile. Only `BRAND`-carrying strings widen
 * — which is why this is a brand-aware mapped type rather than
 * `z.input<typeof Schema>`: zod's input type would also turn every `.default()`
 * field optional, letting a fixture omit a field it must still supply. Looser in
 * a way that has nothing to do with ids.
 */

import type { BRAND } from 'zod'
import type { AutomationRunWire, AutomationWire } from './automation'
import type { ConversationSummaryWire } from './conversation'
import type { IssueWire } from './issue'
import type { SessionMeta } from './session'

/**
 * Widen every BRANDED string in `T` back to `string`, recursing through arrays
 * and nested objects (`IssueWire.sessions` is the one nested entity, and it
 * carries branded ids of its own).
 */
export type UnbrandIds<T> = { [K in keyof T]: Unbrand<T[K]> }

type Unbrand<V> =
  V extends BRAND<string | number | symbol>
    ? string
    : V extends string
      ? V
      : V extends readonly (infer E)[]
        ? Unbrand<E>[]
        : V extends object
          ? UnbrandIds<V>
          : V

/** {@link SessionMeta} with its branded ids on the input side (plain strings). */
export type SessionMetaInput = UnbrandIds<SessionMeta>
/** {@link IssueWire} with its branded ids on the input side. */
export type IssueWireInput = UnbrandIds<IssueWire>
/** {@link AutomationWire} with its branded ids on the input side. */
export type AutomationWireInput = UnbrandIds<AutomationWire>
/** {@link AutomationRunWire} with its branded ids on the input side. */
export type AutomationRunWireInput = UnbrandIds<AutomationRunWire>
/** {@link ConversationSummaryWire} with its branded ids on the input side. */
export type ConversationSummaryWireInput = UnbrandIds<ConversationSummaryWire>
