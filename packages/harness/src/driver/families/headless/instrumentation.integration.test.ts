import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type InstrumentationDestination, supported } from '../../../manifest.js'
import { harnessAdapterFor, registerTestManifest } from '../../../registry.js'
import { canonicalHeadlessContractFacts } from '../../contract.js'
import { createMemoryAttachmentStager } from '../../testing/attachment-stager.js'
import { installContextFixture } from '../../testing/context-fixture.js'
import { createMemoryDriverSlots } from '../../testing/driver-slots.js'
import {
  testHarnessContext,
  testSessionTerms,
  testTurnPosturePort,
} from '../../testing/harness-context.js'
import { startHookIngest } from '../terminal/instrumentation.js'
import { createFakeHosts } from './process-test-support.js'
import { createHeadlessRuntime, type HeadlessDriverHost } from './runtime.js'
import { testHarnessSnapshot } from './test-support.js'

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function waitFor(predicate: () => boolean | Promise<boolean>) {
  await vi.waitFor(async () => expect(await predicate()).toBe(true), {
    timeout: 5000,
    interval: 10,
  })
}

/** Invented native protocol. Its payload, flags and helper have no production
 * harness grammar. The real driver, installer, process and HTTP boundary run. */
async function world(toolPolicy?: 'none', cleanupThrows = false) {
  const root = await mkdtemp(join(tmpdir(), 'invocation-boundary-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const fixture = installContextFixture()
  cleanup.push(fixture.release)
  const adapter = harnessAdapterFor('fixture')!
  const install = vi.fn(async (destination: InstrumentationDestination) =>
    destination.extensionsAllowed === false
      ? { args: [] }
      : {
          args: ['--observer', join(destination.settingsDir, 'observer.mjs')],
          env: { OBSERVATION_ENV: 'declared' },
          file: {
            path: join(destination.settingsDir, 'observer.mjs'),
            contents: `export default ${JSON.stringify(destination.endpointUrl)}`,
          },
          ...(cleanupThrows
            ? {
                cleanup: async () => {
                  throw new Error('invented cleanup failure')
                },
              }
            : {}),
        },
  )
  const headless = adapter.headless
  if (!headless.supported) throw new Error(headless.reason)
  const release = registerTestManifest({
    ...adapter,
    headless: supported({
      ...headless.value,
      noTools: 'enforced',
      buildExec: supported((opts) => ({
        args: ['--session-id', opts.sessionId ?? opts.resumeValue ?? '', '--', opts.prompt],
      })),
    }),
    instrumentation: supported({
      driverIds: ['headless'],
      scope: { kind: 'session' },
      install,
      hookTransport: 'loopback-http',
      payloadCodec: {
        decode: async () => [],
        eventName: () => undefined,
        sessionId: () => undefined,
        transcriptPath: () => undefined,
      },
    }),
  })
  cleanup.push(release)
  const binary = join(root, 'invented-native')
  await writeFile(
    binary,
    `#!${process.execPath}
import { existsSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const args = process.argv.slice(2)
writeFileSync(process.env.CAPTURE, JSON.stringify({args, env: process.env.OBSERVATION_ENV}))
process.on('SIGTERM', () => setTimeout(() => process.exit(143), 150))
while (!existsSync(process.env.RELEASE)) await new Promise(r => setTimeout(r, 10))
const file = args[args.indexOf('--observer') + 1]
if (args.includes('--observer')) {
  const endpoint = (await import(pathToFileURL(file).href)).default
  const response = await fetch(endpoint, {method:'POST',body:JSON.stringify({id:'native-reading',percent:25,nativeSessionId:args[args.indexOf('--session-id')+1],at:'2026-11-22T00:00:00.000Z'})})
  if (response.status !== 200) throw new Error('callback refused')
}
console.error('original native diagnostic')
console.log('answer:' + args[args.indexOf('--') + 1])
process.exit(process.env.FAIL === '1' ? 3 : 0)
`,
  )
  await chmod(binary, 0o755)
  const ingest = await startHookIngest({
    port: 0,
    onPayload: () => {
      throw new Error('legacy decoder must not receive invocation telemetry')
    },
    beforeAck: async () => {
      throw new Error('legacy receipt parser must not receive invocation telemetry')
    },
  })
  cleanup.push(() => ingest.close())
  const engines = createFakeHosts()
  cleanup.push(() => engines.killAll())
  const sessionId = asSessionId('invented-native-session')
  const context = testHarnessContext({
    kind: adapter.kind,
    executable: binary,
    version: 'pinned-observer-version',
    home: root,
  })
  const listen = vi.fn<NonNullable<HeadlessDriverHost['instrumentation']>['listen']>(
    (id, token, receive) => ingest.register(id, receive, token).dispose,
  )
  const bindHeadlessSession = vi.fn()
  const capture = join(root, 'capture.json'),
    releaseFile = join(root, 'release')
  const host: HeadlessDriverHost = {
    ...testTurnPosturePort(),
    send: vi.fn(),
    now: Date.now,
    snapshot: async () => ({
      ...testHarnessSnapshot({}, 99),
      executables: new Map([
        [
          adapter.kind,
          { kind: adapter.kind, path: binary, version: 'pinned-observer-version', generation: 99 },
        ],
      ]),
    }),
    engines: () => engines.owner,
    turnChildEnv: ({ specEnv, execEnv }) => ({ env: { ...specEnv, ...execEnv }, stripEnv: [] }),
    assertNativeAccount() {},
    sessionEnv: () => ({ CAPTURE: capture, RELEASE: releaseFile }),
    durableLabel: () => 'invented-observation-host',
    bindHeadlessSession,
    readHistory: async () => ({ items: [], hasMore: false }),
    archiveTranscript: async () => ({ path: '/unused' }),
    readFileBytes: async () => new Uint8Array(),
    stageAttachment: createMemoryAttachmentStager(),
    instrumentation: {
      settingsDir: root,
      endpointFor: (id, token) => `${ingest.endpointFor(id)}?invocation=${token}`,
      listen,
    },
  }
  const runtime = createHeadlessRuntime(host, createMemoryDriverSlots())
  cleanup.push(() => runtime.dispose())
  const handle = await runtime.createWithId(sessionId, {
    harness: 'fixture',
    harnessContext: context,
    ...testSessionTerms(),
    workdir: root,
    model: {},
    selection: { auth: 'unknown', platform: 'linux', available: [] },
    instructions: { supported: false, reason: 'test' },
    mcpServers: { supported: false, reason: 'test' },
    toolPolicy,
  })
  const turn = {
    text: '--original-positional',
    id: 'invented-turn',
    accountId: 'native:fixture:invented',
    sessionUuid: 'native-primary',
    ...(toolPolicy ? { toolPolicy } : {}),
  }
  const requestDigest = createHash('sha256')
    .update(
      canonicalHeadlessContractFacts({
        prompt: turn.text,
        turnId: turn.id,
        accountId: turn.accountId,
        sessionId,
        sessionUuid: turn.sessionUuid,
        ...(toolPolicy ? { toolPolicy } : {}),
      }),
    )
    .digest('hex')
  const input = { ...turn, requestDigest }
  return {
    root,
    runtime,
    handle,
    input,
    install,
    listen,
    bindHeadlessSession,
    engines,
    host,
    sessionId,
    context,
    capture,
    releaseFile,
  }
}

describe('production invocation instrumentation boundary', () => {
  it('rejects malformed HTTP request targets without throwing from ingest', async () => {
    const ingest = await startHookIngest({ port: 0, onPayload: vi.fn() })
    cleanup.push(() => ingest.close())
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: ingest.port, method: 'POST', path: 'http://[invalid' },
        (response) => {
          response.resume()
          response.on('end', () => resolve(response.statusCode))
        },
      )
      req.on('error', reject)
      req.end('{}')
    })
    expect(status).toBe(404)
  })
  it('preserves native success when telemetry cleanup rejects', async () => {
    const w = await world(undefined, true)
    await w.handle.send(w.input, { delivery: 'when-ready', origin: 'human' })
    await waitFor(() => existsSync(w.capture))
    const args = JSON.parse(await readFile(w.capture, 'utf8')).args as string[]
    const file = args[args.indexOf('--observer') + 1]!
    await writeFile(w.releaseFile, '')
    await waitFor(async () => (await w.handle.state()).phase === 'idle')
    expect((await w.handle.state()).idle?.kind).toBe('done')
    expect(existsSync(file)).toBe(false)
  })

  it.each([
    'start',
    'replay',
  ] as const)('releases installed resources when %s fails', async (failure) => {
    const w = await world()
    if (failure === 'start')
      vi.spyOn(w.engines.owner, 'startEngine').mockRejectedValue(
        new Error('invented start refusal'),
      )
    else {
      const reattach = w.engines.owner.reattachEngine.bind(w.engines.owner)
      vi.spyOn(w.engines.owner, 'reattachEngine').mockImplementation((request) => {
        if (w.engines.starts.length > 0) return Promise.reject(new Error('invented replay failure'))
        return reattach(request)
      })
    }
    await w.handle.send(w.input, { delivery: 'when-ready', origin: 'human' })
    await waitFor(() => w.install.mock.calls.length === 1 && w.listen.mock.calls.length === 1)
    const destination = w.install.mock.calls[0]![0]
    await waitFor(() => !existsSync(join(destination.settingsDir, 'observer.mjs')))
    expect((await fetch(destination.endpointUrl, { method: 'POST', body: '{}' })).status).toBe(403)
    if (failure === 'replay')
      await waitFor(async () => !(await w.engines.owner.engineAlive('invented-observation-host')))
  })
  it('rejects foreign, disposed and replaced callback capabilities without legacy dispatch', async () => {
    const legacy = vi.fn()
    const ingest = await startHookIngest({ port: 0, onPayload: legacy })
    cleanup.push(() => ingest.close())
    const sessionId = asSessionId('callback-owner')
    const first = vi.fn(),
      replacement = vi.fn()
    const callback = ingest.register(sessionId, first)
    const post = (url: string) =>
      fetch(url, { method: 'POST', body: JSON.stringify({ opaque: true }) })
    expect(
      (await post(callback.endpointUrl.replace('/callback-owner?', '/foreign-session?'))).status,
    ).toBe(403)
    expect(first).not.toHaveBeenCalled()
    expect((await post(callback.endpointUrl)).status).toBe(200)
    const next = ingest.register(sessionId, replacement, callback.id)
    callback.dispose()
    expect((await post(next.endpointUrl)).status).toBe(200)
    expect(replacement).toHaveBeenCalledWith({ opaque: true })
    next.dispose()
    expect((await post(next.endpointUrl)).status).toBe(403)
    expect(first).toHaveBeenCalledTimes(1)
    expect(replacement).toHaveBeenCalledTimes(1)
    expect(legacy).not.toHaveBeenCalled()
  })
  it.each([
    undefined,
    'none',
  ] as const)('preserves argv/stdout and delivers opaque callbacks with policy %s', async (policy) => {
    const w = await world(policy)
    expect(
      (await w.handle.send(w.input, { delivery: 'when-ready', origin: 'human' })).outcome,
    ).toBe('accepted')
    await waitFor(() => existsSync(w.capture))
    const captured = JSON.parse(await readFile(w.capture, 'utf8'))
    expect(captured.args.slice(-2)).toEqual(['--', '--original-positional'])
    expect(w.install.mock.calls[0]?.[0]).toMatchObject({
      extensionsAllowed: policy !== 'none',
      harnessContext: { ...w.context, installation: { ...w.context.installation, generation: 99 } },
    })
    expect(w.listen).toHaveBeenCalledTimes(policy ? 0 : 1)
    const file = captured.args[captured.args.indexOf('--observer') + 1]
    if (!policy) expect(existsSync(file)).toBe(true)
    await writeFile(w.releaseFile, '')
    await waitFor(async () => (await w.handle.state()).phase === 'idle')
    const context = (await w.handle.snapshot()).context?.context
    if (!policy) {
      expect(context).toMatchObject({
        status: 'available',
        sample: {
          id: 'native-reading',
          nativeSessionId: 'native-primary',
          at: '2026-11-22T00:00:00.000Z',
        },
        occupancy: { percent: { value: 25 } },
      })
      expect(existsSync(file)).toBe(false)
    } else {
      expect(captured.args).not.toContain('--observer')
      expect(captured.env).toBeUndefined()
      expect(await readdir(w.root)).not.toContain(String(w.sessionId))
    }
    expect(w.bindHeadlessSession.mock.calls.at(-1)?.[4]).toMatchObject({
      harnessContext: { ...w.context, installation: { ...w.context.installation, generation: 99 } },
      startedAtMs: expect.any(Number),
    })
  })

  it('retains a surviving helper until real exit and adopts without installing or starting again', async () => {
    const w = await world()
    await w.handle.send(w.input, { delivery: 'when-ready', origin: 'human' })
    await waitFor(() => existsSync(w.capture))
    const args = JSON.parse(await readFile(w.capture, 'utf8')).args as string[]
    const file = args[args.indexOf('--observer') + 1]!
    const binding = w.handle.binding
    w.runtime.dispose()
    expect(existsSync(file)).toBe(true)
    const adopted = createHeadlessRuntime(w.host, createMemoryDriverSlots())
    cleanup.push(() => adopted.dispose())
    const handle = await adopted.adopt(binding)
    const before = w.bindHeadlessSession.mock.calls.length
    await handle.send(w.input, { delivery: 'when-ready', origin: 'human' })
    await waitFor(() => w.listen.mock.calls.length === 2)
    expect(w.install).toHaveBeenCalledTimes(1)
    expect(w.engines.starts).toHaveLength(1)
    expect(
      w.bindHeadlessSession.mock.calls.slice(before).every((call) => call[4] === undefined),
    ).toBe(true)
    await writeFile(w.releaseFile, '')
    await waitFor(async () => (await handle.state()).phase === 'idle')
    expect(existsSync(file)).toBe(false)
  })

  it.each([
    'interrupt',
    'timeout',
    'failure',
  ] as const)('cleans helper and callback after actual %s completion', async (cause) => {
    const w = await world()
    if (cause === 'failure')
      w.host.sessionEnv = () => ({ CAPTURE: w.capture, RELEASE: w.releaseFile, FAIL: '1' })
    let input = w.input
    if (cause === 'timeout') {
      input = { ...input, timeoutMs: 300 } as typeof input
      input.requestDigest = createHash('sha256')
        .update(
          canonicalHeadlessContractFacts({
            prompt: input.text,
            turnId: input.id,
            sessionId: w.sessionId,
            accountId: input.accountId,
            sessionUuid: input.sessionUuid,
            timeoutMs: 300,
          }),
        )
        .digest('hex')
    }
    await w.handle.send(input, { delivery: 'when-ready', origin: 'human' })
    await waitFor(() => existsSync(w.capture))
    const args = JSON.parse(await readFile(w.capture, 'utf8')).args as string[]
    const file = args[args.indexOf('--observer') + 1]!
    const endpoint = (await readFile(file, 'utf8')).slice('export default '.length)
    if (cause === 'interrupt') await w.handle.interrupt()
    if (cause === 'failure') await writeFile(w.releaseFile, '')
    await waitFor(() => !existsSync(file))
    expect((await fetch(JSON.parse(endpoint), { method: 'POST', body: '{}' })).status).toBe(403)
  })
})
