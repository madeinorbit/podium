/**
 * The web-side status-dot classname helper.
 *
 * This module used to also carry `export * from '@podium/client-core/viewmodels'`
 * — a compatibility forward, so that `./derive` imports kept working after the
 * pure derivations moved to the platform-neutral package. POD-333 deleted the
 * forward and moved the call sites; what is left is the one thing that could
 * never move, because it depends on tailwind-merge via `cn()`.
 *
 * Worth noting for the next person tempted to re-add the line: a blanket
 * re-forward in a file that ALSO has real code is the shape the deletion audit
 * missed for two phases, because `reexport-shims` counted re-export-ONLY files.
 * It is counted now (see scripts/rearch-audit.ts) — but the cheaper reason not
 * to write one is that it makes this module's export surface unbounded.
 */

import { type DotTone, sessionDotTone } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model'
import { cn } from './utils'

// Tone → hue via the activity tokens (--live/--info) plus semantic --warning,
// so each theme preset recolors agent activity (working reads calm blue in
// every preset, POD-166 R10). The tokens keep stable, dot-appropriate hues in every
// preset — the old reason to avoid tokens (near-black light-mode --primary)
// doesn't apply to them. Error stays an explicit red so a broken session never
// blends in with a preset's live/destructive hue (matching the minimap palette).
const DOT_TONE_CLASS: Record<DotTone, string> = {
  working: 'bg-live',
  attention: 'bg-warning',
  error: 'bg-red-500',
  ready: 'bg-info',
  neutral: 'bg-muted-foreground',
}

/**
 * Full className for a session's status dot: the tone hue plus a `parked` marker
 * for hibernated sessions. The marker drives the grayed/italic row look in CSS
 * (`.dot.parked + .worker-label`), independent of the dot colour. Status dots
 * are deliberately still: ongoing agent motion is represented only by the
 * shared braille spinner + timer primitive.
 */
export function sessionDotClass(s: SessionMeta): string {
  const tone = sessionDotTone(s)
  const parked = s.status === 'hibernated'
  return cn(
    'dot inline-block size-2 min-w-2 flex-none rounded-full',
    DOT_TONE_CLASS[tone],
    parked && 'parked',
  )
}
