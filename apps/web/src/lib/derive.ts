/**
 * Re-export shim (issue #15 Phase 4): the pure view-model derivations moved to
 * @podium/client-core/viewmodels (platform-neutral, shared with the rewritten
 * mobile app). Existing `./derive` imports keep working through this shim.
 * Only the css-classname helpers — which depend on tailwind-merge via cn() —
 * stay web-side.
 */
export * from '@podium/client-core/viewmodels'

import { type DotTone, sessionDotTone } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/protocol'
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
