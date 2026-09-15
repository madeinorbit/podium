import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync'
import { openTestStore } from '../test-support/open-test-store'
import { SyncWorkerClient } from './worker-client'
import type { BootstrapJob } from './types'

const job = (id: string, deadlineMs?: number): BootstrapJob => ({ transferId: id, principal: DEVICE_GRADE_PRINCIPAL, feedId: 'feed', epoch: 'epoch', encoding: 'identity', ...(deadlineMs ? { deadlineMs } : {}) })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sync-worker-'))
  const path = join(dir, 'test.db')
  const store = await openTestStore(path)
  await store.close()
  const writer = openDatabase(path)
  writer.exec('PRAGMA journal_mode=WAL')
  const client = new SyncWorkerClient({ dbPath: path })
  return { path, writer, client, async close() { await client.close(); writer.close(); rmSync(dir, { recursive: true, force: true }) } }
}
function append(writer: SqlDatabase, id: string, text = 'x') {
  const payload = JSON.stringify({ id, text })
  writer.exec('BEGIN IMMEDIATE')
  try {
    writer.prepare("INSERT INTO changes(entity,entity_id,op,payload,event_time) VALUES ('repo',?,'upsert',?,1)").run(id,payload)
    writer.prepare("INSERT OR REPLACE INTO change_latest(entity,entity_id,seq,payload) VALUES ('repo',?,last_insert_rowid(),?)").run(id,payload)
    writer.exec('COMMIT')
  } catch (error) { writer.exec('ROLLBACK'); throw error }
}
async function checkpoint(writer: SqlDatabase) {
  for (let i=0;i<100;i++) {
    const row=writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {busy:number}
    if (row.busy===0) return
    await delay(10)
  }
  throw new Error('read transaction was not released')
}
async function text(body: ReadableStream<Uint8Array>) { return await new Response(body).text() }

describe('real sync worker boundary', () => {
  it('holds a consistent head and complete row set during concurrent appends', async () => {
    const f = await fixture()
    let timer: ReturnType<typeof setInterval> | undefined
    try {
      for(let i=0;i<600;i++) append(f.writer, String(i), 'x'.repeat(1024))
      const transfer = f.client.bootstrap(job('consistent'))
      // This writer only appends new refs, so seq <= S is an independent exact oracle.
      let next = 600
      timer = setInterval(() => append(f.writer, String(next++)), 1)
      const meta = await transfer.meta
      const output = (await text(transfer.body)).trim().split('\n').map(line => JSON.parse(line))
      clearInterval(timer); timer = undefined
      const actual = output.filter(r=>r.type==='feedBootstrap').flatMap(r=>r.changes)
      const expected = f.writer.prepare('SELECT seq,entity_id FROM change_latest WHERE seq <= ? ORDER BY seq').all(meta.seq) as {seq:number;entity_id:string}[]
      expect(actual.map(r=>[r.seq,r.entityId])).toEqual(expected.map(r=>[r.seq,r.entity_id]))
      expect(actual.every(r=>r.seq<=meta.seq)).toBe(true)
      expect(output.at(-1).seq).toBe(meta.seq)
      expect(f.client.activeJobCount()).toBe(0)
      await checkpoint(f.writer)
    } finally { clearInterval(timer); await f.close() }
  }, 30_000)
  it('aborts mid-pass-2 and expires a stalled transfer, releasing both snapshots', async () => {
    const f=await fixture()
    try {
      for(let i=0;i<300;i++) append(f.writer,String(i),'x'.repeat(4096))
      const abort=new AbortController()
      const first=f.client.bootstrap(job('abort'),abort.signal)
      const reader=first.body.getReader()
      await reader.read(); await reader.read()
      abort.abort()
      await expect(reader.read()).rejects.toMatchObject({reason:'cancelled'})
      expect(f.client.activeJobCount()).toBe(0)
      await checkpoint(f.writer)
      const expiring=f.client.bootstrap(job('deadline', Date.now()+1000))
      await expiring.meta
      await expect(text(expiring.body)).resolves.toBeString()
      const stalled=f.client.bootstrap(job('stalled', Date.now()+100))
      await expect(textAfterDeadline(stalled.body)).rejects.toMatchObject({reason:'deadline'})
      expect(f.client.activeJobCount()).toBe(0)
      await checkpoint(f.writer)
    } finally { await f.close() }
  },30_000)
  it('bounds admission and fails every transfer on worker termination and shutdown', async () => {
    const f=await fixture()
    try {
      append(f.writer,'one')
      const transfers=Array.from({length:11},(_,i)=>f.client.bootstrap(job(String(i))))
      await expect(transfers[10]!.meta).rejects.toMatchObject({reason:'queue-full'})
      for(const t of transfers) void t.body.cancel().catch(()=>{})
      await checkpoint(f.writer)
      const crashed=f.client.bootstrap(job('crash'))
      await crashed.meta
      // Actual worker termination, not a synthetic client error.
      const worker=(f.client as unknown as {worker:{terminate():Promise<number>}}).worker
      await worker.terminate()
      await expect(text(crashed.body)).rejects.toMatchObject({reason:'worker-crashed'})
      expect(f.client.activeJobCount()).toBe(0)
      await checkpoint(f.writer)
      for(let i=0;i<100 && f.client.state()!=='running';i++) await delay(20)
      expect(f.client.state()).toBe('running')
      const stopped=f.client.bootstrap(job('shutdown'))
      await stopped.meta
      await f.client.close()
      await expect(text(stopped.body)).rejects.toMatchObject({reason:'shutdown'})
      expect(f.client.activeJobCount()).toBe(0)
      await checkpoint(f.writer)
    } finally { await f.close() }
  },30_000)
})
async function textAfterDeadline(body: ReadableStream<Uint8Array>) { await delay(200); return text(body) }
