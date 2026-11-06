import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acceptAgentObservation } from '@podium/harness'
import { ensurePodiumCodexHooks } from '@podium/harness/adapters/codex/instrumentation'
import { testHarnessContext } from '@podium/harness/driver/testing'
import type { StatTick } from '@podium/harness/store'
import { asSessionId } from '@podium/model'
import type { DurableAttachment } from '@podium/process/durable'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Only the OS answers are fixtures. Exercise the real owned resolver, adapter,
// daemon rebind/ack wiring, bootstrap fold, and transcript tail together.
const os = vi.hoisted(() => ({ paths: new Map<number, string[]>(), started: '', calls: 0 }))
vi.mock('../../../packages/harness/src/adapters/codex/owned-rollout.js', async (original) => {
  const actual =
    await original<typeof import('../../../packages/harness/src/adapters/codex/owned-rollout.js')>()
  return {
    ...actual,
    createOwnedCodexRolloutResolver: (
      input: Parameters<typeof actual.createOwnedCodexRolloutResolver>[0],
    ) =>
      actual.createOwnedCodexRolloutResolver({
        ...input,
        platform: 'darwin',
        inspect: async (command, args) => {
          os.calls++
          if (command === '/bin/ps') return `${args[1]} 1 ${os.started}\n`
          if (command === '/usr/bin/pgrep') return ''
          if (command === '/usr/sbin/lsof')
            return (
              `p${args[3]}\0\n` +
              (os.paths.get(Number(args[3])) ?? []).map((path, i) => `f${i}\0n${path}\0\n`).join('')
            )
          throw new Error('unexpected OS query')
        },
      }),
  }
})

import { createSessionObservers } from './session-observers'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  os.paths.clear()
  os.calls = 0
  vi.useRealTimers()
})

async function setup(reattach: boolean, redirected = false, untrusted = false) {
  const home = await mkdtemp(join(tmpdir(), 'codex-recovery-flow-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const nativeHome = join(home, redirected ? 'account-codex' : '.codex')
  const sessions = join(nativeHome, 'sessions')
  await mkdir(sessions, { recursive: true })
  if (untrusted) {
    const installed = await ensurePodiumCodexHooks({
      codexHome: nativeHome,
      verifiedVersion: 'codex-cli 0.162.0',
    })
    expect(installed).toMatchObject({ installed: true, trusted: false })
  }
  const now = Math.floor(Date.now() / 1_000) * 1_000
  const originalStartedAt = reattach ? now - 60_000 : now
  const [weekday, day, month, year, time] = new Date(originalStartedAt).toUTCString().split(' ')
  os.started = `${weekday?.slice(0, 3)} ${month} ${day} ${time} ${year}`
  const watchers = new Set<() => void>()
  const statTick: StatTick = {
    subscribe(watcher) {
      watchers.add(watcher)
      return () => watchers.delete(watcher)
    },
  }
  const sent: DaemonMessage[] = []
  const observers = createSessionObservers({
    send: (message) => sent.push(message),
    statTick,
    ...(redirected ? {} : { homeDir: home }),
    onTranscriptDirty: vi.fn(),
    cwdTracker: { onHookCwd: vi.fn(async () => {}) },
  })
  const sessionId = asSessionId(`recovery-${randomUUID()}`)
  cleanups.push(() => observers.clearSession(sessionId))
  let exit = () => {}
  let lost = () => {}
  let pid = 101
  const session: DurableAttachment = {
    get pid() {
      return pid
    },
    holdsWriterLease: () => true,
    onFrame: () => () => {},
    onExit: (cb) => {
      exit = () => cb(0)
      return () => {}
    },
    onLeaseLost: (cb) => {
      lost = cb
      return () => {}
    },
    onTitle: () => () => {},
    write() {},
    writeBytes() {},
    resize() {},
    dispose() {},
  }
  const common = {
    sessionId,
    agentKind: 'codex' as const,
    cwd: '/same/repo',
    durableLabel: 'podium-fixture',
    observationGeneration: 1,
    observationBindingVersion: 1,
    observationProviderSessionId: null,
  }
  observers.initSessionObservers(
    reattach
      ? {
          ...common,
          type: 'reattach',
          lastKnownGeometry: { cols: 80, rows: 24 },
          createdAtMs: originalStartedAt,
        }
      : { ...common, type: 'spawn', geometry: { cols: 80, rows: 24 } },
    session,
    undefined,
    {
      seedOnFrame: false,
      ...(reattach ? {} : { startedAtMs: now }),
      // The session's pinned context names its Codex folder; a redirected
      // session's context points CODEX_HOME at the account folder.
      harnessContext: testHarnessContext({
        kind: 'codex',
        home,
        ...(redirected ? { env: { CODEX_HOME: nativeHome } } : {}),
      }),
    },
  )
  async function rollout(text: string) {
    const id = randomUUID()
    const path = join(sessions, `rollout-${id}.jsonl`)
    const records = [
      {
        type: 'session_meta',
        payload: {
          id, cwd: '/same/repo', source: 'cli',
          timestamp: new Date(originalStartedAt).toISOString(),
        },
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: `${id}-turn` } },
      { type: 'event_msg', payload: { type: 'user_message', message: `user ${text}` } },
      { type: 'event_msg', payload: { type: 'agent_message', message: `assistant ${text}` } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: `assistant ${text}` }],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: `assistant ${text}` },
      },
    ]
    await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
    return { id, path }
  }
  const tick = () => {
    for (const watcher of [...watchers]) watcher()
  }
  const proposals = () => sent.filter((message) => message.type === 'agentObservationRebind')
  function acknowledge(index: number, accepted = true) {
    const request = proposals()[index]!
    observers.onProviderRebindAck({
      ...request,
      type: 'agentObservationRebindAck',
      result: accepted ? 'accepted' : 'rejected',
      providerSessionId: accepted ? request.nextProviderSessionId : request.providerSessionId,
      observerGeneration: request.observerGeneration + (accepted ? 1 : 0),
      bindingVersion: request.bindingVersion + (accepted ? 1 : 0),
      priorObserverGeneration: request.observerGeneration,
      priorBindingVersion: request.bindingVersion,
      checkpoint: null,
      ...(accepted ? {} : { rejectionReason: 'provider_binding_mismatch' as const }),
    })
  }
  const text = () =>
    JSON.stringify(
      sent
        .filter((message) => message.type === 'transcriptDelta')
        .flatMap((message) => message.items),
    )
  return {
    now,
    sent,
    sessionId,
    observers,
    rollout,
    tick,
    proposals,
    acknowledge,
    text,
    exit: () => exit(),
    loseLease: () => lost(),
    setPid: (value: number) => {
      pid = value
    },
  }
}

