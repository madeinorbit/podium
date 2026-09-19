/**
 * THE HEADLESS RUNTIME DRIVER, PINNED (POD-4392).
 *
 * Every guard in `headless-driver.ts` has a negative test that goes red when
 * the guard is neutered: digest mismatch, missing identity, no-tools verdict,
 * native-account fence, same-turn collision, busy, structured-permissions and
 * attachment refusals, unsupported deliveries, adopt identity and ack identity.
 * The turn-execution seam is injected — these prove the WRAPPER preserves the
 * legacy semantics; the harnesses themselves stay covered by
 * `headless-drivers.test.ts` / `durable-headless.test.ts`.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalHeadlessContractFacts,
  DriverRefusalError,
  resolveProcedures,
  type AgentSessionHandle,
  type RuntimeEvent,
  type SessionSpec,
  type TurnInput,
} from '@podium/agent-runtime'
import { supported } from '@podium/harness'
import { asAccountId, asSessionId, type SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import type { DurableProcess } from '@podium/process/durable'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createHeadlessRuntime,
  headlessCapabilities,
  type HeadlessDriverHost,
  type HeadlessDriverRunners,
  type HeadlessRuntime,
} from './headless-driver.js'
import type { HeadlessEmit, HeadlessTurnOutcome, HeadlessTurnSpec } from '../headless-drivers.js'
import { testHarnessSnapshot } from '../test-support/harness-snapshot.js'

const ACCOUNT = 'native:claude-code:fp-1'
const OTHER_ACCOUNT = 'native:claude-code:fp-2'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeTurn {
  durable: boolean
  turnId?: string
  spec: HeadlessTurnSpec
  emit: HeadlessEmit
  interrupted: boolean
  interruptCalls: number
  resolve: (outcome: HeadlessTurnOutcome) => void
  reject: (error: unknown) => void
}

function makeRunners(): HeadlessDriverRunners & { turns: FakeTurn[] } {
  const turns: FakeTurn[] = []
  const start = (durable: boolean, turnId: string | undefined, spec: HeadlessTurnSpec, emit: HeadlessEmit) => {
    let resolve!: (outcome: HeadlessTurnOutcome) => void
    let reject!: (error: unknown) => void
    const done = new Promise<HeadlessTurnOutcome>((res, rej) => {
      resolve = res
      reject = rej
    })
    const turn: FakeTurn = {
      durable,
      ...(turnId !== undefined ? { turnId } : {}),
      spec,
      emit,
      interrupted: false,
      interruptCalls: 0,
      resolve,
      reject,
    }
    turns.push(turn)
    return {
      done,
      interrupt: () => {
        turn.interrupted = true
        turn.interruptCalls += 1
      },
    }
  }
  return {
    turns,
    runTurn: (spec, emit) => start(false, undefined, spec, emit),
    runDurableTurn: (turnId, _sessionId, spec, emit) => start(true, turnId, spec, emit),
  }
}

interface FakeHost extends HeadlessDriverHost {
  binds: { sessionId: SessionId; agentKind: string; cwd: string; resumeValue: string }[]
  sent: DaemonMessage[]
  envs: Record<string, string>[]
  nativeAccount: 'ok' | 'mismatch'
  useDurable: boolean
  historyItems: { id: string; role: 'user' | 'assistant'; text: string }[]
}

function makeRuntime(overrides: Partial<Pick<FakeHost, 'nativeAccount' | 'useDurable'>> = {}): {
  runtime: HeadlessRuntime
  host: FakeHost
  runners: HeadlessDriverRunners & { turns: FakeTurn[] }
} {
  const runners = makeRunners()
  const now = 1_000_000
  const host: FakeHost = {
    binds: [],
    sent: [],
    envs: [],
    nativeAccount: overrides.nativeAccount ?? 'ok',
    useDurable: overrides.useDurable ?? false,
    historyItems: [],
    send: (msg) => {
      host.sent.push(msg)
    },
    snapshot: async () => testHarnessSnapshot(),
    durable: () => (host.useDurable ? ({} as DurableProcess) : undefined),
    assertNativeAccount: (_agent, accountId) => {
      if (host.nativeAccount !== 'ok' || !String(accountId).startsWith('native:')) {
        throw new Error('tool-less headless turn requires an exact native account fingerprint')
      }
    },
    sessionEnv: (input) => {
      const env = { HOME: '/test', PODIUM_RELAY: input.sessionId, AGENT: input.agent }
      host.envs.push(env)
      return env
    },
    durableLabel: (sessionId) => `podium-${sessionId}`,
    bindHeadlessSession: (sessionId, agentKind, cwd, resumeValue) => {
      host.binds.push({ sessionId, agentKind: String(agentKind), cwd, resumeValue })
    },
    readHistory: async () => ({
      items: host.historyItems.map((item) => ({ ...item, ts: new Date(now).toISOString() })),
      hasMore: false,
    }),
    now: () => now,
  }
  const runtime = createHeadlessRuntime(host, runners)
  return { runtime, host, runners }
}

function makeSpec(harness = 'claude-code', extra: Partial<SessionSpec> = {}): SessionSpec {
  return {
    harness,
    selection: { auth: 'unknown', platform: 'linux', available: [] },
    workdir: '/repo',
    model: {},
    instructions: { supported: false, reason: 'test needs no instructions' },
    mcpServers: { supported: false, reason: 'test needs no MCP servers' },
    ...extra,
  }
}

/** Mirror the driver's digest computation exactly: turn-carried fields only. */
function digestFor(input: {
  text: string
  turnId: string
  sessionId: string
  accountId: string
  model?: string
  effort?: string
  allowedTools?: string[]
  permissionMode?: string
  toolPolicy?: 'none'
  mcpConfig?: string
  resumeValue?: string
  sessionUuid?: string
}): string {
  return createHash('sha256')
    .update(
      canonicalHeadlessContractFacts({
        prompt: input.text,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.allowedTools !== undefined ? { allowedTools: [...input.allowedTools] } : {}),
        ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
        ...(input.toolPolicy !== undefined ? { toolPolicy: input.toolPolicy } : {}),
        ...(input.mcpConfig !== undefined ? { mcpConfig: input.mcpConfig } : {}),
        ...(input.resumeValue !== undefined ? { resumeValue: input.resumeValue } : {}),
        ...(input.sessionUuid !== undefined ? { sessionUuid: input.sessionUuid } : {}),
        turnId: input.turnId,
        sessionId: input.sessionId,
        accountId: input.accountId,
      }),
    )
    .digest('hex')
}

