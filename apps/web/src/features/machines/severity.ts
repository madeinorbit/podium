/**
 * Memory/load pressure → colors, reproducing the legacy `.mem-*` contract: the
 * bar fill is always tinted by severity; the icon stays neutral while `ok` and
 * only recolors on warn/critical; the compact (icon-only) chip carries severity
 * on the whole glyph (green when fine → warning → destructive).
 *
 * Shared by the header chip and the popover that explains it: the panel repeats
 * each meter at the same width and the same fill, so the bar you pointed at is
 * the bar you find named. A module of its own because the panel is lazy — an
 * import back into HostIndicators would drag the eager chunk into it.
 */
export const SEVERITY = {
  ok: { fill: 'bg-success', icon: '', compact: 'text-success' },
  warn: { fill: 'bg-warning', icon: 'text-warning', compact: 'text-warning' },
  critical: {
    fill: 'bg-destructive',
    icon: 'text-destructive',
    compact: 'text-destructive',
  },
} as const

/** Memory severity → the `data-tone` the header readout colours itself by. */
export const TONE_KEY = { ok: 'ok', warn: 'warn', critical: 'crit' } as const
