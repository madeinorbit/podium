// @vitest-environment happy-dom
/**
 * THE DISCLOSURE ANIMATES, AND STILL ENDS UP EMPTY (POD-1253).
 *
 * Every fold in the work sidebar used to be `{!collapsed && rows}` — present in
 * one frame, absent in the next. `FoldPanel` gives the gesture a clipped height
 * animation instead, which changes one observable thing that the rest of the
 * suite depends on: the content is still mounted for the length of the exit.
 *
 * So this pins BOTH halves. It has to: an exit that never finished would look
 * exactly like the old instant hide to a test that only checked the end state,
 * and a panel that unmounted on the press would look exactly like a working
 * animation to a test that only checked the start.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { FoldPanel } from './work-folds'
import { WorklistMotion } from './worklist-motion'

afterEach(cleanup)

function Panel({ open }: { open: boolean }): JSX.Element {
  return (
    <WorklistMotion layoutGroupId="fold-panel-test">
      <FoldPanel open={open} testId="panel">
        <div>the rows</div>
      </FoldPanel>
    </WorklistMotion>
  )
}

describe('FoldPanel', () => {
  it('clips rather than unmounts on the press, and unmounts once the exit lands', async () => {
    const view = render(<Panel open={true} />)
    expect(screen.getByText('the rows')).toBeTruthy()
    // The panel is the clip: whatever it animates, it must never let a row paint
    // outside it, or a mid-collapse frame tears into the row below.
    expect(screen.getByTestId('panel').className).toContain('overflow-hidden')
    expect(screen.getByTestId('panel').style.contain).toBe('layout paint')

    view.rerender(<Panel open={false} />)
    // STILL THERE in the commit that shut it — this is the assertion that fails
    // if the panel ever goes back to `{open && children}`.
    expect(screen.queryByText('the rows')).toBeTruthy()
    // …and gone once the exit finishes, so a shut fold really is shut: nothing
    // for the ⌘-digit shortcuts, the drag scope or a screen reader to find.
    await waitFor(() => expect(screen.queryByText('the rows')).toBeNull())
  })

  it('opens without replaying on first paint', () => {
    // An open fold on load must simply BE open. `AnimatePresence initial={false}`
    // is what stops a reload from unrolling thirty rows nobody asked to see
    // move; without it every mount of the column is a disclosure animation.
    render(<Panel open={true} />)
    expect(screen.getByText('the rows')).toBeTruthy()
    expect(screen.getByTestId('panel').style.height).not.toBe('0px')
  })
})
