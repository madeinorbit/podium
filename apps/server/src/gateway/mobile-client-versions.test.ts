import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MobileClientVersions,
  type MobileVersionHistory,
  mobileVersionReport,
} from './mobile-client-versions'

const DAY = 86_400_000
const start = Date.parse('2026-10-01T00:00:00Z')
const roots: string[] = []
const trackers: MobileClientVersions[] = []
afterEach(() => {
  for (const tracker of trackers.splice(0)) tracker.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mobile-versions-'))
  roots.push(root)
  const path = join(root, 'versions.json')
  let now = start
  const tracker = new MobileClientVersions(path, () => now)
  trackers.push(tracker)
  return {
    tracker,
    path,
    setNow: (time: number) => {
      now = time
    },
    read: () => JSON.parse(readFileSync(path, 'utf8')) as MobileVersionHistory,
  }
}

function quiet(now: number): MobileVersionHistory {
  return { schema: 1, observedSince: start, updatedAt: now, versions: [] }
}

describe('mobile release adoption evidence', () => {
  it('requires seven complete days since the release and last unsupported connection', () => {
    const seen = start + DAY
    const history = quiet(seen + 7 * DAY - 1)
    history.versions = [
      {
        appVersion: '1.0.0+12',
        firstSeenAt: start,
        lastSeenAt: seen,
        connections: 2,
        connected: 0,
      },
    ]
    expect(mobileVersionReport(history, '1.0.0+13', start, history.updatedAt).step7Ready).toBe(
      false,
    )
    history.updatedAt++
    expect(mobileVersionReport(history, '1.0.0+13', start, history.updatedAt).step7Ready).toBe(true)
    // A later TestFlight release cannot inherit the first release's quiet window.
    expect(
      mobileVersionReport(history, '1.0.0+14', history.updatedAt, history.updatedAt).step7Ready,
    ).toBe(false)
  })

  it('compares native build numbers numerically and leaves unstamped/mobile-web builds unsupported unless declared', () => {
    const now = start + 8 * DAY
    const history = quiet(now)
    history.versions = [
      '1.0.0+9',
      '1.0.0+12',
      '1.0.0+13',
      '1.0.0+100',
      'dev',
      'dev+web',
      'unidentified',
    ].map((appVersion) => ({
      appVersion,
      firstSeenAt: start,
      lastSeenAt: now,
      connections: 1,
      connected: 0,
    }))
    const report = mobileVersionReport(history, '1.0.0+13', start, now, ['dev+web'])
    expect(report.versions.filter((row) => row.supported).map((row) => row.appVersion)).toEqual([
      '1.0.0+13',
      '1.0.0+100',
      'dev+web',
    ])
    expect(report.step7Ready).toBe(false)
  })

  it('does not pass from a stale server snapshot or a still-connected older build', () => {
    const now = start + 8 * DAY
    expect(mobileVersionReport(quiet(now - 120_001), '1.0.0+13', start, now).step7Ready).toBe(false)
    const history = quiet(now)
    history.versions = [
      {
        appVersion: 'unknown',
        firstSeenAt: start,
        lastSeenAt: start,
        connections: 1,
        connected: 1,
      },
    ]
    expect(mobileVersionReport(history, '1.0.0+13', start, now)).toMatchObject({
      connectedOlder: 1,
      step7Ready: false,
    })
  })

  it('retains the last connection after disconnect, and reports simultaneous versions', () => {
    const { tracker, read, setNow } = fixture()
    tracker.connected('old', { role: 'mobile', v: '1.0.0+12' })
    tracker.connected('new', { role: 'mobile', v: '1.0.0+13' })
    tracker.connected('desktop', { role: 'web', v: 'dev' })
    setNow(start + 30_000)
    tracker.disconnected('old')
    expect(read().versions).toEqual([
      {
        appVersion: '1.0.0+12',
        firstSeenAt: start,
        lastSeenAt: start + 30_000,
        connections: 1,
        connected: 0,
      },
      {
        appVersion: '1.0.0+13',
        firstSeenAt: start,
        lastSeenAt: start + 30_000,
        connections: 1,
        connected: 1,
      },
    ])
  })

  it('heartbeats a quiet older socket, rather than aging it out after hello', () => {
    const { tracker, read, setNow } = fixture()
    tracker.connected('old', { role: 'mobile', v: '1.0.0+12' })
    setNow(start + 60_000)
    tracker.checkpoint()
    expect(read().versions[0]).toMatchObject({ lastSeenAt: start + 60_000, connected: 1 })
    setNow(start + 3 * DAY)
    tracker.checkpoint()
    expect(read().observedSince).toBe(start + 3 * DAY)
  })

  it('keeps historical distribution over restart, but starts a new coverage window', () => {
    const { tracker, read, path, setNow } = fixture()
    tracker.connected('old', { role: 'mobile', v: 'dev' })
    tracker.close()
    setNow(start + DAY)
    const replacement = new MobileClientVersions(path, () => start + DAY)
    trackers.push(replacement)
    expect(read()).toMatchObject({
      observedSince: start + DAY,
      versions: [{ appVersion: 'dev', connections: 1, connected: 0 }],
    })
  })

  it('records unidentified connections conservatively and keeps instance files separate', () => {
    const one = fixture()
    const two = fixture()
    one.tracker.connected('unknown', undefined)
    expect(one.read().versions[0]?.appVersion).toBe('unidentified')
    expect(two.read().versions).toEqual([])
  })
})
