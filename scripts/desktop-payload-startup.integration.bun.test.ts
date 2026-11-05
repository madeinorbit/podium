/** Small real-process ownership/validation proof; no claimed historical-release rescue here. */
import { afterEach, describe, expect, it } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  legacyInstallationInUse,
  prepareDesktopPayloadStartup,
  validateDesktopPayload,
} from '../packages/runtime/src/desktop-payload-startup'
import {
  acquireInstallationLease,
  acquireLegacyExecutableFence,
  type InstallationLease,
  installationStateRoots,
} from '../packages/runtime/src/installation-lease'
import { hermeticChildEnv } from '../test-hermetic-env'

const roots: string[] = []
const children: ChildProcess[] = []
const leases: InstallationLease[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    child.kill('SIGKILL')
    await once(child, 'exit')
  }
  for (const lease of leases.splice(0)) lease.release()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'podium-payload-process-'))
  roots.push(root)
  return { root, install: join(root, 'payload') }
}
function usage(install: string, exclusive: boolean) {
  const lease = acquireInstallationLease(install, exclusive)
  leases.push(lease)
  return lease
}
function owner(install: string, state: string) {
  const child = spawn(
    process.execPath,
    [resolve('scripts/fixtures/installation-usage.ts'), install, state],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: hermeticChildEnv({
        PODIUM_STATE_DIR: state,
        PODIUM_INSTANCE: 'payloadproof',
        PODIUM_NO_RELAY: '1',
      }),
    },
  )
  children.push(child)
  return child
}
async function ready(child: ChildProcess) {
  let output = ''
  let errors = ''
  child.stdout?.on('data', (value) => {
    output += value
  })
  child.stderr?.on('data', (value) => {
    errors += value
  })
  const deadline = Date.now() + 10_000
  while (!output.includes('installation usage ready')) {
    if (child.exitCode !== null || Date.now() >= deadline)
      throw new Error(`owner did not start: ${errors}`)
    await Bun.sleep(20)
  }
}
function payload(path: string, version: string) {
  mkdirSync(join(path, 'web'), { recursive: true })
  mkdirSync(join(path, 'mobile'), { recursive: true })
  writeFileSync(join(path, 'VERSION'), `${version}\n`)
  writeFileSync(join(path, 'podium'), '#!/bin/sh\nexec "$(dirname "$0")/podium-cli" "$@"\n', {
    mode: 0o755,
  })
  writeFileSync(join(path, 'podium-cli'), `#!/bin/sh\nprintf 'podium ${version}\\n'\n`, {
    mode: 0o755,
  })
  writeFileSync(join(path, 'podium-host'), 'host fixture')
  for (const client of ['web', 'mobile']) {
    writeFileSync(join(path, client, 'index.html'), `${client} ${version}`)
    writeFileSync(
      join(path, client, 'podium-build.json'),
      JSON.stringify({ appVersion: version, sourceSha: 'process-fixture' }),
    )
  }
}

