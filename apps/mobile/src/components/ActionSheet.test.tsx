import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { type ReactNode, useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(async () => {}),
}))

// The sheet's physics belong to `BottomSheet` and are tested there; what this
// file is about is WHEN an action runs relative to the sheet's dismissal. The
// real sheet calls `onClose` once its exit animation completes and its Modal
// unmounts; here the withdrawal of `visible` stands in for that completion.
vi.mock('./BottomSheet', async () => {
  const { useEffect, useRef } = await import('react')
  return {
    BottomSheet: ({
      visible,
      onClose,
      head,
      children,
      footer,
    }: {
      visible: boolean
      onClose: () => void
      head?: ReactNode
      children: ReactNode
      footer?: ReactNode
    }) => {
      const was = useRef(false)
      useEffect(() => {
        if (was.current && !visible) onClose()
        was.current = visible
      })
      return visible ? (
        <>
          {head}
          {children}
          {footer}
        </>
      ) : null
    },
  }
})

const { ActionSheet } = await import('./ActionSheet')

describe('ActionSheet (JS sheet) deferral', () => {
  it('runs a chosen action only after the sheet has fully closed, and before onClose', async () => {
    const log: string[] = []
    render(
      <ActionSheet
        visible
        title="Menu"
        actions={[{ label: 'Open', onPress: () => log.push('action') }]}
        onClose={() => log.push('close')}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    // Nothing at press time: the action waits out the dismissal, and the host
    // must not hear onClose before the action has had its chance to hand off.
    expect(log).toEqual([])
    await waitFor(() => expect(log).toEqual(['action', 'close']))
  })

  it('cancel closes without running anything', async () => {
    const log: string[] = []
    render(
      <ActionSheet
        visible
        actions={[{ label: 'Delete', destructive: true, onPress: () => log.push('action') }]}
        onClose={() => log.push('close')}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(log).toEqual(['close']))
  })

  // The WorkIssueMenu shape: a host that keys teardown on "no sheet is open"
  // (`closeIf`) and whose root-menu actions open nested sheets. The hand-off
  // must reach the nested sheet without the host passing through closed —
  // otherwise the whole menu unmounts at press time and the follow-up sheet
  // never appears.
  it('an action can hand off to a follow-up sheet without tearing the host down', async () => {
    function Host({ onTearDown }: { onTearDown: () => void }) {
      const [sheet, setSheet] = useState<'menu' | 'status' | null>('menu')
      const closeIf = (kind: 'menu' | 'status') => () =>
        setSheet((current) => (current === kind ? null : current))
      useEffect(() => {
        if (sheet === null) onTearDown()
      }, [onTearDown, sheet])
      return (
        <>
          <ActionSheet
            visible={sheet === 'menu'}
            actions={[{ label: 'Set status', onPress: () => setSheet('status') }]}
            onClose={closeIf('menu')}
          />
          <ActionSheet
            visible={sheet === 'status'}
            actions={[{ label: 'In progress', onPress: () => {} }]}
            onClose={closeIf('status')}
          />
        </>
      )
    }
    function Rig() {
      const [open, setOpen] = useState(true)
      return open ? <Host onTearDown={() => setOpen(false)} /> : <div data-testid="torn-down" />
    }
    render(<Rig />)
    fireEvent.click(screen.getByRole('button', { name: 'Set status' }))
    await screen.findByRole('button', { name: 'In progress' })
    expect(screen.queryByTestId('torn-down')).toBeNull()
    // Finishing in the nested sheet is what finally closes the host.
    fireEvent.click(screen.getByRole('button', { name: 'In progress' }))
    await screen.findByTestId('torn-down')
  })
})
