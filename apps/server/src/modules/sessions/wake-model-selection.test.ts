import { afterEach, describe, expect, it } from 'vitest'
import { asAccountId } from '@podium/model'
import { runSessionCli, type SessionControlClient } from '../../../../cli/src/session-cli'
import { MODEL_CATALOG_VERSION } from '../../model-catalog'
import { disposeOracles, makeOracle, type Oracle } from './oracle-support'

afterEach(() => disposeOracles())

async function setup(start: 'explicit' | 'auto' | 'settings' = 'auto') {
  const o = await makeOracle()
  await o.store.settings.setModelCatalog({
    machineId: o.store.hostMachineId, version: MODEL_CATALOG_VERSION, fetchedAt: Date.now(),
    byAgent: { codex: [
      { value: 'gpt-5.6', label: 'GPT-5.6', efforts: ['low', 'medium', 'high'] },
      { value: 'gpt-6-sol', label: 'GPT-6', efforts: ['low', 'medium', 'high'] },
    ] },
  })
  const settings = await o.store.settings.getSettings()
  await o.store.settings.setSettings({
    ...settings,
    roles: { ...settings.roles, coding: {
      ...settings.roles.coding, accountId: asAccountId('native:codex'), harness: 'codex',
      model: start === 'settings' ? 'gpt-6-sol' : 'auto',
      effort: start === 'settings' ? 'medium' : 'auto',
    } },
  })
  const { sessionId } = await o.call.sessions.create({
    agentKind: 'codex', cwd: '/p',
    ...(start === 'explicit' ? { model: 'gpt-5.6', effort: 'low' } : {}),
    ...(start === 'auto' ? { model: 'auto', effort: 'auto' } : {}),
  })
  await o.reg.gateway.routeDaemonFrame(o.store.hostMachineId, {
    type: 'bind', sessionId, cmd: 'codex', cwd: '/p', agentKind: 'codex',
    geometry: { cols: 80, rows: 24 },
  })
  await o.reg.gateway.routeDaemonFrame(o.store.hostMachineId, {
    type: 'sessionResumeRef', sessionId,
    resume: { kind: 'codex-thread', value: 'old-thread' },
  })
  const client = { sessions: {
    sendText: { mutate: o.call.sessions.sendText },
    resumeAndSend: { mutate: o.call.sessions.resumeAndSend },
  } } as unknown as SessionControlClient
  return { o, sessionId, client }
}

function spawns(o: Oracle) {
  return o.daemon.filter((frame) => frame.type === 'spawn')
}

async function park(o: Oracle, sessionId: Awaited<ReturnType<typeof setup>>['sessionId']) {
  expect(await o.call.sessions.hibernate({ sessionId })).toEqual({ ok: true })
  o.daemon.length = 0
}

