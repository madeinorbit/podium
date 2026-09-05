/** Production CLI admission across separate legacy invocations and real signed swaps. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readMachineUpdateJournal } from '@podium/runtime/machine-update'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'podium-legacy-cli-'))
const key = generateKeyPairSync('ed25519')
const pubkey = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
let feed: ReturnType<typeof Bun.serve>
let advertised = '2.0.0'
let downloads = 0
let invalidSignature = false
const archives = new Map<string, Buffer>()
const cli = join(work, 'podium.js')

beforeAll(async () => {
  const entry = join(work, 'entry.ts')
  // Real CLI parsing/dispatch. Host roles are deliberately unavailable: these are
  // unconfigured, manual-restart installs. No installer/executor/probe is replaced.
  writeFileSync(
    entry,
    `import { main } from ${JSON.stringify(join(ROOT, 'apps/cli/src/cli.ts'))};
await main(async () => { throw new Error('legacy update must not start host roles') });\n`,
  )
  const build = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    conditions: ['@podium/source'],
    outdir: work,
    naming: 'podium.js',
    plugins: [
      {
        name: 'private-release-verifier-key',
        setup(builder) {
          builder.onLoad({ filter: /\/update-delivery\.ts$/ }, ({ path }) => ({
            loader: 'ts',
            contents: readFileSync(path, 'utf8').replace(
              /export const PODIUM_UPDATE_PUBKEY = '[^']+'/,
              `export const PODIUM_UPDATE_PUBKEY = ${JSON.stringify(pubkey)}`,
            ),
          }))
        },
      },
    ],
  })
  if (!build.success) throw new Error(build.logs.map(String).join('\n'))
  for (const version of ['2.0.0', '3.0.0']) {
    const stage = join(work, version)
    const headless = join(stage, 'headless')
    mkdirSync(headless, { recursive: true })
    cpSync(cli, join(headless, 'podium.js'))
    writeFileSync(join(headless, 'VERSION'), version + '\n')
    const archive = join(stage, 'bundle.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', stage, 'headless'])
    archives.set(version, readFileSync(archive))
  }
  feed = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.startsWith('/update/')) {
        const bytes = archives.get(advertised)!
        return Response.json({
          version: advertised,
          platforms: {
            'linux-x86_64': {
              url: `${url.origin}/artifact/${advertised}`,
              signature: sign(
                null,
                invalidSignature ? Buffer.from('wrong artifact') : bytes,
                key.privateKey,
              ).toString('base64'),
            },
          },
        })
      }
      const bytes = archives.get(url.pathname.replace('/artifact/', ''))
      if (!bytes) return new Response('missing', { status: 404 })
      downloads++
      return new Response(new Uint8Array(bytes))
    },
  })
}, 120_000)

afterAll(() => {
  feed?.stop(true)
  rmSync(work, { recursive: true, force: true })
})

function installation(name: string) {
  const root = join(work, name)
  const install = join(root, 'install')
  const state = join(root, 'state')
  mkdirSync(install, { recursive: true })
  cpSync(cli, join(install, 'podium.js'))
  writeFileSync(join(install, 'VERSION'), '1.0.0\n')
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith('PODIUM_') &&
        !['NOTIFY_SOCKET', 'WATCHDOG_USEC', 'INVOCATION_ID', 'ABDUCO_SOCKET_DIR'].includes(key),
    ),
  )
  Object.assign(env, {
    PODIUM_INSTANCE: 'legacy-recovery',
    PODIUM_STATE_DIR: state,
    PODIUM_HOME: install,
    PODIUM_NO_RELAY: '1',
    PODIUM_UPDATE_TARGET: 'linux-x86_64',
    PODIUM_UPDATE_FEED: `http://127.0.0.1:${feed.port}`,
    XDG_STATE_HOME: join(root, 'xdg-state'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    // Never reach the operator's compatibility systemd units.
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/absent-bus`,
  })
  return {
    install,
    runtime: join(state, 'runtime'),
    async invoke(command = 'update') {
      const child = Bun.spawn([process.execPath, join(install, 'podium.js'), command], {
        cwd: root,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        return { code, stdout, stderr }
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

describe('legacy one-shot CLI journal reconciliation', () => {
  it('accepts two successive signed updates with a manual process restart', async () => {
    const instance = installation('successive')
    advertised = '2.0.0'
    const first = await instance.invoke()
    expect(first.code, first.stderr).toBe(10)
    expect(first.stdout).toContain('restart podium to apply')
    const prior = readMachineUpdateJournal(instance.runtime)!
    expect(prior.phase).toBe('restarting')
    expect(prior.prepared?.digest).toBe(
      `sha256-${createHash('sha256').update(archives.get('2.0.0')!).digest('base64')}`,
    )
    expect(prior.prepared?.digest).toBe(
      readFileSync(join(instance.install, 'ARTIFACT.sha256'), 'utf8').trim(),
    )
    // The old CLI exited; start the installed successor through real CLI dispatch.
    expect((await instance.invoke('version')).code).toBe(0)
    advertised = '3.0.0'
    const second = await instance.invoke()
    expect(second.code, second.stderr).toBe(10)
    expect(second.stdout).toContain('updating 2.0.0 → 3.0.0')
    expect(second.stdout).toContain('restart podium to apply')
    const next = readMachineUpdateJournal(instance.runtime)!
    expect(next.completed[prior.grant.grantId]?.phase).toBe('current')
    expect(next.grant.grantId).not.toBe(prior.grant.grantId)
    expect(next.grant.target.version).toBe('3.0.0')
    expect(next.phase).toBe('restarting')
    expect(next.prepared?.digest).toBe(
      `sha256-${createHash('sha256').update(archives.get('3.0.0')!).digest('base64')}`,
    )
    expect(readFileSync(join(instance.install, 'ARTIFACT.sha256'), 'utf8').trim()).toBe(
      next.prepared?.digest,
    )
    expect(readFileSync(join(instance.install, 'podium.js'))).toEqual(readFileSync(cli))
    expect(readFileSync(join(instance.install, 'VERSION'), 'utf8').trim()).toBe('3.0.0')
    expect(readFileSync(join(`${instance.install}.old`, 'VERSION'), 'utf8').trim()).toBe('2.0.0')
  }, 90_000)

  it('rejects an invalid artifact signature before extraction or swap', async () => {
    const instance = installation('invalid-signature')
    advertised = '2.0.0'
    invalidSignature = true
    try {
      const result = await instance.invoke()
      expect(result.code, result.stderr).toBe(1)
      expect(result.stderr).toContain('signature verification FAILED')
      expect(readMachineUpdateJournal(instance.runtime)?.phase).toBe('rejected')
      expect(readFileSync(join(instance.install, 'VERSION'), 'utf8').trim()).toBe('1.0.0')
      expect(existsSync(`${instance.install}.old`)).toBe(false)
      expect(existsSync(`${instance.install}.prepared`)).toBe(false)
      expect(existsSync(join(instance.install, 'ARTIFACT.sha256'))).toBe(false)
    } finally {
      invalidSignature = false
    }
  }, 90_000)

  for (const mismatch of ['version', 'digest', 'missing-digest'] as const) {
    it(`retains pending activation refusal for ${mismatch} across repeated CLI invocations`, async () => {
      const instance = installation(mismatch)
      advertised = '2.0.0'
      const first = await instance.invoke()
      expect(first.code, first.stderr).toBe(10)
      if (mismatch === 'version') writeFileSync(join(instance.install, 'VERSION'), '1.0.0\n')
      else if (mismatch === 'digest')
        writeFileSync(join(instance.install, 'ARTIFACT.sha256'), 'different\n')
      else rmSync(join(instance.install, 'ARTIFACT.sha256'))
      const before = readMachineUpdateJournal(instance.runtime)
      const beforeDownloads = downloads
      advertised = '3.0.0'
      for (let attempt = 0; attempt < 3; attempt++) {
        const refused = await instance.invoke()
        expect(refused.code, refused.stderr).toBe(1)
        expect(refused.stderr).toContain('update-committed: activation must settle')
        expect(readMachineUpdateJournal(instance.runtime)).toEqual(before)
      }
      expect(downloads).toBe(beforeDownloads)
    }, 90_000)
  }
})
