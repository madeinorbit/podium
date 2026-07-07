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
import { cn } from '@/lib/utils'

// Tone → theme-independent hue. NOT the `bg-primary`/`bg-success` design tokens:
// `bg-primary` is near-black in the light theme, so an explicit blue keeps the
// status colours identical across themes and modes (matching the minimap palette).
const DOT_TONE_CLASS: Record<DotTone, string> = {
  working: 'bg-emerald-500',
  attention: 'bg-amber-500',
  error: 'bg-red-500',
  ready: 'bg-blue-500',
  neutral: 'bg-muted-foreground',
}

/**
 * Full className for a session's status dot: the tone hue plus a `parked` marker
 * for hibernated sessions. The marker drives the grayed/italic row look in CSS
 * (`.dot.parked + .worker-label`), independent of the dot colour. A live working
 * (green) dot also gets `dot-working` for the breathing-glow animation — but a
 * hibernated dot stays calm (no animation) even if its last tone was working.
 */
export function sessionDotClass(s: SessionMeta): string {
  const tone = sessionDotTone(s)
  const parked = s.status === 'hibernated'
  return cn(
    'dot inline-block size-2 min-w-2 flex-none rounded-full',
    DOT_TONE_CLASS[tone],
    parked && 'parked',
    tone === 'working' && !parked && 'dot-working',
    (s.status === 'starting' || s.status === 'reconnecting') && !parked && 'dot-starting',
  )
}
