import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('lets first sheet text measurement wait for main without holding the React Native cache lock', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'podium-text-cache-'))
  try {
    const require = createRequire(import.meta.url)
    const reactNative = dirname(require.resolve('react-native/package.json'))
    const binary = join(scratch, 'cache-regression')
    execFileSync(
      process.env.CXX ?? 'c++',
      [
        '-std=c++20',
        '-pthread',
        '-I',
        join(reactNative, 'ReactCommon'),
        join(dirname(fileURLToPath(import.meta.url)), 'fixtures/react-native-text-cache.cpp'),
        '-o',
        binary,
      ],
      { timeout: 20_000 },
    )
    expect(execFileSync(binary, { encoding: 'utf8', timeout: 5_000 })).toContain(
      'PASS: first sheet measurement, concurrent insertion, cache hits and eviction',
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}, 30_000)
