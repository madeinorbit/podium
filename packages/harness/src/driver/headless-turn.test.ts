/**
 * HEADLESS TURNS THROUGH THE DRIVER CONTRACT (POD-4386).
 *
 * The legacy daemon headless port fenced every turn on digest, account,
 * replay-without-rerun, ack, rebind and original-deadline. The generic
 * procedures could not carry the per-turn headless fields, so the two
 * production callers stayed on the legacy path. These are the properties the
 * migration rests on, run against the in-memory reference driver: the fields
 * reach the driver, the fences refuse rather than rerun, replays do not
 * re-deliver, acks are identity-checked, resumes rebind the transcript, and
 * the deadline survives a restart.
 */

import { unsupported } from '../manifest.js'
import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  assertHeadlessAccount,
  assertHeadlessDigest,
  assertHeadlessNoTools,
  assertNativeHeadlessAccountId,
  canonicalHeadlessContractFacts,
  createMemoryHeadlessJournal,
  headlessAcknowledge,
  headlessAskAndAwait,
  headlessOneShot,
} from './headless-turn.js'
import type { SessionSpec } from './session-spec.js'
import type { SendOptions, TurnInput } from './turns.js'
import { createFakeDriver, resetFakeRuntime } from './testing/fake-driver.js'

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)
const ACCOUNT = 'native:fake-harness:fp-1'
const OTHER_ACCOUNT = 'native:fake-harness:fp-2'

const SPEC: SessionSpec = {
  harness: 'fake-harness',
  selection: { auth: 'unknown', platform: 'linux', available: ['fake'] },
  workdir: '/repo',
  model: {},
  instructions: unsupported('headless test needs no instructions'),
  mcpServers: unsupported('headless test needs no MCP servers'),
}

function item(id: string, text: string): TranscriptItem {
  return { id, role: 'assistant', text, ts: '2026-09-19T00:00:00.000Z' }
}

async function driveTurn(
  sessionId: Parameters<ReturnType<typeof createFakeDriver>['control']['completeTurn']>[0],
  driver: ReturnType<typeof createFakeDriver>,
  succeed = true,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10))
  if (succeed) driver.control.completeTurn(sessionId)
  else driver.control.failTurn(sessionId, 'provider-error')
}

describe('headless contract fields', () => {
  it('carries per-turn headless fields to the driver', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const handle = await driver.create(SPEC)
    const sessionId = handle.binding.sessionId
    const waited = headlessAskAndAwait(
      handle,
      {
        text: 'hello',
        allowedTools: ['Read', 'Bash'],
        permissionMode: 'auto',
        mcpConfig: '{"mcpServers":{}}',
        resumeValue: 'harness-1',
        sessionUuid: 'uuid-1',
        accountId: ACCOUNT,
        requestDigest: DIGEST_A,
        structuredPermissions: true,
      },
      { turnId: 'turn-1', harness: 'fake-harness' },
    )
    await driveTurn(sessionId, driver)
    await waited
    expect(driver.control.lastHeadless(sessionId)).toMatchObject({
      allowedTools: ['Read', 'Bash'],
      permissionMode: 'auto',
      mcpConfig: '{"mcpServers":{}}',
      resumeValue: 'harness-1',
      sessionUuid: 'uuid-1',
      accountId: ACCOUNT,
      requestDigest: DIGEST_A,
      structuredPermissions: true,
    })
  })

  it('carries session-level headless defaults on SessionSpec', () => {
    const spec: SessionSpec = {
      ...SPEC,
      durableLabel: 'podium-s1',
      executablePath: '/usr/bin/claude',
      structuredPermissions: true,
      allowedTools: ['Read'],
      permissionMode: 'auto',
      toolPolicy: 'none',
      accountId: ACCOUNT,
    }
    expect(spec.durableLabel).toBe('podium-s1')
    expect(spec.executablePath).toBe('/usr/bin/claude')
    expect(spec.accountId).toBe(ACCOUNT)
  })

  it('runs on every dispatch family (server, terminal)', async () => {
    for (const family of ['server', 'terminal'] as const) {
      resetFakeRuntime()
      const driver = createFakeDriver({ family })
      const handle = await driver.create(SPEC)
      const sessionId = handle.binding.sessionId
      const waited = headlessAskAndAwait(
        handle,
        { text: 'hi', accountId: ACCOUNT, requestDigest: DIGEST_A },
        { turnId: `t-${family}`, harness: 'fake-harness' },
      )
      await driveTurn(sessionId, driver)
      const outcome = await waited
      expect(outcome.terminal.ev).toBe('completed')
    }
  })

  it('pins the canonical facts shape for the digest', () => {
    const facts = {
      prompt: 'p',
      turnId: 't',
      sessionId: 's',
      accountId: ACCOUNT,
    }
    const a = canonicalHeadlessContractFacts(facts)
    const b = canonicalHeadlessContractFacts({ ...facts })
    expect(a).toBe(b)
    expect(a).toContain('"prompt":"p"')
  })
})

