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
function retainedInput(phase: string, recover = true, initialDraft = '') {
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
  const delivery = machine.deliver(text, { origin: 'human', delivery: 'when-ready', signal: controller.signal })
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
})
