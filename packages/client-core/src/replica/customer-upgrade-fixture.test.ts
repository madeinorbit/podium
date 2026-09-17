/**
 * THE CUSTOMER UPGRADE, client arm [POD-3974]. Acceptance matrix row (design
 * rev 23, Part B): "Web: full localStorage under old namespace; sign-out of
 * successor — boot succeeds; old namespace expires; documented what remains".
 *
 * WHAT BOOTS. A localStorage holding the retired principal's namespace as the
 * incident left it (root cause 2, 2026-09-14): the device is full, so the
 * successor's first marker write throws QuotaExceededError. The storage here
 * counts bytes and throws exactly like a browser at its quota; nothing about
 * the namespace policy is replaced. The successor principal is the member the
 * upgraded database mints, read from the shared fixture's server arm contract
 * rather than typed here.
 */

import { firstAdminMemberId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { localStorage as captured, manifest } from '../../../runtime/src/fixtures/customer-upgrade'
import type { StorageApi } from './contract'
import {
  inspectPrincipalNamespaces,
  preparePrincipalNamespace,
  principalKeyPrefix,
} from '../principal-storage'

const OLD = manifest.client.oldNamespacePrefix
const BASE = manifest.client.basePrefix
const DAY = 24 * 60 * 60 * 1000
/** The moment the incident's deploy booted the upgraded web client. */
const UPGRADE_AT = Date.parse('2026-09-14T09:22:00.000Z')

/** A device at its quota: the captured keys fit exactly; one more byte throws. */
function fullDevice(headroom = 0): { api: StorageApi; keys: () => string[]; used: () => number } {
  const values = new Map<string, string>(Object.entries(captured))
  const used = () => [...values.entries()].reduce((n, [k, v]) => n + k.length + v.length, 0)
  const budget = used() + headroom
  return {
    api: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        const without = used() - (values.has(key) ? key.length + values.get(key)!.length : 0)
        if (without + key.length + value.length > budget) {
          const err = new Error('QuotaExceededError')
          err.name = 'QuotaExceededError'
          throw err
        }
        values.set(key, value)
      },
      removeItem: (key: string) => void values.delete(key),
    },
    keys: () => [...values.keys()],
    used,
  }
}

const boot = (device: ReturnType<typeof fullDevice>, principal: string, now: number) =>
  preparePrincipalNamespace({
    storage: device.api,
    enumerateKeys: device.keys,
    basePrefix: BASE,
    principal,
    now: () => now,
  })

describe('customer upgrade fixture: client', () => {
  it('holds the captured shape: the retired namespace fills the device, recently used, no successor marker', () => {
    const device = fullDevice()
    expect(device.keys().filter((key) => key.startsWith(OLD)).length).toBeGreaterThanOrEqual(5)
    expect(device.api.getItem(`${OLD}.namespace.v1`)).toContain(manifest.retiredPrincipal)
    expect(device.keys().some((key) => key.startsWith(`${BASE}.principal.mem_`))).toBe(false)
    expect(() => device.api.setItem('probe', 'x')).toThrow('QuotaExceededError')
    // The retired marker is RECENT relative to the upgrade: time-based retention alone keeps it.
    const marker = JSON.parse(device.api.getItem(`${OLD}.namespace.v1`)!) as { lastUsedAt: number }
    expect(UPGRADE_AT - marker.lastUsedAt).toBeLessThan(30 * DAY)
  })

  it('boots on the full device: the successor marker is durable after the old namespace gives way', () => {
    const device = fullDevice()
    const member = firstAdminMemberId()
    const successor = boot(device, member, UPGRADE_AT)
    expect(successor.durable).toBe(true)
    expect(successor.evictedPrincipals).toEqual([manifest.retiredPrincipal])
    expect(successor.keyPrefix).toBe(principalKeyPrefix(BASE, member))
    expect(device.api.getItem(`${successor.keyPrefix}.namespace.v1`)).toContain(member)
    // The old namespace expired in full; the pre-auth theme key is untouched.
    expect(device.keys().filter((key) => key.startsWith(OLD))).toEqual([])
    expect(device.api.getItem('podium-theme')).toBe('dark')
    // The offline gate now sees exactly one identity: no ambiguity, no danger screen.
    expect(inspectPrincipalNamespaces({ storage: device.api, enumerateKeys: device.keys, basePrefix: BASE })).toEqual([member])
  })

  it('same-identity bootstrap keeps the successor cache and evicts nothing', () => {
    const device = fullDevice()
    const member = firstAdminMemberId()
    const first = boot(device, member, UPGRADE_AT)
    expect(first.durable).toBe(true)
    device.api.setItem(`${first.keyPrefix}.cursor.v1`, '1')
    device.api.setItem(`${first.keyPrefix}.sessions.v1`, JSON.stringify(['s1']))
    const again = boot(device, member, UPGRADE_AT + DAY)
    expect(again.durable).toBe(true)
    expect(again.evictedPrincipals).toEqual([])
    expect(again.knownPrincipals).toEqual([member])
    expect(device.api.getItem(`${first.keyPrefix}.cursor.v1`)).toBe('1')
    expect(device.api.getItem(`${first.keyPrefix}.sessions.v1`)).toBe(JSON.stringify(['s1']))
    expect(JSON.parse(device.api.getItem(`${first.keyPrefix}.namespace.v1`)!)).toMatchObject({ lastUsedAt: UPGRADE_AT + DAY })
  })

  it('retention is unchanged: with room, a recent foreign namespace is kept for its 30 days', () => {
    const device = fullDevice(4096)
    const member = firstAdminMemberId()
    const successor = boot(device, member, UPGRADE_AT)
    expect(successor.durable).toBe(true)
    expect(successor.evictedPrincipals).toEqual([])
    expect(device.keys().some((key) => key.startsWith(OLD))).toBe(true)
    const later = boot(device, member, UPGRADE_AT + 31 * DAY)
    expect(later.evictedPrincipals).toEqual([manifest.retiredPrincipal])
    expect(device.keys().some((key) => key.startsWith(OLD))).toBe(false)
  })

  it('sign-out of the successor erases its namespace; what remains is documented', () => {
    const device = fullDevice()
    const member = firstAdminMemberId()
    const successor = boot(device, member, UPGRADE_AT)
    device.api.setItem(`${successor.keyPrefix}.cursor.v1`, '7')
    successor.erase()
    // Exactly the pre-auth theme key: no principal namespace, no marker, no ledger.
    expect(device.keys()).toEqual(['podium-theme'])
    expect(inspectPrincipalNamespaces({ storage: device.api, enumerateKeys: device.keys, basePrefix: BASE })).toEqual([])
  })
})
