/** Support-window audit. Concrete translations retire when the floor passes them. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const ROOT = join(import.meta.dirname, '..')
const VERSION = 'packages/protocol/src/version.ts'
const EDGE = 'apps/server/src/gateway/wire-feed-edge.ts'
export interface AuditInput { read(path: string): string | null; sources(): string[] }
export interface Finding { check: string; where: string; detail: string }
export function runChecks(input: AuditInput): Finding[] {
  const findings: Finding[] = []
  const version = input.read(VERSION) ?? ''
  const edge = input.read(EDGE) ?? ''
  const wire = Number(version.match(/export const CLIENT_WIRE_VERSION\s*=\s*(\d+)/)?.[1] ?? 0)
  const min = Number(version.match(/export const MIN_CLIENT_WIRE_VERSION\s*=\s*(\d+)/)?.[1] ?? 0)
  if (min < 1 || wire < min) findings.push({ check: 'valid-window', where: VERSION, detail: 'Expected a positive inclusive support window.' })
  if (!edge.includes('this.registry.assertCoversWindow()')) findings.push({ check: 'window-covered', where: EDGE, detail: 'The serving edge must verify every supported version at construction.' })
  if (!edge.includes('this.register(new IdentityWireAdapter())')) findings.push({ check: 'current-identity', where: EDGE, detail: 'The current version must retain its identity adapter.' })
  for (const adapter of edge.matchAll(/version:\s*(\d+),[\s\S]*?translate:/g)) {
    const n = Number(adapter[1])
    if (n < min || n > wire) findings.push({ check: 'unsupported-adapter', where: EDGE, detail: `Translation ${n} is outside [${min}, ${wire}].` })
    if (n < wire && !/expiresWhenMinSupportedReaches:\s*\d+/.test(adapter[0])) findings.push({ check: 'mechanical-expiry', where: EDGE, detail: `Translation ${n} requires a mechanical expiry.` })
  }
  return findings
}
function realInput(): AuditInput {
  return { read: path => { try { return readFileSync(join(ROOT, path), 'utf8') } catch { return null } }, sources: () => [] }
}
export const outcomesOf = (input: AuditInput): string[] => runChecks(input).map(finding => finding.check)
const fixture = (version: string, edge = 'this.register(new IdentityWireAdapter()); this.registry.assertCoversWindow()'): AuditInput => ({ read: path => path === VERSION ? version : path === EDGE ? edge : null, sources: () => [] })
const window = 'export const CLIENT_WIRE_VERSION = 4; export const MIN_CLIENT_WIRE_VERSION = 4'
export const PROBES = [
  { name: 'missing version', expect: 'valid-window', input: fixture('') },
  { name: 'inverted window', expect: 'valid-window', input: fixture('export const CLIENT_WIRE_VERSION = 3; export const MIN_CLIENT_WIRE_VERSION = 4') },
  { name: 'no coverage assertion', expect: 'window-covered', input: fixture(window, 'this.register(new IdentityWireAdapter())') },
  { name: 'no current adapter', expect: 'current-identity', input: fixture(window, 'this.registry.assertCoversWindow()') },
  { name: 'expired translation', expect: 'unsupported-adapter', input: fixture(window, 'version: 2, expiresWhenMinSupportedReaches: 3, translate:') },
  { name: 'permanent old translation', expect: 'mechanical-expiry', input: fixture(window, 'version: 3, expiry: null, translate:') },
] as const
if (import.meta.main) {
  const findings = runChecks(realInput())
  if (process.argv.includes('--probe')) for (const probe of PROBES) {
    if (!outcomesOf(probe.input).includes(probe.expect)) throw new Error(`Probe failed: ${probe.name}`)
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify({ findings }, null, 2))
  else for (const finding of findings) console.error(`${finding.check}: ${finding.detail}`)
  if (findings.length) process.exit(1)
  console.log('wire-adapter audit OK — current identity and support-window coverage retained')
}
