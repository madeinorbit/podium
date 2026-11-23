import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { harnessAccount } from '../harness-context.js'
import { quotaCommandRunner } from './quota-command.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function runner() {
  const home = await mkdtemp(join(tmpdir(), 'podium-quota-process-test-'))
  roots.push(home)
  return quotaCommandRunner({
    ...harnessAccount('pi', home, { HOME: home, PATH: process.env.PATH ?? '' }),
    installation: {
      kind: 'pi',
      executable: process.execPath,
      version: '',
      generation: 1,
      provenance: 'external',
    },
  })
}

describe('native quota process boundary', () => {
  it.skipIf(process.platform === 'win32')(
    'uses a private workspace and blocks native browser launchers, then removes its temporary files',
    async () => {
      const run = await runner()
      const native = await mkdtemp(join(tmpdir(), 'podium-quota-native-state-'))
      roots.push(native)
      await writeFile(join(native, 'fixture'), 'native account state')
      const result = await run({
        args: (directory) => [
          '-e',
          `import {statSync,readFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process'; console.log(JSON.stringify({cwd:process.cwd(),mode:statSync(process.cwd()).mode&511,native:readFileSync(process.argv[1],'utf8'),browser:spawnSync(process.env.BROWSER,[]).status,open:spawnSync('${process.platform === 'darwin' ? 'open' : 'xdg-open'}',['https://accounts.google.com']).status}))`,
          join(directory, 'native-state', 'fixture'),
        ],
        linkedDirectories: { 'native-state': native },
        timeoutMs: 5000,
      })
      expect(result.exitCode).toBe(0)
      const observed = JSON.parse(result.stdout)
      expect(observed).toMatchObject({
        mode: 0o700,
        browser: 1,
        open: 1,
        native: 'native account state',
      })
      expect(existsSync(observed.cwd)).toBe(false)
      expect(readFileSync(join(native, 'fixture'), 'utf8')).toBe('native account state')
    },
  )

  it('preserves structured failure output on a non-zero exit', async () => {
    const result = await (await runner())({
      args: ['-e', `console.log('native failure'); process.exit(2)`],
      timeoutMs: 5000,
    })
    expect(result).toMatchObject({ exitCode: 2, timedOut: false, stdout: 'native failure\n' })
  })

  it('bounds hung probes and output without accepting a partial success', async () => {
    const run = await runner()
    expect(await run({ args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 30 })).toMatchObject({
      timedOut: true,
    })
    const overflow = await run({
      args: ['-e', `process.stdout.write('x'.repeat(1500000))`],
      timeoutMs: 5000,
    })
    expect(overflow.errorCode).toBe('ERR_QUOTA_OUTPUT_LIMIT')
    expect(Buffer.byteLength(overflow.stdout)).toBeLessThanOrEqual(1_000_000)
  })

  it.skipIf(process.platform !== 'linux')(
    'stops descendants in the probe-owned process group after completion',
    async () => {
      const run = await runner()
      const result = await run({
        args: [
          '-e',
          `import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(child.pid); child.unref()`,
        ],
        timeoutMs: 5000,
      })
      expect(result.exitCode).toBe(0)
      const pid = Number(result.stdout.trim())
      expect(pid).toBeGreaterThan(0)
      await expect
        .poll(() => {
          try {
            return /\) [ZX] /u.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
          } catch {
            return true
          }
        })
        .toBe(true)
    },
  )
})
