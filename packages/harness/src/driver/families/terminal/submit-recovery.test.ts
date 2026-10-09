import { describe, expect, it, vi } from 'vitest'
import {
  createTerminalInjection,
  SUBMIT_VERIFY_DELAY_MS,
  type AcceptSeen,
  type TerminalInjectionPorts,
} from './injection.js'
import { injectionPayload } from './paste.js'

// The live failure left the pasted text in Claude's input while a turn ran.
// Model that external result: the first Enter adds a newline; a later Enter
// queues the same input. The regression must exercise deliver(), not a helper.
function retainedInput(
  phase: string,
  recover = true,
  initialDraft = '',
  kind: 'when-ready' | 'steer' = 'when-ready',
) {
  const text = 'Retained prompt\nwith a second line'
  const writes: string[] = []
  let draft = initialDraft
  let foreignWrites = 0
  let held!: () => void
  const heldProof = new Promise<void>((resolve) => { held = resolve })
  const controller = new AbortController()
  const ports: TerminalInjectionPorts & {
    readInput(): Promise<string | undefined>
    foreignWriteCount(): number
  } = {
    now: Date.now,
    running: () => true,
    live: () => true,
    phase: () => phase,
    lastOutputAtMs: () => Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    rawFirstTurn: () => false,
    needsSubmitVerification: () => true,
    observedTurnEpoch: () => 0,
    echoAccept: {
      watch: () => ({ accepted: new Promise<AcceptSeen>(() => {}), held: heldProof, cancel() {} }),
    },
    readInput: async () => draft,
    foreignWriteCount: () => foreignWrites,
    write(bytes) {
      writes.push(bytes)
      if (bytes !== '\r') draft += bytes.slice('\x1b[200~'.length, -'\x1b[201~'.length)
      else if (writes.filter((write) => write === '\r').length === 1) draft += '\n'
      else if (recover) { draft = ''; held() }
    },
  }
  const machine = createTerminalInjection(ports)
  const delivery = machine.deliver(text, { origin: 'human', delivery: kind, signal: controller.signal })
  return {
    ports, writes, text, delivery, machine, signal: controller.signal, queue: held,
    draft: () => draft,
    edit: (value: string) => { draft = value; foreignWrites += 1 },
    async close() {
      controller.abort()
      await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_DELAY_MS)
      await delivery
      machine.dispose()
    },
  }
}

describe('retained input submit recovery', () => {
  it.each(['idle', 'working', 'compacting'])('submits the retained input once while %s, without another paste', async (phase) => {
    vi.useFakeTimers()
    const run = retainedInput(phase)
    try {
      await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_DELAY_MS)
      expect(run.writes).toEqual([injectionPayload(run.text, { rawFirstTurn: false }).bytes, '\r', '\r'])
      expect(run.draft()).toBe('')
      expect(await run.delivery).toMatchObject({ outcome: 'accepted', held: 'memory', provenBy: 'transcript-echo' })
    } finally { await run.close(); vi.useRealTimers() }
  })

  it('recovers a paste Claude collapsed into its measured input placeholder', async () => {
    vi.useFakeTimers()
    const run = retainedInput('working')
    try {
      await vi.advanceTimersByTimeAsync(100)
      run.ports.readInput = async () => '[Pasted text #1 +3 lines]'
      await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_DELAY_MS)
      expect(run.writes).toEqual([injectionPayload(run.text, { rawFirstTurn: false }).bytes, '\r', '\r'])
      expect(await run.delivery).toMatchObject({ outcome: 'accepted', held: 'memory' })
    } finally { await run.close(); vi.useRealTimers() }
  })

  it('does not claim a placeholder without writer accounting', async () => {
    vi.useFakeTimers()
    const run = retainedInput('working')
    try {
      await vi.advanceTimersByTimeAsync(100)
      run.ports.readInput = async () => '[Pasted text #1 +3 lines]'
      delete (run.ports as Partial<typeof run.ports>).foreignWriteCount
      await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_DELAY_MS * 2)
      expect(run.writes.filter((write) => write === '\r')).toHaveLength(1)
    } finally { await run.close(); vi.useRealTimers() }
  })

  it('tries only one recovery Enter and keeps an unproven send unverified', async () => {
    vi.useFakeTimers()
    const run = retainedInput('working', false)
    try {
      await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_DELAY_MS * 3)
      expect(run.writes).toEqual([injectionPayload(run.text, { rawFirstTurn: false }).bytes, '\r', '\r'])
      await run.close()
      expect(await run.delivery).toMatchObject({ outcome: 'unverified' })
    } finally { await run.close(); vi.useRealTimers() }
  })

  it.each([['idle', ''], ['working', ''], ['working', 'An unrelated human edit']])('leaves a cleared or changed input alone (%s, %j)', async (phase, draft) => {
    vi.useFakeTimers()
    const run = retainedInput(phase)
    try {
      await vi.advanceTimersByTimeAsync(100)
      run.ports.readInput = async () => draft
      await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_DELAY_MS * 2)
      expect(run.writes.filter((write) => write === '\r')).toHaveLength(1)
    } finally { await run.close(); vi.useRealTimers() }
  })

  it('does not submit an input another writer edited, even when its text matches', async () => {
    vi.useFakeTimers()
    const run = retainedInput('working')
    try {
      await vi.advanceTimersByTimeAsync(100)
      run.edit(run.text)
      await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_DELAY_MS * 2)
      expect(run.writes.filter((write) => write === '\r')).toHaveLength(1)
    } finally { await run.close(); vi.useRealTimers() }
  })

  it('rechecks writer accounting after the asynchronous screen read', async () => {
    vi.useFakeTimers()
    const run = retainedInput('working')
    try {
      await vi.advanceTimersByTimeAsync(100)
      run.ports.readInput = async () => { run.edit(run.text); return run.text }
      await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_DELAY_MS * 2)
      expect(run.writes.filter((write) => write === '\r')).toHaveLength(1)
    } finally { await run.close(); vi.useRealTimers() }
  })

  it('leaves input that was already occupied before its paste alone', async () => {
    vi.useFakeTimers()
    const run = retainedInput('working', false, 'Existing human draft')
    try {
      await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_DELAY_MS * 2)
      expect(run.writes.filter((write) => write === '\r')).toHaveLength(1)
    } finally { await run.close(); vi.useRealTimers() }
  })

  it('does not recover an earlier paste after another send writes into the same box', async () => {
    vi.useFakeTimers()
    const run = retainedInput('working', false)
    try {
      await vi.advanceTimersByTimeAsync(100)
      const second = run.machine.deliver('Next message', { origin: 'human', delivery: 'when-ready', signal: run.signal })
      await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_DELAY_MS * 2)
      expect(run.writes.filter((write) => write === '\r')).toHaveLength(2)
      await run.close()
      expect(await second).toMatchObject({ outcome: 'unverified' })
    } finally { await run.close(); vi.useRealTimers() }
  })

  it('does not send a recovery CR when native queue proof arrives during the screen read', async () => {
    vi.useFakeTimers()
    const run = retainedInput('working')
    try {
      await vi.advanceTimersByTimeAsync(100)
      run.ports.readInput = async () => { run.queue(); return run.text }
      await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_DELAY_MS)
      expect(run.writes.filter((write) => write === '\r')).toHaveLength(1)
      expect(await run.delivery).toMatchObject({ outcome: 'accepted', held: 'memory' })
    } finally { await run.close(); vi.useRealTimers() }
  })

  it('does not blindly nudge when the previously visible input box disappears', async () => {
    vi.useFakeTimers()
    const run = retainedInput('idle')
    try {
      await vi.advanceTimersByTimeAsync(100)
      run.ports.readInput = async () => undefined
      await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_DELAY_MS * 2)
      expect(run.writes.filter((write) => write === '\r')).toHaveLength(1)
    } finally { await run.close(); vi.useRealTimers() }
  })
})