function makeTurn(
  sessionId: SessionId,
  fields: {
    turnId?: string
    text?: string
    accountId?: string
    model?: string
    effort?: string
    allowedTools?: string[]
    permissionMode?: string
    toolPolicy?: 'none'
    mcpConfig?: string
    resumeValue?: string
    sessionUuid?: string
    digest?: string
  } = {},
): TurnInput {
  const turnId = fields.turnId ?? 'turn-1'
  const text = fields.text ?? 'hello'
  const accountId = fields.accountId ?? ACCOUNT
  const requestDigest =
    fields.digest ??
    digestFor({
      text,
      turnId,
      sessionId,
      accountId,
      ...(fields.model !== undefined ? { model: fields.model } : {}),
      ...(fields.effort !== undefined ? { effort: fields.effort } : {}),
      ...(fields.allowedTools !== undefined ? { allowedTools: fields.allowedTools } : {}),
      ...(fields.permissionMode !== undefined ? { permissionMode: fields.permissionMode } : {}),
      ...(fields.toolPolicy !== undefined ? { toolPolicy: fields.toolPolicy } : {}),
      ...(fields.mcpConfig !== undefined ? { mcpConfig: fields.mcpConfig } : {}),
      ...(fields.resumeValue !== undefined ? { resumeValue: fields.resumeValue } : {}),
      ...(fields.sessionUuid !== undefined ? { sessionUuid: fields.sessionUuid } : {}),
    })
  return {
    id: turnId,
    text,
    accountId,
    requestDigest,
    ...(fields.model !== undefined || fields.effort !== undefined
      ? {
          overrides: supported({
            ...(fields.model !== undefined ? { model: fields.model } : {}),
            ...(fields.effort !== undefined ? { effort: fields.effort } : {}),
          }),
        }
      : {}),
    ...(fields.allowedTools !== undefined ? { allowedTools: fields.allowedTools } : {}),
    ...(fields.permissionMode !== undefined ? { permissionMode: fields.permissionMode } : {}),
    ...(fields.toolPolicy !== undefined ? { toolPolicy: fields.toolPolicy } : {}),
    ...(fields.mcpConfig !== undefined ? { mcpConfig: fields.mcpConfig } : {}),
    ...(fields.resumeValue !== undefined ? { resumeValue: fields.resumeValue } : {}),
    ...(fields.sessionUuid !== undefined ? { sessionUuid: fields.sessionUuid } : {}),
  }
}

