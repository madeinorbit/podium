/**
 * THE PERSISTENT AFFORDANCE (POD-2102, spec §6.1).
 *
 * A 24px status-strip cell that exists whenever an update does: a quiet dot for
 * an offer, an animated one while an operation runs, a warning when it failed or
 * needs this surface. Clicking toggles the panel.
 *
 * WHY THIS EXISTS AT ALL. Hiding the old dialog set component state and the
 * update became unreachable — permanently, for an installed PWA, because
 * nothing else would ever change to bring it back (spec §1.1). "Hide" is only
 * an honest verb if there is somewhere for the thing to go. This is that
 * somewhere, and it is driven entirely from server truth, so it survives a
 * reload, a bundle swap, and the server restarting mid-update.
 */
import type { JSX } from 'react'
import type { IndicatorState } from './operation-view'

export interface UpdateIndicatorProps {
  state: IndicatorState
  label: string
  open: boolean
  onToggle: () => void
}

export function UpdateIndicator({
  state,
  label,
  open,
  onToggle,
}: UpdateIndicatorProps): JSX.Element | null {
  if (state === 'none') return null

  return (
    <button
      type="button"
      data-testid="update-indicator"
      data-indicator={state}
      data-pressable
      className="status-strip-update"
      aria-label={label}
      aria-expanded={open}
      title={label}
      onClick={onToggle}
    >
      <span
        aria-hidden="true"
        className={
          state === 'attention'
            ? 'status-strip-update-dot status-strip-update-dot-attention'
            : state === 'animating'
              ? 'status-strip-update-dot status-strip-update-dot-running'
              : 'status-strip-update-dot'
        }
      />
      <span className="status-strip-update-label">
        {state === 'attention' ? 'Update' : state === 'animating' ? 'Updating' : 'Update'}
      </span>
    </button>
  )
}