describe.skipIf(process.platform !== 'linux')(
  'Linux cold-start installation process boundaries',
  () => {
    it('atomically fences legacy execution in both directions without changing executable bytes', async () => {
      const { install } = fixture()
      mkdirSync(install)
      const binary = join(install, 'sleep')
      copyFileSync('/bin/sleep', binary)
      chmodSync(binary, 0o755)
      const before = readFileSync(binary)
      const legacy = spawn(binary, ['30'], { stdio: 'ignore' })
      children.push(legacy)
      await once(legacy, 'spawn')
      await Bun.sleep(50)
      expect(() => acquireLegacyExecutableFence(install)).toThrow()
      legacy.kill('SIGKILL')
      await once(legacy, 'exit')
      const release = acquireLegacyExecutableFence(install)
      try {
        // Bun may report the exec failure synchronously or on the child error event.
        let code: string | undefined
        try {
          const blocked = spawn(binary, ['30'], { stdio: 'ignore' })
          children.push(blocked)
          const [error] = await once(blocked, 'error')
          code = (error as NodeJS.ErrnoException).code
        } catch (error) {
          code = (error as NodeJS.ErrnoException).code
        }
        expect(code).toBe('ETXTBSY')
        expect(readFileSync(binary)).toEqual(before)
      } finally {
        release()
      }
    })
    it('keeps fallback excluded through parent/successor overlap and releases only after the last owner dies', async () => {
      const { root, install } = fixture()
      const parent = owner(install, join(root, 'blue'))
      await ready(parent)
      const successor = owner(install, join(root, 'blue'))
      const other = owner(install, join(root, 'green'))
      await Promise.all([ready(successor), ready(other)])
      expect(() => usage(install, true)).toThrow()
      parent.kill('SIGKILL')
      await once(parent, 'exit')
      expect(() => usage(install, true)).toThrow()
      successor.kill('SIGKILL')
      await once(successor, 'exit')
      expect(() => usage(install, true)).toThrow()
      other.kill('SIGKILL')
      await once(other, 'exit')
      const fallback = usage(install, true)
      expect(installationStateRoots(fallback).sort()).toEqual([
        join(root, 'blue'),
        join(root, 'green'),
      ])
    })

    it('keeps unrelated installations independent', async () => {
      const { root, install } = fixture()
      const parent = owner(install, join(root, 'blue'))
      await ready(parent)
      expect(usage(join(root, 'other-payload'), true).exclusive).toBe(true)
    })

    it('a real loaded legacy executable blocks fallback even without a new lease or any selected-root record', async () => {
      const { root, install } = fixture()
      mkdirSync(install)
      const binary = join(install, 'sleep')
      copyFileSync('/bin/sleep', binary)
      chmodSync(binary, 0o755)
      // Preserve the multicall ELF's actual basename as well as argv[0].
      const legacy = spawn(binary, ['30'], { stdio: ['ignore', 'ignore', 'pipe'], argv0: 'sleep' })
      children.push(legacy)
      let failure = ''
      legacy.stderr?.on('data', (data) => {
        failure += data
      })
      await once(legacy, 'spawn')
      await Bun.sleep(50)
      expect({ exit: legacy.exitCode, signal: legacy.signalCode, failure }).toEqual({
        exit: null,
        signal: null,
        failure: '',
      })
      expect(await legacyInstallationInUse(install)).toBe(true)
      legacy.kill('SIGKILL')
      await once(legacy, 'exit')
      expect(await legacyInstallationInUse(install)).toBe(false)
      expect(existsSync(join(root, 'state'))).toBe(false)
    })

    it('validates executed version and both client builds; a relabeled VERSION is insufficient', async () => {
      const { install } = fixture()
      payload(install, '0.2.0')
      await validateDesktopPayload(install, '0.2.0')
      writeFileSync(join(install, 'VERSION'), '0.4.0-edge.1\n')
      await expect(validateDesktopPayload(install, '0.4.0-edge.1')).rejects.toThrow('disagree')
      payload(install, '0.4.0-edge.1')
      writeFileSync(
        join(install, 'mobile/podium-build.json'),
        JSON.stringify({ appVersion: '0.2.0' }),
      )
      await expect(validateDesktopPayload(install, '0.4.0-edge.1')).rejects.toThrow('metadata')
    })

    it('stages and activates the complete source fixture, then validates the installed executable', async () => {
      const { root, install } = fixture()
      const seed = join(root, 'signed-app/payload')
      payload(install, '0.2.0')
      payload(seed, '0.4.0-edge.1')
      writeFileSync(join(seed, 'complete-resource'), 'resource travels with the CLI')
      const state = join(root, 'state')
      const lease = usage(install, true)
      const result = await prepareDesktopPayloadStartup(
        {
          seed,
          installDir: install,
          stateDir: state,
          channel: 'edge',
          releaseBuild: true,
          exclusive: true,
          appManaged: true,
        },
        lease,
      )
      expect(result).toEqual({ outcome: 'replaced', from: '0.2.0', version: '0.4.0-edge.1' })
      await validateDesktopPayload(install, '0.4.0-edge.1')
      expect(readFileSync(join(install, 'complete-resource'), 'utf8')).toBe(
        'resource travels with the CLI',
      )
      expect(existsSync(state)).toBe(false)
    })
  },
)
