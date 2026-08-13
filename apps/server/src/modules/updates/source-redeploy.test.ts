import { describe, expect, it, vi } from 'vitest'
import {
  createSourceRedeployRequest,
  createSourceWebRebuildRequest,
  sourceRedeployUnit,
  sourceWebUnit,
} from './source-redeploy'

describe('source coordinator redeploy', () => {
  it('uses the instance-scoped redeploy and web unit names', () => {
    expect(sourceRedeployUnit('default')).toBe('podium-redeploy.service')
    expect(sourceRedeployUnit('blue')).toBe('podium-blue-redeploy.service')
    expect(sourceWebUnit('default')).toBe('podium-web.service')
    expect(sourceWebUnit('blue')).toBe('podium-blue-web.service')
  })

  it('is absent outside a systemd-managed source server', () => {
    expect(createSourceRedeployRequest({ instanceId: 'default', env: {} })).toBeUndefined()
  })

  it('schedules the existing verified redeploy unit after authorization', async () => {
    vi.useFakeTimers()
    const startUnit = vi.fn()
    const request = createSourceRedeployRequest({
      instanceId: 'blue',
      env: { INVOCATION_ID: 'systemd-run' },
      delayMs: 750,
      startUnit,
    })

    request?.()
    request?.()
    expect(startUnit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(750)
    expect(startUnit).toHaveBeenCalledWith('podium-blue-redeploy.service')
    vi.useRealTimers()
  })

  it('restarts the web unit when only the dist is behind', async () => {
    vi.useFakeTimers()
    const startUnit = vi.fn()
    const request = createSourceWebRebuildRequest({
      instanceId: 'default',
      env: { INVOCATION_ID: 'systemd-run' },
      delayMs: 750,
      startUnit,
    })

    request?.()
    await vi.advanceTimersByTimeAsync(750)
    expect(startUnit).toHaveBeenCalledWith('podium-web.service')
    vi.useRealTimers()
  })
})