describe('restart selection and explicit wake flags (POD-3911)', () => {
  it.each(['explicit', 'auto', 'settings'] as const)('restart omits both fields after a %s start', async (start) => {
    const { o, sessionId } = await setup(start)
    const first = spawns(o).at(-1)!
    if (start === 'explicit') expect(first).toMatchObject({ model: 'gpt-5.6', effort: 'low' })
    if (start === 'settings') expect(first).toMatchObject({ model: 'gpt-6-sol', effort: 'medium' })
    if (start === 'auto') {
      expect(Object.hasOwn(first, 'model')).toBe(false)
      expect(Object.hasOwn(first, 'effort')).toBe(false)
    }
    await park(o, sessionId)
    expect(await o.call.sessions.resurrect({ sessionId })).toEqual({ ok: true })
    expect(spawns(o)).toHaveLength(1)
    expect(Object.hasOwn(spawns(o)[0]!, 'model')).toBe(false)
    expect(Object.hasOwn(spawns(o)[0]!, 'effort')).toBe(false)
  })

  it.each([['send', '--wake'], ['resume-and-send']])('%s carries overrides through the server wake and persists the requested pair', async (...command) => {
    const { o, sessionId, client } = await setup('settings')
    await park(o, sessionId)
    await runSessionCli([...command, sessionId, '--text', 'hello',
      '--model', 'gpt-5.6', '--effort', 'high'], client)
    expect(spawns(o)).toHaveLength(1)
    expect(spawns(o)[0]).toMatchObject({ sessionId, model: 'gpt-5.6', effort: 'high' })
    expect(await o.store.sessions.getSession(sessionId)).toMatchObject({
      requestedModel: 'gpt-5.6', requestedEffort: 'high',
    })
    expect(await o.store.sync.listQueuedMessages(sessionId)).toHaveLength(1)
  })

  it('refuses an unknown explicit model before wake side effects with a suggestion', async () => {
    const { o, sessionId } = await setup()
    await park(o, sessionId)
    const before = await o.store.sessions.getSession(sessionId)
    await expect(o.call.sessions.resumeAndSend({ sessionId, text: 'hello', model: 'gpt-5.7' }))
      .rejects.toThrow(/unknown model "gpt-5.7".*Did you mean "gpt-5.6"/s)
    expect(spawns(o)).toHaveLength(0)
    expect(await o.store.sessions.getSession(sessionId)).toEqual(before)
    expect(await o.store.sync.listQueuedMessages(sessionId)).toHaveLength(0)
  })

  it('force allows an unknown explicit model on wake', async () => {
    const { o, sessionId, client } = await setup()
    await park(o, sessionId)
    await runSessionCli(['resume-and-send', sessionId, '--text', 'hello',
      '--model', 'gpt-6-experimental', '--force-unknown-model'], client)
    expect(spawns(o)).toHaveLength(1)
    expect(spawns(o)[0]?.model).toBe('gpt-6-experimental')
    expect(Object.hasOwn(spawns(o)[0]!, 'effort')).toBe(false)
    expect(await o.store.events.listEventsSince(0, { kinds: ['agent.model_forced'] }))
      .toEqual([expect.objectContaining({ subject: sessionId,
        payload: expect.objectContaining({ model: 'gpt-6-experimental' }),
      })])
  })

  it.each(['gpt-5.6', 'gpt-6-experimental'])('force never allows an unknown effort with %s', async (model) => {
    const { o, sessionId } = await setup()
    await park(o, sessionId)
    await expect(o.call.sessions.resumeAndSend({
      sessionId, text: 'hello', model, effort: 'highh', forceUnknownModel: true,
    })).rejects.toThrow(/unknown effort "highh".*Did you mean "high"/s)
    expect(spawns(o)).toHaveLength(0)
    expect(await o.store.sync.listQueuedMessages(sessionId)).toHaveLength(0)
  })

  it.each([['send'], ['send', '--wake'], ['resume-and-send']])('%s refuses flags on a live session without queueing', async (...command) => {
    const { o, sessionId, client } = await setup()
    o.daemon.length = 0
    await expect(runSessionCli([...command, sessionId, '--text', 'hello',
      '--model', 'gpt-5.6', '--effort', 'high'], client))
      .rejects.toThrow(/apply only when the session is woken.*already running/)
    expect(spawns(o)).toHaveLength(0)
    expect(await o.store.sync.listQueuedMessages(sessionId)).toHaveLength(0)
  })

  it.each(['model', 'effort'] as const)('waking with only %s never fills the other field from Settings', async (field) => {
    const { o, sessionId } = await setup('settings')
    await park(o, sessionId)
    await o.call.sessions.resumeAndSend({ sessionId, text: 'hello',
      ...(field === 'model' ? { model: 'gpt-5.6' } : { effort: 'high' }),
    })
    expect(spawns(o)).toHaveLength(1)
    expect(spawns(o)[0]?.[field]).toBe(field === 'model' ? 'gpt-5.6' : 'high')
    expect(Object.hasOwn(spawns(o)[0]!, field === 'model' ? 'effort' : 'model')).toBe(false)
  })
})
