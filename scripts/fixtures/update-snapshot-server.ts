/** Isolated HTTP/SQLite boundary for update snapshot regression tests. */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { SessionStore } from '../../apps/server/src/store'

const [role, root] = process.argv.slice(2)
if (!root) throw new Error('snapshot fixture requires an explicit state root')
const path = join(root, 'live.db')
if (role === 'opener') {
  const db = openDatabase(path, { readOnly: true })
  try {
    console.log(JSON.stringify(db.prepare('SELECT count(*) AS rows FROM payload').get()))
  } finally {
    db.close()
  }
} else {
  const store = await SessionStore.open(path)
  const db = openDatabase(path)
  db.exec(`PRAGMA wal_autocheckpoint=0;
    CREATE TABLE payload (id INTEGER PRIMARY KEY, bytes BLOB);
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<5000)
    INSERT INTO payload SELECT i, zeroblob(4000) FROM n;`)
  let staging = false
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      switch (new URL(request.url).pathname) {
        case '/snapshot':
          staging = true
          try {
            return Response.json(await store.verifiedSnapshotBeforeUpdate('before', 'after'))
          } finally {
            staging = false
          }
        case '/write':
          await store.repos.addRepo('/during-snapshot', store.hostMachineId)
          return Response.json(await store.repos.listRepoPaths())
        case '/hold':
          db.exec('BEGIN; SELECT count(*) FROM payload')
          return new Response('held')
        case '/release':
          db.exec('ROLLBACK')
          return new Response('released')
        case '/read':
          return Response.json(db.prepare('SELECT sum(length(bytes)) AS bytes FROM payload').get())
        default:
          return Response.json({ staging, repos: await store.repos.listRepoPaths() })
      }
    },
  })
  console.log(
    JSON.stringify({
      ready: true,
      pid: process.pid,
      port: server.port,
      shm: statSync(`${path}-shm`).size,
    }),
  )
  process.once('SIGTERM', async () => {
    await server.stop(true)
    db.close()
    await store.close()
    process.exit(0)
  })
}
