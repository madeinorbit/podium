/**
 * THE ARTIFACT DOWNLOAD ROUTE ASKS WHO IS CALLING [PDM-261].
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT
 * ---------------------------------------------------------------------------
 *
 * `GET /files/artifact/:issueId/:artifactId/*` was registered with
 * `registry.modules.issueArtifacts` — the artifact STORE — and sat behind
 * `clientAuthGuard`. The guard establishes that the caller is signed in. It
 * establishes nothing about whether these bytes are theirs, and a store cannot
 * supply the missing half because an issue id is the only thing it is given. So
 * any member could read any issue's attachments by naming its id, over a
 * transport the tRPC census does not cover.
 *
 * The route's own comment said its auth "matches the rest of /files/*", which
 * is a true sentence about AUTHENTICATION standing where a sentence about
 * authorization should have been — the exact conflation this epic exists to
 * remove.
 *
 * ---------------------------------------------------------------------------
 * WHY BOTH DOORS ARE IN ONE FILE
 * ---------------------------------------------------------------------------
 *
 * `files.read`'s artifact arm and this route serve the SAME bytes of the SAME
 * issue over two transports. PDM-272 repaired the tRPC half; this is the raw
 * half. The claim being made is not "each of them checks something" — two
 * lookalike rules satisfy that and then drift. The claim is that there is ONE
 * rule, `checkIssueAccess` inside `FileAccessGate.readArtifact`, and both doors
 * run it.
 *
 * A claim about identity is only provable by a shared failure, so the fixture
 * below builds ONE `fileAccessGate` and drives BOTH doors through it. Breaking
 * that single `checkIssueAccess` call reddens this file on both sides at once;
 * two independent checks could not do that. It is the same structure, and for
 * the same reason, as `modules/files/queries.authz.test.ts`'s "the two doors
 * onto one session agree".
 *
 * ---------------------------------------------------------------------------
 * WHAT THE NEGATIVES ASSERT
 * ---------------------------------------------------------------------------
 *
 * ABSENCE OF THE EFFECT, not presence of a status (catalogue #19). A route that
 * read the artifact and threw on the way out would answer 404 and still have
 * disclosed nothing less than before. `artifactReads` is the real observation:
 * a refused request must not reach the store at all.
 *
 * AND THE RANGED PATHS TOO (catalogue #10 — negatives must cover the cases the
 * fix is not about). Two of the route's three read paths start with a `Range`
 * header, and the suffix path issues a one-byte PROBE read before anything
 * else. A repair that authorized only the plain path would leave `Range:
 * bytes=-1` serving the first byte of any issue's artifact and reporting its
 * true size — which is disclosure, and would have looked entirely green.
 *
 * THE GATE IS REAL. `fileAccessGate` is constructed, not stubbed; only the
 * modules beneath it are fixtures. Catalogue #20 is explicit that a test which
 * mocks the permission call covers nothing about the permission.
 *
 * THE STRANGER HOLDS NO CAPABILITY OF CONSEQUENCE (catalogue #14). Collapsing
 * them into an admin — whose `scope.kind: 'all'` returns from `checkIssueAccess`
 * before the target is ever read — would assert the artifact rule while never
 * running it. ADMIN is here as its own case, for the opposite reason: without a
 * caller who IS served, a gate that refused everyone would pass every refusal
 * below (catalogue #4, the inert guard).
 */

import { asArtifactId, asIssueId, asUserId, type Capability, type UserId } from '@podium/model'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { CommandPrincipal } from './command-principal'
import { registerArtifactRoute } from './file-artifact-route'
import { type FileAccessModules, fileAccessGate } from './modules/files/file-access-gate'
import { FILE_QUERIES } from './modules/files/queries'
import type { FileState } from './modules/files/registry'

const OWNER = asUserId('u_owner')
/** Neither the owner nor an admin. The only thing that can allow or refuse this
 *  identity is the issue-ownership rule under test. */
const STRANGER = asUserId('u_stranger')
const ADMIN = asUserId('u_admin')

const ISSUE = 'iss_alpha'
const ARTIFACT = 'art_1'
const REL = 'shots/a.png'
const SECRET = 'SECRET ARTIFACT BYTES'
const URL_PATH = `/files/artifact/${ISSUE}/${ARTIFACT}/${REL}`

