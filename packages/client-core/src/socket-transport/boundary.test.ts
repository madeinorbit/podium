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

  /**
   * POD-2061 put a FEED POSITION in `hello`, and the field above is still on the
   * forbidden list — which is the point rather than an oversight. The sink names
   * and fills the field (`feed-hello.ts`); this class spreads what it is handed
   * without reading it, so the two properties hold together: the wire carries a
   * cursor, and the transport still cannot tell you what one is.
   *
   * Asserted as a SPREAD of an opaque local, because that is the only shape with
   * that property. `...(x ?? {})` cannot look inside `x`; `feedCursor: x.seq`
   * would fail the check above, but so would every honest way of writing it, and
   * a check that only fires on the honest spellings is not a check.
   */
  it('spreads the feed sink hello fields without reading them', () => {
    expect(executable).toMatch(/const helloFields = this\.wantWorld\s*\?\s*null\s*:/)
    expect(executable).toMatch(/\.\.\.\(helloFields \?\? \{\}\)/)
    // What the sink is told it bought is a boolean derived from PRESENCE alone.
    expect(executable).toMatch(/this\.opts\.feed\?\.connected\(helloFields === null\)/)
  })

  it.each([
    'feedDelta',
    'feedBootstrap',
    'feedRescope',
    'feedResyncRequired',
    'feedResume',
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
