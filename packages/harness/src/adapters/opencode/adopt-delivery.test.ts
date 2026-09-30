/** POD-4794 defect 1: adopt an idle OpenCode terminal session after a daemon
 *  restart, deliver a when-ready send, and require the transcript echo to be
 *  observed with the row settling delivered.
 *
 *  Lowest layer spanning the seam: the REAL opencode poll observer (fixture
 *  SQLite store, adopt-shaped inputs: stale recorded resume, no startedAtMs)
 *  feeds the REAL terminal driver. If the observer fails to rebind after the
 *  adopt, no echo can ever arrive and the row degrades instead of delivering.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import type { AgentKind, AgentRuntimeState, SessionId, TranscriptItem } from '@podium/model'
import { asSessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { createTerminalRuntime, type TerminalHarnessProfile } from '../../driver/families/terminal/runtime.js'
import type { TerminalTransport } from '../../driver/families/terminal/host-ports.js'
import { createMemoryDriverSlots } from '../../driver/testing/driver-slots.js'
import { declaredValue } from '../../transcript-types.js'
import { harnessInterrupt, harnessNeedsSubmitVerification, harnessUsesRawFirstTurn, manifestFor } from '../../registry.js'
import { observeOpencodeState } from './state.js'

const loadSource = () => import('../../store/sources/sqlite.js')

function testProfileFor(agentKind: AgentKind): TerminalHarnessProfile {
  const manifest = manifestFor(agentKind)
  if (!manifest) throw new Error(`missing manifest for ${agentKind}`)
  const terminal = manifest.runtime.terminal
  const interrupt = harnessInterrupt(agentKind)
  return {
    driverId: terminal.driverId,
    instrumentationRequired: declaredValue(manifest.instrumentation) !== undefined,
    sendProof: terminal.sendProof,
    composerReadiness: manifest.capabilities.composerReadiness,
    acceptCorrelation: terminal.acceptCorrelation,
    transcriptTimestamps: terminal.transcriptTimestamps,
    exitLosesUnrecorded: terminal.exitLosesUnrecorded === true,
    lifecycleFromState: terminal.lifecycleFromState === true,
    needsSubmitVerification: harnessNeedsSubmitVerification(agentKind),
    usesRawFirstTurn: harnessUsesRawFirstTurn(agentKind),
    archivable: declaredValue(manifest.handoffTranscript) !== undefined,
    reportsContextPercent: manifest.capabilities.observationProvider !== 'none',
    interruptBytes: interrupt.bytes,
    interruptQuitsWhenIdle: interrupt.quitsWhenIdle,
  }
}

const PASTE_START = '[200~'
const PASTE_END = '[201~'
const pastedText = (text: string): string | undefined =>
  text.startsWith(PASTE_START) && text.endsWith(PASTE_END)
    ? text.slice(PASTE_START.length, text.length - PASTE_END.length)
    : undefined

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor: predicate not satisfied in time')
    await new Promise((r) => setTimeout(r, 25))
  }
}

function seedAdoptDb(databasePath: string, sessionId: string, cwd: string): void {
  const db = openDatabase(databasePath)
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'proj', parent_id TEXT,
    slug TEXT NOT NULL DEFAULT 'slug', directory TEXT NOT NULL, title TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '1', share_url TEXT, summary_additions INTEGER,
    summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, revert TEXT,
    permission TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    time_compacting INTEGER, time_archived INTEGER, workspace_id TEXT, path TEXT,
    agent TEXT, model TEXT, cost REAL NOT NULL DEFAULT 0, tokens_input INTEGER NOT NULL DEFAULT 0,
    tokens_output INTEGER NOT NULL DEFAULT 0, tokens_reasoning INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0,
    metadata TEXT)`)
  db.exec(`CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  db.exec(`CREATE TABLE part (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  // Old timestamps: an adopted idle survivor, long settled before the restart.
  db.prepare(`INSERT INTO session (id, directory, title, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?)`).run(sessionId, cwd, 't', 1_700_000_000_000, 1_700_000_100_000)
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?)`).run('msg-base', sessionId, 1, 2, JSON.stringify({ role: 'assistant' }))
  db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    'prt-base',
    'msg-base',
    sessionId,
    1,
    2,
    JSON.stringify({ type: 'text', text: 'idle baseline' }),
  )
  db.close()
}

interface VirtualTimer {
  at: number
  fn: () => void
  cancelled: boolean
}

describe('adopt rebinding delivers mail (POD-4794 defect 1)', () => {
  it('observes the echo and settles delivered after an adopt with a stale resume', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-opencode-adopt-delivery-'))
    const databasePath = join(home, 'opencode.db')
    seedAdoptDb(databasePath, 'ses_adopt', '/repo/adopt')

    const POD_SID = asSessionId('f1595322-a014-4b85-8104-f32089d4198f')
    let clock = Date.UTC(2026, 7, 14)
    // MANUALLY pumped: the driver's verification window must stay open across
    // the observer's real-time poll. Auto-pumping would drain the virtual
    // window in microseconds, before the 10ms poll can answer.
    let timers: VirtualTimer[] = []
    const stepTimers = (): void => {
      timers = timers.filter((t) => !t.cancelled)
      if (timers.length === 0) return
      timers.sort((a, b) => a.at - b.at)
      const next = timers.shift()
      if (next) {
        clock = Math.max(clock, next.at)
        next.fn()
      }
    }
    const phases = new Map<SessionId, AgentRuntimeState>([
      [POD_SID, { phase: 'idle', since: new Date(clock).toISOString(), nativeSubagentCount: 0 }],
    ])
    const written: string[] = []
    const frames: DaemonMessage[] = []
    const transports = new Map<SessionId, TerminalTransport>()
    const slots = createMemoryDriverSlots()
    let runtime!: ReturnType<typeof createTerminalRuntime>

    const TEXT = '[podium message msg_x] hello adopted agent'
    // The TUI records the turn in its own store the moment the bytes land —
    // synchronous with the write, the way a live CLI would.
    const recordTurn = (pasted: string): void => {
      if (pasted !== TEXT) return
      const nowMs = Date.now()
      const db = openDatabase(databasePath)
      db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES (?, ?, ?, ?, ?)`).run(
        'msg-u1',
        'ses_adopt',
        nowMs,
        nowMs,
        JSON.stringify({ role: 'user' }),
      )
      db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        'prt-u1',
        'msg-u1',
        'ses_adopt',
        nowMs,
        nowMs,
        JSON.stringify({ type: 'text', text: TEXT }),
      )
      db.prepare(`UPDATE session SET time_updated = ? WHERE id = ?`).run(nowMs, 'ses_adopt')
      db.close()
    }
    const ensureTransport = (sessionId: SessionId): TerminalTransport => {
      let t = transports.get(sessionId)
      if (!t) {
        t = {
          live: true,
          writeBase64: (dataBase64: string) => {
            const text = Buffer.from(dataBase64, 'base64').toString('utf8')
            written.push(text)
            const pasted = pastedText(text)
            if (pasted !== undefined) recordTurn(pasted)
          },
        }
        transports.set(sessionId, t)
      }
      return t
    }

    runtime = createTerminalRuntime(
      {
        installInstrumentation: async () => ({ args: [] }),
        stageAttachment: async ({ source }) => ({
          id: 'a1',
          path: '/tmp/a1',
          filename: source.filename,
          mediaType: source.mediaType,
          kind: source.mediaType.startsWith('image/') ? 'image' : 'file',
        }),
        send: (msg) => frames.push(msg),
        trackedState: (sessionId) => phases.get(sessionId),
        draftSyncing: () => false,
        setDraftTarget: () => false,
        processAlive: async () => true,
        recover: async (msg, ready) => {
          ready(ensureTransport(msg.sessionId))
        },
        stopSession: async () => true,
        launch: async () => {},
        readHistory: async () => ({ items: [], hasMore: false }),
        archiveTranscript: async () => ({ path: '/tmp/s.jsonl' }),
        readArchiveBytes: async () => new TextEncoder().encode('{}'),
        resources: () => ({ memoryBytes: 1, oomKills: 0 }),
        now: () => clock,
        setTimer: (fn, delayMs) => {
          // Queued only: the test steps the virtual clock explicitly so the
          // verification window stays open across the observer's real poll.
          const timer: VirtualTimer = { at: clock + delayMs, fn, cancelled: false }
          timers.push(timer)
          return timer
        },
        clearTimer: (handle) => {
          ;(handle as VirtualTimer).cancelled = true
        },
        onDrainAbandoned: () => {},
      },
      undefined,
      slots,
    )
    const slotsSet = slots.set.bind(slots)
    slots.set = (sessionId, handle) => {
      slotsSet(sessionId, handle)
      runtime.setTerminal(sessionId, ensureTransport(sessionId))
    }

    // Adopt shape: stale recorded resume (resolves nowhere), no startedAtMs.
    const attached: string[] = []
    const obs = observeOpencodeState({
      cwd: '/repo/adopt',
      databasePath,
      resumeValue: 'ses_stale_gone',
      pollMs: 10,
      loadSource,
      onEvents: () => {},
      onSession: (id) => attached.push(id),
      onTranscriptItems: (items, reset) => {
        const stamped: TranscriptItem[] = items as TranscriptItem[]
        runtime.observe({
          type: 'transcriptDelta',
          sessionId: POD_SID,
          items: stamped,
          ...(reset ? { reset: true } : {}),
        })
      },
    })
    const pastes = (): string[] =>
      written.map(pastedText).filter((t): t is string => t !== undefined)
    const outcomes = (): Array<{ rowId: string; outcome: string }> =>
      frames.flatMap((f) =>
        f.type === 'runtimeEvent' && f.event.t === 'delivery'
          ? [{ rowId: f.event.rowId, outcome: f.event.outcome }]
          : [],
      )
    try {
      // The adopted survivor re-registers (live=false until bind).
      const session = runtime.register(
        { sessionId: POD_SID, agentKind: 'opencode', cwd: '/repo/adopt', resume: null },
        testProfileFor('opencode'),
      )
      clock -= 6000
      runtime.observe({ type: 'bind', sessionId: POD_SID, cmd: 'f', cwd: '/repo/adopt', agentKind: 'opencode' })
      clock += 6000

      // THE REBIND: the observer must attach despite the stale resume, and the
      // baseline transcript must reach the driver.
      await waitFor(() => attached.length > 0)
      expect(attached).toEqual(['ses_adopt'])

      const receipt = await session.send(
        { id: 'row-adopt', rowId: 'row-adopt', text: TEXT },
        { origin: 'mail', delivery: 'when-ready' },
      )
      expect(receipt.outcome).toBe('queued')
      await waitFor(() => pastes().includes(TEXT))
      expect(pastes()).toContain(TEXT)

      // The rebound poll observes the recorded turn; the echo settles it.
      // Each round steps the driver's virtual clock once, then yields to the
      // observer's real-time poll.
      const deadline = Date.now() + 8000
      for (;;) {
        stepTimers()
        if (outcomes().some((e) => e.rowId === 'row-adopt')) break
        if (Date.now() > deadline) throw new Error('waitFor: predicate not satisfied in time')
        await new Promise((r) => setTimeout(r, 25))
      }
      expect(outcomes()).toContainEqual({ rowId: 'row-adopt', outcome: 'delivered' })
    } finally {
      obs.stop()
      runtime.dispose()
    }
  })
})
