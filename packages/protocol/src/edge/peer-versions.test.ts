import { describe, expect, it } from 'vitest'
import { PeerVersionTelemetry } from './peer-versions'

describe('minimum-connected-version telemetry', () => {
  it('reports null and permits any floor when nobody is connected', () => {
    const telemetry = new PeerVersionTelemetry()
    expect(telemetry.snapshot().minimum).toBeNull()
    expect(telemetry.snapshot().canRaiseFloorTo(2)).toBe(true)
  })

  it('reports the MINIMUM, not the mode — one stale peer decides', () => {
    const telemetry = new PeerVersionTelemetry()
    telemetry.connected('a', 2)
    telemetry.connected('b', 2)
    telemetry.connected('stale-pwa-tab', 1)
    const snapshot = telemetry.snapshot()
    expect(snapshot.minimum).toBe(1)
    expect(snapshot.totalPeers).toBe(3)
    expect(snapshot.byVersion).toEqual([
      { version: 1, peers: 1 },
      { version: 2, peers: 2 },
    ])
    // The rollout question. Two of three peers being current is not an answer.
    expect(snapshot.canRaiseFloorTo(2)).toBe(false)
  })

  it('answers YES once the last old peer disconnects', () => {
    const telemetry = new PeerVersionTelemetry()
    telemetry.connected('a', 2)
    telemetry.connected('stale-pwa-tab', 1)
    expect(telemetry.snapshot().canRaiseFloorTo(2)).toBe(false)
    telemetry.disconnected('stale-pwa-tab')
    expect(telemetry.snapshot().canRaiseFloorTo(2)).toBe(true)
    expect(telemetry.snapshot().minimum).toBe(2)
  })

  it('keys by CONNECTION, so one user with two tabs shows both versions', () => {
    // A cached PWA tab and a freshly loaded one are two live connections of one
    // person, and it is the cached one that a premature floor raise breaks.
    const telemetry = new PeerVersionTelemetry()
    telemetry.connected('tab-cached', 1)
    telemetry.connected('tab-fresh', 2)
    expect(telemetry.snapshot().totalPeers).toBe(2)
    expect(telemetry.snapshot().minimum).toBe(1)
  })

  it('re-registers a reconnecting connection id rather than double-counting it', () => {
    const telemetry = new PeerVersionTelemetry()
    telemetry.connected('a', 1)
    telemetry.connected('a', 2)
    expect(telemetry.snapshot().totalPeers).toBe(1)
    expect(telemetry.snapshot().minimum).toBe(2)
  })
})