/**
 * A REAL capability for one person, scoped to what they own.
 *
 * `role` is one of the model's three rather than a plausible-looking literal —
 * an invented role makes `ROLE_ACTIONS[cap.role]` undefined and every case here
 * fails on a TypeError instead of on a decision (catalogue #14).
 */
const workerCapability = (userId: UserId): Capability =>
  ({
    role: 'worker',
    scope: { kind: 'owned', userId },
    onBehalfOf: userId,
  }) as unknown as Capability

/** What a logged-in admin actually carries — `userCommandPrincipal`'s admin arm. */
const adminCapability = (userId: UserId): Capability =>
  ({
    role: 'admin',
    scope: { kind: 'all' },
    actorUser: userId,
    onBehalfOf: userId,
  }) as unknown as Capability

function harness() {
  /** Every touch of the artifact store, in order. A refused read must add
   *  nothing here — that is the assertion this file exists for. */
  const artifactReads: string[] = []

  const modules = {
    rpc: {
      readFile: async () => ({ ok: true }),
      listDir: async () => ({ ok: true }),
      repoOp: async () => ({ ok: true }),
      writeFile: async () => ({ ok: true }),
    },
    issueArtifacts: {
      read: async (
        issueId: string,
        artifactId: string,
        path: string,
        range?: { offset: number; length: number },
      ) => {
        artifactReads.push(
          `${issueId}/${artifactId}/${path}${range ? ` @${range.offset}+${range.length}` : ''}`,
        )
        const bytes = Buffer.from(SECRET)
        return {
          bytes: range ? bytes.subarray(range.offset, range.offset + range.length) : bytes,
          contentType: 'image/png',
          size: bytes.length,
        }
      },
    },
    sessions: { sessionOwner: async () => undefined },
    issues: {
      has: () => true,
      ancestorIds: () => [],
      // The issue belongs to OWNER. A `worker` capability scoped to what SOMEONE
      // ELSE owns is refused by `authorize`'s owned arm; an `admin`'s `all`
      // scope never reaches this at all.
      ownedTarget: () => ({ kind: 'owned' as const, id: ISSUE, owner: OWNER, grants: [] }),
      issueForCwd: () => null,
    },
    machines: {
      defaultMachine: async () => 'm_alpha',
      ownershipRows: async () => [],
      grantsForMachine: () => [],
    },
  } as unknown as FileAccessModules

  const repos = { list: async () => [] } as never

  const gateFor = (userId: UserId, capability: Capability) =>
    fileAccessGate(modules, repos, { userId, capability }, {
      kind: 'user',
      user: userId,
      capability,
    } as unknown as CommandPrincipal)

  /** The RAW HTTP door, bound to one caller — the shape `server.ts` wires. */
  const appFor = (userId: UserId, capability = workerCapability(userId)): Hono => {
    const app = new Hono()
    registerArtifactRoute(app, { doorFor: async () => gateFor(userId, capability) })
    return app
  }

  /** No principal could be resolved from the request at all. */
  const appWithNoPrincipal = (): Hono => {
    const app = new Hono()
    registerArtifactRoute(app, { doorFor: async () => undefined })
    return app
  }

  /** The tRPC door, over the SAME gate, so the two cannot be handed two
   *  different worlds. */
  const fileStateFor = (userId: UserId, capability = workerCapability(userId)): FileState => ({
    files: gateFor(userId, capability),
  })

  return { appFor, appWithNoPrincipal, fileStateFor, artifactReads }
}

const trpcRead = (state: FileState) =>
  FILE_QUERIES.read.run(state, {
    issueId: asIssueId(ISSUE),
    artifactId: asArtifactId(ARTIFACT),
    path: REL,
  } as never)

