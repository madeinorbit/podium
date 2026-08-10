import { describe, expect, it, vi } from 'vitest'
import { createSourceRedeployRequest, sourceRedeployUnit } from './source-redeploy'

describe('source coordinator redeploy', () => {
  it('uses the instance-scoped redeploy unit name', () => {
    expect(sourceRedeployUnit('default')).toBe('podium-redeploy.service')
    expect(sourceRedeployUnit('blue')).toBe('podium-blue-redeploy.service')
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
    expect(startUnit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(750)
    expect(startUnit).toHaveBeenCalledWith('podium-blue-redeploy.service')
    vi.useRealTimers()
  })
})
