import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DaemonMessage } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexIdentityReceipts } from './codex-identity-receipts'

const roots: string[] = []

async function makeStore(): Promise<CodexIdentityReceipts> {
  const root = await mkdtemp(join(tmpdir(), 'podium-codex-receipts-'))
  roots.push(root)
  const dir = join(root, 'receipts')
  await mkdir(dir)
  return new CodexIdentityReceipts(dir)
}

function receiptPath(store: CodexIdentityReceipts, sessionId: string): string {
  const path = store.pathFor(sessionId)
  if (!path) throw new Error(`invalid fixture session id: ${sessionId}`)
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('CodexIdentityReceipts', () => {
  it('atomically records a process-derived exact binding for acknowledged replay', async () => {
    const store = await makeStore()
    expect(await store.record('pane-a', 'thread-a')).toBe(true)
    expect(await store.pending()).toEqual([{ sessionId: 'pane-a', nativeId: 'thread-a' }])

    const sent: DaemonMessage[] = []
    await store.replay((msg) => sent.push(msg))
    expect(sent).toEqual([
      {
        type: 'sessionResumeRef',
        sessionId: 'pane-a',
        resume: { kind: 'codex-thread', value: 'thread-a' },
        confidence: 'exact',
        ackRequested: true,
      },
    ])
  })

  it('replays only complete valid payloads as exact acknowledged bindings', async () => {
    const store = await makeStore()
    await writeFile(receiptPath(store, 'pane-a'), JSON.stringify({ session_id: 'thread-a' }))
    await writeFile(receiptPath(store, 'pane-b'), 'not json')
    await writeFile(join(store.dir, 'pane-c.123.tmp'), JSON.stringify({ session_id: 'thread-c' }))

    const sent: DaemonMessage[] = []
    expect(await store.replay((msg) => sent.push(msg))).toBe(1)
    expect(sent).toEqual([
      {
        type: 'sessionResumeRef',
        sessionId: 'pane-a',
        resume: { kind: 'codex-thread', value: 'thread-a' },
        confidence: 'exact',
        ackRequested: true,
      },
    ])
  })

  it('recovers an interrupted ack claim without overwriting a newer hook', async () => {
    const store = await makeStore()
    const suffix = '123.00000000-0000-0000-0000-000000000000.ack'
    const onlyClaim = join(store.dir, `pane-a.json.${suffix}`)
    const staleClaim = join(store.dir, `pane-b.json.${suffix}`)
    await writeFile(onlyClaim, JSON.stringify({ session_id: 'thread-a' }))
    await writeFile(staleClaim, JSON.stringify({ session_id: 'thread-b-old' }))
    await writeFile(receiptPath(store, 'pane-b'), JSON.stringify({ session_id: 'thread-b-new' }))

    expect(await store.pending()).toEqual([
      { sessionId: 'pane-a', nativeId: 'thread-a' },
      { sessionId: 'pane-b', nativeId: 'thread-b-new' },
    ])
    expect(
      JSON.parse(await readFile(receiptPath(store, 'pane-a'), 'utf8')) as { session_id: string },
    ).toEqual({ session_id: 'thread-a' })
    expect(
      JSON.parse(await readFile(receiptPath(store, 'pane-b'), 'utf8')) as { session_id: string },
    ).toEqual({ session_id: 'thread-b-new' })
    await expect(access(onlyClaim)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(staleClaim)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('deletes only when the ack still matches the latest payload', async () => {
    const store = await makeStore()
    const path = receiptPath(store, 'pane-a')
    await writeFile(path, JSON.stringify({ session_id: 'thread-new' }))

    expect(await store.acknowledge('pane-a', { kind: 'codex-thread', value: 'thread-old' })).toBe(
      false,
    )
    await access(path)

    expect(await store.acknowledge('pane-a', { kind: 'codex-thread', value: 'thread-new' })).toBe(
      true,
    )
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
