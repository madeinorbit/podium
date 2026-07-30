/**
 * THE CONTRACTED WRITE SURFACE, AT THE SERVICE (POD-420).
 *
 * The planner in `@podium/commands` refuses an offline secret write on the
 * CLIENT. This file is the other half — the server-side property that holds
 * whatever the client does, because a client is not an authorization boundary:
 *
 *   **`settings.set` cannot write a secret at all.**
 *
 * The suite is built so its refusals can each say YES and NO:
 *
 *  - the blob write REFUSES a changed secret …and ACCEPTS the same blob with the
 *    secret unchanged, or the guard would be satisfied by one that refuses every
 *    blob write and the shipped clients (which round-trip the whole object)
 *    would all be broken;
 *  - `setSecret` WRITES the material …and returns a projection that does not
 *    contain it;
 *  - the preference patch APPLIES a real leaf …and REFUSES a value the model's
 *    own schema rejects, so "it wrote something" is not the only thing proved.
 */

import { SERVER_SECRET_KEYS } from '@podium/model'
import { normalizeSettings, type PodiumSettings } from '@podium/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../bus'
import { SettingsService } from './service'

/** The store surface the service persists through, in memory. */
function makeStore() {
  let settings = normalizeSettings({})
  let catalog: unknown = null
  return {
    getSettings: (): PodiumSettings => settings,
    setSettings: (next: PodiumSettings): void => {
      settings = next
    },
    // biome-ignore lint/suspicious/noExplicitAny: the catalog shape is the model
    // catalog's and is irrelevant here; the service only round-trips it.
    getModelCatalog: (): any => catalog,
    // biome-ignore lint/suspicious/noExplicitAny: as above.
    setModelCatalog: (snapshot: any): void => {
      catalog = snapshot
    },
  }
}

const FINGERPRINT_KEY = Buffer.from('c'.repeat(64), 'hex')

let store: ReturnType<typeof makeStore>
let bus: EventBus
let service: SettingsService

beforeEach(() => {
  store = makeStore()
  bus = new EventBus()
  service = new SettingsService(store, bus, {
    fingerprintKey: () => FINGERPRINT_KEY,
    now: () => Date.parse('2026-07-30T12:00:00.000Z'),
    modelProbe: { list: vi.fn(async () => []) } as never,
  })
})

describe('the blob write may not carry a secret', () => {
  it('ACCEPTS a blob whose secrets are unchanged — the shipped clients round-trip them', () => {
    // The positive control. Without it, a guard that refused every `settings.set`
    // would satisfy every refusal below while breaking the sidebar, the
    // auto-continue dialog and the engine.
    const current = service.getSettings()
    const saved = service.setSettings({
      ...current,
      sidebar: { ...current.sidebar, repoSort: 'alphabetical' },
    })
    expect(saved.sidebar.repoSort).toBe('alphabetical')
  })

  it('REFUSES a changed secret, naming the KEY and never the value', () => {
    const current = service.getSettings()
    expect(() =>
      service.setSettings({
        ...current,
        apiKeys: { ...current.apiKeys, openai: 'sk-smuggled-through-the-blob' },
      }),
    ).toThrow(/may not write server-owned secrets \(apiKeys\.openai\)/)
    // The material is not in the message, and it is not in the store.
    expect(() =>
      service.setSettings({
        ...current,
        apiKeys: { ...current.apiKeys, openai: 'sk-smuggled-through-the-blob' },
      }),
    ).not.toThrow(/sk-smuggled/)
    expect(service.getSettings().apiKeys.openai).toBe('')
  })

  it('REFUSES a CLEARED secret too — a removal is a change', () => {
    service.setSecret('apiKeys.anthropic', 'sk-configured')
    const current = service.getSettings()
    expect(() =>
      service.setSettings({ ...current, apiKeys: { ...current.apiKeys, anthropic: '' } }),
    ).toThrow(/apiKeys\.anthropic/)
    expect(service.getSettings().apiKeys.anthropic).toBe('sk-configured')
  })

  it('refuses EVERY secret key, not just the one someone remembered', () => {
    const base = service.getSettings()
    const mutated: PodiumSettings[] = [
      { ...base, apiKeys: { ...base.apiKeys, openrouter: 'x' } },
      { ...base, apiKeys: { ...base.apiKeys, anthropic: 'x' } },
      { ...base, apiKeys: { ...base.apiKeys, openai: 'x' } },
      { ...base, integrations: { ...base.integrations, linearApiKey: 'x' } },
      { ...base, notifications: { ...base.notifications, telegramBotToken: 'x' } },
    ]
    // One case per member of the model's closed vocabulary — asserted, so a
    // secret added to the model without a case here is a failure rather than a
    // silently unchecked key.
    expect(mutated).toHaveLength(SERVER_SECRET_KEYS.length)
    for (const next of mutated) expect(() => service.setSettings(next)).toThrow(/server-owned/)
  })

  it('lets a NON-secret member of the same nested object through', () => {
    // `notifications` holds a secret (`telegramBotToken`) beside routing
    // (`telegramChatId`) — one object, two matrix rows. The guard must be about
    // the LEAF, not about the object that contains one.
    const current = service.getSettings()
    const saved = service.setSettings({
      ...current,
      notifications: { ...current.notifications, telegramChatId: '-100999' },
    })
    expect(saved.notifications.telegramChatId).toBe('-100999')
  })
})

