import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourcePath = fileURLToPath(new URL('./socket-hub.ts', import.meta.url))
const source = readFileSync(sourcePath, 'utf8')
const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

describe('transport ownership boundary', () => {
  it('contains no feed cursor, epoch-healing, WATERMARK, or EVICT semantics', () => {
    for (const forbidden of [
      'metadataCursor',
      'feedStamp',
      'fromExclusive',
      'parseChangesSinceResult',
      'noteFeedStamp',
      'healMetadata',
      'pendingDeltas',
    ]) {
      expect(executable, forbidden).not.toContain(forbidden)
    }
    expect(executable).not.toMatch(/\bwatermark\b/i)
    expect(executable).not.toMatch(/\bevict\b/i)
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
