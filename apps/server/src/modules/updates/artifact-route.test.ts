import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterAll, describe, expect, it } from 'vitest'
import { registerDevArtifactRoute } from './artifact-route'
import type { BuiltDevBundle } from './dev-bundle'
import {
  developmentArtifactUrl,
  selectDevelopmentArtifactOrigin,
  targetForSharedReadModel,
  wireDevBundlePublisher,
} from './dev-publisher-wiring'

const bytes = new Uint8Array([9, 8, 7, 6])
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const signature = sign(null, bytes, privateKey)

// A real file, because the route's job is now to stream one off disk.
const stage = mkdtempSync(join(tmpdir(), 'podium-dev-bundle-'))
const artifact = join(stage, 'podium-headless-dev+abc1234-20260812T182015Z.tar.gz')
writeFileSync(artifact, bytes)
afterAll(() => rmSync(stage, { recursive: true, force: true }))

const built: BuiltDevBundle = {
  version: 'dev+abc1234',
  path: artifact,
  size: bytes.length,
  digest: 'sha256-fixture',
  signature: signature.toString('base64'),
}

function appFor(authenticated = true) {
  const app = new Hono()
  registerDevArtifactRoute(app, {
    current: () => built,
    authenticate: (request) =>
      authenticated && request.headers.get('authorization') === 'Bearer machine-token',
  })
  return app
}

