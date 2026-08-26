import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

/**
 * A STANDING SANDBOX TAKES A NEW VERSION IN PLACE (POD-2835).
 *
 * Testing a new version used to mean tearing the sandbox down and running the
 * gate again, which re-provisioned a whole container image to change one
 * binary. That is not only slow, it is the wrong shape: this epic exists to
 * prove a RUNNING install takes a new version in place, so a sandbox that needs
 * rebuilding to change its version is not using the mechanism being proved.
 *
 * These tests cover the parts that must hold before any Docker object is
 * touched — argument handling, and refusing to act on a run that is not there
 * with a message that names it. The product path itself is proven by running
 * it against a real hold; what is pinned here is that the tool cannot be
 * pointed at nothing and quietly appear to work.
 */

const ROOT = join(import.meta.dirname, '..')
const REVISE = join(ROOT, 'scripts/docker-update-e2e-revise.sh')

async function run(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(REVISE, args, {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PODIUM_UPDATE_E2E_PASSWORD: '' },
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

describe('argument handling', () => {
  it('prints usage and succeeds for --help', async () => {
    const { code, stdout } = await run(['--help'])
    expect(code).toBe(0)
    expect(stdout).toContain('--swap-bundle')
  })

  it('refuses to run without a target run', async () => {
    const { code } = await run([])
    expect(code).toBe(2)
  })

  it('refuses a bundle swap that does not say which container to write', async () => {
    // Silently picking one would write over an install nobody named, which is
    // the one operation in this tool that cannot be undone by the updater.
    const { code, stderr } = await run(['--run', 'whatever', '--swap-bundle', '/tmp/x.tar.gz'])
    expect(code).toBe(2)
    expect(stderr).toContain('--into')
  })
})

describe('attaching to a run', () => {
  it('names the run it could not find rather than failing obscurely', async () => {
    const { code, stderr } = await run(['--run', 'podium-update-e2e-does-not-exist-2835'])
    expect(code).not.toBe(0)
    expect(stderr).toContain('podium-update-e2e-does-not-exist-2835')
    // The container name is included because that is what a reader greps the
    // docker output for when the run id alone looks right.
    expect(stderr).toContain('podium-update-e2e-does-not-exist-2835-source')
  })

  it('does not start a gate run as a side effect of sourcing the harness', async () => {
    // The harness is sourced for its helpers. If its `main` ever ran on source,
    // pointing this tool at a missing run would BUILD one — creating containers,
    // an image and a network that nothing here would ever clean up.
    const { stdout, stderr } = await run(['--run', 'podium-update-e2e-does-not-exist-2835'])
    const output = stdout + stderr
    expect(output).not.toContain('provisioning base image')
    expect(output).not.toContain('reusing cached base image')
  })
})

/**
 * THE HOLD HAS TO SAY THIS PATH EXISTS, OR NOBODY FINDS IT.
 *
 * A tool for putting a new version into a standing sandbox is worth nothing if
 * the sandbox's own instructions still read as though tearing it down were the
 * only option. The footer therefore names it.
 *
 * These render the real `print_hold_footer`. The first version of that block
 * interpolated the password hint with `${E2E_PASSWORD:+...}`, and the
 * apostrophe in the hint opened a quote bash never closed: the whole footer
 * died with `bad substitution` at the moment a hold was trying to report
 * itself, taking the URLs and the teardown line with it.
 */
async function footer(password: string): Promise<string> {
  const script = [
    'set -Eeuo pipefail',
    'shopt -s inherit_errexit',
    `source ${JSON.stringify(join(ROOT, 'scripts/docker-update-e2e.sh'))}`,
    'WORK=/tmp/does-not-matter',
    'HOLD_REF=main',
    'TAILNET_HTTPS_PORT=""',
    'print_hold_footer "$(git rev-parse HEAD)"',
  ].join('\n')
  const { stdout } = await promisify(execFile)('bash', ['-c', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PODIUM_UPDATE_E2E_RUN_ID: 'demo-run',
      PODIUM_UPDATE_E2E_PASSWORD: password,
    },
  })
  return stdout
}

describe('the hold footer', () => {
  it('renders whole, and names the revise path, when the run has a password', async () => {
    const text = await footer('secret')
    expect(text).toContain('docker-update-e2e-revise.sh --run demo-run')
    expect(text).toContain('PODIUM_UPDATE_E2E_PASSWORD=')
    // The lines AFTER the new block must survive it; a broken expansion took
    // the teardown command down with it.
    expect(text).toContain('One-line teardown')
  })

  it('renders whole, and omits the password hint, when the run has none', async () => {
    const text = await footer('')
    expect(text).toContain('docker-update-e2e-revise.sh --run demo-run')
    expect(text).not.toContain('PODIUM_UPDATE_E2E_PASSWORD=')
    expect(text).toContain('One-line teardown')
  })
})
