import { asMachineId } from '@podium/model'
import type { HostMemoryBreakdown } from '@podium/protocol'
import { expect, it, vi } from 'vitest'
import { MachineProcessesTopic } from './processes-topic'

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const memory: HostMemoryBreakdown = {
  hostname: 'host',
  sampledAt: '2026-11-08T00:00:00Z',
  supported: false,
  memory: { totalBytes: 100, availableBytes: 50, swapTotalBytes: 0, swapFreeBytes: 0 },
  agents: [],
  projects: [],
  otherBytes: 50,
}
const inventory = {
  candidates: [],
  orphans: [],
  diagnostics: [],
  estimate: { status: 'unknown' as const, recoverableBytes: null, measuredAt: null },
}
it('enriches demanded process samples with reclaim state, and fences reads after unsubscribe', async () => {
  const send = vi.fn()
  const publish = vi.fn()
  let roots!: (paths: string[]) => void
  const source = new MachineProcessesTopic({
    supports: () => true,
    send,
    publish,
  })
  source.installReaders({
    roots: () =>
      new Promise((done) => {
        roots = done
      }),
    reclaim: vi.fn(async () => inventory),
    fallback: vi.fn(async () => memory),
  })
  source.start('machine')
  source.stop('machine')
  roots(['/repo'])
  await settle()
  expect(send.mock.calls.some(([, frame]) => frame.on)).toBe(false)
  source.start('machine')
  roots(['/repo'])
  await settle()
  expect(send).toHaveBeenLastCalledWith(
    asMachineId('machine'),
    expect.objectContaining({ on: true, input: { roots: ['/repo'] } }),
  )
  source.receive('machine', memory)
  await settle()
  expect(publish).toHaveBeenLastCalledWith('machine', { breakdown: memory, reclaim: inventory })
  expect(source.snapshot('machine')).toEqual({ breakdown: memory, reclaim: inventory })
  source.unavailable('machine')
  expect(source.snapshot('machine')).toBeUndefined()
  expect(publish).toHaveBeenLastCalledWith('machine', undefined)
  source.stop('machine')
  source.receive('machine', memory)
  await settle()
  expect(source.snapshot('machine')).toBeUndefined()
})
it('old daemons get one request on open and explicit focus, with no periodic requests', async () => {
  const fallback = vi.fn(async () => memory)
  const source = new MachineProcessesTopic({
    supports: () => false,
    send: vi.fn(),
    publish: vi.fn(),
  })
  source.installReaders({
    roots: vi.fn(),
    reclaim: async () => inventory,
    fallback,
  })
  source.start('machine')
  await settle()
  expect(fallback).toHaveBeenCalledTimes(1)
  source.refresh('machine')
  await settle()
  expect(fallback).toHaveBeenCalledTimes(2)
  source.stop('machine')
})

it('refuses demand before readers are installed and refuses a second installation', async () => {
  const publish = vi.fn()
  const fallback = vi.fn(async () => memory)
  const source = new MachineProcessesTopic({ supports: () => false, send: vi.fn(), publish })
  expect(() => source.start('machine')).toThrow('readers not installed')
  expect(() => source.refresh('machine')).toThrow('readers not installed')
  expect(source.snapshot('machine')).toBeUndefined()
  const readers = { roots: async () => [], reclaim: async () => inventory, fallback }
  source.installReaders(readers)
  expect(() => source.installReaders(readers)).toThrow('readers already installed')
  source.start('machine')
  await settle()
  expect(fallback).toHaveBeenCalledTimes(1)
  expect(publish).toHaveBeenCalledWith('machine', { breakdown: memory, reclaim: inventory })
})
