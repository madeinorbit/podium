/** Server-side release evidence. Self-reported versions never authorize a client. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ClientLogOrigin } from '@podium/protocol'

const DAY = 86_400_000
export const MOBILE_OBSERVATION_MAX_GAP_MS = 120_000
export interface MobileVersionObservation {
  appVersion: string
  firstSeenAt: number
  lastSeenAt: number
  connections: number
  connected: number
}
export interface MobileVersionHistory {
  schema: 1
  observedSince: number
  updatedAt: number
  versions: MobileVersionObservation[]
}

/** Unknown native/web-mobile builds and unidentified connections fail the gate closed. */
export function mobileVersionReport(
  history: MobileVersionHistory,
  release: string,
  releasedAt: number,
  now: number,
  supportedWebVersions: readonly string[] = [],
) {
  const parse = (value: string): number[] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)\+(\d+)$/.exec(value)
    return match ? match.slice(1).map(Number) : undefined
  }
  const minimum = parse(release)
  if (!minimum || !Number.isFinite(releasedAt) || releasedAt > now) {
    throw new Error(
      'A native release version (marketing+build) and its past release time are required',
    )
  }
  const supported = (version: string): boolean => {
    if (supportedWebVersions.includes(version)) return true
    const candidate = parse(version)
    if (!candidate) return false
    for (let index = 0; index < minimum.length; index++) {
      const actual = candidate[index] ?? 0
      const expected = minimum[index] ?? 0
      if (actual !== expected) return actual > expected
    }
    return true
  }
  const versions = history.versions.map((row) => ({ ...row, supported: supported(row.appVersion) }))
  const unsupported = versions.filter((row) => !row.supported)
  const quietSince = Math.max(
    releasedAt,
    history.observedSince,
    ...unsupported.map((row) => row.lastSeenAt),
  )
  const observationCurrent =
    now >= history.updatedAt && now - history.updatedAt <= MOBILE_OBSERVATION_MAX_GAP_MS
  const connectedOlder = unsupported.reduce((sum, row) => sum + row.connected, 0)
  return {
    release,
    releasedAt: new Date(releasedAt).toISOString(),
    observedSince: new Date(history.observedSince).toISOString(),
    updatedAt: new Date(history.updatedAt).toISOString(),
    observationCurrent,
    connectedOlder,
    quietSince: new Date(quietSince).toISOString(),
    eligibleAt: new Date(quietSince + 7 * DAY).toISOString(),
    consecutiveQuietDays: Math.max(0, (now - quietSince) / DAY),
    step7Ready: observationCurrent && connectedOlder === 0 && now - quietSince >= 7 * DAY,
    versions: versions.map((row) => ({
      ...row,
      firstSeenAt: new Date(row.firstSeenAt).toISOString(),
      lastSeenAt: new Date(row.lastSeenAt).toISOString(),
    })),
  }
}

/** A bounded summary survives disconnects and server restarts. Coverage restarts after a gap. */
export class MobileClientVersions {
  private history: MobileVersionHistory
  private readonly clients = new Map<string, string>()
  private readonly timer: ReturnType<typeof setInterval>
  private persistedAt: number
  private healthy = true

  constructor(
    private readonly path: string,
    private readonly now = Date.now,
    interval = 60_000,
  ) {
    const time = now()
    let previous: MobileVersionHistory | undefined
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as MobileVersionHistory
      if (
        value.schema === 1 &&
        Number.isFinite(value.observedSince) &&
        Number.isFinite(value.updatedAt) &&
        Array.isArray(value.versions) &&
        value.versions.length <= 256 &&
        value.versions.every(
          (row) =>
            typeof row.appVersion === 'string' &&
            Number.isFinite(row.firstSeenAt) &&
            Number.isFinite(row.lastSeenAt) &&
            Number.isFinite(row.connections),
        )
      )
        previous = value
    } catch {
      /* Missing/corrupt evidence starts a new observation window. */
    }
    // Restart is a coverage boundary: no previous socket is still connected here.
    this.history = {
      schema: 1,
      observedSince: time,
      updatedAt: time,
      versions: (previous?.versions ?? []).map((row) => ({ ...row, connected: 0 })),
    }
    this.persistedAt = time
    this.checkpoint()
    this.timer = setInterval(() => this.checkpoint(), interval)
    this.timer.unref?.()
  }

  connected(clientId: string, origin: ClientLogOrigin | undefined): void {
    const version =
      origin?.role === 'mobile'
        ? origin.v?.trim() || 'unknown'
        : origin === undefined
          ? 'unidentified'
          : undefined
    const previous = this.clients.get(clientId)
    if (previous === version) return
    if (previous !== undefined) this.disconnected(clientId)
    if (version === undefined) return
    const time = this.now()
    let row = this.history.versions.find((item) => item.appVersion === version)
    if (!row) {
      // Overflow remains an unsupported observation, never an untracked connection.
      const key = this.history.versions.length >= 255 ? 'overflow' : version
      row = this.history.versions.find((item) => item.appVersion === key)
      if (!row) {
        row = { appVersion: key, firstSeenAt: time, lastSeenAt: time, connections: 0, connected: 0 }
        this.history.versions.push(row)
      }
    }
    row.connections++
    row.lastSeenAt = time
    this.clients.set(clientId, row.appVersion)
    this.checkpoint()
  }

  disconnected(clientId: string): void {
    const version = this.clients.get(clientId)
    if (version === undefined) return
    const row = this.history.versions.find((item) => item.appVersion === version)
    if (row) row.lastSeenAt = this.now()
    this.clients.delete(clientId)
    this.checkpoint()
  }

  /** Heartbeat records long-lived older clients, including ones that send no further frames. */
  checkpoint(): void {
    const time = this.now()
    if (
      !this.healthy ||
      time < this.persistedAt ||
      time - this.persistedAt > MOBILE_OBSERVATION_MAX_GAP_MS
    ) {
      this.history.observedSince = time
    }
    const counts = new Map<string, number>()
    for (const version of this.clients.values()) counts.set(version, (counts.get(version) ?? 0) + 1)
    for (const row of this.history.versions) {
      row.connected = counts.get(row.appVersion) ?? 0
      if (row.connected > 0) row.lastSeenAt = time
    }
    this.history.updatedAt = time
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.tmp`
      writeFileSync(temporary, JSON.stringify(this.history), { mode: 0o600 })
      renameSync(temporary, this.path)
      this.persistedAt = time
      this.healthy = true
    } catch {
      this.healthy = false
    }
  }

  close(): void {
    clearInterval(this.timer)
    this.checkpoint()
  }
}
