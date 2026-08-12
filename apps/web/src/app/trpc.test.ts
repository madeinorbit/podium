import { addSink, type LogRecord, resetLogging, setLogLevel } from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reportingFetch, trpcProcedurePath } from './trpc'

/**
 * THE FAILURE SEAM every tRPC call in the web client passes through (POD-1935).
 *
 * The bug this covers was not a broken transport: it was a client with nothing
 * to say. Hundreds of `issues.markRead` 500s and a run of 502s across a restart
 * reached the browser console and the logger never heard about any of them, so
 * the forwarding sink had an empty queue and the operator's per-origin log file
 * was never even created.
 */

let logged: LogRecord[]

beforeEach(() => {
  resetLogging()
  logged = []
  addSink({ name: 'capture', write: (record) => logged.push(record) })
  setLogLevel('warn')
})

afterEach(() => {
  resetLogging()
})

describe('trpcProcedurePath', () => {
  it('names the procedures a batched call carried', () => {
    expect(trpcProcedurePath('https://relay.test/trpc/issues.markRead?batch=1')).toBe(
      'issues.markRead',
    )
    expect(trpcProcedurePath('https://relay.test/trpc/updates.fleet,quota.summary?batch=1')).toBe(
      'updates.fleet,quota.summary',
    )
  })

  it('degrades to the raw path rather than throwing on anything unexpected', () => {
    expect(trpcProcedurePath('not a url')).toBe('not a url')
  })
})

describe('reportingFetch', () => {
  it('logs a warn naming the procedure and status when the server refuses', async () => {
    const base = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    const response = await reportingFetch(base)('https://relay.test/trpc/issues.markRead?batch=1', {
      method: 'POST',
    })

    expect(response.status).toBe(500)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.level).toBe('warn')
    expect(logged[0]?.ns).toBe('web:trpc')
    expect(logged[0]).toMatchObject({ path: 'issues.markRead', status: 500 })
  })

  it('logs a warn and rethrows when the call never reaches the server', async () => {
    const base = vi.fn().mockRejectedValue(new Error('Failed to fetch'))

    await expect(
      reportingFetch(base)('https://relay.test/trpc/updates.fleet?batch=1', { method: 'POST' }),
    ).rejects.toThrow('Failed to fetch')
    expect(logged).toHaveLength(1)
    expect(logged[0]?.level).toBe('warn')
    expect(logged[0]).toMatchObject({ path: 'updates.fleet' })
  })

  it('says nothing about a call that succeeded', async () => {
    const base = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    await reportingFetch(base)('https://relay.test/trpc/issues.list?batch=1', { method: 'POST' })
    expect(logged).toEqual([])
  })

  it('carries the login cookie', async () => {
    const base = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    await reportingFetch(base)('https://relay.test/trpc/issues.list?batch=1', { method: 'POST' })
    expect(base.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'include' })
  })

  it('stays silent for the logging transport, whose failures would feed themselves', async () => {
    const base = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }))
    await reportingFetch(base, { report: false })('https://relay.test/trpc/logs.forward?batch=1', {
      method: 'POST',
    })
    expect(logged).toEqual([])
  })

  it('never reports a logs.* failure even on a reporting client', async () => {
    // Belt and braces: the log transport builds its own client with reporting
    // off, and a caller that forgets still cannot start the loop.
    const base = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }))
    await reportingFetch(base)('https://relay.test/trpc/logs.crash?batch=1', { method: 'POST' })
    expect(logged).toEqual([])
  })
})
