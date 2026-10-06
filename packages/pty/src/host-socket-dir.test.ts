import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import { durableInstanceComponent, durableSessionLabel } from '@podium/runtime/instance'
import { unixSocketPathFits } from '@podium/runtime/unix-socket'
import { afterEach, describe, expect, it } from 'vitest'
import { hostEndpointForMarker, hostSocketDir, hostSocketPath, liveHostSocket } from './host.js'

/**
 * POD-4986: with abduco gone, podium-host is the only durable host, so a named
 * instance's host socket must fit `sun_path` for EVERY id the instance pattern
 * admits. The directory is keyed by the bounded instance component; an id of
 * 17 bytes or less keeps its directory, and a host bound under the raw id by an
 * older daemon is still found.
 */
describe('the host socket directory of a named instance', () => {
  const RUNTIME = '/run/user/1000'
  const env = (instance: string): NodeJS.ProcessEnv => ({
    PODIUM_INSTANCE: instance,
    XDG_RUNTIME_DIR: RUNTIME,
  })
  const savedRuntime = process.env.XDG_RUNTIME_DIR
  let root = ''
  let server: Server | undefined

  afterEach(async () => {
    if (savedRuntime === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = savedRuntime
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = undefined
    if (root) rmSync(root, { recursive: true, force: true })
    root = ''
  })

  it('keeps an id of 17 bytes or less as its own directory', () => {
    process.env.XDG_RUNTIME_DIR = RUNTIME
    expect(hostSocketDir(env('default'))).toBe(`${RUNTIME}/hosts/default`)
    expect(hostSocketDir(env('i'.repeat(17)))).toBe(`${RUNTIME}/hosts/${'i'.repeat(17)}`)
  })

  it('fits sun_path for the longest id the pattern admits (32 characters)', () => {
    process.env.XDG_RUNTIME_DIR = RUNTIME
    const id = `update-e2e-${'x'.repeat(21)}`
    expect(id).toHaveLength(32)
    const label = durableSessionLabel(asSessionId('00000000-0000-4000-8000-000000000000'), id)
    const path = hostSocketPath(label, env(id))
    expect(path).toBe(`${RUNTIME}/hosts/${durableInstanceComponent(id)}/${label}.sock`)
    expect(Buffer.byteLength(path)).toBe(105)
    expect(unixSocketPathFits(path)).toBe(true)
  })

  it('still finds a host an older daemon bound under the raw id', async () => {
    root = mkdtempSync('/tmp/phd-')
    const id = 'i'.repeat(18)
    const e = { PODIUM_INSTANCE: id, PODIUM_HOST_SOCKET_DIR: root }
    expect(hostSocketDir(e)).not.toBe(join(root, id))
    mkdirSync(join(root, id), { recursive: true })
    const legacy = join(root, id, 'podium-x.sock')
    server = createServer((c) => c.destroy())
    await new Promise<void>((resolve) => server?.listen(legacy, resolve))
    expect(await liveHostSocket('podium-x', e)).toBe(legacy)
  })
})

// Pure platform mapping: no Windows process is needed to prove isolation.
describe('Windows host endpoint names', () => {
  it('bounds paths, folds Windows case, and separates roots and instances', () => {
    const marker = 'C:\\state\\hosts\\default\\label.sock'
    const pipe = hostEndpointForMarker(marker, 'win32')
    expect(pipe).toMatch(/^\\\\\.\\pipe\\podium-host-[a-f0-9]{64}$/)
    expect(hostEndpointForMarker(marker.toUpperCase(), 'win32')).toBe(pipe)
    expect(hostEndpointForMarker(`${marker}other`, 'win32')).not.toBe(pipe)
    expect(hostEndpointForMarker(marker, 'linux')).toBe(marker)
  })
})
