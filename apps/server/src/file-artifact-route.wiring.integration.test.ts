/**
 * THE ARTIFACT ROUTE'S WIRING, ON A REAL SERVER [PDM-261].
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM `file-artifact-route.authz.test.ts`
 * ---------------------------------------------------------------------------
 *
 * That file proves the ROUTE asks the gate, by handing it a real gate. It can
 * prove nothing about whether `server.ts` hands it one — it calls
 * `registerArtifactRoute` itself. So the composition root is the one part of
 * this repair no unit test can witness, and it is the part carrying the
 * regression risk: `doorFor` answers `undefined` when no principal resolves,
 * and the route turns that into 401. If `requestPrincipal` declines to name a
 * principal for an ordinary host-local request on a single-machine install —
 * the shipped default, where nobody has set a password — then every artifact
 * download stops working and every unit test in this repair stays green.
 *
 * `transport-compression.integration.test.ts` fetches this route too, but it
 * cannot answer the question: at the time of writing it fails upstream of its
 * own artifact assertions (the `/mobile/` shell's content-encoding, line 336),
 * on the branch point as well as here, so those lines never execute. That is
 * catalogue #2 — a test that dies before its own assertion — and relying on it
 * would have been relying on coverage that is absent rather than red.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM. It does not re-prove the
 * authorization rule; it has one principal, the open-mode first admin, whose
 * `scope.kind` is `all`. The refusal is proved over a real `fileAccessGate`
 * with three distinct identities in `file-artifact-route.authz.test.ts`, which
 * is where a second member can be constructed cheaply. This file's whole claim
 * is that the composition root resolves a caller and the bytes come back.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { noJanitorWorkerForTests } from './janitor-host'
import { type ServerHandle, startServer } from './server'
import { defaultDbPath } from './store'

const ISSUE = 'wiring-proof-issue'
const ARTIFACT = 'wiring-proof-artifact'
const BODY = 'artifact-wiring-proof-bytes'

const priorStateDir = process.env.PODIUM_STATE_DIR
const priorMode = process.env.PODIUM_MODE

describe('GET /files/artifact/… on a real server [PDM-261]', () => {
  let stateDir: string
  let server: ServerHandle

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-artifact-wiring-'))
    process.env.PODIUM_STATE_DIR = stateDir
    // `/files/*` sits behind the readiness boundary, which blocks the DATA
    // PLANE until this process has adopted a mode. An unconfigured fixture
    // answers 503 to every request here — a refusal about boot state that has
    // nothing to say about authorization, and one that would have made the two
    // cases below pass and fail together for a reason neither names.
    process.env.PODIUM_MODE = 'all-in-one'
    const artifactDir = join(stateDir, 'artifacts', ISSUE, ARTIFACT)
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(join(artifactDir, 'proof.txt'), BODY)
    server = await startServer({
      dbPath: defaultDbPath(),
      janitorWorkerForTests: noJanitorWorkerForTests,
      port: 0,
    })
  })

  afterAll(async () => {
    await server.close()
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    if (priorMode === undefined) delete process.env.PODIUM_MODE
    else process.env.PODIUM_MODE = priorMode
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('serves the bytes to a host-local caller in open mode', async () => {
    // The whole chain: clientAuthGuard passes, `requestPrincipal` names the
    // first admin, `doorFor` builds that caller's gate, `checkIssueAccess`
    // allows an `all` scope, and the store answers. A 401 here is the wiring
    // regression this file exists to catch; a 404 would mean the gate was built
    // but refused, which is a different bug with a different fix.
    const res = await fetch(
      `http://127.0.0.1:${server.port}/files/artifact/${ISSUE}/${ARTIFACT}/proof.txt`,
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(BODY)
  })

  it('still 404s an artifact that is not there, rather than refusing it', async () => {
    // The other half of the same wiring: a resolvable caller whose read simply
    // finds nothing must reach the store and come back empty-handed. Without
    // this, a `doorFor` that refused everything would satisfy the case above
    // only by accident of it being the one file that exists.
    const res = await fetch(
      `http://127.0.0.1:${server.port}/files/artifact/${ISSUE}/${ARTIFACT}/absent.txt`,
    )
    expect(res.status).toBe(404)
  })
})