// A steer is typed into a running turn on purpose (POD-5855). Grok's queue line
// reads "Enter to send now": an Enter into its empty box cancels the turn, so a
// steer must never get the blind ladder a when-ready send gets when nothing
// confirms it. Each case runs the when-ready control arm beside it.
function steerWorld(delivery: 'steer' | 'when-ready', options: { record?: boolean } = {}) {
  const writes: string[] = []
  let record!: (seen: AcceptSeen) => void
  const recorded = new Promise<AcceptSeen>((resolve) => { record = resolve })
  const ports: TerminalInjectionPorts = {
    now: Date.now,
    running: () => true,
    live: () => true,
    // The turn ended between the typing and the first tick: the reading a
    // blind ladder acts on.
    phase: () => 'idle',
    lastOutputAtMs: () => Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    rawFirstTurn: () => false,
    needsSubmitVerification: () => true,
    observedTurnEpoch: () => 3,
    echoAccept: { watch: () => ({ accepted: recorded, cancel() {} }) },
    write(bytes) {
      writes.push(bytes)
      if (bytes === '\r' && options.record) record({ transcriptItem: { id: 'entry-1' } })
    },
  }
  const machine = createTerminalInjection(ports)
  const receipt = machine.deliver('a person typed this mid-turn', { origin: 'controller', delivery })
  return { writes, receipt, machine }
}

describe('a steer typed into a running turn (POD-5855)', () => {
  it.each([
    ['steer', 1],
    ['when-ready', 3],
  ] as const)('a %s with no proof and no input box gets %i Enter(s)', async (delivery, enters) => {
    vi.useFakeTimers()
    const run = steerWorld(delivery)
    try {
      await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_DELAY_MS * 4)
      expect(run.writes.filter((write) => write === '\r')).toHaveLength(enters)
      expect(await run.receipt).toMatchObject({ outcome: 'unverified', deliveredAs: delivery })
    } finally { run.machine.dispose(); vi.useRealTimers() }
  })

  it.each([
    ['steer', 3],
    ['when-ready', 4],
  ] as const)('a recorded %s after a turn names turn %i', async (delivery, turnEpoch) => {
    vi.useFakeTimers()
    const run = steerWorld('when-ready', { record: true })
    try {
      await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_DELAY_MS)
      expect(await run.receipt).toMatchObject({ outcome: 'accepted', turnEpoch: 3 })
      const next = run.machine.deliver('and this too', { origin: 'controller', delivery })
      await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_DELAY_MS)
      // A steer joins the turn it was typed into; only a new turn advances it.
      expect(await next).toMatchObject({ outcome: 'accepted', deliveredAs: delivery, turnEpoch })
    } finally { run.machine.dispose(); vi.useRealTimers() }
  })

  it('still submits a steer Claude left in its input box, once', async () => {
    vi.useFakeTimers()
    const run = retainedInput('working', true, '', 'steer')
    try {
      await vi.advanceTimersByTimeAsync(SUBMIT_VERIFY_DELAY_MS)
      expect(run.writes.filter((write) => write === '\r')).toHaveLength(2)
      expect(await run.delivery).toMatchObject({ outcome: 'accepted', held: 'memory' })
    } finally { await run.close(); vi.useRealTimers() }
  })
})
