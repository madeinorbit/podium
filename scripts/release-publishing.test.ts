import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_ROOT_DIGEST_FILE } from './client-build-root-digest'
import { publishPreparedHeadless } from './release'

const scratch: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function stage(bytes: string) {
  const dir = mkdtempSync(join(tmpdir(), 'podium-publish-order-'))
  scratch.push(dir)
  const asset = 'podium-headless-linux-x64.tar.gz'
  writeFileSync(join(dir, asset), bytes)
  writeFileSync(join(dir, `${asset}.sig`), 'signature')
  writeFileSync(join(dir, CLIENT_ROOT_DIGEST_FILE), 'root')
  writeFileSync(
    join(dir, `${asset}.json`),
    JSON.stringify({
      version: '1.2.3',
      target: 'linux-x86_64',
      asset,
      signature: 'signature',
      webDigest: 'web',
      clientRootDigest: 'root',
    }),
  )
  const changelogPath = join(dir, 'CHANGELOG.md')
  writeFileSync(changelogPath, '')
  vi.stubEnv('GH_TOKEN', '')
  return { dir, asset, changelogPath }
}

describe('rolling release advertisements', () => {
  it.each([
    'edge',
    'dev',
  ] as const)('names immutable version/digest files for %s while retaining installer aliases', (channel) => {
    const p = stage('signed bytes')
    publishPreparedHeadless({ ...p, channel, tag: channel, requiredTargets: ['linux-x86_64'] })
    const manifest = JSON.parse(readFileSync(join(p.dir, 'podium-update.json'), 'utf8'))
    const named = manifest.artifacts.headless.platforms['linux-x86_64']
    const digest = createHash('sha256').update('signed bytes').digest('hex')
    const immutable = p.asset.replace('.tar.gz', `-1.2.3-${digest}.tar.gz`)
    expect(named.url).toContain(`/${channel}/${immutable}`)
    expect(readFileSync(join(p.dir, immutable), 'utf8')).toBe('signed bytes')
    expect(readFileSync(join(p.dir, `${immutable}.sig`), 'utf8')).toBe('signature')
    expect(readFileSync(join(p.dir, p.asset), 'utf8')).toBe('signed bytes')
  })

  it('republishing the same version with different bytes gives a different immutable URL', () => {
    const urls = ['first bytes', 'replacement bytes'].map((bytes) => {
      const p = stage(bytes)
      publishPreparedHeadless({
        ...p,
        channel: 'edge',
        tag: 'edge',
        requiredTargets: ['linux-x86_64'],
      })
      return JSON.parse(readFileSync(join(p.dir, 'podium-update.json'), 'utf8')).artifacts.headless
        .platforms['linux-x86_64'].url
    })
    expect(urls[0]).not.toBe(urls[1])
  })
})