describe('development artifact route', () => {
  it('builds an origin-relative route with encoded version and authentication token', () => {
    const url = new URL(
      developmentArtifactUrl('https://podium.example.test:55555', 'dev+abc/123', 'random token/?'),
    )
    expect(url.origin).toBe('https://podium.example.test:55555')
    expect(url.pathname).toBe('/updates/dev-bundle/dev%2Babc%2F123')
    expect(url.searchParams.get('token')).toBe('random token/?')
  })
  it('keeps a source publisher enabled for same-host fallback', () => {
    const base: Parameters<typeof wireDevBundlePublisher>[0] = {
      sourceRoot: '/repo/podium',
      artifactOrigin: 'https://podium.example.test',
      localArtifactOrigin: () => 'http://127.0.0.1:18787',
      hasRemoteManagedMachines: () => false,
      artifactToken: 'random-token',
      signingKey: 'unused-until-build',
      setTarget: () => {},
      locks: {
        acquire: () => ({ granted: true, alreadyHeld: false, lock: {} as never }),
        cancel: () => {},
        renew: () => {},
        release: () => {},
      },
    }
    expect(wireDevBundlePublisher(base).enabled).toBe(true)
    expect(
      wireDevBundlePublisher({
        ...base,
        artifactOrigin: undefined,
      }).enabled,
    ).toBe(true)
    expect(wireDevBundlePublisher({ ...base, sourceRoot: undefined }).enabled).toBe(false)
  })

  it('shares ONE cached HEAD reader across everything it wires', async () => {
    // The composition is the only place that can share it, and a shared reader
    // is exactly the kind of wiring that goes missing without anyone noticing:
    // drop it and every caller still works, just with a `git rev-parse` each
    // (POD-2052). A poll reads HEAD twice — to decide, and to name the target.
    const root = mkdtempSync(join(tmpdir(), 'wiring-head-'))
    try {
      mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true })
      writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'a'.repeat(40)}\n`)

      let reads = 0
      const wiring = wireDevBundlePublisher({
        sourceRoot: root,
        artifactOrigin: 'https://podium.example.test',
        localArtifactOrigin: () => 'http://127.0.0.1:18787',
        hasRemoteManagedMachines: () => false,
        artifactToken: 'random-token',
        signingKey: 'unused-until-build',
        setTarget: () => {},
        locks: {
          acquire: () => ({ granted: true, alreadyHeld: false, lock: {} as never }),
          cancel: () => {},
          renew: () => {},
          release: () => {},
        },
        readHeadSha: async () => {
          reads++
          return 'aaaaaaa'
        },
      })

      for (let i = 0; i < 8; i++) await wiring.publishTarget()
      expect(reads).toBe(1)

      // A commit lands: the stamp moves and the next reader goes back to git.
      writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'b'.repeat(40)}\n`)
      await wiring.publishTarget()
      expect(reads).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses loopback only for a same-host managed fleet', () => {
    const localOrigin = 'http://127.0.0.1:18787'
    expect(
      selectDevelopmentArtifactOrigin({
        externalOrigin: 'https://podium.example.test',
        localOrigin,
        hasRemoteManagedMachines: true,
      }),
    ).toBe('https://podium.example.test')
    expect(
      selectDevelopmentArtifactOrigin({
        externalOrigin: undefined,
        localOrigin,
        hasRemoteManagedMachines: false,
      }),
    ).toBe(localOrigin)
    expect(() =>
      selectDevelopmentArtifactOrigin({
        externalOrigin: undefined,
        localOrigin,
        hasRemoteManagedMachines: true,
      }),
    ).toThrow(/requires PODIUM_DEV_ARTIFACT_BASE_URL/)
  })

  it('puts dest identity into the shared read model without a public origin', () => {
    const identity = {
      version: 'dev+f3f48c2',
      critical: false,
      artifacts: {
        web: { digest: 'f3f48c2' },
        headlessAlternatives: [{ delivery: 'git' as const, repo: '/repo', sha: 'f3f48c2' }],
      },
    }
    expect(targetForSharedReadModel(identity, undefined)).toEqual(identity)
    expect(targetForSharedReadModel(identity, 'https://podium.example.test')).toEqual(identity)
  })

  it('strips a dest tarball URL when there is no public origin', () => {
    const packed = {
      version: 'dev+f3f48c2',
      critical: false,
      artifacts: {
        web: { digest: 'f3f48c2' },
        headless: {
          delivery: 'feed' as const,
          platforms: {
            'linux-x86_64': {
              url: 'http://127.0.0.1:18787/updates/dev-bundle/dev%2Bf3f48c2?token=x',
              digest: 'sha256-fixture',
              signature: 'sig',
            },
          },
        },
        headlessAlternatives: [{ delivery: 'git' as const, repo: '/repo', sha: 'f3f48c2' }],
      },
    }
    expect(targetForSharedReadModel(packed, undefined).artifacts.headless).toBeUndefined()
    expect(targetForSharedReadModel(packed, undefined).artifacts.web).toEqual({ digest: 'f3f48c2' })
    expect(targetForSharedReadModel(packed, 'https://podium.example.test')).toEqual(packed)
  })

  it('streams the exact signed bytes to an authenticated machine', async () => {
    const app = appFor()
    const response = await app.request('/updates/dev-bundle/dev%2Babc1234', {
      headers: { authorization: 'Bearer machine-token' },
    })
    const served = new Uint8Array(await response.arrayBuffer())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(bytes.length))
    expect(Array.from(served)).toEqual(Array.from(bytes))
    expect(verify(null, served, publicKey, Buffer.from(built.signature, 'base64'))).toBe(true)
  })

  it('says not found when the published artifact is no longer on disk', async () => {
    // Retention, a clean checkout, an operator with a shell: the file can go
    // between publication and a request, and the honest answer is "not here".
    const app = new Hono()
    registerDevArtifactRoute(app, {
      current: () => ({ ...built, path: join(stage, 'never-written.tar.gz') }),
      authenticate: () => true,
    })
    expect((await app.request('/updates/dev-bundle/dev%2Babc1234')).status).toBe(404)
  })

  it('opens the artifact only after authentication and version agree', async () => {
    const opened: string[] = []
    const app = new Hono()
    registerDevArtifactRoute(app, {
      current: () => built,
      authenticate: (request) => request.headers.get('authorization') === 'Bearer machine-token',
      open: async (path) => {
        opened.push(path)
        return { stream: new Blob([bytes]).stream(), size: bytes.length }
      },
    })

    await app.request('/updates/dev-bundle/dev%2Babc1234')
    await app.request('/updates/dev-bundle/dev%2Bold', {
      headers: { authorization: 'Bearer machine-token' },
    })
    expect(opened).toEqual([])

    await app.request('/updates/dev-bundle/dev%2Babc1234', {
      headers: { authorization: 'Bearer machine-token' },
    })
    expect(opened).toEqual([built.path])
  })

  it('refuses an unauthenticated request', async () => {
    const response = await appFor().request('/updates/dev-bundle/dev%2Babc1234')
    expect(response.status).toBe(401)
  })

  it('refuses a version that is not the current build', async () => {
    const response = await appFor().request('/updates/dev-bundle/dev%2Bold', {
      headers: { authorization: 'Bearer machine-token' },
    })
    expect(response.status).toBe(404)
  })

  it('does not expose a stale path after the current build changes', async () => {
    let current: BuiltDevBundle | null = built
    const app = new Hono()
    registerDevArtifactRoute(app, {
      current: () => current,
      authenticate: () => true,
    })

    current = { ...built, version: 'dev+new1234' }
    const stale = await app.request('/updates/dev-bundle/dev%2Babc1234')
    const fresh = await app.request('/updates/dev-bundle/dev%2Bnew1234')
    expect(stale.status).toBe(404)
    expect(fresh.status).toBe(200)
  })
})
