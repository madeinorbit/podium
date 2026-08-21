import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdatesProvider } from './updates-context'

// The engine arrives through `lazy()`, so the real module would suspend and
// render the provider's `null` fallback in both cases — which would make this
// suite pass while proving nothing. Standing in for it makes "was it mounted at
// all" observable, which is the only thing under test here.
vi.mock('./UpdatesEngine', () => ({
  UpdatesEngine: () => <div data-testid="updates-engine-mount" />,
}))

afterEach(cleanup)

/**
 * ITERATION MODE (POD-2513): a source page in front of the installed server must
 * not offer an update. The offer it would show is a REAL one — clicking it would
 * start a real fleet rollout — from a page that is not the installed app, and
 * that page's own build is not what the rollout would deliver. "Updater fully
 * off" (updater-convergence spec §7) is this line.
 */
describe('UpdatesProvider in iteration mode', () => {
  it('mounts no update engine', async () => {
    render(
      <UpdatesProvider iterating={true}>
        <p>app</p>
      </UpdatesProvider>,
    )
    await screen.findByText('app')
    expect(screen.queryByTestId('updates-engine-mount')).toBeNull()
  })

  it('still renders the app around it — the mode changes the updater, not the app', async () => {
    render(
      <UpdatesProvider iterating={true}>
        <p>app</p>
      </UpdatesProvider>,
    )
    expect(await screen.findByText('app')).toBeTruthy()
  })

  it('mounts the engine normally when iteration mode is off', async () => {
    render(
      <UpdatesProvider iterating={false}>
        <p>app</p>
      </UpdatesProvider>,
    )
    expect(await screen.findByTestId('updates-engine-mount')).toBeTruthy()
  })
})