describe('hookless owned Codex transcript flow', () => {
  it.each([
    { scenario: 'fresh without hooks', reattach: false, untrusted: false },
    { scenario: 'fresh with untrusted hooks', reattach: false, untrusted: true },
    { scenario: 'surviving 0.3.0 session', reattach: true, untrusted: false },
  ])('recovers $scenario and streams after acknowledged binding', async ({ reattach, untrusted }) => {
    const f = await setup(reattach, false, untrusted)
    const own = await f.rollout('original history')
    os.paths.set(101, [own.path])
    // The first attempt may precede lazy creation. Drive the existing slow cadence.
    vi.spyOn(Date, 'now').mockReturnValue(f.now + 11_000)
    f.tick()
    await vi.waitFor(() => {
      f.tick()
      expect(f.proposals().length).toBeGreaterThan(0)
    })
    expect(f.text()).not.toContain('original history')
    expect(f.sent.filter((message) => message.type === 'sessionResumeRef')).toEqual([])
    f.acknowledge(0)
    await vi.waitFor(() => expect(f.text()).toContain('assistant original history'))
    expect(f.text()).toContain('user original history')
    const observations = () =>
      f.sent
        .filter((message) => message.type === 'agentObservation')
        .map((message) => message.observation)
    await vi.waitFor(() =>
      expect(observations().some((observation) => observation.providerSessionId === own.id)).toBe(
        true,
      ),
    )
    const bootstrap = observations().find(
      (observation) => observation.providerSessionId === own.id,
    )!
    expect(bootstrap).toMatchObject({ provenance: 'bootstrap', transitionKind: 'snapshot' })
    const result = acceptAgentObservation(
      null,
      { provider: 'codex', providerSessionId: own.id, observationGeneration: 2, bindingVersion: 2 },
      bootstrap,
      new Date(f.now + 11_000).toISOString(),
    )
    if (result.kind === 'rejected') throw new Error(result.rejectionReason)
    f.observers.onObservationAck({
      type: 'agentObservationAck',
      sessionId: f.sessionId,
      observerGeneration: 2,
      bindingVersion: 2,
      transitionId: bootstrap.transitionId,
      result: result.kind,
      checkpoint: result.checkpoint,
      acceptedCursor: result.checkpoint.providerCursor,
    })
    await appendFile(
      own.path,
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'user_message', message: 'second live turn' },
      }) + '\n',
    )
    await appendFile(
      own.path,
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'second live answer' }],
        },
      }) + '\n',
    )
    f.tick()
    await vi.waitFor(() => expect(f.text()).toContain('second live answer'))
    expect(f.text()).toContain('second live turn')
    expect(
      observations().filter(
        (observation) =>
          observation.provenance === 'live' && observation.transitionKind === 'turn_terminal',
      ),
    ).toEqual([])
    vi.restoreAllMocks()
  })

  it('keeps polling after first bind and gates /new on a second accepted rebind', async () => {
    const f = await setup(false, true)
    const first = await f.rollout('first')
    os.paths.set(101, [first.path])
    vi.spyOn(Date, 'now').mockReturnValue(f.now + 11_000)
    f.tick()
    await vi.waitFor(() => {
      f.tick()
      expect(f.proposals().length).toBeGreaterThan(0)
    })
    f.acknowledge(0)
    await vi.waitFor(() => expect(f.text()).toContain('assistant first'))
    const calls = os.calls
    for (let i = 0; i < 20; i++) f.tick()
    expect(os.calls).toBe(calls)
    const next = await f.rollout('next conversation')
    os.paths.set(101, [next.path])
    vi.mocked(Date.now).mockReturnValue(f.now + 22_000)
    f.tick()
    await vi.waitFor(() =>
      expect(f.proposals().some((request) => request.nextProviderSessionId === next.id)).toBe(true),
    )
    expect(f.text()).not.toContain('next conversation')
    f.acknowledge(1, false)
    expect(f.text()).not.toContain('next conversation')
    f.acknowledge(1)
    await vi.waitFor(() => expect(f.text()).toContain('assistant next conversation'))
    vi.restoreAllMocks()
  })
})
