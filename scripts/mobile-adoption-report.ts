/** Operator-local report: version/count evidence only, no user content or credentials. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { mobileVersionReport, type MobileVersionHistory } from '../apps/server/src/gateway/mobile-client-versions'

const { values } = parseArgs({ options: {
  'state-root': { type: 'string' }, release: { type: 'string' },
  'released-at': { type: 'string' }, 'supported-web-version': { type: 'string', multiple: true },
} })
if (!values['state-root'] || !values.release || !values['released-at']) {
  throw new Error('Usage: bun scripts/mobile-adoption-report.ts --state-root <server-state-dir> --release <marketing+build> --released-at <ISO> [--supported-web-version <version>]')
}
const history = JSON.parse(readFileSync(join(values['state-root'], 'mobile-client-versions.json'), 'utf8')) as MobileVersionHistory
const report = mobileVersionReport(history, values.release, Date.parse(values['released-at']), Date.now(), values['supported-web-version'])
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (!report.step7Ready) process.exitCode = 2
