import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourcePath = fileURLToPath(new URL('./socket-hub.ts', import.meta.url))
const source = readFileSync(sourcePath, 'utf8')
const portSource = readFileSync(
  fileURLToPath(new URL('./legacy-feed-port.ts', import.meta.url)),
  'utf8',
)
const moduleSource = `${source}\n${portSource}`
const executable = moduleSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

describe('transport ownership boundary', () => {
  it('contains no feed position, healing, WATERMARK, RESCOPE, or EVICT semantics', () => {
    for (const forbidden of [
      'fetchChangesSince',
      'initialCursor',
      'onMetadataApplied',
      'MetadataAppliedState',
      'metadataCursor',
      'feedCursor',
      'feedEpoch',
      'feedStamp',
      'fromExclusive',
      'parseChangesSinceResult',
      'noteFeedStamp',
      'healMetadata',
      'pendingDeltas',
      'advanceWatermark',
      'watermarkCursor',
      'applyRescope',
      'rescopeCursor',
      'applyEvict',
      'deleteEvicted',
    ]) {
      expect(executable, forbidden).not.toContain(forbidden)
    }
    expect(executable).not.toMatch(/\bwatermark\b/i)
    expect(executable).not.toMatch(/\bevict\b/i)
    expect(moduleSource).not.toMatch(/from ['"]\.\.\/replica(?:\/|['"])/)
  })

  it.each([
    'feedDelta',
    'feedBootstrap',
    'feedRescope',
    'feedResyncRequired',
  ] as const)('forwards %s opaquely to the Replica port', (family) => {
    expect(source).toMatch(
      new RegExp(`${family}: \\(msg\\) => \\{\\s*this\\.opts\\.feed\\?\\.frame\\(msg\\)\\s*\\}`),
    )
  })

  it('has no terminal-client protocol implementation residue', () => {
    const terminalSource = fileURLToPath(new URL('../../../terminal-client/src/', import.meta.url))
    expect(existsSync(`${terminalSource}connection.ts`)).toBe(false)
    expect(existsSync(`${terminalSource}echo-latency.ts`)).toBe(false)
    const terminalPackage = readFileSync(
      fileURLToPath(new URL('../../../terminal-client/package.json', import.meta.url)),
      'utf8',
    )
    expect(terminalPackage).not.toContain('"./connection"')
  })
})
