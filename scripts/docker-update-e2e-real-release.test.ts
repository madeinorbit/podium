import { execFile, execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  desiredParentUnit,
  legacyUnitNames,
} from '@podium/runtime/topology-migration'
import { afterAll, describe, expect, it } from 'vitest'
import { coupleDesktopPairing } from './docker-update-e2e/couple-desktop-pairing'
import { snapshotCandidate, verifyCandidateSnapshot } from './release-candidate-snapshot'
import {
  V0_1_0_DESKTOP_PUBKEY,
  verifyStableBridgeCandidate,
} from './verify-stable-bridge-candidate'

const run = promisify(execFile)
const root = join(import.meta.dirname, '..')
const lane = readFileSync(join(root, 'scripts/docker-update-e2e/real-release-lane.sh'), 'utf8')
const harness = readFileSync(join(root, 'scripts/docker-update-e2e.sh'), 'utf8')
const releaseWorkflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')
const scratch: string[] = []
afterAll(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

/**
 * WHAT THIS PINS, AND WHY IT IS NOT THE GATE ITSELF.
 *
 * The real-release row is the one row whose expectations are about a version
 * nobody works in any more, so nothing in day-to-day development pushes back when
 * they go stale — and the row costs a full gate run to discover that. POD-2747
 * is the precedent: two assertions in this gate had quietly stopped being true and
 * neither could be caught by running it, because each aborted its row first.
 *
 * So the facts that can rot silently are asserted here, in seconds:
 *
 *  - the unit names the row expects after convergence are the ones the topology
 *    module actually produces. A rename would otherwise leave the row asserting
 *    yesterday's names against a host that converged correctly — or, far worse,
 *    passing because it looked for nothing.
 *  - the refusal text the row greps for is the text the OLD release emits, read
 *    out of the tag rather than remembered.
 *  - the feed prefixes the row serves are the paths the OLD release fetches.
 *  - the trust-root substitution refuses everything except its one exact site.
 */

function fromTag(path: string): string {
  return execFileSync('git', ['show', `v0.1.0:${path}`], { cwd: root, encoding: 'utf8' })
}

describe('real-release row expectations still match the code they describe', () => {
  it('keeps both shell entry points syntactically valid', () => {
    execFileSync('bash', ['-n', join(root, 'scripts/docker-update-e2e.sh')])
    execFileSync('bash', ['-n', join(root, 'scripts/docker-update-e2e/real-release-lane.sh')])
  })

  it('expects the unit names the topology module actually produces for a default install', () => {
    // The row is the DEFAULT instance on purpose (see the lane header), so these
    // are the default-instance names.
    expect(lane).toContain(`REAL_PARENT_UNIT=${desiredParentUnit('default')}`)
    const legacy = legacyUnitNames('default')
    for (const role of ['server', 'daemon', 'janitor']) {
      expect(legacy).toContain(`podium-${role}.service`)
    }
    // `real_legacy_unit` builds exactly that shape.
    expect(lane).toContain(`printf 'podium-%s.service' "$1"`)
  })

  it('greps for the refusal string v0.1.0 actually emits', () => {
    const resolver = fromTag('apps/server/src/modules/updates/release-target.ts')
    // The pairing gate the row proves: exact version equality between the two
    // manifests, refused with this sentence.
    expect(resolver).toContain('desktop build for')
    expect(resolver).toContain('desktop.version !== target.version')
    expect(lane).toContain("grep -Fq 'desktop build for'")
  })

  it('reads the refusal where v0.1.0 records it', () => {
    const service = fromTag('apps/server/src/modules/updates/service.ts')
    expect(service).toContain("{ status: 'unavailable'; reason: string }")
    expect(lane).toContain('.outcome.status=="unavailable"')
    expect(lane).toContain('.outcome.reason')
  })

  it('reads the headless-only row where CURRENT code records the outcome', () => {
    // The one row in this lane that asks about current code rather than v0.1.0,
    // so it is the one whose field names rot against THIS checkout instead of
    // against a tag. `unavailable` is how the silent stranding was recorded, so
    // the row's whole claim is that the status stays `ok`.
    const service = readFileSync(
      join(root, 'apps/server/src/modules/updates/service.ts'),
      'utf8',
    )
    expect(service).toContain("{ status: 'ok' } | { status: 'unavailable'; reason: string }")
    expect(lane).toContain('.outcome.status // ""')
    expect(lane).toContain('real_headless_only_is_offered')
  })

  it('requires a check recorded AFTER the deletion, not a surviving one', () => {
    // The first armed run went green with the coupling restored, which is
    // impossible if the row were reading a fresh check -- `updates.checkNow`
    // rate-limits to one feed request per channel per 30s and returns the
    // RECORDED outcome inside that window, so the poll could be answered from
    // before the row deleted anything. A row that cannot tell "we looked and it
    // is fine" from "we have not looked yet" is the defect under test wearing a
    // test's clothes.
    const service = readFileSync(join(root, 'apps/server/src/modules/updates/service.ts'), 'utf8')
    expect(service).toContain('checkedAt')
    expect(service).toMatch(/FORCED_CHECK_INTERVAL_MS = 30_000/)
    expect(lane).toContain('REAL_STABLE_CHECK_BASELINE')
    expect(lane).toContain('(( at > REAL_STABLE_CHECK_BASELINE )) || return 1')
  })

  it('deletes the desktop manifest and proves the deletion before asserting on it', () => {
    // A row that removes a file and then asserts a green is only worth something
    // if the removal actually reached the thing under test. Without the probe
    // this row would pass just as happily against a feed that never stopped
    // serving latest.json.
    expect(lane).toContain('rm -f /work/source/dist-bun/release/latest.json')
    expect(lane).toMatch(/if container_http_probe "\$REAL_CONSUMER" GET \\\n\s+"[^"]*latest\.json"/)
  })

  it('arms the pairing control against the condition the resolver actually has', () => {
    // The control rewrites one exact line of release-target.ts. If that line is
    // reworded, the control dies loudly -- but only for whoever runs the gate
    // with it armed, which is rare and expensive. This says so in seconds, and
    // it is the difference between a red row nobody can reproduce and a red row
    // that names its own cause.
    const resolver = readFileSync(
      join(root, 'apps/server/src/modules/updates/release-target.ts'),
      'utf8',
    )
    expect(coupleDesktopPairing(resolver).occurrences).toBe(1)
    // Red alone is not the claim; red NAMING the desktop manifest is.
    expect(lane).toContain("grep -Fq 'desktop manifest'")
  })

  it('runs the coupling control through a login shell, with the HOST’s script', () => {
    // Both halves are mistakes this lane has already paid for once each.
    // `container_exec` runs `docker exec` directly, so `bun` is not on PATH
    // without `-l`; and `/work/source` holds whatever ref the run selected,
    // which is not necessarily the copy this control was written against.
    expect(lane).toMatch(/docker cp "\$ROOT\/scripts\/docker-update-e2e\/couple-desktop-pairing\.ts"/)
    expect(lane).toContain('bash -lc \\\n')
    expect(lane).not.toContain('/work/source/scripts/docker-update-e2e/couple-desktop-pairing.ts')
  })

  it('scopes each deliberate-failure check to the row that control targets', () => {
    // The convergence check read `-n "$PROVE_FAILURE"` while migration was the
    // only control, so "a control is armed" and "convergence must go red" were
    // the same statement. A second control broke that: it targets the RESOLVER
    // and leaves convergence correctly green, which the unscoped check called a
    // failure -- reddening a row that had done its job and skipping the row the
    // control was actually arming.
    expect(lane).toContain('if [[ "$PROVE_FAILURE" == real-release-migration &&')
    expect(lane).not.toMatch(/if \[\[ -n "\$PROVE_FAILURE" && "\$\{RESULT\[real-release-converged\]/)
    // …and the pairing control names its own row rather than borrowing that one.
    expect(lane).toContain('[[ "$PROVE_FAILURE" == real-release-pairing-coupled ]] || return 1')
  })

  it('does not claim release.ts silently ignores an option it cannot read', () => {
    // This comment asserted the opposite until POD-2800 landed a strict parser,
    // and nothing pushed back: a stale comment is a confident claim about a
    // world that moved, and it cost the next reader more than a missing one
    // would. The pin is on the PROPERTY, not the wording, so it survives an
    // edit but not a reversal.
    const release = readFileSync(join(root, 'scripts/release.ts'), 'utf8')
    expect(release).toMatch(/unknown option/)
    expect(lane).not.toMatch(/parses `--channel` by exact\s+#?\s*argv match/)
    expect(lane).not.toMatch(/is silently ignored and builds/)
  })

  it('serves the feed paths a v0.1.0 stable install fetches', () => {
    const resolver = fromTag('apps/server/src/modules/updates/release-target.ts')
    expect(resolver).toContain('${RELEASE_BASE}/latest/download/podium-update.json')
    expect(resolver).toContain('${RELEASE_BASE}/latest/download/latest.json')
    // Both manifests live under this one directory, so the row must serve it.
    expect(lane).toContain('/madeinorbit/podium/releases/latest/download/')
  })

  it('carries the trust root v0.1.0 actually baked', () => {
    const delivery = fromTag('packages/runtime/src/update-delivery.ts')
    const match = delivery.match(/PODIUM_UPDATE_PUBKEY = '([^']+)'/)
    expect(match).not.toBeNull()
    const baked = match![1]!
    expect(lane).toContain(`REAL_RELEASE_PUBKEY='${baked}'`)
    // An Ed25519 SPKI DER is 44 bytes, so its base64 is 60 characters — which is
    // what makes the in-place substitution safe.
    expect(baked).toHaveLength(60)
  })

  it('carries the desktop updater key the published v0.1.0 shell actually baked', () => {
    const config = JSON.parse(fromTag('apps/desktop/src-tauri/tauri.conf.json')) as {
      plugins: { updater: { pubkey: string } }
    }
    expect(V0_1_0_DESKTOP_PUBKEY).toBe(config.plugins.updater.pubkey)
    expect(Buffer.from(V0_1_0_DESKTOP_PUBKEY, 'base64').toString('utf8')).toContain(
      'minisign public key',
    )
    const shippedLock = fromTag('apps/desktop/src-tauri/Cargo.lock')
    expect(shippedLock).toMatch(/name = "minisign-verify"\nversion = "0\.2\.5"/)
    const verifierManifest = readFileSync(
      join(root, 'scripts/stable-candidate-minisign/Cargo.toml'),
      'utf8',
    )
    expect(verifierManifest).toContain('minisign-verify = "=0.2.5"')
  })

  it('serves the feed with the HOST script, not whatever ref the source checkout is on', () => {
    // `/work/source` is HEAD normally and HOLD_REF in hold mode, so the copy of
    // edge-feed.ts in there is not necessarily the one this lane needs. A hold run
    // served the epic branch's copy, which knows only the rolling `edge` directory,
    // and every stable URL 404'd.
    expect(lane).not.toContain('/work/source/scripts/docker-update-e2e/edge-feed.ts')
    expect(lane).toMatch(/docker cp "\$ROOT\/scripts\/docker-update-e2e\/edge-feed\.ts"/)
  })

  it('proves the feed reaches the consumer before blaming the old resolver', () => {
    // Otherwise a harness fault reads as a product finding.
    expect(lane).toContain('the run-local stable feed never served podium-update.json')
  })

  it('installs the DEFAULT instance, because a released 0.1.0 cannot complete a named one', () => {
    // Guarding the reason rather than the symptom: a later edit that reintroduces
    // `--instance` would reintroduce the adoption wedge and the port divergence
    // the lane header explains.
    expect(lane).not.toMatch(/install\.sh --instance/)
    expect(lane).toContain('REAL_STATE=/home/podium/.podium')
  })

  it('activates v0.1.0 before logging in to the password it stored at setup', () => {
    // setup.complete changes boot-relevant mode/persistence. v0.1.0 therefore
    // reports activation_pending and returns 503 from /auth/login until a new
    // process adopts the config; /health stays green throughout and cannot be
    // the wait. This is a readiness transition, not a no-password exception.
    const setup = lane.slice(
      lane.indexOf('real_release_setup()'),
      lane.indexOf('# WHAT AN INSTALL OF THIS ERA REALLY LOOKS LIKE'),
    )
    expect(setup).toContain('real_data_plane_available')
    // The URL lives in the helper, not inline here. Assert it THERE, so this
    // still proves the wait is on the readiness contract rather than /health —
    // which stays green while the data plane is blocked and would wait on
    // nothing.
    const probe = lane.slice(
      lane.indexOf('real_data_plane_available()'),
      lane.indexOf('real_version_is()'),
    )
    expect(probe).toContain('GET "http://127.0.0.1:18787/readiness"')
    expect(probe).toContain('dataPlane=="available"')
    expect(setup.indexOf('real_exec "$REAL_COMMAND"')).toBeLessThan(
      setup.indexOf('real_data_plane_available'),
    )
    expect(setup.indexOf('real_data_plane_available')).toBeLessThan(
      setup.indexOf('e2e_login "$REAL_CONSUMER"'),
    )
    expect(setup).not.toContain('acknowledgeNoPassword')
  })

  it('keeps the production signing secret out of prepared-candidate mode', () => {
    expect(harness).toContain('the prepared-candidate proof refuses PODIUM_UPDATE_SIGNING_KEY')
    const proof = releaseWorkflow.slice(
      releaseWorkflow.indexOf('Prove the stable candidate from published v0.1.0'),
      releaseWorkflow.indexOf('Preserve stable bridge proof evidence'),
    )
    expect(proof).toContain('PODIUM_UPDATE_E2E_REAL_TARGET_DIR=')
    expect(proof).not.toContain('PODIUM_UPDATE_SIGNING_KEY')
    expect(proof).toContain('PODIUM_UPDATE_E2E_REAL_DESKTOP_VERIFIER=')
    expect(lane).toContain('No private key enters this')
  })

  it('proves and seals the complete candidate before the named publish boundary', () => {
    const prepare = releaseWorkflow.indexOf('Prepare the complete stable candidate')
    const seal = releaseWorkflow.indexOf('Seal the stable candidate bytes')
    const proof = releaseWorkflow.indexOf('Prove the stable candidate from published v0.1.0')
    const publish = releaseWorkflow.indexOf('Publish one multi-platform release')
    expect(prepare).toBeGreaterThan(-1)
    expect(seal).toBeGreaterThan(prepare)
    expect(proof).toBeGreaterThan(seal)
    expect(publish).toBeGreaterThan(proof)
    expect(releaseWorkflow.slice(proof, publish)).not.toMatch(/gh release (create|upload)/)
  })

  it('mounts the accepted candidate read-only and installs unmodified v0.1.0', () => {
    expect(harness).toContain('"$REAL_TARGET_DIR:$REAL_CANDIDATE_ROOT:ro"')
    const bootstrap = lane.slice(
      lane.indexOf('prepare_real_release_bootstrap()'),
      lane.indexOf('# ---------------------------------------------------------------------------\n# 3.'),
    )
    expect(bootstrap).toContain('REAL_PRODUCTION_CANDIDATE == 1')
    expect(bootstrap).toContain('kept the published $REAL_RELEASE_TAG installer and binary bytes unchanged')
    const install = lane.slice(lane.indexOf('install_real_release()'), lane.indexOf('real_release_setup()'))
    const productionBranch = install.slice(
      install.indexOf('REAL_PRODUCTION_CANDIDATE == 1'),
      install.indexOf('else'),
    )
    expect(productionBranch).not.toContain('PODIUM_INSTALL_PUBKEY')
    expect(harness).toContain(
      '( "$ONLY" == real-release && "$REAL_PRODUCTION_CANDIDATE" == 0 )',
    )
  })
})

describe('patch-trust-root refuses everything but its one exact site', () => {
  const script = join(root, 'scripts/docker-update-e2e/patch-trust-root.ts')
  const oldKey = 'MCowBQYDK2VwAyEAG12/153QJI/SePyYeJQhBSbh1ZsFgkoMkwb823NiYOU='
  const newKey = 'MCowBQYDK2VwAyEAfsqq4y1gWrYABY5StaANv24V+7mTaR8IL2JZNVHaQyo='

  function fixture(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'podium-trust-root-'))
    scratch.push(dir)
    const file = join(dir, 'binary')
    writeFileSync(file, body)
    return file
  }

  it('substitutes one occurrence and changes nothing outside it', async () => {
    const file = fixture(`before${oldKey}after`)
    const { stdout } = await run('bun', [script, file, oldKey, newKey])
    const report = JSON.parse(stdout)
    expect(report.occurrences).toBe(1)
    expect(report.sizeUnchanged).toBe(true)
    expect(report.changedInsideConstant).toBe(true)
    expect(report.changedBytes).toBeLessThanOrEqual(oldKey.length)
    expect(readFileSync(file, 'utf8')).toBe(`before${newKey}after`)
  })

  it('refuses when the constant is absent', async () => {
    const file = fixture('no key here')
    await expect(run('bun', [script, file, oldKey, newKey])).rejects.toThrow(/found 0/)
    expect(readFileSync(file, 'utf8')).toBe('no key here')
  })

  it('refuses when the constant appears more than once', async () => {
    const file = fixture(`${oldKey}${oldKey}`)
    await expect(run('bun', [script, file, oldKey, newKey])).rejects.toThrow(/found 2/)
  })

  it('refuses a replacement of a different length, which would move every offset', async () => {
    const file = fixture(`x${oldKey}y`)
    await expect(run('bun', [script, file, oldKey, 'short'])).rejects.toThrow(/differ in length/)
  })
})

describe('prepared stable bridge candidate', () => {
  function candidate() {
    const dir = mkdtempSync(join(tmpdir(), 'podium-stable-bridge-'))
    scratch.push(dir)
    const version = '0.1.1'
    const tag = `v${version}`
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const pubkey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const headless: Record<string, { url: string; signature: string; digest: string }> = {}
    for (const [platform, name, body] of [
      ['linux-x86_64', 'podium-headless-linux-x64.tar.gz', 'x64 candidate'],
      ['linux-aarch64', 'podium-headless-linux-arm64.tar.gz', 'arm64 candidate'],
    ] as const) {
      const bytes = Buffer.from(body)
      const signature = sign(null, bytes, privateKey).toString('base64')
      writeFileSync(join(dir, name), bytes)
      writeFileSync(join(dir, `${name}.sig`), signature)
      headless[platform] = {
        url: `https://github.com/madeinorbit/podium/releases/download/${tag}/${name}`,
        signature,
        digest: `sha256-${createHash('sha256').update(bytes).digest('base64')}`,
      }
    }
    const desktopName = 'Podium_0.1.1_amd64.AppImage'
    const desktopPublicKey = `untrusted comment: minisign public key E7620F1842B4E81F
RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3`
    const desktopSignature = `untrusted comment: signature from minisign secret key
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=
trusted comment: timestamp:1556193335\tfile:test
y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==`
    writeFileSync(join(dir, desktopName), 'test')
    writeFileSync(join(dir, `${desktopName}.sig`), desktopSignature)
    writeFileSync(
      join(dir, 'podium-update.json'),
      JSON.stringify({
        version,
        platforms: Object.fromEntries(
          Object.entries(headless).map(([platform, value]) => [
            platform,
            { url: value.url, signature: value.signature },
          ]),
        ),
        artifacts: { headless: { delivery: 'feed', platforms: headless } },
      }),
    )
    writeFileSync(
      join(dir, 'latest.json'),
      JSON.stringify({
        version,
        platforms: {
          'linux-x86_64': {
            url: `https://github.com/madeinorbit/podium/releases/download/${tag}/${desktopName}`,
            signature: desktopSignature,
          },
        },
      }),
    )
    const verifyDesktop = (artifact: string, signaturePath: string) => {
      execFileSync(
        'cargo',
        [
          'run',
          '--quiet',
          '--locked',
          '--manifest-path',
          join(root, 'scripts/stable-candidate-minisign/Cargo.toml'),
          '--',
          desktopPublicKey,
          artifact,
          signaturePath,
        ],
        { stdio: 'pipe' },
      )
    }
    return { dir, version, tag, pubkey, verifyDesktop }
  }

  it('accepts a matching pair only after every referenced prepared artifact is present', () => {
    const fixture = candidate()
    expect(verifyStableBridgeCandidate(fixture)).toEqual({
      headlessArtifacts: 2,
      desktopArtifacts: 1,
    })
  })

  it('refuses a desktop signature string without cryptographic verification', () => {
    const fixture = candidate()
    const { verifyDesktop: _, ...unverified } = fixture
    expect(() => verifyStableBridgeCandidate(unverified)).toThrow(/desktop updater key/)
  })

  it('refuses one tampered headless platform even when the runnable x64 candidate is valid', () => {
    const fixture = candidate()
    writeFileSync(join(fixture.dir, 'podium-headless-linux-arm64.tar.gz'), 'tampered')
    expect(() => verifyStableBridgeCandidate(fixture)).toThrow(/linux-aarch64.*not signed/)
  })

  it('refuses a desktop manifest from a different release', () => {
    const fixture = candidate()
    const path = join(fixture.dir, 'latest.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version: string }
    writeFileSync(path, JSON.stringify({ ...manifest, version: '0.1.0' }))
    expect(() => verifyStableBridgeCandidate(fixture)).toThrow(/must both name 0\.1\.1/)
  })

  it('refuses a referenced desktop artifact whose prepared bytes are absent', () => {
    const fixture = candidate()
    const path = join(fixture.dir, 'latest.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      platforms: Record<string, { url: string; signature: string }>
    }
    manifest.platforms['linux-x86_64']!.url =
      `https://github.com/madeinorbit/podium/releases/download/${fixture.tag}/missing.AppImage`
    writeFileSync(path, JSON.stringify(manifest))
    expect(() => verifyStableBridgeCandidate(fixture)).toThrow(/missing artifact/)
  })

  it('refuses desktop bytes that do not match their genuine minisign signature', () => {
    const fixture = candidate()
    writeFileSync(join(fixture.dir, 'Podium_0.1.1_amd64.AppImage'), 'Test')
    expect(() => verifyStableBridgeCandidate(fixture)).toThrow(/desktop linux-x86_64.*not signed/)
  })

  it('seals the accepted directory so publish cannot substitute later bytes', () => {
    const fixture = candidate()
    const snapshotDir = mkdtempSync(join(tmpdir(), 'podium-candidate-seal-'))
    scratch.push(snapshotDir)
    const snapshot = join(snapshotDir, 'snapshot.json')
    writeFileSync(snapshot, JSON.stringify(snapshotCandidate(fixture.dir)))
    verifyCandidateSnapshot(fixture.dir, snapshot)
    writeFileSync(join(fixture.dir, 'podium-headless-linux-x64.tar.gz'), 'substituted')
    expect(() => verifyCandidateSnapshot(fixture.dir, snapshot)).toThrow(
      /changed after its v0\.1\.0 acceptance proof/,
    )
  })
})

describe('coupleDesktopPairing refuses anything but its one exact site', () => {
  const decoupled =
    'if (feed.desktopManifestUrl && (minimumShell !== undefined || minimumBridge !== undefined)) {'

  it('restores the coupled condition and removes the decoupled one', () => {
    const { source, occurrences } = coupleDesktopPairing(`a\n  ${decoupled}\nb`)
    expect(occurrences).toBe(1)
    expect(source).toContain('if (feed.desktopManifestUrl) {')
    expect(source).not.toContain(decoupled)
  })

  it('refuses when the condition is absent', () => {
    // The case that matters: a control which silently matched nothing would
    // leave the row GREEN under a deliberate-failure run, and a green row there
    // reads as "this row cannot be armed".
    expect(() => coupleDesktopPairing('no condition here')).toThrow(/found 0/)
  })

  it('refuses when the condition appears more than once', () => {
    expect(() => coupleDesktopPairing(`${decoupled}\n${decoupled}`)).toThrow(/found 2/)
  })
})