async function createHandle(
  runtime: HeadlessRuntime,
  harness = 'claude-code',
  extra: Partial<SessionSpec> = {},
): Promise<{ handle: AgentSessionHandle; sessionId: SessionId }> {
  const handle = await runtime.driverFor(harness).create(makeSpec(harness, extra))
  return { handle, sessionId: handle.binding.sessionId }
}

async function takeEvents(handle: AgentSessionHandle, count: number): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = []
  const iterator = handle.events('bootstrap')[Symbol.asyncIterator]()
  try {
    for (let i = 0; i < count; i += 1) {
      // The stream only ends on disposal; a per-item timeout turns "no more
      // events yet" into the end of this read instead of a hung test.
      const next = await Promise.race([
        iterator.next(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
      ])
      if (next === null || next.done === true) break
      out.push(next.value)
    }
  } finally {
    await iterator.return?.()
  }
  return out
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

// ---------------------------------------------------------------------------
// Binding and capabilities
// ---------------------------------------------------------------------------

describe('headless driver identity', () => {
  it('creates a session behind a headless server-family binding', async () => {
    const { runtime } = makeRuntime()
    const { handle, sessionId } = await createHandle(runtime)
    try {
      expect(handle.binding).toMatchObject({
        sessionId,
        driver: 'headless',
        family: 'server',
        harness: 'claude-code',
        workdir: '/repo',
        resume: null,
      })
      expect(handle.binding.process.key).toBe(`podium-${sessionId}`)
      expect(runtime.handleFor(sessionId)).toBe(handle)
      expect(runtime.bindings()).toHaveLength(1)
    } finally {
      runtime.dispose()
    }
  })

  it('declares send, interrupt, history and next-turn configure', () => {
    const capabilities = headlessCapabilities()
    expect(capabilities.send.native).toContain('when-ready')
    expect(capabilities.send.proof).toContain('protocol-ack')
    expect(capabilities.send.mayReturnUnverified).toBe(false)
    expect(capabilities.interrupt.fenceOnProviderConfirmation).toBe(false)
    expect(capabilities.transcript).toMatchObject({ supported: true })
    expect(capabilities.configure).toMatchObject({
      supported: true,
      value: { effective: 'next-turn' },
    })
    expect(capabilities.interactions).toMatchObject({ supported: false })
    expect(capabilities.staging).toMatchObject({ supported: false })
    expect(capabilities.attach).toMatchObject({ supported: false })
  })

  it('refuses to create a harness this build cannot drive headlessly', async () => {
    const { runtime } = makeRuntime()
    try {
      await expect(runtime.driverFor('shell').create(makeSpec('shell'))).rejects.toThrow()
    } finally {
      runtime.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe('headless dispatch', () => {
  it('forwards per-turn fields onto the runner spec', async () => {
    const { runtime, host, runners } = makeRuntime()
    try {
      const { handle, sessionId } = await createHandle(runtime)
      const input = makeTurn(sessionId, {
        allowedTools: ['Read', 'Bash'],
        permissionMode: 'auto',
        mcpConfig: '{"mcpServers":{}}',
        resumeValue: 'harness-9',
        sessionUuid: 'uuid-9',
        model: 'sonnet',
        effort: 'high',
      })
      const receipt = await handle.send(input, { origin: 'system', delivery: 'when-ready' })
      expect(receipt).toMatchObject({ outcome: 'accepted', turnEpoch: 1, deliveredAs: 'when-ready' })
      expect(runners.turns).toHaveLength(1)
      const spec = runners.turns[0]?.spec
      expect(spec).toMatchObject({
        agent: 'claude-code',
        accountId: ACCOUNT,
        cwd: '/repo',
        prompt: 'hello',
        allowedTools: ['Read', 'Bash'],
        permissionMode: 'auto',
        mcpConfig: '{"mcpServers":{}}',
        resumeValue: 'harness-9',
        sessionUuid: 'uuid-9',
        model: 'sonnet',
        effort: 'high',
        durableLabel: `podium-${sessionId}`,
      })
      expect(spec?.env).toMatchObject({ HOME: '/test' })
      expect(host.envs).toHaveLength(1)
    } finally {
      runtime.dispose()
    }
  })

  it('resolves session-sticky defaults under per-turn winners', async () => {
    const { runtime, runners } = makeRuntime()
    try {
      const { handle, sessionId } = await createHandle(runtime, 'claude-code', {
        allowedTools: ['Read'],
        permissionMode: 'plan',
        executablePath: '/opt/claude',
      })
      await handle.configure({ model: 'opus', effort: 'max' })
      const input = makeTurn(sessionId, { permissionMode: 'auto' })
      const receipt = await handle.send(input, { origin: 'system', delivery: 'when-ready' })
      expect(receipt.outcome).toBe('accepted')
      expect(runners.turns[0]?.spec).toMatchObject({
        allowedTools: ['Read'],
        permissionMode: 'auto',
        model: 'opus',
        effort: 'max',
        executablePath: '/opt/claude',
      })
    } finally {
      runtime.dispose()
    }
  })

  it('completes a turn with done verdict, resume learning and one bind', async () => {
    const { runtime, host, runners } = makeRuntime()
    try {
      const { handle, sessionId } = await createHandle(runtime)
      const receipt = await handle.send(makeTurn(sessionId), {
        origin: 'system',
        delivery: 'when-ready',
      })
      expect(receipt.outcome).toBe('accepted')
      runners.turns[0]?.emit({ kind: 'status', status: 'running', harnessSessionId: 'harness-1' })
      runners.turns[0]?.resolve({ harnessSessionId: 'harness-1', output: 'done' })
      await flush()
      const events = await takeEvents(handle, 4)
      expect(events.map((event) => (event.t === 'turn' ? event.ev.ev : event.t))).toContain(
        'completed',
      )
      const terminal = events.find((event) => event.t === 'turn' && event.ev.ev !== 'started')
      expect(terminal).toMatchObject({ ev: { ev: 'completed', turnEpoch: 1, verdict: 'done' } })
      expect(handle.binding.resume).toMatchObject({ value: 'harness-1' })
      expect(host.binds.filter((bind) => bind.resumeValue === 'harness-1')).toHaveLength(1)
      expect((await handle.state()).phase).toBe('idle')
    } finally {
      runtime.dispose()
    }
  })

  it('streams partial text as turn-scoped previews and never as complete items', async () => {
    const { runtime, runners } = makeRuntime()
    try {
      const { handle, sessionId } = await createHandle(runtime)
      await handle.send(makeTurn(sessionId), { origin: 'system', delivery: 'when-ready' })
      runners.turns[0]?.emit({ kind: 'partial-text', text: 'half', itemHint: 'm-1' })
      runners.turns[0]?.emit({ kind: 'partial-text', text: 'half done', itemHint: 'm-1' })
      runners.turns[0]?.resolve({ harnessSessionId: 'harness-1', output: 'half done' })
      await flush()
      const events = await takeEvents(handle, 6)
      const partials = events.filter(
        (event): event is Extract<RuntimeEvent, { t: 'item' }> =>
          event.t === 'item' && event.item.kind === 'partial',
      )
      expect(partials.map((event) => event.item.item.text)).toEqual(['half', 'half done'])
      expect(
        events.some((event) => event.t === 'item' && event.item.kind === 'complete'),
      ).toBe(false)
    } finally {
      runtime.dispose()
    }
  })

  it('routes durable turns through the durable runner with the turn identity', async () => {
    const { runtime, runners } = makeRuntime({ useDurable: true })
    try {
      const { handle, sessionId } = await createHandle(runtime)
      const receipt = await handle.send(makeTurn(sessionId, { turnId: 'd-turn' }), {
        origin: 'system',
        delivery: 'when-ready',
      })
      expect(receipt.outcome).toBe('accepted')
      expect(runners.turns).toHaveLength(1)
      expect(runners.turns[0]).toMatchObject({ durable: true, turnId: 'd-turn' })
    } finally {
      runtime.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Fences (each armed: neutering the guard dispatches, and the test goes red)
// ---------------------------------------------------------------------------

describe('headless fences', () => {
  it('refuses a digest mismatch before dispatch', async () => {
    const { runtime, runners } = makeRuntime()
    try {
      const { handle, sessionId } = await createHandle(runtime)
      const receipt = await handle.send(
        makeTurn(sessionId, { digest: 'b'.repeat(64) }),
        { origin: 'system', delivery: 'when-ready' },
      )
      expect(receipt).toMatchObject({
        outcome: 'refused',
        refusal: { reason: 'invalid_value', detail: expect.stringContaining('digest') },
      })
      expect(runners.turns).toHaveLength(0)
    } finally {
      runtime.dispose()
    }
  })

  it('refuses when turn identity is missing', async () => {
    const { runtime, runners } = makeRuntime()
    try {
      const { handle, sessionId } = await createHandle(runtime)
      const full = makeTurn(sessionId)
      for (const missing of ['id', 'requestDigest', 'accountId'] as const) {
        const input = { ...full }
        delete input[missing]
        const receipt = await handle.send(input, { origin: 'system', delivery: 'when-ready' })
        expect(receipt).toMatchObject({ outcome: 'refused', refusal: { reason: 'invalid_value' } })
      }
      expect(runners.turns).toHaveLength(0)
    } finally {
      runtime.dispose()
    }
  })

  it('binds changed per-turn fields into the digest', async () => {
    const { runtime, runners } = makeRuntime()
    try {
      const { handle, sessionId } = await createHandle(runtime)
      // Minted for one tool set, delivered with another: the facts changed, so
      // the digest must refuse rather than run the wrong policy.
      const input = makeTurn(sessionId, { allowedTools: ['Read'] })
      const receipt = await handle.send(
        { ...input, allowedTools: ['Bash'] },
        { origin: 'system', delivery: 'when-ready' },
      )
      expect(receipt).toMatchObject({ outcome: 'refused', refusal: { reason: 'invalid_value' } })
      expect(runners.turns).toHaveLength(0)
    } finally {
      runtime.dispose()
    }
  })

  it('refuses toolPolicy none where the harness cannot enforce it', async () => {
    const { runtime, runners } = makeRuntime()
    try {
      const { handle, sessionId } = await createHandle(runtime, 'codex')
      const receipt = await handle.send(
        makeTurn(sessionId, { toolPolicy: 'none', accountId: 'native:codex:fp-1' }),
        { origin: 'system', delivery: 'when-ready' },
      )
      expect(receipt).toMatchObject({
        outcome: 'refused',
        refusal: { reason: 'invalid_value', detail: expect.stringContaining('cannot enforce') },
      })
      expect(runners.turns).toHaveLength(0)
    } finally {
      runtime.dispose()
    }
  })

  it('refuses tool-less turns without the exact native account', async () => {
    const { runtime, runners } = makeRuntime({ nativeAccount: 'mismatch' })
    try {
      const { handle, sessionId } = await createHandle(runtime)
      const receipt = await handle.send(makeTurn(sessionId, { toolPolicy: 'none' }), {
        origin: 'system',
        delivery: 'when-ready',
      })
      expect(receipt).toMatchObject({ outcome: 'refused', refusal: { reason: 'invalid_value' } })
      expect(runners.turns).toHaveLength(0)
    } finally {
      runtime.dispose()
    }
  })

  it('rewires the same turn without rerun and refuses collisions', async () => {
    const { runtime, runners } = makeRuntime()
    try {
      const { handle, sessionId } = await createHandle(runtime)
      const first = await handle.send(makeTurn(sessionId, { turnId: 't' }), {
        origin: 'system',
        delivery: 'when-ready',
      })
      expect(first).toMatchObject({ outcome: 'accepted', turnEpoch: 1 })
      const replay = await handle.send(makeTurn(sessionId, { turnId: 't' }), {
        origin: 'system',
        delivery: 'when-ready',
      })
      expect(replay).toMatchObject({ outcome: 'accepted', turnEpoch: 1 })
      expect(runners.turns).toHaveLength(1)
      // Same turnId, different identity: never a reuse.
      const clash = await handle.send(
        makeTurn(sessionId, { turnId: 't', text: 'changed' }),
        { origin: 'system', delivery: 'when-ready' },
      )
      expect(clash).toMatchObject({
        outcome: 'refused',
        refusal: { reason: 'invalid_value', detail: expect.stringContaining('identity mismatch') },
      })
      // A different turn while one is open is busy, never a queue.
      const busy = await handle.send(makeTurn(sessionId, { turnId: 't2' }), {
        origin: 'system',
        delivery: 'when-ready',
      })
      expect(busy).toMatchObject({ outcome: 'refused', refusal: { reason: 'busy' } })
      expect(runners.turns).toHaveLength(1)
    } finally {
      runtime.dispose()
    }
  })

  it('refuses structured permissions without an answer channel', async () => {
    const { runtime, runners } = makeRuntime()
    try {
      const { handle, sessionId } = await createHandle(runtime)
      const input = { ...makeTurn(sessionId), structuredPermissions: true as const }
      const receipt = await handle.send(input, { origin: 'system', delivery: 'when-ready' })
      expect(receipt).toMatchObject({
        outcome: 'refused',
        refusal: { reason: 'unsupported' },
      })
      expect(runners.turns).toHaveLength(0)
    } finally {
      runtime.dispose()
    }
  })

  it('refuses attachments and non-write deliveries', async () => {
    const { runtime, runners } = makeRuntime()
    try {
      const { handle, sessionId } = await createHandle(runtime)
      const withAttachment = {
        ...makeTurn(sessionId),
        attachments: [{ id: 'a', path: '/tmp/a', filename: 'a', mediaType: 'text/plain', kind: 'file' as const }],
      }
      expect(
        await handle.send(withAttachment, { origin: 'system', delivery: 'when-ready' }),
      ).toMatchObject({ outcome: 'refused', refusal: { reason: 'unsupported' } })
      for (const delivery of ['steer', 'queue', 'at-boundary'] as const) {
        expect(
          await handle.send(makeTurn(sessionId), { origin: 'system', delivery }),
        ).toMatchObject({ outcome: 'refused', refusal: { reason: 'unsupported' } })
      }
      expect(runners.turns).toHaveLength(0)
    } finally {
      runtime.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Interrupt, failure mapping, lifecycle
// ---------------------------------------------------------------------------

describe('headless turn endings', () => {
  it('reports an interrupted turn as completed/interrupted', async () => {
    const { runtime, runners } = makeRuntime()
    try {
      const { handle, sessionId } = await createHandle(runtime)
      await handle.send(makeTurn(sessionId), { origin: 'system', delivery: 'when-ready' })
      await handle.interrupt()
      expect(runners.turns[0]?.interrupted).toBe(true)
      runners.turns[0]?.reject(new Error('turn interrupted'))
      await flush()
      const events = await takeEvents(handle, 4)
      expect(events.at(-1)).toMatchObject({
        t: 'turn',
        ev: { ev: 'completed', turnEpoch: 1, verdict: 'interrupted' },
      })
      expect(await handle.state()).toMatchObject({ phase: 'idle', idle: { kind: 'interrupted' } })
    } finally {
      runtime.dispose()
    }
  })

  it('maps timeouts to retryable failures and provider errors to fatal ones', async () => {
    const { runtime, runners } = makeRuntime()
    try {
      const { handle, sessionId } = await createHandle(runtime)
      await handle.send(makeTurn(sessionId, { turnId: 'slow' }), {
        origin: 'system',
        delivery: 'when-ready',
      })
      runners.turns[0]?.reject(new Error('turn timed out'))
      await flush()
      const slow = await takeEvents(handle, 4)
      expect(slow.at(-1)).toMatchObject({
        t: 'turn',
        ev: { ev: 'failed', reason: 'timeout', disposition: 'retryable' },
      })
      await handle.send(makeTurn(sessionId, { turnId: 'bad' }), {
        origin: 'system',
        delivery: 'when-ready',
      })
      runners.turns[1]?.reject(new Error('provider exploded'))
      await flush()
      const bad = await takeEvents(handle, 8)
      expect(bad.at(-1)).toMatchObject({
        t: 'turn',
        ev: { ev: 'failed', reason: 'provider-error', disposition: 'fatal' },
      })
      expect(await handle.state()).toMatchObject({ phase: 'errored' })
    } finally {
      runtime.dispose()
    }
  })

  it('binds the harness session even when the turn fails', async () => {
    const { runtime, host, runners } = makeRuntime()
    try {
      const { handle, sessionId } = await createHandle(runtime)
      await handle.send(makeTurn(sessionId), { origin: 'system', delivery: 'when-ready' })
      const { HeadlessTurnError } = await import('../headless-drivers.js')
      runners.turns[0]?.reject(new HeadlessTurnError('crashed mid-turn', 'orphan-1'))
      await flush()
      expect(host.binds.filter((bind) => bind.resumeValue === 'orphan-1')).toHaveLength(1)
      expect(handle.binding.resume).toMatchObject({ value: 'orphan-1' })
    } finally {
      runtime.dispose()
    }
  })

  it('fences the live turn first on interrupt delivery, then sends', async () => {
    const { runtime, runners } = makeRuntime()
    try {
      const { handle, sessionId } = await createHandle(runtime)
      await handle.send(makeTurn(sessionId, { turnId: 'first' }), {
        origin: 'system',
        delivery: 'when-ready',
      })
      const receipt = await handle.send(makeTurn(sessionId, { turnId: 'second' }), {
        origin: 'system',
        delivery: 'interrupt',
      })
      expect(receipt).toMatchObject({ outcome: 'accepted', turnEpoch: 2 })
      expect(runners.turns[0]?.interrupted).toBe(true)
      expect(runners.turns).toHaveLength(2)
      runners.turns[0]?.reject(new Error('turn interrupted'))
      runners.turns[1]?.resolve({ harnessSessionId: 'h-2', output: 'second' })
      await flush()
      const events = await takeEvents(handle, 8)
      const terminals = events.filter((event) => event.t === 'turn' && event.ev.ev !== 'started')
      expect(terminals).toMatchObject([
        { ev: { ev: 'completed', turnEpoch: 1, verdict: 'interrupted' } },
        { ev: { ev: 'completed', turnEpoch: 2, verdict: 'done' } },
      ])
    } finally {
      runtime.dispose()
    }
  })

  it('stops and kills end the session and refuse further sends', async () => {
    const { runtime } = makeRuntime()
    try {
      const { handle, sessionId } = await createHandle(runtime)
      await handle.stop()
      expect(await handle.state()).toMatchObject({ phase: 'ended' })
      expect(
        await handle.send(makeTurn(sessionId, { turnId: 'late' }), {
          origin: 'system',
          delivery: 'when-ready',
        }),
      ).toMatchObject({ outcome: 'refused', refusal: { reason: 'not_running' } })
      const events = await takeEvents(handle, 4)
      expect(events.at(-1)).toMatchObject({ t: 'process', ev: { ev: 'exited' } })
    } finally {
      runtime.dispose()
    }
  })

  it('hibernates only with a resume ref and an idle session', async () => {
    const { runtime } = makeRuntime()
    try {
      const { handle, sessionId } = await createHandle(runtime)
      expect(await handle.hibernate()).toMatchObject({ reason: 'no_resume_ref' })
      await handle.send(makeTurn(sessionId), { origin: 'system', delivery: 'when-ready' })
      // No resume yet and a turn running: still refused, never a loss.
      expect(await handle.hibernate()).toMatchObject({ reason: 'no_resume_ref' })
    } finally {
      runtime.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// History, resume, adopt, ack
// ---------------------------------------------------------------------------

describe('headless history and rebind', () => {
  it('reads transcript history through the host with the learned resume', async () => {
    const { runtime, host, runners } = makeRuntime()
    try {
      const { handle, sessionId } = await createHandle(runtime)
      host.historyItems.push({ id: 'u-1', role: 'user', text: 'hello' })
      await handle.send(makeTurn(sessionId), { origin: 'system', delivery: 'when-ready' })
      runners.turns[0]?.resolve({ harnessSessionId: 'h-1', output: 'hi' })
      await flush()
      const page = await handle.transcript.history({ limit: 10 })
      expect(page.items.map((item) => item.text)).toEqual(['hello'])
    } finally {
      runtime.dispose()
    }
  })

  it('resumes by rebinding the transcript to the ref', async () => {
    const { runtime, host } = makeRuntime()
    try {
      const spec = makeSpec('claude-code')
      const sessionId = asSessionId('headless-resume-1')
      const handle = await runtime.resumeWithId(
        sessionId,
        { kind: 'claude-session', value: 'h-resumed' },
        spec,
      )
      expect(handle.binding.resume).toMatchObject({ value: 'h-resumed' })
      expect(host.binds).toMatchObject([
        { sessionId, agentKind: 'claude-code', cwd: '/repo', resumeValue: 'h-resumed' },
      ])
    } finally {
      runtime.dispose()
    }
  })

  it('adopts on exact process identity and refuses anything else', async () => {
    const { runtime, host } = makeRuntime()
    try {
      const sessionId = asSessionId('headless-adopt-1')
      const binding = {
        sessionId,
        driver: 'headless' as const,
        family: 'server' as const,
        harness: 'claude-code',
        workdir: '/repo',
        resume: { kind: 'claude-session', value: 'h-adopt' },
        process: { key: `podium-${sessionId}` },
        bindingVersion: 3,
      }
      const handle = await runtime.adopt(binding)
      expect(handle.binding.bindingVersion).toBe(4)
      expect(handle.binding.resume).toMatchObject({ value: 'h-adopt' })
      expect(host.binds).toMatchObject([{ sessionId, resumeValue: 'h-adopt' }])
      const events = await takeEvents(handle, 3)
      expect(events.at(-1)).toMatchObject({
        t: 'process',
        ev: { ev: 'adopted', bindingVersion: 4 },
      })
      await expect(
        runtime.adopt({ ...binding, process: { key: 'podium-someone-else' } }),
      ).rejects.toThrow(/exact process identity mismatch/)
    } finally {
      runtime.dispose()
    }
  })

  it('answers, exports and attaches as unsupported; usage likewise', async () => {
    const { runtime } = makeRuntime()
    try {
      const { handle } = await createHandle(runtime)
      expect(await handle.answer('ask:1', { decision: 'allow' })).toMatchObject({
        ok: false,
        reason: 'unknown-interaction',
      })
      expect(await handle.interactions()).toEqual([])
      await expect(handle.export()).rejects.toBeInstanceOf(DriverRefusalError)
      expect(await handle.attach({ mode: 'peek', holder: 'test' })).toMatchObject({
        reason: 'unsupported',
      })
      expect(await handle.draft.get()).toMatchObject({ reason: 'unsupported' })
      expect(await handle.usage()).toMatchObject({ reason: 'unsupported' })
      expect(await handle.stageAttachment({ bytes: new Uint8Array(), filename: 'a', mediaType: 't' })).toMatchObject({
        reason: 'unsupported',
      })
    } finally {
      runtime.dispose()
    }
  })

  it('acknowledges durable journals only on exact identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'headless-ack-'))
    roots.push(root)
    const previous = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = join(root, 'state')
    try {
      const { runtime } = makeRuntime()
      try {
        const sessionId = asSessionId('headless-ack-1')
        const turnId = 'ack-turn'
        const accountId = asAccountId(ACCOUNT)
        const requestDigest = 'a'.repeat(64)
        // Missing journal: ack is a no-op, never a throw.
        runtime.acknowledge({ sessionId, turnId, requestDigest, accountId })
        // Present journal with another identity: mismatch throws and retains.
        const dirHash = createHash('sha256').update(`${sessionId}\u0000${turnId}`).digest('hex')
        const dir = join(root, 'state', 'headless-turns', dirHash)
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          join(dir, 'request-identity.json'),
          JSON.stringify({ sessionId, turnId, requestDigest, accountId }),
        )
        writeFileSync(join(dir, 'result.json'), '{}')
        expect(() =>
          runtime.acknowledge({ sessionId, turnId, requestDigest: 'b'.repeat(64), accountId }),
        ).toThrow(/mismatched/)
        expect(existsSync(dir)).toBe(true)
        // Exact identity deletes.
        runtime.acknowledge({ sessionId, turnId, requestDigest, accountId })
        expect(existsSync(dir)).toBe(false)
      } finally {
        runtime.dispose()
      }
      } finally {
      if (previous === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = previous
    }
  })
})

// ---------------------------------------------------------------------------
// Procedures override
// ---------------------------------------------------------------------------

describe('headless procedures', () => {
  it('carries TurnInput.id into the durable procedure as the turn identity', async () => {
    const { runtime, runners } = makeRuntime()
    try {
      const driver = runtime.driverFor('claude-code')
      const handle = await driver.create(makeSpec('claude-code'))
      const sessionId = handle.binding.sessionId
      const procedures = resolveProcedures(driver)
      const waited = procedures.askAndAwait(
        handle,
        makeTurn(sessionId, { turnId: 'proc-turn' }),
        { origin: 'system' },
      )
      await flush()
      expect(runners.turns).toHaveLength(1)
      runners.turns[0]?.emit({ kind: 'status', status: 'running', harnessSessionId: 'h-p' })
      runners.turns[0]?.resolve({ harnessSessionId: 'h-p', output: 'procedural' })
      const terminal = await waited
      expect(terminal).toMatchObject({ ev: 'completed', turnEpoch: 1, verdict: 'done' })
      await expect(
        procedures.askAndAwait(handle, { text: 'no identity' }, { origin: 'system' }),
      ).rejects.toThrow(/TurnInput.id/)
    } finally {
      runtime.dispose()
    }
  })
})