describe('GET /files/artifact/:issueId/:artifactId/* — authorization [PDM-261]', () => {
  it('serves the caller whose capability covers the issue', async () => {
    // The positive that stops every refusal below from passing against a route
    // that simply broke. The payload really is the sensitive one.
    const h = harness()
    const res = await h.appFor(OWNER).request(URL_PATH)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(SECRET)
    expect(h.artifactReads).toEqual([`${ISSUE}/${ARTIFACT}/${REL}`])
  })

  it('serves an admin, whose scope covers every issue', async () => {
    // Without this the file could not tell "the rule refuses a stranger" from
    // "the gate refuses everybody" (catalogue #4). It is also the shipped case:
    // a browser login carries exactly this capability.
    const h = harness()
    const res = await h.appFor(ADMIN, adminCapability(ADMIN)).request(URL_PATH)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(SECRET)
  })

  it('refuses a member the issue does not belong to, and reads no artifact', async () => {
    const h = harness()
    const res = await h.appFor(STRANGER).request(URL_PATH)
    // 404 AND NOT 403, and that is `checkIssueAccess`'s rule rather than a
    // choice made here: an owned-scope refusal is spelled "unknown issue" so the
    // surface is not an existence oracle over other people's issues. It is the
    // same body and status a genuinely missing artifact gets.
    expect(res.status).toBe(404)
    // THE ASSERTION THIS FILE EXISTS FOR. Before the repair this array held one
    // entry and the response held the bytes.
    expect(h.artifactReads).toEqual([])
  })

  it('refuses a stranger asking for a SUFFIX range, before the probe read', async () => {
    // The suffix path reads one byte to learn the size before it resolves the
    // range. Authorizing only the plain path would leave this serving the first
    // byte of anyone's artifact and reporting its true length.
    const h = harness()
    const res = await h.appFor(STRANGER).request(URL_PATH, { headers: { range: 'bytes=-4' } })
    expect(res.status).toBe(404)
    expect(h.artifactReads).toEqual([])
  })

  it('refuses a stranger asking for a BOUNDED range', async () => {
    const h = harness()
    const res = await h.appFor(STRANGER).request(URL_PATH, { headers: { range: 'bytes=0-3' } })
    expect(res.status).toBe(404)
    expect(h.artifactReads).toEqual([])
  })

  it('answers 401 when no principal can be resolved, and reads no artifact', async () => {
    const h = harness()
    const res = await h.appWithNoPrincipal().request(URL_PATH)
    expect(res.status).toBe(401)
    expect(h.artifactReads).toEqual([])
  })

  it('forwards the byte range through the gate to the store', async () => {
    // The gate grew `range` FOR this route (PDM-261). A gate that accepted the
    // argument and dropped it would return the whole file, the route would then
    // report a content-range it did not serve, and the route's own stub-door
    // tests could not see it because their stub honours whatever it is passed.
    const h = harness()
    const res = await h.appFor(OWNER).request(URL_PATH, { headers: { range: 'bytes=3-6' } })
    expect(res.status).toBe(206)
    expect(await res.text()).toBe(SECRET.slice(3, 7))
    expect(res.headers.get('content-range')).toBe(`bytes 3-6/${SECRET.length}`)
    expect(h.artifactReads).toEqual([`${ISSUE}/${ARTIFACT}/${REL} @3+4`])
  })
})

/**
 * THE ASYMMETRY, PINNED AS ONE FACT.
 *
 * Two transports, one issue, one gate. Asserting them together is what stops
 * them drifting apart again: an edit that re-opens either door reddens a test
 * whose name says both, and a reader sees immediately that the pair is meant to
 * agree. Deleting the `checkIssueAccess` call inside `readArtifact` fails both
 * cases below, which is the evidence that there is one rule here and not two.
 */
describe('the two doors onto one issue artifact agree', () => {
  it('refuses the same stranger through the raw route and through files.read', async () => {
    const h = harness()

    const res = await h.appFor(STRANGER).request(URL_PATH)
    const err = await trpcRead(h.fileStateFor(STRANGER))
      .then(() => undefined)
      .catch((e: unknown) => e as { code?: string })

    expect(res.status).toBe(404)
    expect(err?.code).toBe('NOT_FOUND')
    // Neither refusal reached the store. Before PDM-272 the tRPC entry was here;
    // before this issue, so was the raw one.
    expect(h.artifactReads).toEqual([])
  })

  it('serves the same owner through both doors', async () => {
    const h = harness()
    const res = await h.appFor(OWNER).request(URL_PATH)
    const trpc = await trpcRead(h.fileStateFor(OWNER))
    expect(await res.text()).toBe(SECRET)
    expect(trpc).toMatchObject({ ok: true, content: SECRET })
  })
})
