/**
 * Composer-sync port types — harness-free (POD-4477, epic POD-4414 §4.1).
 *
 * Per-harness composer extraction/injection rules live in
 * `adapters/<harness>/composer.ts`: pure functions over screen content and
 * text, one authoritative definition per harness (spec §4). This module keeps
 * only the port — the TYPED SUBSET a composer-sync consumer is handed, never
 * the whole Adapter (spec §5 rule 2). The daemon's composition root resolves
 * the manifest once and hands this in; the browser entry bundles the same
 * rules for the harnesses the client build knows (CODE, never served).
 *
 * Nothing here names a harness or imports an adapter (spec §5 rule 4, 3.R
 * D6 — the terminal family may not import any specific adapter), so reaching
 * a rule the consumer was not handed fails compilation, not review — the same
 * narrowing POD-4521 applied to terminal instrumentation with
 * `TerminalInstrumentationSections`.
 */

import type { HarnessComposer } from '../../../manifest.js'

export type {
  ComposerScreenLines,
  ComposerVerify,
  HarnessComposer,
} from '../../../manifest.js'

/**
 * THE SECTIONS COMPOSER-SYNC OWNS (spec §4.1).
 *
 * A composer-sync consumer is not handed the whole Adapter: it receives this
 * typed subset, the sections it owns, so the read restriction is a type
 * rather than a rule. The family has no parameter that accepts a manifest and
 * no import that could fetch one, so naming a harness here fails compilation.
 */
export interface TerminalComposerSections {
  /**
   * The harness's own scrape/inject/verify rules (`adapters/<h>/composer.ts`):
   * extract the current draft, judge writability, clear and type without
   * submitting, verify a write landed, and — where declared — the
   * empty-composer input-ready heuristic. Absent (a declined section) the
   * caller runs no composer sync for the session, never another harness's.
   */
  composer: HarnessComposer
}
