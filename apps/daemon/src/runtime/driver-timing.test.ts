import type { RuntimeEvent, SessionBinding } from '@podium/agent-runtime'
import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { DriverTimingRecorder, type DriverTimingRecord } from './driver-timing'

const SESSION = asSessionId('timing-session')

const binding = (family: SessionBinding['family'] = 'server'): SessionBinding => ({
  sessionId: SESSION,
  driver: family === 'terminal' ? 'generic-pty' : 'codex-app-server',
  family,
  harness: 'codex',
  workdir: '/work',
  resume: null,
  process: { key: 'timing-process' },
  bindingVersion: 1,
})

const event = (body: object, turnEpoch = 1): RuntimeEvent =>
  ({
    at: '2026-08-30T12:00:00.000Z',
    provenance: 'live',
    cursor: { segmentId: 'timing', components: { seq: 1 } },
    observerGeneration: 1,
    turnEpoch,
    ...body,
    // The envelope is shared; each caller supplies the `t`/`ev` discriminant,
    // which an `object` body cannot state to the checker.
  }) as unknown as RuntimeEvent

describe('driver timing recorder', () => {
  it('logs launch, accepted prompt, first response, and completion from monotonic clocks', () => {
    let now = 1_000
    const records: DriverTimingRecord[] = []
    const timing = new DriverTimingRecorder({
      now: () => now,
      write: (record) => records.push(record),
    })

    timing.sessionRequested({ sessionId: SESSION, harness: 'codex' })
    now += 25
    timing.driverSelected(SESSION, 'codex-app-server')
    now += 75
    timing.sessionReady(binding())
    timing.promptRequested(binding(), 'turn-1')
    now += 10
    timing.promptReceipt(binding(), 'turn-1', {
      outcome: 'accepted',
      turnEpoch: 1,
      deliveredAs: 'when-ready',
      provenBy: 'protocol-ack',
      at: '2026-08-30T12:00:00.010Z',
    })
    now += 15
    timing.runtimeEvent(
      binding(),
      event({ t: 'item', item: { kind: 'delta', itemId: 'a', textDelta: 'O' } }),
    )
    now += 75
    timing.runtimeEvent(
      binding(),
      event({ t: 'turn', ev: { ev: 'completed', turnEpoch: 1, verdict: 'done' } }),
    )

    expect(records.map(({ stage, durationMs }) => [stage, durationMs])).toEqual([
      ['session_requested', 0],
      ['driver_selected', 25],
      ['session_ready', 100],
      ['prompt_requested', 0],
      ['prompt_accepted', 10],
      ['turn_first_response', 25],
      ['turn_completed', 100],
    ])
    expect(records.at(-1)).toMatchObject({
      family: 'server',
      runtimeMode: 'headless',
      turnId: 'turn-1',
      turnEpoch: 1,
    })
  })

  it('attributes an initial prompt when its turn event arrives before a receipt', () => {
    let now = 50
    const records: DriverTimingRecord[] = []
    const timing = new DriverTimingRecorder({
      now: () => now,
      write: (record) => records.push(record),
    })

    timing.sessionRequested({
      sessionId: SESSION,
      harness: 'codex',
      requestedDriverId: 'generic-pty',
      initialPrompt: true,
    })
    now += 40
    timing.runtimeEvent(
      binding('terminal'),
      event({ t: 'turn', ev: { ev: 'started', turnEpoch: 1, origin: 'human' } }),
    )

    expect(records.at(-1)).toMatchObject({
      stage: 'turn_started',
      source: 'initial-prompt',
      durationMs: 40,
      runtimeMode: 'headed',
    })
  })

  it('records headed process and first output once on the launch clock', () => {
    let now = 100
    const records: DriverTimingRecord[] = []
    const timing = new DriverTimingRecorder({
      now: () => now,
      write: (record) => records.push(record),
    })

    timing.sessionRequested({ sessionId: SESSION, harness: 'codex' })
    now += 10
    timing.driverSelected(SESSION, 'generic-pty')
    now += 15
    timing.headedCliStage(SESSION, 'codex', 'native_cli_process_started', { adopted: false })
    now += 20
    timing.headedCliStage(SESSION, 'codex', 'native_cli_first_output', { bytes: 4 })
    timing.headedCliStage(SESSION, 'codex', 'native_cli_first_output', { bytes: 8 })

    expect(records.map(({ stage, lane, durationMs }) => [stage, lane, durationMs])).toEqual([
      ['session_requested', 'launch', 0],
      ['driver_selected', 'launch', 10],
      ['native_cli_spawn_requested', 'launch', 10],
      ['native_cli_process_started', 'launch', 25],
      ['native_cli_first_output', 'launch', 45],
    ])
  })

  it('times a human-submitted native prompt from the PTY newline boundary', () => {
    let now = 300
    const records: DriverTimingRecord[] = []
    const timing = new DriverTimingRecorder({
      now: () => now,
      write: (record) => records.push(record),
    })
    const terminal = binding('terminal')

    timing.sessionRequested({ sessionId: SESSION, harness: 'codex' })
    timing.driverSelected(SESSION, 'generic-pty')
    timing.sessionReady(terminal)
    now += 10
    timing.nativePromptSubmitted(SESSION)
    now += 20
    timing.runtimeEvent(
      terminal,
      event({ t: 'turn', ev: { ev: 'started', turnEpoch: 1, origin: 'human' } }),
    )
    now += 30
    timing.runtimeEvent(
      terminal,
      event({ t: 'turn', ev: { ev: 'completed', turnEpoch: 1, verdict: 'done' } }),
    )

    expect(records.filter((record) => record.lane === 'turn')).toMatchObject([
      { stage: 'prompt_requested', source: 'native-input', durationMs: 0 },
      { stage: 'turn_started', source: 'native-input', durationMs: 20 },
      { stage: 'turn_completed', source: 'native-input', durationMs: 50 },
    ])
  })

  it('separates attach spawn, first output, input readiness, endpoint, and refusal', () => {
    let now = 200
    const records: DriverTimingRecord[] = []
    const timing = new DriverTimingRecorder({
      now: () => now,
      write: (record) => records.push(record),
    })

    timing.attachRequested(binding())
    now += 5
    timing.nativeCliStage(SESSION, 'codex', 'native_cli_spawn_requested')
    now += 20
    timing.nativeCliStage(SESSION, 'codex', 'native_cli_process_started')
    now += 30
    timing.nativeCliStage(SESSION, 'codex', 'native_cli_first_output')
    timing.nativeCliStage(SESSION, 'codex', 'native_cli_first_output')
    now += 10
    timing.nativeCliStage(SESSION, 'codex', 'native_cli_input_ready')
    now += 1
    timing.attachResult(binding(), {
      kind: 'client',
      placement: 'on-machine',
      stream: { id: 'timing-session' },
      warm: { ttlMs: 1_000 },
    })
    timing.attachRequested(binding())
    now += 2
    timing.attachResult(binding(), { reason: 'busy' })

    expect(records.map(({ stage, durationMs, attempt }) => [stage, durationMs, attempt])).toEqual([
      ['attach_requested', 0, 1],
      ['native_cli_spawn_requested', 5, 1],
      ['native_cli_process_started', 25, 1],
      ['native_cli_first_output', 55, 1],
      ['native_cli_input_ready', 65, 1],
      ['attach_endpoint_ready', 66, 1],
      ['attach_requested', 0, 2],
      ['attach_refused', 2, 2],
    ])
  })
})
