import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { assertBunToolchain } from './bun-toolchain'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(pin: string, packageManager = `bun@${pin}`): string {
  const root = mkdtempSync(join(tmpdir(), 'bun-toolchain-'))
  roots.push(root)
  writeFileSync(join(root, 'mise.toml'), `[tools]\nbun = "${pin}"\n`)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager }))
  return root
}
it('accepts the selected version and rejects an executable bypassing mise', () => {
  const root = fixture('1.4.2')
  expect(() => assertBunToolchain(root, '1.4.2')).not.toThrow()
  expect(() => assertBunToolchain(root, '1.3.14')).toThrow('Bun 1.3.14 is running')
})
it('rejects floating pins and inconsistent package metadata', () => {
  expect(() => assertBunToolchain(fixture('latest'), '1.4.2')).toThrow('exact Bun version')
  expect(() => assertBunToolchain(fixture('1.4.2', 'bun@1.3.14'), '1.4.2')).toThrow('must match')
})
