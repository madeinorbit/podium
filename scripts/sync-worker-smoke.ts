import { SyncWorkerClient } from '../apps/server/src/sync-worker/worker-client'
import { DEVICE_GRADE_PRINCIPAL } from '../packages/sync/src/bootstrap-worker'
const client = new SyncWorkerClient({ dbPath: process.argv[2]! })
try {
  const { meta, body } = client.bootstrap({ transferId: 'compiled', principal: DEVICE_GRADE_PRINCIPAL, feedId: 'feed', epoch: 'epoch', encoding: 'identity', deadlineMs: Date.now() + 10_000 })
  const output = await new Response(body).text()
  if ((await meta).totalRows !== 0 || !output.includes('syncComplete')) throw new Error('Invalid compiled bootstrap')
  const delta = client.delta({ mode: 'delta', from: 0, transferId: 'compiled-delta', principal: DEVICE_GRADE_PRINCIPAL, feedId: 'feed', epoch: 'epoch', encoding: 'identity', deadlineMs: Date.now() + 10_000 })
  const deltaOutput = await new Response(delta.body).text()
  if ((await delta.meta).mode !== 'delta' || !deltaOutput.includes('feedDelta') || !deltaOutput.includes('syncComplete')) throw new Error('Invalid compiled delta')
  console.log('SYNC_WORKER_SMOKE_OK')
} finally { await client.close() }
