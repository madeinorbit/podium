/**
 * POD-4965: the header's offline chips name the machines still in use, not the
 * server's whole machine history. POD-4830's case (a daemon that just dropped)
 * keeps its chip; a row last seen weeks ago, revoked or replaced does not.
 */
import { describe, expect, it } from 'vitest'
import { HEADER_OFFLINE_WINDOW_MS, headerOfflineMachines } from './header-offline-machines'

const NOW = Date.parse('2026-09-30T14:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const machine = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  online: false,
  lastSeenAt: ago(60 * 1000),
  revokedAt: null,
  supersededBy: null,
  ...over,
})

const ids = (list: { id: string }[]) => list.map((m) => m.id)

describe('headerOfflineMachines', () => {
  it('keeps a machine that went offline minutes ago (POD-4830)', () => {
    expect(ids(headerOfflineMachines([machine('laptop')], new Set(), NOW))).toEqual(['laptop'])
  })

  it('keeps a supervised daemon loss: online, daemon down, seen just now', () => {
    const m = machine('box', { online: true, availability: { daemon: false }, lastSeenAt: ago(0) })
    expect(ids(headerOfflineMachines([m], new Set(), NOW))).toEqual(['box'])
  })

  it('keeps a machine closed for a weekend, drops one past the window', () => {
    const weekend = machine('weekend', { lastSeenAt: ago(3 * DAY) })
    const edge = machine('edge', { lastSeenAt: ago(HEADER_OFFLINE_WINDOW_MS) })
    const past = machine('past', { lastSeenAt: ago(HEADER_OFFLINE_WINDOW_MS + 1) })
    expect(ids(headerOfflineMachines([weekend, edge, past], new Set(), NOW))).toEqual([
      'weekend',
      'edge',
    ])
  })

  it('drops the retired rows that filled the header (last seen 31-51 days ago)', () => {
    const rows = [
      machine('old-mac-1', { lastSeenAt: ago(51 * DAY) }),
      machine('old-mac-2', { lastSeenAt: ago(33 * DAY) }),
      machine('old-mac-3', { lastSeenAt: ago(31 * DAY) }),
    ]
    expect(headerOfflineMachines(rows, new Set(), NOW)).toEqual([])
  })

  it('gives no offline chip to a machine never assigned to run agents', () => {
    const serverOnly = machine('server-only', {
      online: true,
      availability: { daemon: false },
      serviceAssignment: { agentExecution: false },
      lastSeenAt: ago(0),
    })
    const agentHost = machine('agent-host', {
      online: true,
      availability: { daemon: false },
      serviceAssignment: { agentExecution: true },
      lastSeenAt: ago(0),
    })
    expect(ids(headerOfflineMachines([serverOnly, agentHost], new Set(), NOW))).toEqual([
      'agent-host',
    ])
  })

  it('drops revoked and superseded machines however recent', () => {
    const revoked = machine('revoked', { revokedAt: ago(DAY) })
    const replaced = machine('replaced', { supersededBy: 'new-id' })
    expect(headerOfflineMachines([revoked, replaced], new Set(), NOW)).toEqual([])
  })

  it('leaves online machines and machines with a live sample to the live chip', () => {
    const online = machine('online', { online: true })
    const sampled = machine('sampled')
    expect(headerOfflineMachines([online, sampled], new Set(['sampled']), NOW)).toEqual([])
  })

  it('gives no chip when lastSeenAt proves nothing', () => {
    const bad = machine('bad', { lastSeenAt: 'not a date' })
    const missing = machine('missing', { lastSeenAt: undefined })
    expect(headerOfflineMachines([bad, missing], new Set(), NOW)).toEqual([])
  })

  it('accepts epoch milliseconds', () => {
    const m = machine('ms', { lastSeenAt: NOW - DAY })
    expect(ids(headerOfflineMachines([m], new Set(), NOW))).toEqual(['ms'])
  })
})
