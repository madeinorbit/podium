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

import { applySettingsPatch, changedSettingsLeaves } from '@podium/commands/settings-write-plan'
import { DEFAULT_SETTINGS, normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { refusalMessage, saveSettingsAsCommands, settingsChange } from './save-settings'

function fakeTrpc() {
  // My personal leaves are an edit of my `userPreferences` record (POD-6673),
  // handed to the save as its `personal` writer.
  const updatePersonal = vi.fn(async (_input: { values: Record<string, unknown> }) => {})
  // The instance leaves are an edit of the `instancePreferences` record
  // (POD-6677), handed to the save as its `instance` writer.
  const updateInstance = vi.fn(async (_input: { values: Record<string, unknown> }) => {})
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
      setSecret: { mutate: setSecret },
      clearSecret: { mutate: clearSecret },
    },
  } as unknown as Trpc
  PERSONAL.set(trpc, async (values) => await updatePersonal({ values: { ...values } }))
  INSTANCE.set(trpc, async (values) => await updateInstance({ values: { ...values } }))
  return { trpc, updatePersonal, updateInstance, setSecret, clearSecret }
}

const PERSONAL = new WeakMap<Trpc, (values: Readonly<Record<string, unknown>>) => Promise<void>>()
const INSTANCE = new WeakMap<Trpc, (values: Readonly<Record<string, unknown>>) => Promise<void>>()
/** The save as the settings screen calls it: with the two records' writers. */
const save = (
  trpc: Trpc,
  previous: Parameters<typeof saveSettingsAsCommands>[1],
  next: Parameters<typeof saveSettingsAsCommands>[2],
  options: { online: boolean },
) =>
  saveSettingsAsCommands(trpc, previous, next, {
    ...options,
    personal: PERSONAL.get(trpc),
    instance: INSTANCE.get(trpc),
  })

const base = normalizeSettings({})

describe('resetting absent-default instance settings', () => {
  it('sends every optional instance clear as a reset of the instance record and advances the saved baseline', async () => {
    const { trpc, updatePersonal, updateInstance, setSecret, clearSecret } = fakeTrpc()
    const previous = normalizeSettings({
      transcripts: { mirror: false },
      deployment: {
        authOpenMode: true,
        updateChannel: 'dev',
        connectEnabled: false,
        telemetryUsage: 'off',
        telemetryCrash: 'on',
        telemetryInstallId: 'saved-install',
        telemetrySince: 0,
      },
    })
    const result = await save(trpc, previous, DEFAULT_SETTINGS, { online: true })
    expect(updateInstance).toHaveBeenCalledExactlyOnceWith({
      values: {
        'transcripts.mirror': undefined,
        'deployment.authOpenMode': undefined,
        'deployment.updateChannel': undefined,
        'deployment.connectEnabled': undefined,
        'deployment.telemetryUsage': undefined,
        'deployment.telemetryCrash': undefined,
        'deployment.telemetryInstallId': undefined,
        'deployment.telemetrySince': undefined,
      },
    })
    expect(updatePersonal).not.toHaveBeenCalled()
    expect(setSecret).not.toHaveBeenCalled()
    expect(clearSecret).not.toHaveBeenCalled()
    expect(result.refusals).toEqual([])
    expect(result.saved).toEqual(DEFAULT_SETTINGS)
  })
})

describe('offline, a secret never leaves the machine', () => {
  it('does NOT call setSecret, and reports the refusal', async () => {
    const { trpc, setSecret, clearSecret } = fakeTrpc()
    const next = { ...base, apiKeys: { ...base.apiKeys, openai: 'sk-live-new' } }
    const result = await save(trpc, base, next, { online: false })
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
    const result = await save(trpc, base, next, { online: false })
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
    const result = await save(trpc, base, next, { online: true })
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
    const result = await save(trpc, configured, base, { online: true })
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
    await save(trpc, base, next, { online: true })
    expect(updatePersonal).toHaveBeenCalledWith({ values: { 'sidebar.repoSort': 'alphabetical' } })
    expect(updateInstance).toHaveBeenCalledWith({ values: { 'gitWorkflow.mergeStyle': 'pr' } })
  })

  it('sends NOTHING when nothing changed', async () => {
    const { trpc, updatePersonal, updateInstance, setSecret, clearSecret } = fakeTrpc()
    const result = await save(trpc, base, { ...base }, { online: true })
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
    await save(trpc, base, next, { online: true })
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

describe('one control and its inverse', () => {
  const permitted = {
    'records.userPreferences.edit': true,
    'records.instancePreferences.edit': true,
  }
  it('plans the same leaves as the former form diff, without staging', async () => {
    const { trpc, updateInstance } = fakeTrpc()
    const patch = { hibernation: { ...base.hibernation, enabled: false } }
    const change = settingsChange(base, patch)
    expect(change.paths).toEqual(
      changedSettingsLeaves(base, { ...base, ...patch }).map((leaf) => leaf.path),
    )
    await change.save(trpc, () => base, { instance: INSTANCE.get(trpc) }, permitted)
    expect(updateInstance).toHaveBeenCalledExactlyOnceWith({
      values: { 'hibernation.enabled': false },
    })
  })
  it('undoes only this control and keeps concurrent changes from another device', async () => {
    const { trpc } = fakeTrpc()
    let record = normalizeSettings({})
    const personal = vi.fn(async (values: Readonly<Record<string, unknown>>) => {
      record = applySettingsPatch(record, values)
    })
    const undo = await settingsChange(record, {
      notifications: { ...record.notifications, ntfyTopic: 'new-topic' },
    }).save(trpc, () => record, { personal }, permitted)
    record = applySettingsPatch(record, { 'notifications.web': false, 'hibernation.memoryPct': 90 })
    await undo()
    expect(personal).toHaveBeenLastCalledWith({ 'notifications.ntfyTopic': '' })
    expect(record.notifications.web).toBe(false)
    expect(record.hibernation.memoryPct).toBe(90)
  })
  it('resets an optional instance leaf when Undo returns it to its absent default', async () => {
    const { trpc } = fakeTrpc()
    let record = normalizeSettings({})
    const instance = vi.fn(async (values: Readonly<Record<string, unknown>>) => {
      record = applySettingsPatch(record, values)
    })
    const undo = await settingsChange(record, { transcripts: { mirror: false } }).save(
      trpc,
      () => record,
      { instance },
      permitted,
    )
    expect(instance).toHaveBeenCalledWith({ 'transcripts.mirror': false })
    await undo()
    expect(instance).toHaveBeenLastCalledWith({ 'transcripts.mirror': undefined })
  })
  it('never issues a record write the viewer cannot use', async () => {
    const { trpc, updateInstance } = fakeTrpc()
    await expect(
      settingsChange(base, { hibernation: { ...base.hibernation, enabled: false } }).save(
        trpc,
        () => base,
        { instance: INSTANCE.get(trpc) },
        {},
      ),
    ).rejects.toThrow('permission')
    expect(updateInstance).not.toHaveBeenCalled()
  })
  it('propagates a refused write instead of producing an Undo action', async () => {
    const { trpc } = fakeTrpc()
    const instance = vi.fn(async () => {
      throw new Error('locked by the deployment')
    })
    await expect(
      settingsChange(base, { transcripts: { mirror: false } }).save(
        trpc,
        () => base,
        { instance },
        permitted,
      ),
    ).rejects.toThrow('locked by the deployment')
  })
})
