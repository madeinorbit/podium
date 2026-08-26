import { execFile } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * THE BASE IMAGE IS CONTENT-ADDRESSED SO A SECOND RUN DOES NO APT WORK (POD-2835).
 *
 * `prepare_image` never used `docker build`, so it never had a layer cache: it
 * provisioned a bare `ubuntu:24.04` and `docker commit`-ed the result to a tag
 * unique per run, which cleanup then deleted. 635 lines of apt output, on every
 * single run, by construction — nothing was reusable even in principle.
 *
 * The provisioned layer is now tagged by a hash of everything that can change
 * what it contains, and rebuilt only when that tag is absent. These tests pin
 * the hash inputs, because a hash that misses an input is WORSE than no cache:
 * it serves a stale image that no longer matches the provisioning that named it.
 *
 * `HOST_UID`/`HOST_GID` are inputs because provisioning bakes ownership in —
 * `provision.sh` takes them as $1 and $2 and creates the `podium` account from
 * them. A cache keyed without them would hand a second user an image whose
 * bind-mounted evidence they cannot write.
 *
 * Nothing here starts Docker. These drive the real script's own functions by
 * sourcing it, which the harness supports (its `main` runs only when executed).
 */

const ROOT = join(import.meta.dirname, '..')
const GATE = join(ROOT, 'scripts/docker-update-e2e.sh')
const PROVISION = join(ROOT, 'scripts/docker-update-e2e/provision.sh')

const scratch = mkdtempSync(join(tmpdir(), 'pod-2835-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Source the harness and run bash against its own functions. */
async function bash(snippet: string, env: Record<string, string> = {}): Promise<string> {
  const script = `set -Eeuo pipefail\nshopt -s inherit_errexit\nsource ${JSON.stringify(GATE)}\n${snippet}\n`
  const { stdout } = await promisify(execFile)('bash', ['-c', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return stdout.trim()
}

/**
 * The tag the harness would compute under one set of inputs. Overriding the
 * variables after sourcing is exactly how `prepare_image` reads them, so this
 * asks the real function rather than reimplementing its recipe.
 */
async function tagFor(
  overrides: { uid?: string; gid?: string; base?: string; provision?: string } = {},
): Promise<string> {
  const assignments = [
    overrides.uid === undefined ? '' : `HOST_UID=${JSON.stringify(overrides.uid)}`,
    overrides.gid === undefined ? '' : `HOST_GID=${JSON.stringify(overrides.gid)}`,
    overrides.base === undefined ? '' : `BASE_OS_IMAGE=${JSON.stringify(overrides.base)}`,
    overrides.provision === undefined
      ? ''
      : `PROVISION_SCRIPT=${JSON.stringify(overrides.provision)}`,
  ].filter(Boolean)
  return bash(`${assignments.join('\n')}\nbase_image_tag`)
}

describe('the cached base image tag', () => {
  it('is stable across two computations with identical inputs', async () => {
    const first = await tagFor({ uid: '1000', gid: '1000' })
    const second = await tagFor({ uid: '1000', gid: '1000' })
    expect(first).toBe(second)
    expect(first).not.toBe('')
  })

  it('is shared rather than run-scoped, so a later run can find it', async () => {
    // The whole point: the tag must not carry $RUN_ID, or it is unfindable by
    // construction — which is the defect this issue exists to remove.
    // Both values come from ONE shell: RUN_ID embeds $$, so a second bash would
    // report a different run and the comparison would pass for the wrong reason.
    const [tag, runId] = (
      await bash('HOST_UID=1000\nHOST_GID=1000\nbase_image_tag\nprintf "%s\\n" "$RUN_ID"')
    ).split('\n')
    expect(tag).not.toContain(runId)
    expect(tag).toContain('podium-update-e2e-base')
  })

  it('changes when provision.sh changes by a single byte', async () => {
    const copy = join(scratch, 'provision-copy.sh')
    copyFileSync(PROVISION, copy)
    const before = await tagFor({ uid: '1000', gid: '1000', provision: copy })
    writeFileSync(copy, `${readFileSync(copy, 'utf8')}#`)
    const after = await tagFor({ uid: '1000', gid: '1000', provision: copy })
    expect(after).not.toBe(before)
  })

  it('changes when the invoking user changes, because provisioning bakes ownership in', async () => {
    const base = await tagFor({ uid: '1000', gid: '1000' })
    expect(await tagFor({ uid: '1001', gid: '1000' })).not.toBe(base)
    expect(await tagFor({ uid: '1000', gid: '1001' })).not.toBe(base)
  })

  it('changes when the base OS image changes', async () => {
    const base = await tagFor({ uid: '1000', gid: '1000', base: 'ubuntu:24.04' })
    expect(await tagFor({ uid: '1000', gid: '1000', base: 'ubuntu:26.04' })).not.toBe(base)
  })
})

describe('the run-scoped image tag', () => {
  it('stays run-scoped so cleanup can keep asserting no owned object remains', async () => {
    // Cleanup's strictness is load-bearing and must not be traded for the cache.
    // IMAGE is still unique per run; the cached base is merely tagged INTO it,
    // and removing one of two tags on a shared image id removes only that tag.
    const [image, runId] = (await bash('printf "%s\\n%s\\n" "$IMAGE" "$RUN_ID"')).split('\n')
    expect(image).toBe(`${runId}:ubuntu24`)
  })

  it('is a different name from the cached base, so cleanup cannot delete the cache', async () => {
    const [image, cached] = (
      await bash('HOST_UID=1000\nHOST_GID=1000\nprintf "%s\\n" "$IMAGE"\nbase_image_tag')
    ).split('\n')
    expect(image).not.toBe(cached)
  })
})
