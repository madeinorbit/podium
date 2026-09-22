import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureManifest } from '@podium/harness/adapters/fixture'
import {
  clearTestManifests,
  manifestFor,
  registerTestManifest,
} from '@podium/harness'
import { asSessionId, type AgentKind } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readTranscript, type TranscriptArchiveContext } from './control/transcripts.js'
import { managementLoginCommandFor } from './harness-management.js'
import { transcriptForExport } from './handoff-package.js'
import {
  resolveRuntimeDriver,
  selectionAuthForLogin,
  terminalProfileFor,
} from './runtime/registry.js'

/**
 * THE FIXTURE HARNESS THROUGH THE REAL SERVER→DAEMON ROUTE (POD-4474, spec §7).
 *
 * The harness-side suite proves the manifest is well-formed; this file proves
 * every mechanism SERVES it where server frames actually land — the daemon's
 * manifest-dispatched control handlers, not the driver directly:
 *
 *   transcriptRead frame → control/transcripts.ts → manifestFor → Store chain
 *   spawn planning      → runtime/registry.ts    → select() + terminal profile
 *   login argv          → harness-management.ts  → inventory.loginCommand
 *   export              → handoff-package.ts     → handoffTranscript section
 *
 * No PTY is spawned and no CLI runs: the route under test is dispatch, and
 * dispatch is what a seventh harness has to survive. The spawn path itself
 * (control/session.ts) needs a process and stays in the integration lane.
 */

const FIXTURE = 'fixture' as AgentKind

const RECORDS = [
  { v: 1, id: 'u1', ts: '2026-09-22T03:00:00.000Z', role: 'user', text: 'route hello' },
  {
    v: 1,
    id: 'a1',
    ts: '2026-09-22T03:00:01.000Z',
    role: 'agent',
    text: 'route back',
    model: 'fixture-model-1',
  },
]

describe('fixture harness through the server→daemon route', () => {
  let home: string
  let replies: DaemonMessage[]
  let ctx: TranscriptArchiveContext
  let unregister: () => void

  beforeEach(async () => {
    expect(manifestFor('fixture')).toBeUndefined()
    home = await mkdtemp(join(tmpdir(), 'fixture-route-'))
    await mkdir(join(home, '.fixture', 'sessions'), { recursive: true })
    await writeFile(
      join(home, '.fixture', 'sessions', 'sess-1.jsonl'),
      RECORDS.map((record) => JSON.stringify(record)).join('\n'),
    )
    await writeFile(join(home, '.fixture', 'auth.json'), JSON.stringify({ account: 'router' }))
    replies = []
    ctx = {
      homeDir: home,
      send: (message) => {
        replies.push(message as DaemonMessage)
      },
    }
    // THE SETUP'S RETURN IS THE ASSERTION: a registration that silently
    // installed nothing would read as "integration broken" with zero events.
    unregister = registerTestManifest(fixtureManifest)
    expect(typeof unregister).toBe('function')
    expect(manifestFor('fixture')).toBe(fixtureManifest)
  })

  afterEach(async () => {
    unregister()
    clearTestManifests()
    expect(manifestFor('fixture')).toBeUndefined()
    await rm(home, { recursive: true, force: true })
  })

  it('serves a transcriptRead frame with the fixture grammar items', async () => {
    await readTranscript(ctx, {
      type: 'transcriptRead',
      requestId: 'read-1',
      sessionId: asSessionId('sess-row-1'),
      agentKind: FIXTURE,
      cwd: '/work',
      resume: { kind: 'fixture-session', value: 'sess-1' },
      direction: 'before',
      limit: 10,
    })
    // Assert the reply the server would route back, not just "no throw":
    // the two items, in order, with the model the grammar reports.
    expect(replies).toEqual([
      expect.objectContaining({
        type: 'transcriptReadResult',
        requestId: 'read-1',
        items: [
          expect.objectContaining({ role: 'user', text: 'route hello' }),
          expect.objectContaining({ role: 'assistant', text: 'route back' }),
        ],
        hasMore: false,
      }),
    ])
  })

  it('degrades an unknown harness to an empty page rather than another grammar', async () => {
    await readTranscript(ctx, {
      type: 'transcriptRead',
      requestId: 'read-unknown',
      sessionId: asSessionId('sess-row-2'),
      agentKind: 'some-future-cli' as AgentKind,
      cwd: '/work',
      direction: 'before',
      limit: 10,
    })
    expect(replies).toEqual([
      expect.objectContaining({ type: 'transcriptReadResult', items: [] }),
    ])
  })

  it('resolves the terminal driver for a fixture spawn through the real policy', () => {
    // The profile is DERIVED from the registered manifest, never hand-built:
    // a seventh harness that forgets a field fails here, not in production.
    const profile = terminalProfileFor(FIXTURE)
    expect(profile).toMatchObject({
      driverId: 'generic-pty',
      sendProof: ['transcript-echo'],
      composerReadiness: 'on-bind',
      instrumentationRequired: false,
      archivable: true,
    })
    expect(
      resolveRuntimeDriver({ agentKind: FIXTURE, requested: undefined, available: [], platform: 'linux' }),
    ).toEqual({ ok: true, driverId: 'generic-pty' })
    // Capability is three facts: the matrix says terminal is implemented, and
    // selection still answers unknown auth — never "will work".
    expect(selectionAuthForLogin(FIXTURE, 'in')).toBe('unknown')
    // Unknown kinds refuse with the id named, not with a default driver.
    expect(
      resolveRuntimeDriver({
        agentKind: 'some-future-cli' as AgentKind,
        requested: undefined,
        available: [],
        platform: 'linux',
      }),
    ).toEqual({ ok: false, reason: `no manifest for harness 'some-future-cli'` })
  })

  it('answers the login argv from the fixture inventory section', () => {
    // The exact seam control/session.ts reads before opening the login
    // Terminal: Inventory owns the command, the session owns the process.
    expect(managementLoginCommandFor('fixture')).toEqual({
      cmd: 'fixture-agent',
      args: ['login'],
    })
    expect(managementLoginCommandFor('some-future-cli')).toBeUndefined()
  })

  it('exports the handoff transcript from the section the archive path reads', async () => {
    const exported = await transcriptForExport({
      agentKind: 'fixture',
      cwd: '/work',
      resumeValue: 'sess-1',
      home,
    })
    expect(exported.path).toBe(join(home, '.fixture', 'sessions', 'sess-1.jsonl'))
    // And a declined section refuses with its reason named — the same
    // dispatch, the honest answer for opencode.
    await expect(
      transcriptForExport({ agentKind: 'opencode', cwd: '/work', resumeValue: 'x', home }),
    ).rejects.toThrow('declares handoff unsupported')
  })
})
