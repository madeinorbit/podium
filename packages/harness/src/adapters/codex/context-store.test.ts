import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tailTranscript } from '../../store/tailer.js'
import { codexContext } from './context.js'
import { nativeTime, object } from './context-native.js'
import native from './fixtures/context-0.169.0.json'

/** The existing Store tail is the only IO owner. Observe exactly the raw
 * records it already reads, with the original native time and a bounded seed.
 * This fixture exercises that read port without a daemon, CLI or provider. */
describe('Codex bounded existing Store recovery', () => {
  it.each([
    'generic-pty',
    'headless',
  ] as const)('recovers the newest attributable native sample in %s', async (driver) => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-context-store-'))
    const path = join(dir, 'rollout.jsonl')
    const id = '01a2002b-2d4d-7161-847f-3e6ef24bf11f'
    const declaration = codexContext.forDriver(driver)
    if (!declaration.supported) throw new Error(declaration.reason)
    const lifetime = new AbortController()
    const probe = vi.fn(() => {
      throw new Error('Recovery cannot open another native conversation')
    })
    const strategy = declaration.value.bind({
      harness: 'codex',
      driver,
      nativeSessionId: id,
      revision: { bindingVersion: 2, observerGeneration: 2, contextRevision: 3, turnEpoch: 7 },
      signal: lifetime.signal,
      publish: vi.fn(),
      probe: { request: probe },
    })
    let tail: ReturnType<typeof tailTranscript> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let rows = 0
    const positions: number[] = []
    try {
      writeFileSync(path, `${native.rollout.map((row) => JSON.stringify(row)).join('\n')}\n`)
      const before = readFileSync(path)
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Bounded Store seed did not settle')), 2000)
        tail = tailTranscript(path, () => {}, {
          resumeValue: id,
          initialWindowBytes: 65_536,
          readChunkBytes: 4096,
          maxInitialItems: 32,
          // Source callback at the existing Store read boundary. No transcript
          // item mapping, extra file read, history scan or measurement poll.
          recordRuntime(raw) {
            const record = object(raw)
            positions.push(Number(record?.ordinal))
            strategy.observe(raw, {
              at: nativeTime(record?.timestamp) ?? '2026-11-22T12:00:00.000Z',
              provenance: 'bootstrap',
              observerGeneration: 2,
              turnEpoch: 7,
              cursor: { segmentId: 'existing-store-tail', components: { ordinal: ++rows } },
            })
            return {}
          },
          statTick: { subscribe: () => () => {} },
          onStatus: (status) =>
            status.kind === 'first-emission' ? resolve() : reject(status.error),
        })
      })
      const result = await strategy.summary({ timeoutMs: 100 })
      expect(result.status).toBe('observation')
      if (result.status !== 'observation') throw new Error(result.reason.message)
      expect(result.observation).toMatchObject({
        provenance: 'bootstrap',
        context: {
          status: 'available',
          occupancy: { basis: 'last-request', usedTokens: { value: 2051 } },
          sample: {
            observerGeneration: 2,
            bindingVersion: 2,
            turnEpoch: 7,
            nativeSessionId: id,
            at: '2026-11-21T22:12:40.412Z',
          },
        },
      })
      expect(rows).toBe(native.rollout.length)
      expect(positions.at(-1)).toBe(62)
      expect(readFileSync(path)).toEqual(before)
      expect(probe).not.toHaveBeenCalled()
    } finally {
      if (timer) clearTimeout(timer)
      tail?.stop()
      lifetime.abort()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not scan backwards for a missing header or turn outside the seed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-context-window-'))
    const path = join(dir, 'rollout.jsonl')
    const declaration = codexContext.forDriver('headless')
    if (!declaration.supported) throw new Error(declaration.reason)
    const life = new AbortController()
    const strategy = declaration.value.bind({
      harness: 'codex',
      driver: 'headless',
      nativeSessionId: '01a2002b-2d4d-7161-847f-3e6ef24bf11f',
      revision: { bindingVersion: 1, observerGeneration: 1, contextRevision: 1, turnEpoch: 0 },
      signal: life.signal,
      publish: vi.fn(),
    })
    let tail: ReturnType<typeof tailTranscript> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let records = 0
    let bytes = 0
    const window = 4096
    try {
      const padding = JSON.stringify({
        type: 'response_item',
        payload: { text: 'x'.repeat(300_000) },
      })
      writeFileSync(
        path,
        JSON.stringify(native.rollout[0]) +
          '\n' +
          padding +
          '\n' +
          JSON.stringify(native.rollout.at(-2)) +
          '\n',
      )
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Bounded missing-lineage seed did not settle')),
          2000,
        )
        tail = tailTranscript(path, () => {}, {
          resumeValue: '01a2002b-2d4d-7161-847f-3e6ef24bf11f',
          initialWindowBytes: window,
          readChunkBytes: 1024,
          recordRuntime(raw) {
            records++
            bytes += Buffer.byteLength(JSON.stringify(raw))
            strategy.observe(raw, {
              at: '2026-11-22T12:00:00.000Z',
              provenance: 'bootstrap',
              observerGeneration: 1,
              turnEpoch: 0,
              cursor: { segmentId: 'bounded-tail', components: { seq: records } },
            })
            return {}
          },
          statTick: { subscribe: () => () => {} },
          onStatus: (status) =>
            status.kind === 'first-emission' ? resolve() : reject(status.error),
        })
      })
      expect(records).toBe(1)
      expect(bytes).toBeLessThan(window)
      const result = await strategy.summary({ timeoutMs: 100 })
      if (result.status !== 'observation') throw new Error(result.reason.message)
      expect(result.observation.context).toMatchObject({
        status: 'unavailable',
        reason: { code: 'unverified-native-version' },
      })
    } finally {
      if (timer) clearTimeout(timer)
      tail?.stop()
      life.abort()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