describe('headless fences', () => {
  it('refuses a malformed digest at the driver', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const handle = await driver.create(SPEC)
    const receipt = await handle.send(
      { text: 'x', accountId: ACCOUNT, requestDigest: 'not-hex' },
      { origin: 'system', delivery: 'when-ready' },
    )
    expect(receipt.outcome).toBe('refused')
    if (receipt.outcome === 'refused') {
      expect(receipt.refusal.reason).toBe('invalid_value')
      expect(receipt.refusal.detail).toContain('digest')
    }
  })

  it('refuses toolPolicy none without a native account at the driver', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const handle = await driver.create(SPEC)
    const receipt = await handle.send(
      { text: 'x', toolPolicy: 'none', accountId: 'operator', requestDigest: DIGEST_A },
      { origin: 'system', delivery: 'when-ready' },
    )
    expect(receipt.outcome).toBe('refused')
    if (receipt.outcome === 'refused') expect(receipt.refusal.detail).toContain('native')
  })

  it('refuses toolPolicy none when the harness cannot enforce it', () => {
    expect(() => assertHeadlessNoTools('none', false, 'grok')).toThrow(/cannot enforce/)
  })

  it('refuses a non-native account for tool-less turns', () => {
    expect(() => assertNativeHeadlessAccountId('claude', 'operator')).toThrow(/exact native/)
  })

  it('refuses a digest mismatch', () => {
    expect(() => assertHeadlessDigest(DIGEST_A, DIGEST_B)).toThrow(/digest mismatch/)
  })

  it('refuses an account mismatch', () => {
    expect(() => assertHeadlessAccount(ACCOUNT, OTHER_ACCOUNT)).toThrow(/identity mismatch/)
  })

  it('requires digest and account identity', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const handle = await driver.create(SPEC)
    await expect(headlessAskAndAwait(handle, { text: 'x' }, { turnId: 't' })).rejects.toThrow(
      /requestDigest and accountId/,
    )
  })

  it('carries options.turnId onto the send as TurnInput.id', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const handle = await driver.create(SPEC)
    const sessionId = handle.binding.sessionId
    const seen: TurnInput[] = []
    const wrapping = {
      ...handle,
      send: (input: TurnInput, options: SendOptions) => {
        seen.push(input)
        return handle.send(input, options)
      },
    }
    const waited = headlessAskAndAwait(
      wrapping,
      { text: 'hello', accountId: ACCOUNT, requestDigest: DIGEST_A },
      { turnId: 'turn-carry', harness: 'fake-harness' },
    )
    await driveTurn(sessionId, driver)
    await waited
    expect(seen).toHaveLength(1)
    // The daemon headless driver keys replay/ack/deadline on this id; without
    // the carry it can only refuse the turn as identity-free.
    expect(seen[0]?.id).toBe('turn-carry')
  })

  it('refuses when options.turnId and TurnInput.id disagree', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const handle = await driver.create(SPEC)
    await expect(
      headlessAskAndAwait(
        handle,
        { id: 'turn-other', text: 'hello', accountId: ACCOUNT, requestDigest: DIGEST_A },
        { turnId: 'turn-carry', harness: 'fake-harness' },
      ),
    ).rejects.toThrow(/disagree/)
  })
})

