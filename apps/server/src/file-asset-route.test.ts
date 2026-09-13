// apps/server/src/file-asset-route.test.ts
import {
  asMachineId,
  asSessionId,
  asUserId,
  type Capability,
  type SessionId,
  type UserId,
} from '@podium/model'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { CommandPrincipal } from './command-principal'
import { type AssetGate, type AssetGateForRequest, registerAssetRoute } from './file-asset-route'
import { fileAccessGate, type FileAccessModules } from './modules/files/file-access-gate'

type AssetResult = Awaited<ReturnType<AssetGate['readSessionAsset']>>
/** The daemon always echoes the `path` it read; these fixtures care about the
 *  bytes, so `withPath` fills it from the request rather than making every stub
 *  below repeat it. */
type AssetStub = Omit<AssetResult, 'path'> & { path?: string }
const withPath = (path: string, r: AssetStub): AssetResult => ({ ...r, path: r.path ?? path })

/**
 * THE TRANSPORT HALF: ranges, headers, sniffing, status codes. These stub the
 * gate deliberately — they are about what the HTTP layer does with an answer,
 * not about how the answer was decided. The AUTHORIZATION half at the bottom of
 * this file constructs the real gate instead, and that split is the honest one:
 * a stub here would be lying only if it were also used to claim a rule was
 * enforced.
 */
const gateOf = (
  read: (range?: { offset?: number; length?: number }) => Promise<AssetStub>,
): AssetGateForRequest =>
  async () => ({
    readSessionAsset: async (_s, path, range) => withPath(path, await read(range)),
    readRootAsset: async (_r, path, _m, range) => withPath(path, await read(range)),
  })

const stub = (r: AssetStub): AssetGateForRequest => gateOf(async () => r)

/** A gate that records which door was opened, with what. Replaces the old
 *  `vi.fn()` on `readAsset`: the route no longer HAS a `readAsset` to spy on,
 *  and which of the two doors it chose is now part of what these assert. */
const recordingGate = (
  result: (range?: { offset?: number; length?: number }) => AssetStub,
): { gate: AssetGateForRequest; calls: Record<string, unknown>[] } => {
  const calls: Record<string, unknown>[] = []
  const gate: AssetGateForRequest = async () => ({
    readSessionAsset: async (sessionId, path, range) => {
      calls.push({ door: 'session', sessionId, path, ...(range ?? {}) })
      return withPath(path, result(range))
    },
    readRootAsset: async (root, path, machineId, range) => {
      calls.push({ door: 'root', root, path, machineId, ...(range ?? {}) })
      return withPath(path, result(range))
    },
  })
  return { gate, calls }
}

