/**
 * THE SAVE PATH, AND THE ONE ASSERTION THE ACCEPTANCE CRITERION TURNS ON:
 * offline, the secret mutation IS NEVER CALLED.
 *
 * "The user saw an error" is not the property that matters — a client that
 * displayed a message and sent the request anyway would satisfy a
 * message-shaped test perfectly. What must be true is that the credential does
 * not leave the machine, so the spies below assert the CALLS, and every refusal
 * case is paired with the online case that proves the same call happens when it
 * is allowed to.
 */

import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { refusalMessage, saveSettingsAsCommands } from './save-settings'

function fakeTrpc() {
  const updatePersonal = vi.fn(async ({ values }: { values: Record<string, unknown> }) =>
    normalizeSettings({ sidebar: { repoSort: values['sidebar.repoSort'] ?? 'lastUsed' } }),
  )
  const updateInstance = vi.fn(async () => normalizeSettings({}))
  const setSecret = vi.fn(async () => ({
    key: 'apiKeys.openai',
    present: true,
    fingerprint: 'deadbeefdeadbeef',
    updatedAt: '2026-07-30T00:00:00.000Z',
  }))
  const clearSecret = vi.fn(async () => ({
    key: 'apiKeys.openai',
    present: false,
    fingerprint: null,
    updatedAt: null,
  }))
  const trpc = {
    settings: {
      updatePersonal: { mutate: updatePersonal },
      updateInstance: { mutate: updateInstance },
      setSecret: { mutate: setSecret },
      clearSecret: { mutate: clearSecret },
    },
  } as unknown as Trpc
  return { trpc, updatePersonal, updateInstance, setSecret, clearSecret }
}

const base = normalizeSettings({})

describe('offline, a secret never leaves the machine', () => {
  it('does NOT call setSecret, and reports the refusal', async () => {
    const { trpc, setSecret, clearSecret } = fakeTrpc()
    const next = { ...base, apiKeys: { ...base.apiKeys, openai: 'sk-live-new' } }
    const result = await saveSettingsAsCommands(trpc, base, next, { online: false })
    expect(setSecret).not.toHaveBeenCalled()
    expect(clearSecret).not.toHaveBeenCalled()
    expect(result.refusals.map((r) => r.path)).toEqual(['apiKeys.openai'])
    // The baseline does NOT advance past the refused field, so the form stays
    // dirty and the user's typed value is not silently treated as saved.
    expect(result.saved.apiKeys.openai).toBe('')
  })

  it('… while a preference in the same save IS written', async () => {
    // Without this, "does not call setSecret" is satisfied by a save that calls
    // nothing at all.
    const { trpc, updatePersonal, setSecret } = fakeTrpc()
    const next = {
      ...base,
      sidebar: { ...base.sidebar, repoSort: 'alphabetical' as const },
      apiKeys: { ...base.apiKeys, openai: 'sk-live-new' },
    }
    const result = await saveSettingsAsCommands(trpc, base, next, { online: false })
    expect(updatePersonal).toHaveBeenCalledWith({ values: { 'sidebar.repoSort': 'alphabetical' } })
    expect(setSecret).not.toHaveBeenCalled()
    expect(result.refusals).toHaveLength(1)
  })

  it('the refusal message names the field and says why', () => {
    const message = refusalMessage([
      {
        path: 'apiKeys.openai',
        reason: 'requires-connection',
        message: 'irrelevant — the bar composes its own line',
      },
    ])
    expect(message).toContain('apiKeys.openai')
    expect(message).toContain('offline')
    expect(message).toContain('never queued')
  })

  it('no refusals means no message — the bar shows its normal state', () => {
    expect(refusalMessage([])).toBeNull()
  })
})

describe('online, the commands are issued — one per tier, one per secret', () => {
  it('calls setSecret with the material and folds it into the baseline', async () => {
    const { trpc, setSecret } = fakeTrpc()
    const next = { ...base, apiKeys: { ...base.apiKeys, openai: 'sk-live-new' } }
    const result = await saveSettingsAsCommands(trpc, base, next, { online: true })
    expect(setSecret).toHaveBeenCalledWith({ key: 'apiKeys.openai', value: 'sk-live-new' })
    expect(result.refusals).toEqual([])
    // The secret command answers with a PRESENCE projection and never the
    // material, so the baseline is brought forward from what was sent — without
    // this the form would stay permanently dirty after a successful save.
    expect(result.saved.apiKeys.openai).toBe('sk-live-new')
  })

  it('an EMPTIED secret calls clearSecret, never setSecret with an empty value', async () => {
    const { trpc, setSecret, clearSecret } = fakeTrpc()
    const configured = { ...base, apiKeys: { ...base.apiKeys, openai: 'sk-old' } }
    const result = await saveSettingsAsCommands(trpc, configured, base, { online: true })
    expect(clearSecret).toHaveBeenCalledWith({ key: 'apiKeys.openai' })
    expect(setSecret).not.toHaveBeenCalled()
    expect(result.saved.apiKeys.openai).toBe('')
  })

  it('splits a mixed edit across the two preference commands', async () => {
    const { trpc, updatePersonal, updateInstance } = fakeTrpc()
    const next = {
      ...base,
      sidebar: { ...base.sidebar, repoSort: 'alphabetical' as const },
      gitWorkflow: { ...base.gitWorkflow, mergeStyle: 'pr' as const },
    }
    await saveSettingsAsCommands(trpc, base, next, { online: true })
    expect(updatePersonal).toHaveBeenCalledWith({ values: { 'sidebar.repoSort': 'alphabetical' } })
    expect(updateInstance).toHaveBeenCalledWith({ values: { 'gitWorkflow.mergeStyle': 'pr' } })
  })

  it('sends NOTHING when nothing changed', async () => {
    const { trpc, updatePersonal, updateInstance, setSecret, clearSecret } = fakeTrpc()
    const result = await saveSettingsAsCommands(trpc, base, { ...base }, { online: true })
    for (const spy of [updatePersonal, updateInstance, setSecret, clearSecret]) {
      expect(spy).not.toHaveBeenCalled()
    }
    expect(result.refusals).toEqual([])
  })

  it('never sends a secret through a preference command', async () => {
    // The property POD-352 named, asserted at the CALL: whatever the planner
    // decides, no api key may appear in an updatePersonal/updateInstance payload.
    const { trpc, updatePersonal, updateInstance } = fakeTrpc()
    const next = {
      ...base,
      sidebar: { ...base.sidebar, repoSort: 'alphabetical' as const },
      apiKeys: { ...base.apiKeys, openai: 'sk-live-new' },
      integrations: { ...base.integrations, linearApiKey: 'lin_api_x' },
    }
    await saveSettingsAsCommands(trpc, base, next, { online: true })
    for (const spy of [updatePersonal, updateInstance]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('sk-live-new')
        expect(JSON.stringify(call)).not.toContain('lin_api_x')
        expect(JSON.stringify(call)).not.toContain('apiKeys')
      }
    }
    // …and the spies were actually called, so the loop above is not empty.
    expect(updatePersonal).toHaveBeenCalledTimes(1)
  })
})
