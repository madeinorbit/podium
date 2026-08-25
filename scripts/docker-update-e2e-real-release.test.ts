import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  desiredParentUnit,
  legacyUnitNames,
} from '@podium/runtime/topology-migration'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const root = join(import.meta.dirname, '..')
const lane = readFileSync(join(root, 'scripts/docker-update-e2e/real-release-lane.sh'), 'utf8')

/**
 * WHAT THIS PINS, AND WHY IT IS NOT THE GATE ITSELF.
 *
 * The real-release row is the one row whose expectations are about a version
 * nobody works in any more, so nothing in day-to-day development pushes back when
 * they go stale — and the row costs a full gate run to discover that. POD-2747
 * is the precedent: two assertions in this gate had quietly stopped being true and
 * neither could be caught by running it, because each aborted its row first.
 *
 * So the facts that can rot silently are asserted here, in seconds:
 *
 *  - the unit names the row expects after convergence are the ones the topology
 *    module actually produces. A rename would otherwise leave the row asserting
 *    yesterday's names against a host that converged correctly — or, far worse,
 *    passing because it looked for nothing.
 *  - the refusal text the row greps for is the text the OLD release emits, read
 *    out of the tag rather than remembered.
 *  - the feed prefixes the row serves are the paths the OLD release fetches.
 *  - the trust-root substitution refuses everything except its one exact site.
 */

function fromTag(path: string): string {
  return execFileSync('git', ['show', `v0.1.0:${path}`], { cwd: root, encoding: 'utf8' })
}

describe('real-release row expectations still match the code they describe', () => {
  it('expects the unit names the topology module actually produces for a default install', () => {
    // The row is the DEFAULT instance on purpose (see the lane header), so these
    // are the default-instance names.
    expect(lane).toContain(`REAL_PARENT_UNIT=${desiredParentUnit('default')}`)
    const legacy = legacyUnitNames('default')
    for (const role of ['server', 'daemon', 'janitor']) {
      expect(legacy).toContain(`podium-${role}.service`)
    }
    // `real_legacy_unit` builds exactly that shape.
    expect(lane).toContain(`printf 'podium-%s.service' "$1"`)
  })

  it('greps for the refusal string v0.1.0 actually emits', () => {
    const resolver = fromTag('apps/server/src/modules/updates/release-target.ts')
    // The pairing gate the row proves: exact version equality between the two
    // manifests, refused with this sentence.
    expect(resolver).toContain('desktop build for')
    expect(resolver).toContain('desktop.version !== target.version')
    expect(lane).toContain("grep -Fq 'desktop build for'")
  })

  it('reads the refusal where v0.1.0 records it', () => {
    const service = fromTag('apps/server/src/modules/updates/service.ts')
    expect(service).toContain("{ status: 'unavailable'; reason: string }")
    expect(lane).toContain('.outcome.status=="unavailable"')
    expect(lane).toContain('.outcome.reason')
  })

  it('serves the feed paths a v0.1.0 stable install fetches', () => {
    const resolver = fromTag('apps/server/src/modules/updates/release-target.ts')
    expect(resolver).toContain('${RELEASE_BASE}/latest/download/podium-update.json')
    expect(resolver).toContain('${RELEASE_BASE}/latest/download/latest.json')
    // Both manifests live under this one directory, so the row must serve it.
    expect(lane).toContain('/madeinorbit/podium/releases/latest/download/')
  })

  it('carries the trust root v0.1.0 actually baked', () => {
    const delivery = fromTag('packages/runtime/src/update-delivery.ts')
    const match = delivery.match(/PODIUM_UPDATE_PUBKEY = '([^']+)'/)
    expect(match).not.toBeNull()
    const baked = match![1]!
    expect(lane).toContain(`REAL_RELEASE_PUBKEY='${baked}'`)
    // An Ed25519 SPKI DER is 44 bytes, so its base64 is 60 characters — which is
    // what makes the in-place substitution safe.
    expect(baked).toHaveLength(60)
  })

  it('installs the DEFAULT instance, because a released 0.1.0 cannot complete a named one', () => {
    // Guarding the reason rather than the symptom: a later edit that reintroduces
    // `--instance` would reintroduce the adoption wedge and the port divergence
    // the lane header explains.
    expect(lane).not.toMatch(/install\.sh --instance/)
    expect(lane).toContain('REAL_STATE=/home/podium/.podium')
  })
})

describe('patch-trust-root refuses everything but its one exact site', () => {
  const script = join(root, 'scripts/docker-update-e2e/patch-trust-root.ts')
  const oldKey = 'MCowBQYDK2VwAyEAG12/153QJI/SePyYeJQhBSbh1ZsFgkoMkwb823NiYOU='
  const newKey = 'MCowBQYDK2VwAyEAfsqq4y1gWrYABY5StaANv24V+7mTaR8IL2JZNVHaQyo='

  function fixture(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'podium-trust-root-'))
    const file = join(dir, 'binary')
    writeFileSync(file, body)
    return file
  }

  it('substitutes one occurrence and changes nothing outside it', async () => {
    const file = fixture(`before${oldKey}after`)
    const { stdout } = await run('bun', [script, file, oldKey, newKey])
    const report = JSON.parse(stdout)
    expect(report.occurrences).toBe(1)
    expect(report.sizeUnchanged).toBe(true)
    expect(report.changedInsideConstant).toBe(true)
    expect(report.changedBytes).toBeLessThanOrEqual(oldKey.length)
    expect(readFileSync(file, 'utf8')).toBe(`before${newKey}after`)
  })

  it('refuses when the constant is absent', async () => {
    const file = fixture('no key here')
    await expect(run('bun', [script, file, oldKey, newKey])).rejects.toThrow(/found 0/)
    expect(readFileSync(file, 'utf8')).toBe('no key here')
  })

  it('refuses when the constant appears more than once', async () => {
    const file = fixture(`${oldKey}${oldKey}`)
    await expect(run('bun', [script, file, oldKey, newKey])).rejects.toThrow(/found 2/)
  })

  it('refuses a replacement of a different length, which would move every offset', async () => {
    const file = fixture(`x${oldKey}y`)
    await expect(run('bun', [script, file, oldKey, 'short'])).rejects.toThrow(/differ in length/)
  })
})
