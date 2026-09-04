// @vitest-environment happy-dom
/**
 * THE LAZY-LOAD GUARANTEE THE SHELL RESTS ON (POD-1603).
 *
 * `LoadPanel` and `QuotaPanel` are `React.lazy` behind this popover so that
 * ~40k of panel UI stays out of the eager bundle the budget prices. What made
 * that true was never the `lazy()` call on its own — it was that the shell does
 * not RENDER its panel until the popover opens.
 *
 * That used to be spelled as a render prop, which made it obvious: no call, no
 * element, no chunk. POD-1603 removed the prop along with pinning, and a plain
 * `children` element is created on every render of the header — so the property
 * now rests entirely on Base UI keeping a closed portal empty. This pins that,
 * in both directions, because the failure is invisible: the app would work
 * perfectly and simply load the chunks it was built to defer.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HealthPopover } from './HealthPopover'

const mountPopover = (): ReturnType<typeof vi.fn> => {
  const mounted = vi.fn()
  const Body = (): JSX.Element => {
    mounted()
    return <div>the breakdown</div>
  }
  render(
    <HealthPopover trigger={<button type="button">chip</button>}>
      <Body />
    </HealthPopover>,
  )
  return mounted
}

afterEach(cleanup)

describe('the health popover mounts its panel on open, not before', () => {
  it('leaves the panel unrendered while closed', () => {
    const mounted = mountPopover()
    expect(screen.getByText('chip')).toBeTruthy()
    expect(mounted).not.toHaveBeenCalled()
  })

  it('renders it once the chip is used — the control case for the above', async () => {
    const mounted = mountPopover()
    fireEvent.click(screen.getByText('chip'))
    await waitFor(() => expect(screen.getByText('the breakdown')).toBeTruthy())
    expect(mounted).toHaveBeenCalled()
  })
})
