/** A collected production-browser failure at the addressed link boundary.
 * Flatblock only. Restore source even when build or runner fails. */
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'

if (hostname() !== 'flatblock') throw new Error('Production control belongs on flatblock')
const path = 'packages/client-graph/src/mobile-inbox-views.ts'
const needle = 'return id === LOADING ? LOADING : id ? `/issue/${encodeURIComponent(id)}` : null'
const original = await readFile(path, 'utf8')
if (original.indexOf(needle) < 0 || original.indexOf(needle) !== original.lastIndexOf(needle))
  throw new Error('Ambiguous production route control')
try {
  await writeFile(path, original.replace(needle, needle.replace('/issue/', '/wrong-issue/')))
  const run = spawnSync(
    'bun',
    ['run', 'test:browser', '--', '--suite', 'expo-mobile-inbox-pool', '--project=chromium-pixel'],
    {
      encoding: 'utf8',
      timeout: 900000,
      env: { ...process.env, PORT: '45173', NO_COLOR: '1' },
    },
  )
  const output = `${run.stdout}\n${run.stderr}`
  if (
    run.error || run.status === 0 || !/\b1 failed\b/.test(output) ||
    !/toHaveURL/.test(output) || !/wrong-issue/.test(output)
  ) {
    console.error(output)
    throw new Error('Production route fault did not demonstrate the expected collected red')
  }
  console.log(JSON.stringify({ control: 'production addressed route', collectedRed: true }))
} finally {
  await writeFile(path, original)
}