describe('GET /files/asset', () => {
  it('returns bytes with content-type for a valid asset', async () => {
    const app = new Hono()
    registerAssetRoute(
      app,
      stub({
        ok: true,
        dataBase64: Buffer.from('PNGDATA').toString('base64'),
        contentType: 'image/png',
      }),
    )
    const res = await app.request('/files/asset?sessionId=s&path=/w/a.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('PNGDATA')
  })
  it('forwards byte ranges and returns partial-content headers for media viewers', async () => {
    const { gate, calls } = recordingGate(() => ({
      ok: true,
      path: '/w/demo.mp4',
      dataBase64: Buffer.from('456').toString('base64'),
      contentType: 'video/mp4',
      size: 10,
    }))
    const app = new Hono()
    registerAssetRoute(app, gate)
    const res = await app.request('/files/asset?sessionId=s&path=/w/demo.mp4', {
      headers: { range: 'bytes=4-6' },
    })

    expect(calls).toEqual([
      { door: 'session', sessionId: 's', path: '/w/demo.mp4', offset: 4, length: 3 },
    ])
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 4-6/10')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('456')
  })
  it.each([
    ['bytes=4-', 4, 10 * 1024 * 1024, '456789', 'bytes 4-9/10'],
    ['bytes=8-99', 8, 92, '89', 'bytes 8-9/10'],
    ['bytes=-3', 7, 3, '789', 'bytes 7-9/10'],
  ])('resolves %s against the total file size', async (header, offset, readLength, body, contentRange) => {
    const source = Buffer.from('0123456789')
    const { gate, calls } = recordingGate((range) => ({
      ok: true,
      path: '/w/demo.mp4',
      dataBase64: source
        .subarray(range?.offset ?? 0, (range?.offset ?? 0) + (range?.length ?? source.length))
        .toString('base64'),
      contentType: 'video/mp4',
      size: source.length,
    }))
    const app = new Hono()
    registerAssetRoute(app, gate)
    const res = await app.request('/files/asset?sessionId=s&path=/w/demo.mp4', {
      headers: { range: header },
    })

    expect(calls.at(-1)).toEqual({
      door: 'session',
      sessionId: 's',
      path: '/w/demo.mp4',
      offset,
      length: readLength,
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(contentRange)
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(body)
  })
  it('returns the total size for an unsatisfiable range', async () => {
    const app = new Hono()
    registerAssetRoute(
      app,
      stub({ ok: true, dataBase64: Buffer.from('0').toString('base64'), size: 10 }),
    )
    const res = await app.request('/files/asset?sessionId=s&path=/w/demo.mp4', {
      headers: { range: 'bytes=10-' },
    })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */10')
  })
  it('rejects malformed and multipart ranges', async () => {
    const app = new Hono()
    registerAssetRoute(app, stub({ ok: true }))
    for (const range of ['items=1-2', 'bytes=4-2', 'bytes=0-1,3-4', 'bytes=-0']) {
      expect(
        (await app.request('/files/asset?sessionId=s&path=/w/demo.mp4', { headers: { range } }))
          .status,
      ).toBe(416)
    }
  })
  it('sandboxes HTML so a repo page cannot ride the session cookie', async () => {
    const app = new Hono()
    registerAssetRoute(
      app,
      stub({
        ok: true,
        dataBase64: Buffer.from('<h1>hi</h1>').toString('base64'),
        contentType: 'text/html; charset=utf-8',
      }),
    )
    const res = await app.request('/files/asset?root=/w&path=/w/mock.html')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect(res.headers.get('content-security-policy')).not.toContain('allow-same-origin')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })
  it('leaves an embedded image unsandboxed', async () => {
    const app = new Hono()
    registerAssetRoute(
      app,
      stub({
        ok: true,
        dataBase64: Buffer.from('PNG').toString('base64'),
        contentType: 'image/png',
      }),
    )
    const res = await app.request('/files/asset?root=/w&path=/w/a.png', {
      headers: { 'sec-fetch-dest': 'image' },
    })
    expect(res.headers.get('content-security-policy')).toBeNull()
  })
  it('404s when the read is not ok (e.g. outside sandbox)', async () => {
    const app = new Hono()
    registerAssetRoute(app, stub({ ok: false, error: 'outside workspace' }))
    const res = await app.request('/files/asset?sessionId=s&path=/etc/passwd')
    expect(res.status).toBe(404)
  })
  it('413s when the asset is too large', async () => {
    const app = new Hono()
    registerAssetRoute(app, stub({ ok: false, tooLarge: true }))
    const res = await app.request('/files/asset?sessionId=s&path=/w/big.png')
    expect(res.status).toBe(413)
  })
  it('400s on missing params', async () => {
    const app = new Hono()
    registerAssetRoute(app, stub({ ok: true }))
    const res = await app.request('/files/asset')
    expect(res.status).toBe(400)
  })

  it('serves the file as a download named after its basename when asked', async () => {
    const app = new Hono()
    registerAssetRoute(
      app,
      stub({
        ok: true,
        dataBase64: Buffer.from('<h1>hi</h1>').toString('base64'),
        contentType: 'text/html; charset=utf-8',
      }),
    )
    const res = await app.request('/files/asset?sessionId=s&path=/w/site/index.html&download=1')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="index.html"')
    expect(res.headers.get('content-security-policy')).toBeNull()
  })
})

/**
 * ── THE AUTHORIZATION HALF (PDM-262) ────────────────────────────────────────
 *
 * THE GATE IS REAL HERE, constructed exactly as `queries.authz.test.ts`
 * constructs it and as `derived-family.ts` constructs it in production — only
 * the modules beneath it are fixtures. That is the point of the repair: the raw
 * route and `files.read` are not two predicates that must be kept in step, they
 * are one object. A stubbed gate would make every assertion below a fact about
 * a mock's call log, which catalogue #20 says is worth nothing.
 *
 * THE NEGATIVES ASSERT ABSENCE OF THE EFFECT, not just a status code. A test
 * that checked only `res.status` would pass against a version that read the
 * bytes off the daemon and threw on the way out — disclosure with a tidy status.
 * `rpcCalls` is the real observation.
 *
 * OWNER and STRANGER ARE SET INDEPENDENTLY, and that is deliberate (catalogue
 * #33): the session's owner comes from the `owners` fixture and the caller comes
 * from `gateFor`, so pointing one at a different person creates a real
 * divergence rather than moving both together. If the identity appeared once,
 * editing it would prove nothing.
 */
const OWNER = asUserId('u_owner')
/** Neither the owner nor a grantee, and NOT an admin — `scope.kind` is `owned`,
 *  not `all`, because an operator's `all` returns early before the ownership
 *  rule under test is ever reached (catalogue #14). */
const STRANGER = asUserId('u_stranger')
/** Granted on the TASK, and still refused the SESSION's bytes — PDM-251. */
const GRANTEE = asUserId('u_grantee')
const TARGET = asSessionId('s_target')
const ROOT = '/repos/alpha'
const MACHINE = asMachineId('m_alpha')

const capabilityFor = (userId: UserId): Capability =>
  ({
    role: 'worker',
    scope: { kind: 'owned', userId },
    onBehalfOf: userId,
  }) as unknown as Capability

function gateHarness(opts?: {
  owners?: Record<string, { owner: UserId; grants: UserId[] }>
  roots?: string[]
  /** Grant edges on the machine, so the see/use split can be exercised. */
  machineGrants?: { grantee: string; verb: string }[]
}) {
  const rpcCalls: { input: Record<string, unknown> }[] = []
  const owners = opts?.owners ?? { [TARGET]: { owner: OWNER, grants: [] } }
  const roots = opts?.roots ?? [ROOT]

  const modules = {
    rpc: {
      readAsset: async (input: Record<string, unknown>) => {
        rpcCalls.push({ input })
        return {
          ok: true,
          path: String(input.path),
          dataBase64: Buffer.from('SECRET BYTES').toString('base64'),
          contentType: 'image/png',
          size: 12,
        }
      },
    },
    issueArtifacts: { read: async () => null },
    sessions: { sessionOwner: async (sessionId: SessionId) => owners[sessionId] },
    issues: {
      has: () => true,
      ancestorIds: () => [],
      ownedTarget: () => ({ kind: 'owned' as const, id: 'iss_alpha', owner: OWNER, grants: [] }),
      issueForCwd: () => null,
    },
    machines: {
      defaultMachine: async () => MACHINE,
      // The STORE row's spelling (`id` / `ownerUserId`), which is what
      // `ownershipSnapshotFromMachines` reads. The resolved shape is
      // `machine`/`owner`; getting this wrong makes every machine unknown and
      // every refusal below pass for the wrong reason — catalogue #14.
      ownershipRows: async () => [{ id: MACHINE, ownerUserId: OWNER, name: 'alpha' }],
      grantsForMachine: () => opts?.machineGrants ?? [],
    },
  } as unknown as FileAccessModules

  const repos = { list: async () => roots } as never

  /** The route's port, bound to ONE person — the production shape. */
  const gateFor = (userId: UserId): AssetGateForRequest => {
    const capability = capabilityFor(userId)
    return async () =>
      fileAccessGate(
        modules,
        repos,
        { userId, capability },
        { kind: 'user', user: userId, capability } as unknown as CommandPrincipal,
      )
  }

  const appFor = (userId: UserId): Hono => {
    const app = new Hono()
    registerAssetRoute(app, gateFor(userId))
    return app
  }

  return { appFor, rpcCalls }
}

describe('GET /files/asset — who is asking (PDM-262)', () => {
  describe('the session-addressed arm', () => {
    it('answers the session owner with the bytes', async () => {
      const h = gateHarness()
      const res = await h.appFor(OWNER).request(`/files/asset?sessionId=${TARGET}&path=/w/shot.png`)
      expect(res.status).toBe(200)
      // The payload really is the sensitive one, which is what stops the
      // refusal below from passing against a version that broke the read for
      // everybody (catalogue #10).
      expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('SECRET BYTES')
    })

    it('refuses a GRANTEE — a task grant does not open the session\'s assets (PDM-251)', async () => {
      /**
       * THE RETURN ON SHARING A PREDICATE, MEASURED.
       *
       * PDM-251 landed while this route was being repaired: a session is a
       * PRIVATE resource, owner-only under every scope, so `mayReadSessionOwned`
       * became `mayReadSessionPrivate` and a task grantee stopped reading
       * another member's session files. This route never asked for that change
       * and no line of it was written for this case — it inherited the narrower
       * answer because it calls the same predicate `files.read` does.
       *
       * That is the claim, so it is witnessed here rather than assumed. THE
       * GRANT IS SEEDED, so this refuses a real edge rather than the absence of
       * one; and the owner still reads the same asset under the same fixture,
       * so the refusal cannot be a harness that quietly stopped answering.
       */
      const h = gateHarness({ owners: { [TARGET]: { owner: OWNER, grants: [GRANTEE] } } })
      const res = await h
        .appFor(GRANTEE)
        .request(`/files/asset?sessionId=${TARGET}&path=/w/shot.png`)
      expect(res.status).toBe(404)
      expect(h.rpcCalls).toEqual([])
      // COUNTERFACTUAL, under the same seeded grant.
      const owner = await h
        .appFor(OWNER)
        .request(`/files/asset?sessionId=${TARGET}&path=/w/shot.png`)
      expect(owner.status).toBe(200)
      expect(Buffer.from(await owner.arrayBuffer()).toString()).toBe('SECRET BYTES')
    })

    it('refuses a stranger 404 rather than 403, so the id is not an existence oracle', async () => {
      const h = gateHarness()
      const res = await h
        .appFor(STRANGER)
        .request(`/files/asset?sessionId=${TARGET}&path=/w/shot.png`)
      // 403 here would confirm to anyone holding a session id that it is real.
      expect(res.status).toBe(404)
    })

    it('reaches no daemon for a stranger: the refusal costs the target nothing', async () => {
      const h = gateHarness()
      await h.appFor(STRANGER).request(`/files/asset?sessionId=${TARGET}&path=/w/shot.png`)
      // THE ASSERTION THIS FILE EXISTS FOR. Before the repair this arm called
      // `readAsset` with the caller-supplied session id and returned the bytes.
      expect(h.rpcCalls).toEqual([])
    })

    it('refuses when the session row has NO owner, rather than reading undefined === undefined', async () => {
      const h = gateHarness({ owners: {} })
      const res = await h.appFor(OWNER).request(`/files/asset?sessionId=${TARGET}&path=/w/shot.png`)
      expect(res.status).toBe(404)
      expect(h.rpcCalls).toEqual([])
    })
  })

  describe('the root-addressed arm', () => {
    it('answers someone who may use the machine serving the root', async () => {
      const h = gateHarness()
      const res = await h
        .appFor(OWNER)
        .request(`/files/asset?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(`${ROOT}/a.png`)}`)
      expect(res.status).toBe(200)
      expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('SECRET BYTES')
    })

    it('refuses someone who cannot SEE the machine with 404, not 403', async () => {
      // Containment PASSES here — the root is a registered repository — and the
      // read is still refused. That is the whole distinction the finding names:
      // the path is fine, the person is not.
      //
      // 404 AND NOT 403, and this test asserted 403 until the gate corrected it.
      // `checkMachineVerb` answers `absent` before it considers the verb, so an
      // invisible machine and a never-paired one are ONE answer — otherwise the
      // pair of codes is an existence oracle over somebody else's fleet. The
      // route inherits that rather than choosing its own.
      const h = gateHarness()
      const res = await h
        .appFor(STRANGER)
        .request(`/files/asset?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(`${ROOT}/a.png`)}`)
      expect(res.status).toBe(404)
      expect(h.rpcCalls).toEqual([])
    })

    it('refuses someone who may see but not use the machine with 403, and reads nothing', async () => {
      // The other half of the split, so BOTH codes are witnessed and neither can
      // quietly become the only one the route can produce. A `see` grant makes
      // the machine visible; `use` is still refused.
      const h = gateHarness({ machineGrants: [{ grantee: STRANGER, verb: 'see' }] })
      const res = await h
        .appFor(STRANGER)
        .request(`/files/asset?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(`${ROOT}/a.png`)}`)
      expect(res.status).toBe(403)
      expect(h.rpcCalls).toEqual([])
    })

    it('rejects an unregistered root before reading from the daemon', async () => {
      const h = gateHarness()
      const res = await h
        .appFor(OWNER)
        .request('/files/asset?root=%2F&path=%2Fetc%2Fpasswd')
      expect(res.status).toBe(403)
      expect(h.rpcCalls).toEqual([])
    })

    it('collapses .. BEFORE authorizing, so a crafted prefix cannot escape', async () => {
      // `isAllowedRoot` prefix-matches lexically: `/repos/alpha/../../etc`
      // starts with `/repos/alpha/` and passes it uncollapsed, while the daemon
      // resolves the path to `/etc`.
      const h = gateHarness()
      const res = await h
        .appFor(OWNER)
        .request(
          `/files/asset?root=${encodeURIComponent(`${ROOT}/../../etc`)}&path=${encodeURIComponent('/etc/passwd')}`,
        )
      expect(res.status).toBe(403)
      expect(h.rpcCalls).toEqual([])
    })

    it('forwards the collapsed root, so the authorized root is the one that is read', async () => {
      const h = gateHarness()
      const res = await h
        .appFor(OWNER)
        .request(
          `/files/asset?root=${encodeURIComponent(`${ROOT}/sub/..`)}&path=${encodeURIComponent(`${ROOT}/a.png`)}`,
        )
      expect(res.status).toBe(200)
      expect(h.rpcCalls).toHaveLength(1)
      expect(h.rpcCalls[0]?.input).toMatchObject({ root: ROOT, machineId: MACHINE })
    })

    it('rejects a relative root outright rather than completing it against the server cwd', async () => {
      /**
       * THE ALLOWLIST HERE CONTAINS THE PROCESS CWD, AND THAT IS THE WHOLE TEST.
       *
       * Written the obvious way — a relative root against the `/repos/alpha`
       * fixture — this assertion is INERT, and deleting the `isAbsolute` guard
       * leaves all 26 tests green. `resolve('repos/alpha')` lands under the test
       * runner's cwd, which is not a registered root, so the allowlist refuses
       * it a step later and the test passes for a reason that has nothing to do
       * with the guard it names (catalogue #25: a guard something else makes
       * redundant, and the redundancy is what makes the test inert).
       *
       * It is not redundant in production: the server normally runs FROM a
       * checkout that is itself a registered root, so a relative root resolves
       * INTO an allowed one and the allowlist waves it through. Registering the
       * cwd reproduces that, and then the guard is the only thing refusing.
       * Verified by deletion: with the guard removed this test — and only this
       * test — fails.
       */
      const h = gateHarness({ roots: [process.cwd()] })
      const res = await h
        .appFor(OWNER)
        .request(`/files/asset?root=sub&path=${encodeURIComponent(`${process.cwd()}/sub/a.png`)}`)
      expect(res.status).toBe(403)
      expect(h.rpcCalls).toEqual([])
    })
  })

  /**
   * EVERY READ PATH REFUSES, NOT JUST THE PLAIN ONE.
   *
   * This route has THREE paths to the daemon and they are not one test. The
   * SUFFIX path (`bytes=-N`) issues a ONE-BYTE PROBE READ before it does
   * anything else, purely to learn the file's size; the BOUNDED path
   * (`bytes=A-B`) reads the tentative window first and resolves the range
   * against the size that comes back; only the third is the plain read.
   *
   * A repair that gated the plain path alone would leave `Range: bytes=-1`
   * serving the first byte AND THE TRUE SIZE of anyone's file — and every
   * plain-path test would stay green. This route gates all three by
   * construction, because there is one `read` closure bound before the range is
   * ever considered; the matrix is here so that construction cannot be quietly
   * undone.
   *
   * Raised by PDM-261, who nearly missed it on the sibling route and found the
   * two ranged cases failed SEPARATELY when they restored their defect — not as
   * duplicates of the plain-path case. Both arms, all three paths, and each
   * asserts THE DAEMON WAS NOT REACHED rather than merely that a status came
   * back: a route that reads the bytes and throws on the way out answers 404
   * and has disclosed exactly as much.
   */
  describe('every read path refuses a stranger, and reaches no daemon', () => {
    const paths = [
      ['plain', undefined],
      ['suffix — the one-byte size probe', 'bytes=-3'],
      ['bounded', 'bytes=4-6'],
      ['open-ended', 'bytes=4-'],
    ] as const

    it.each(paths)('session arm, %s', async (_label, range) => {
      const h = gateHarness()
      const res = await h
        .appFor(STRANGER)
        .request(`/files/asset?sessionId=${TARGET}&path=/w/clip.mp4`, {
          ...(range ? { headers: { range } } : {}),
        })
      expect(res.status).toBe(404)
      expect(h.rpcCalls).toEqual([])
    })

    it.each(paths)('root arm, %s', async (_label, range) => {
      const h = gateHarness()
      const res = await h
        .appFor(STRANGER)
        .request(
          `/files/asset?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(`${ROOT}/clip.mp4`)}`,
          { ...(range ? { headers: { range } } : {}) },
        )
      expect(res.status).toBe(404)
      expect(h.rpcCalls).toEqual([])
    })

    it.each(paths)('and the OWNER is served on that same path, %s', async (_label, range) => {
      // The counterfactual, per path. Without it the block above passes against
      // a route that refuses everyone on every range — catalogue #10.
      const h = gateHarness()
      const res = await h
        .appFor(OWNER)
        .request(`/files/asset?sessionId=${TARGET}&path=/w/clip.mp4`, {
          ...(range ? { headers: { range } } : {}),
        })
      expect([200, 206]).toContain(res.status)
      expect(h.rpcCalls.length).toBeGreaterThan(0)
    })
  })

  it('401s when no principal can be resolved for the request', async () => {
    const app = new Hono()
    registerAssetRoute(app, async () => undefined)
    const res = await app.request(`/files/asset?sessionId=${TARGET}&path=/w/shot.png`)
    expect(res.status).toBe(401)
  })
})