describe('headless durability', () => {
  it('replays a completed turn without rerun on reconnect', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const journal = createMemoryHeadlessJournal()
    const handle = await driver.create(SPEC)
    const sessionId = handle.binding.sessionId
    const waited = headlessAskAndAwait(
      handle,
      { text: 'hello', accountId: ACCOUNT, requestDigest: DIGEST_A },
      { turnId: 'turn-replay', journal, harness: 'fake-harness' },
    )
    await driveTurn(sessionId, driver)
    const first = await waited
    expect(first.terminal.ev).toBe('completed')
    expect(driver.control.textDeliveries(sessionId)).toBe(1)

    // Reconnect: same turnId + identity replays with NO new delivery.
    const replayed = await headlessAskAndAwait(
      handle,
      { text: 'hello', accountId: ACCOUNT, requestDigest: DIGEST_A },
      { turnId: 'turn-replay', journal, harness: 'fake-harness' },
    )
    expect(replayed.terminal.ev).toBe('completed')
    expect(driver.control.textDeliveries(sessionId)).toBe(1)
  })

  it('refuses a replay with a different digest', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const journal = createMemoryHeadlessJournal()
    const handle = await driver.create(SPEC)
    const sessionId = handle.binding.sessionId
    const waited = headlessAskAndAwait(
      handle,
      { text: 'hello', accountId: ACCOUNT, requestDigest: DIGEST_A },
      { turnId: 'turn-clash', journal, harness: 'fake-harness' },
    )
    await driveTurn(sessionId, driver)
    await waited
    await expect(
      headlessAskAndAwait(
        handle,
        { text: 'hello', accountId: ACCOUNT, requestDigest: DIGEST_B },
        { turnId: 'turn-clash', journal, harness: 'fake-harness' },
      ),
    ).rejects.toThrow(/replay identity mismatch/)
  })

  it('acknowledges only on exact identity and retains on mismatch', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const journal = createMemoryHeadlessJournal()
    const handle = await driver.create(SPEC)
    const sessionId = handle.binding.sessionId
    const waited = headlessAskAndAwait(
      handle,
      { text: 'hello', accountId: ACCOUNT, requestDigest: DIGEST_A },
      { turnId: 'turn-ack', journal, harness: 'fake-harness' },
    )
    await driveTurn(sessionId, driver)
    await waited
    expect(journal.read('turn-ack')).toBeDefined()
    // Mismatched ack throws and retains.
    expect(() =>
      headlessAcknowledge(journal, {
        turnId: 'turn-ack',
        requestDigest: DIGEST_B,
        accountId: ACCOUNT,
      }),
    ).toThrow(/mismatched/)
    expect(journal.read('turn-ack')).toBeDefined()
    // Exact ack deletes.
    headlessAcknowledge(journal, { turnId: 'turn-ack', requestDigest: DIGEST_A, accountId: ACCOUNT })
    expect(journal.read('turn-ack')).toBeUndefined()
  })

  it('duplicate ack after delete is a no-op', () => {
    const journal = createMemoryHeadlessJournal()
    headlessAcknowledge(journal, { turnId: 'missing', requestDigest: DIGEST_A, accountId: ACCOUNT })
    expect(journal.read('missing')).toBeUndefined()
  })

  it('rebinds the transcript on resume (no silent restart)', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const handle = await driver.create(SPEC)
    const sessionId = handle.binding.sessionId
    const resume = handle.binding.resume
    if (!resume) throw new Error('fake must mint a resume ref')
    driver.control.emitItem(sessionId, item('first-1', 'first answer'))
    driver.control.completeTurn(sessionId)

    const resumed = await driver.resume(resume, SPEC)
    const history = await resumed.transcript.history({ limit: 10 })
    expect(history.items.map((entry) => entry.text)).toContain('first answer')
  })

  it('reports an interrupted turn with its verdict', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const handle = await driver.create(SPEC)
    const sessionId = handle.binding.sessionId
    const waited = headlessAskAndAwait(
      handle,
      { text: 'stop me', accountId: ACCOUNT, requestDigest: DIGEST_A },
      { turnId: 'turn-int', harness: 'fake-harness' },
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    await handle.interrupt()
    driver.control.completeTurn(sessionId)
    const outcome = await waited
    expect(outcome.terminal.ev).toBe('completed')
    if (outcome.terminal.ev === 'completed') expect(outcome.terminal.verdict).toBe('interrupted')
  })

  it('interrupts and throws on timeout', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const handle = await driver.create(SPEC)
    let interrupted = false
    const wrapping = {
      ...handle,
      interrupt: async () => {
        interrupted = true
        return handle.interrupt()
      },
    }
    await expect(
      headlessAskAndAwait(
        wrapping,
        { text: 'hangs', accountId: ACCOUNT, requestDigest: DIGEST_A },
        { turnId: 'turn-timeout', timeoutMs: 20, harness: 'fake-harness' },
      ),
    ).rejects.toThrow(/timed out/)
    expect(interrupted).toBe(true)
  })

  it('preserves the original deadline after a restart', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    const journal = createMemoryHeadlessJournal()
    let now = 1_000_000
    const handle = await driver.create(SPEC)
    // First dispatch records createdAt = now.
    const first = headlessAskAndAwait(
      handle,
      { text: 'slow', accountId: ACCOUNT, requestDigest: DIGEST_A },
      { turnId: 'turn-deadline', journal, timeoutMs: 1000, now: () => now, harness: 'fake-harness' },
    )
    // Let the send land, then abandon the wait (simulating a restart before
    // the fence) by interrupting the underlying turn out-of-band.
    await new Promise((resolve) => setTimeout(resolve, 10))
    void first.catch(() => undefined)
    await handle.interrupt()
    const sessionId = handle.binding.sessionId
    driver.control.completeTurn(sessionId)
    await first.catch(() => undefined)
    expect(journal.createdAt('turn-deadline')).toBe(1_000_000)

    // Restart 800ms later: only 200ms remain of the ORIGINAL 1000ms budget.
    now = 1_000_800
    // The journal still holds the completed result, so the reconnect replays
    // rather than waiting out a fresh budget — the deadline is the original.
    const replayed = await headlessAskAndAwait(
      handle,
      { text: 'slow', accountId: ACCOUNT, requestDigest: DIGEST_A },
      { turnId: 'turn-deadline', journal, timeoutMs: 1000, now: () => now, harness: 'fake-harness' },
    )
    expect(replayed.terminal.ev).toBe('completed')
  })
})

