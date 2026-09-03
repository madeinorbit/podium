/**
 * WHAT THE SERVER-FAMILY BINDS SAY ABOUT THE GRID (POD-3290).
 *
 * All four of these drivers used to send `geometry: { cols: 120, rows: 40 }` on
 * every launch. Nothing had been put at that size — three of them run a server
 * or a stdio engine with no terminal at all, and the fourth is an in-process
 * SDK — but the server has no way to tell a report from an invention, so it
 * marked W `current` on it and a session that had never been sized announced
 * one anyway.
 *
 * Both halves, per driver:
 *
 *   ABSENT  — a launch opens no terminal, so the record is empty and the bind
 *             states nothing about the grid.
 *   PRESENT — with a client terminal open (that is what writes the record; see
 *             `opencode-attach.test.ts`), the same bind reports THAT size.
 *
 * The second half is what arms the first: without it, a bind hardcoded to omit
 * the field would pass just as happily as one that reads the record.
 */

import type { AgentSessionHandle, ClaudeSdkRuntime } from '@podium/agent-runtime'
import { asSessionId, type SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { AppliedGeometryRecord } from '../control/applied-geometry'

const mocks = vi.hoisted(() => ({
  createOpencodeRuntime: vi.fn(),
  createCodexRuntime: vi.fn(),
  createGrokAcpRuntime: vi.fn(),
  createClaudeSdkRuntime: vi.fn(),
}))

/**
 * PARTIAL, on purpose: only the four runtime factories are replaced. Every
 * capability lookup a bind makes (`configureFieldsForDriver`,
 * `attachKindsForDriver`, the driver-id constants) stays REAL, so this suite
 * cannot disagree with what the drivers actually declare.
 */
vi.mock('@podium/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/agent-runtime')>()
  return { ...actual, ...mocks }
})

const { createDaemonOpencodeRuntime } = await import('./opencode-driver')
const { createDaemonCodexRuntime } = await import('./codex-driver')
const { createDaemonGrokRuntime } = await import('./grok-driver')
const { createDaemonClaudeSdkRuntime } = await import('./claude-sdk-driver')

const SESSION = asSessionId('s-server-family')

type BindFrame = Extract<DaemonMessage, { type: 'bind' }>

function handleFor(driver: string, harness: string): AgentSessionHandle {
  return {
    binding: {
      sessionId: SESSION,
      driver,
      family: 'server',
      harness,
      workdir: '/w',
      resume: null,
      process: { key: `${driver}:${SESSION}` },
      bindingVersion: 1,
    },
    state: async () => ({
      phase: 'idle' as const,
      since: '2026-09-03T00:00:00.000Z',
      nativeSubagentCount: 0,
    }),
    events: async function* () {},
    send: async () => ({}) as never,
  } as unknown as AgentSessionHandle
}

function stubRuntime(handle: AgentSessionHandle): unknown {
  return {
    createWithId: vi.fn(async () => handle),
    resumeWithId: vi.fn(async () => handle),
    handleFor: vi.fn((id: SessionId) => (id === SESSION ? handle : undefined)),
    journal: { read: () => undefined },
    driver: {},
  }
}

/** Launch one family and return the `bind` it published. */
async function launchBind(
  family: 'opencode' | 'codex' | 'grok' | 'claude-sdk',
  appliedGeometry: AppliedGeometryRecord,
): Promise<BindFrame> {
  const sent: DaemonMessage[] = []
  const send = (message: DaemonMessage): void => {
    sent.push(message)
  }
  const host = { journal: { read: () => undefined } } as never
  if (family === 'opencode') {
    mocks.createOpencodeRuntime.mockReset()
    mocks.createOpencodeRuntime.mockReturnValue(
      stubRuntime(handleFor('opencode-server', 'opencode')),
    )
    await createDaemonOpencodeRuntime({ send, host, appliedGeometry }).launch({
      sessionId: SESSION,
      cwd: '/w',
    })
  } else if (family === 'codex') {
    mocks.createCodexRuntime.mockReset()
    mocks.createCodexRuntime.mockReturnValue(stubRuntime(handleFor('codex-app-server', 'codex')))
    await createDaemonCodexRuntime({ send, host, appliedGeometry }).launch({
      sessionId: SESSION,
      cwd: '/w',
    })
  } else if (family === 'grok') {
    mocks.createGrokAcpRuntime.mockReset()
    mocks.createGrokAcpRuntime.mockReturnValue(stubRuntime(handleFor('grok-acp', 'grok')))
    await createDaemonGrokRuntime({ send, host, appliedGeometry }).launch({
      sessionId: SESSION,
      cwd: '/w',
    })
  } else {
    mocks.createClaudeSdkRuntime.mockReset()
    mocks.createClaudeSdkRuntime.mockReturnValue(
      stubRuntime(handleFor('claude-sdk', 'claude-code')) as ClaudeSdkRuntime,
    )
    await createDaemonClaudeSdkRuntime({ send, host, appliedGeometry }).launch({
      sessionId: SESSION,
      cwd: '/w',
    })
  }
  const bind = sent.find((message): message is BindFrame => message.type === 'bind')
  expect(bind, `${family} published no bind at all`).toBeDefined()
  return bind as BindFrame
}

const FAMILIES = ['opencode', 'codex', 'grok', 'claude-sdk'] as const

describe('a server-family bind reports a grid only when the daemon applied one', () => {
  it.each(FAMILIES)('%s: a launch opens no terminal, so the bind is BARE', async (family) => {
    const bind = await launchBind(family, new AppliedGeometryRecord())
    // ABSENT, not `geometry: undefined`: the server reads absence as "W is
    // unknown to me" and waits for the first viewer's ask.
    expect(bind).not.toHaveProperty('geometry')
    // …and the frame is otherwise the one this family always sent, so the
    // assertion above is about the grid and not about a bind that failed.
    expect(bind).toMatchObject({ sessionId: SESSION, cwd: '/w', runtimeContract: true })
  })

  it.each(
    FAMILIES,
  )('%s: with a client terminal open at 120x40, the SAME bind reports it', async (family) => {
    const record = new AppliedGeometryRecord()
    // What `clientTerminals` writes when it really opens a harness client at
    // its birth size. Here it stands for that; the write itself is covered in
    // `opencode-attach.test.ts`.
    record.apply(SESSION, 120, 40)
    expect(await launchBind(family, record)).toMatchObject({
      geometry: { cols: 120, rows: 40 },
    })
  })

  it.each(FAMILIES)('%s: reports the record, whatever is in it', async (family) => {
    const record = new AppliedGeometryRecord()
    record.apply(SESSION, 200, 60)
    // ARMS the 120x40 case above against a bind that reverted to a hardcoded
    // default: this one can only pass by reading.
    expect(await launchBind(family, record)).toMatchObject({
      geometry: { cols: 200, rows: 60 },
    })
  })
})
