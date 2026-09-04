import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

describe('server-move clean public cutover', () => {
  it('contains no bespoke status, recovery, or old start procedure outside daemon protocol', () => {
    const forbidden = [
      ['server', 'TransferStatus'].join(''),
      ['recover', 'ServerMove'].join(''),
      ['transfer', 'Server'].join(''),
    ]
    const files = [
      ...sourceFiles(join(root, 'apps')),
      ...sourceFiles(join(root, 'packages', 'commands')),
    ]
    const matches = files.flatMap((path) => {
      const text = readFileSync(path, 'utf8')
      return forbidden.filter((term) => text.includes(term)).map((term) => ({ path, term }))
    })
    expect(matches).toEqual([])
  })
})