describe('setSecret / clearSecret are the only path to material', () => {
  it('writes the material and returns a projection WITHOUT it', () => {
    const wire = service.setSecret('apiKeys.openai', 'sk-live-value')
    expect(service.getSettings().apiKeys.openai).toBe('sk-live-value')
    expect(wire.key).toBe('apiKeys.openai')
    expect(wire.present).toBe(true)
    expect(wire.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(wire)).not.toContain('sk-live-value')
  })

  it('the fingerprint changes on rotation and is stable without one', () => {
    const first = service.setSecret('apiKeys.openai', 'sk-one')
    const again = service.setSecret('apiKeys.openai', 'sk-one')
    const rotated = service.setSecret('apiKeys.openai', 'sk-two')
    expect(again.fingerprint).toBe(first.fingerprint)
    expect(rotated.fingerprint).not.toBe(first.fingerprint)
  })

  it('clearSecret removes it and reports absence', () => {
    service.setSecret('integrations.linearApiKey', 'lin_api_x')
    const wire = service.clearSecret('integrations.linearApiKey')
    expect(service.getSettings().integrations.linearApiKey).toBe('')
    expect(wire).toEqual({
      key: 'integrations.linearApiKey',
      present: false,
      fingerprint: null,
      updatedAt: null,
    })
  })

  it('emits settings.changed, so subscribers react whichever command wrote', () => {
    // The bot token's own consumers (notification replay, the messaging bridge)
    // must not care which command configured it.
    const seen: string[] = []
    bus.on('settings.changed', () => seen.push('changed'))
    service.setSecret('notifications.telegramBotToken', '123:abc')
    service.clearSecret('notifications.telegramBotToken')
    expect(seen).toEqual(['changed', 'changed'])
  })
})

describe('the preference patch applies by path and validates by model', () => {
  it('APPLIES a real leaf without disturbing its siblings', () => {
    const before = service.getSettings()
    const saved = service.updatePreferences({ 'roles.coding.model': 'opus' })
    expect(saved.roles.coding.model).toBe('opus')
    expect(saved.roles.coding.effort).toBe(before.roles.coding.effort)
    expect(saved.sidebar.repoSort).toBe(before.sidebar.repoSort)
  })

  it('applies several paths across nested objects in one call', () => {
    const saved = service.updatePreferences({
      'sidebar.repoSort': 'alphabetical',
      'gitWorkflow.mergeStyle': 'pr',
    })
    expect(saved.sidebar.repoSort).toBe('alphabetical')
    expect(saved.gitWorkflow.mergeStyle).toBe('pr')
  })

  it('REFUSES a value the model rejects — the parse is the value gate', () => {
    // The contract decides ADDRESSES and the model decides VALUE TYPES. Without
    // this the patch would be an untyped write into the blob.
    expect(() => service.updatePreferences({ 'hibernation.memoryPct': 'not a number' })).toThrow()
    expect(() => service.updatePreferences({ 'gitWorkflow.mergeStyle': 'octopus' })).toThrow()
    expect(service.getSettings().gitWorkflow.mergeStyle).toBe('ff-only')
  })

  it('cannot be used to write a secret — it goes through the blob guard', () => {
    // Belt and braces: the command's input schema already refuses a secret path,
    // so this asks whether the HANDLER would too if something reached it.
    expect(() => service.updatePreferences({ 'apiKeys.openai': 'sk-via-patch' })).toThrow(
      /server-owned secrets/,
    )
    expect(service.getSettings().apiKeys.openai).toBe('')
  })
})
