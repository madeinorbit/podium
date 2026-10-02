import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'
import { MobxPilotSetting } from './MobxPilotSetting'

// The latched choice of this app load; the latch itself is tested on the real
// provider path in client/mobile-pool.test.tsx.
const launch = vi.hoisted(() => ({ layer: 'legacy' as 'legacy' | 'pool' }))
vi.mock('../client/mobile-pool', () => ({ mobileDataLayer: () => launch.layer }))

afterEach(() => {
  cleanup()
  launch.layer = 'legacy'
})

const toggle = () => screen.getByLabelText('MobX pilot') as HTMLInputElement

describe('Settings → Experimental: MobX pilot', () => {
  it('saves the device setting for the next start without changing this launch', async () => {
    const { replica } = await renderWithMobileStore(<MobxPilotSetting />)
    expect(toggle().checked).toBe(false)
    expect(replica.uiState().get(MOBX_SIDEBAR_KEY)).toBeNull()

    await act(async () => {
      fireEvent.click(toggle())
    })
    expect(replica.uiState().get(MOBX_SIDEBAR_KEY)).toBe('1')
    expect(toggle().checked).toBe(true)
    expect(screen.getByText('Applies at the next app start. This launch: off.')).toBeTruthy()

    await act(async () => {
      fireEvent.click(toggle())
    })
    expect(replica.uiState().get(MOBX_SIDEBAR_KEY)).toBe('0')
  })

  it('is listed, off by default, on every build including release', async () => {
    // This lane runs as a release build (mobile vitest config: __DEV__ false).
    expect(typeof __DEV__ !== 'undefined' && __DEV__).toBe(false)
    await renderWithMobileStore(<MobxPilotSetting />)
    expect(screen.getByText('Experimental')).toBeTruthy()
    expect(toggle().checked).toBe(false)
    expect(screen.getByText('Applies at the next app start. This launch: off.')).toBeTruthy()
  })

  it('says when this launch runs the pool after it was turned off', async () => {
    launch.layer = 'pool'
    const { replica } = await renderWithMobileStore(<MobxPilotSetting />)
    // Turned off for the next start; this launch still runs the pool.
    act(() => replica.uiState().set(MOBX_SIDEBAR_KEY, '0'))
    expect(toggle().checked).toBe(false)
    expect(screen.getByText('Applies at the next app start. This launch: on.')).toBeTruthy()
  })
})
