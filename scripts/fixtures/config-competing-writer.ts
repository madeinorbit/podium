/** Independent current config owner used by the final-check/rename regression. */
import { writeFileSync } from 'node:fs'
import { loadConfig, saveConfig, withConfigWriteLock } from '../../packages/runtime/src/config'
import { openDatabase } from '../../packages/runtime/src/sqlite'

const [path, report, operation] = process.argv.slice(2)
if (!path || !report) throw new Error('config path and barrier report required')
if (operation === 'hold') {
  withConfigWriteLock(path, () => {
    writeFileSync(report, 'held')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  })
  process.exit(0)
}
const probe = openDatabase(`${path}.write-lock.sqlite`)
let contended = false
try {
  probe.exec('PRAGMA busy_timeout = 0')
  try {
    probe.exec('BEGIN IMMEDIATE')
    probe.exec('ROLLBACK')
  } catch (error) {
    if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error
    contended = true
  }
} finally {
  probe.close()
}
writeFileSync(report, JSON.stringify({ contended }))
saveConfig({ ...loadConfig(path), pairCode: 'NEWER-CODE', updateChannel: 'edge' }, path)
writeFileSync(`${report}.done`, 'published')
