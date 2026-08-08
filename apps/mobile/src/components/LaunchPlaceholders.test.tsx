import { render, waitFor } from '@testing-library/react'
import { Text } from 'react-native'
import { describe, expect, it, vi } from 'vitest'
import { BootstrapCrossfade, WorkSkeleton } from './LaunchPlaceholders'

vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))

describe('BootstrapCrossfade', () => {
  it('covers unresolved content, then latches the resolved page across reconnects', async () => {
    const renderPage = (resolved: boolean) => (
      <BootstrapCrossfade resolved={resolved} placeholder={<WorkSkeleton />}>
        <Text>real work</Text>
      </BootstrapCrossfade>
    )
    const view = render(renderPage(false))

    expect(view.getByTestId('bootstrap-placeholder')).toBeTruthy()
    view.rerender(renderPage(true))
    await waitFor(() => expect(view.queryByTestId('bootstrap-placeholder')).toBeNull())

    // A later transport re-bootstrap is a reconnect, not another app launch.
    view.rerender(renderPage(false))
    expect(view.queryByTestId('bootstrap-placeholder')).toBeNull()
    expect(view.getByText('real work')).toBeTruthy()
  })
})
