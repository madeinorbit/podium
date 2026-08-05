import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ToolbarSlot,
  ToolbarSlotProvider,
  ToolbarSlotTarget,
  useToolbarSlotFilled,
} from './ToolbarSlot'

/** A stand-in command bar: the target plus the seam that must not render as a
 *  divider pointing at an empty centre. */
function Bar(): JSX.Element {
  const filled = useToolbarSlotFilled()
  return (
    <header>
      {filled && <span data-testid="seam" />}
      <ToolbarSlotTarget className="slot" />
    </header>
  )
}

afterEach(cleanup)

describe('the command bar’s dynamic centre (POD-365)', () => {
  it('renders a mode’s controls into the bar while leaving them owned by the mode', () => {
    function Mode(): JSX.Element {
      // State the controls close over stays in the VIEW — the whole reason this
      // is a portal rather than props lifted into the shell.
      const [count, setCount] = useState(0)
      return (
        <main>
          <ToolbarSlot>
            <button type="button" onClick={() => setCount(count + 1)}>
              filter {count}
            </button>
          </ToolbarSlot>
        </main>
      )
    }
    render(
      <ToolbarSlotProvider>
        <Bar />
        <Mode />
      </ToolbarSlotProvider>,
    )

    const slot = document.querySelector('.slot')
    expect(slot?.textContent).toBe('filter 0')
    // Rendered into the bar, not into the view that owns it.
    expect(document.querySelector('main')?.textContent).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'filter 0' }))
    expect(slot?.textContent).toBe('filter 1')
  })

  it('leaves the centre and its seam empty for a mode that claims nothing', () => {
    render(
      <ToolbarSlotProvider>
        <Bar />
        <main />
      </ToolbarSlotProvider>,
    )
    expect(screen.queryByTestId('seam')).toBeNull()
    expect(document.querySelector('.slot')?.textContent).toBe('')
  })

  it('keeps the seam through a mode switch, where the new view mounts before the old unmounts', () => {
    function Shell({ mode }: { mode: 'a' | 'b' }): JSX.Element {
      return (
        <ToolbarSlotProvider>
          <Bar />
          {/* Both mounted at once is exactly the commit React produces mid-swap;
              a boolean "filled" would flicker the seam off here. */}
          <ToolbarSlot key={mode}>
            <span>{mode}</span>
          </ToolbarSlot>
          {mode === 'b' && (
            <ToolbarSlot key="outgoing">
              <span>a</span>
            </ToolbarSlot>
          )}
        </ToolbarSlotProvider>
      )
    }
    const { rerender } = render(<Shell mode="a" />)
    expect(screen.getByTestId('seam')).toBeTruthy()
    rerender(<Shell mode="b" />)
    expect(screen.getByTestId('seam')).toBeTruthy()
  })
})