describe('headlessOneShot', () => {
  it('returns the transcript and kills the handle', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    let sessionId: string | undefined
    const capturing = {
      ...driver,
      create: async (spec: SessionSpec) => {
        const handle = await driver.create(spec)
        sessionId = handle.binding.sessionId
        return handle
      },
    }
    const shot = headlessOneShot(
      capturing,
      SPEC,
      'summarise',
      { text: '', accountId: ACCOUNT, requestDigest: DIGEST_A },
      { turnId: 'shot-1', harness: 'fake-harness' },
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    if (!sessionId) throw new Error('one-shot never created its session')
    driver.control.emitItem(sessionId as never, item('shot-1', 'done'))
    driver.control.completeTurn(sessionId as never)
    const outcome = await shot
    expect(outcome.items.map((entry) => entry.text)).toContain('done')
  })

  it('throws on a failed turn', async () => {
    resetFakeRuntime()
    const driver = createFakeDriver()
    let sessionId: string | undefined
    const capturing = {
      ...driver,
      create: async (spec: SessionSpec) => {
        const handle = await driver.create(spec)
        sessionId = handle.binding.sessionId
        return handle
      },
    }
    const shot = headlessOneShot(
      capturing,
      SPEC,
      'doomed',
      { text: '', accountId: ACCOUNT, requestDigest: DIGEST_A },
      { turnId: 'shot-doom', harness: 'fake-harness' },
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    if (!sessionId) throw new Error('one-shot never created its session')
    driver.control.failTurn(sessionId as never, 'rate-limit')
    await expect(shot).rejects.toThrow(/rate-limit/)
  })
})
