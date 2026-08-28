import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  breakableEntry,
  parseAdmissionArgs,
  probeEnv,
  unleasedRefusal,
  workspaceSourceFile,
} from './global-store-cache-admission'
import { shouldAcquireValidationLease, VALIDATION_HELD_ENV } from './validation-admission'

const source = '/home/agent/podium'

describe('parseAdmissionArgs', () => {
  const args = [
    '--cache-root',
    '/cache/podium/admission',
    '--scratch-parent',
    '/cache/podium/admission-worktrees',
    '--run-id',
    'flatblock-2026-08-25',
    '--output',
    'evidence/admission.json',
  ]

  it('resolves every path so nothing lands relative to a worktree', () => {
    const options = parseAdmissionArgs(args, source)
    expect(options.cacheRoot).toBe('/cache/podium/admission')
    expect(options.output.startsWith('/')).toBe(true)
    expect(options.runId).toBe('flatblock-2026-08-25')
    expect(options.sourceRoot).toBe(source)
  })

  it('checks the commit under test at HEAD unless told otherwise', () => {
    expect(parseAdmissionArgs(args, source).ref).toBe('HEAD')
    expect(parseAdmissionArgs([...args, '--ref', 'abc1234'], source).ref).toBe('abc1234')
  })

  it('defaults the representative package but lets a host override it', () => {
    expect(parseAdmissionArgs(args, source).testPackage).toBe('@podium/composer')
    expect(
      parseAdmissionArgs([...args, '--test-package', '@podium/telemetry'], source).testPackage,
    ).toBe('@podium/telemetry')
  })

  it('accepts --flag=value as well as --flag value', () => {
    const inline = parseAdmissionArgs(
      ['--cache-root=/c', '--scratch-parent=/s', '--run-id=r', '--output=/o.json'],
      source,
    )
    expect(inline).toMatchObject({ cacheRoot: '/c', scratchParent: '/s', runId: 'r' })
  })
})

describe('breakableEntry', () => {
  const installed = ['.bin', '.bun', '@podium', '@types', 'left-pad', 'turbo', 'typescript']

  it('never sacrifices a package the refusal itself has to load', () => {
    // Breaking turbo or typescript would crash the run instead of refusing it, and a
    // crash is not evidence that admission said no.
    expect(breakableEntry(installed)).toBe('left-pad')
    expect(breakableEntry(['.bin', 'turbo', 'typescript', 'vitest'])).toBeNull()
  })

  it('is deterministic across two hosts that installed the same lockfile', () => {
    expect(breakableEntry(['zod', 'left-pad', 'acorn'])).toBe(
      breakableEntry(['acorn', 'zod', 'left-pad']),
    )
  })
})

describe('workspaceSourceFile', () => {
  const scratch: string[] = []
  afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
  })

  function repository(): string {
    const root = mkdtempSync(join(tmpdir(), 'podium-admission-source-'))
    scratch.push(root)
    writeFileSync(join(root, 'package.json'), '{"private":true,"workspaces":["packages/*"]}\n')
    mkdirSync(join(root, 'packages/composer/src'), { recursive: true })
    writeFileSync(join(root, 'packages/composer/package.json'), '{"name":"@podium/composer"}\n')
    writeFileSync(join(root, 'packages/composer/src/index.ts'), 'export const a = 1\n')
    mkdirSync(join(root, 'packages/headless'), { recursive: true })
    writeFileSync(join(root, 'packages/headless/package.json'), '{"name":"@podium/headless"}\n')
    return root
  }

  it('finds the package by its manifest name, not by its directory name', () => {
    const root = repository()
    expect(workspaceSourceFile(root, '@podium/composer')).toBe(
      join(root, 'packages/composer/src/index.ts'),
    )
  })

  it('refuses a package it cannot edit rather than silently skipping the probe', () => {
    const root = repository()
    expect(() => workspaceSourceFile(root, '@podium/headless')).toThrow('no src/index.ts')
    expect(() => workspaceSourceFile(root, '@podium/nonexistent')).toThrow('no workspace package')
  })
})

describe('unleasedRefusal', () => {
  it('accepts only a heavy marker something else put there', () => {
    expect(unleasedRefusal({ [VALIDATION_HELD_ENV]: 'heavy' })).toBeNull()
  })

  it('refuses a run nothing admitted, and names the leased way in', () => {
    expect(unleasedRefusal({})).toContain('deps:global-store-cache-admission')
  })

  it('does not accept a live session as a substitute for a lease', () => {
    // Having an identity that COULD hold test:heavy is not holding it. This is the exact
    // bypass: an agent typing the script path directly still has a session id.
    expect(unleasedRefusal({ PODIUM_SESSION_ID: 'sess_live_agent' })).toBeTruthy()
  })

  it('does not accept a lease of some other class', () => {
    // A focused slot admits one vitest run; it says nothing about a lane that installs
    // three worktrees.
    expect(unleasedRefusal({ [VALIDATION_HELD_ENV]: 'focused' })).toBeTruthy()
    expect(unleasedRefusal({ [VALIDATION_HELD_ENV]: 'watch' })).toBeTruthy()
    expect(unleasedRefusal({ [VALIDATION_HELD_ENV]: '' })).toBeTruthy()
  })
})

describe('probeEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('never manufactures the marker it is checked against', () => {
    // The whole point of `unleasedRefusal`: if this function minted the marker, an
    // unleased run would hand its probes an admitted run's badge, and every reader of
    // that environment downstream would believe it.
    vi.stubEnv(VALIDATION_HELD_ENV, '')
    expect(
      (probeEnv('/home/agent/.bun/bin/bun', '/cache/run/xdg') as Record<string, string>)[
        VALIDATION_HELD_ENV
      ],
    ).not.toBe('heavy')
  })

  it('forwards the lease the lane was admitted under, so no probe takes a second one', () => {
    // Asserted against the two conditions runWithLease actually branches on rather than
    // against variable names: a probe that queued for its own `test:heavy` would queue
    // behind the lane's own holder and never start.
    vi.stubEnv('PODIUM_SESSION_ID', 'sess_live_agent')
    vi.stubEnv(VALIDATION_HELD_ENV, 'heavy')
    const env = probeEnv('/home/agent/.bun/bin/bun', '/cache/run/xdg') as Record<
      string,
      string | undefined
    >
    expect(shouldAcquireValidationLease(env)).toBe(false)
    expect(env[VALIDATION_HELD_ENV]).toBe('heavy')
  })

  it('keeps the cache directory the one the checkout derives for itself', () => {
    // An inherited TURBO_CACHE_DIR would point every worktree at one directory by fiat,
    // and the lane would then prove nothing about how siblings find each other.
    vi.stubEnv('TURBO_CACHE_DIR', '/somewhere/the/operator/uses')
    const env = probeEnv('/home/agent/.bun/bin/bun', '/cache/run/xdg') as Record<
      string,
      string | undefined
    >
    expect(env.TURBO_CACHE_DIR).toBeUndefined()
    expect(env.XDG_CACHE_HOME).toBe('/cache/run/xdg')
  })
})

/**
 * These run the real entry point. An exported `unleasedRefusal` that main() never calls
 * passes every test above, and the property under test is that the ENTRY POINT is shut —
 * so the only way to show it is to enter it.
 */
describe('the entry point itself', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const scratch: string[] = []
  afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
  })

  function temporary(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    scratch.push(dir)
    return dir
  }

  /** A `podium` that grants any lock, so the wrapper can be exercised without touching
   *  the host's real `test:heavy` — which a sibling agent may well be holding. */
  function fakePodium(): { dir: string; log: string } {
    const dir = temporary('podium-admission-lock-')
    const log = join(dir, 'calls.log')
    writeFileSync(
      join(dir, 'podium'),
      `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
if [ "$2" = "acquire" ]; then
  printf '{"data":{"granted":true,"alreadyHeld":false,"lock":{"name":"%s"}},"text":"granted"}\\n' "$3"
fi
`,
    )
    chmodSync(join(dir, 'podium'), 0o755)
    return { dir, log }
  }

  const lockCalls = (log: string): string[] =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []

  /**
   * Arguments that are well-formed enough to be parsed and then stop the lane dead.
   *
   * `--bun` at a path that does not exist fails the version check, which sits AFTER argv
   * parsing and the clean-checkout test and BEFORE `validateAdmissionOptions` — the first
   * thing that writes anything. So these runs stop at the same place whether the checkout
   * they run in is clean or dirty, and never create a worktree or start an install.
   */
  function laneArgs(): { args: string[]; scratchParent: string } {
    const base = temporary('podium-admission-entry-')
    const scratchParent = join(base, 'worktrees')
    return {
      scratchParent,
      args: [
        '--cache-root',
        join(base, 'cache'),
        '--scratch-parent',
        scratchParent,
        '--run-id',
        'entry-point-regression',
        '--output',
        join(base, 'report.json'),
        '--bun',
        join(base, 'no-such-bun'),
      ],
    }
  }

  async function run(
    command: string[],
    env: Record<string, string | undefined>,
  ): Promise<{ exitCode: number; output: string }> {
    const child = Bun.spawn(command, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exitCode, output: `${stdout}\n${stderr}` }
  }

  // The unit `node` project runs its workers under bun, so this is bun — and the lane and
  // the wrapper are TypeScript entry points that nothing else can run.
  const lane = [process.execPath, 'scripts/global-store-cache-admission.ts']
  const wrapper = [
    process.execPath,
    'scripts/validation-admission.ts',
    'heavy',
    '--label',
    'deps:global-store-cache-admission',
    '--',
    ...lane,
  ]
  /** A live session id, because that is what the bypass looks like: an agent with an
   *  identity that COULD have been leased, typing the script path instead. */
  const agent = { PODIUM_SESSION_ID: 'sess_live_agent', [VALIDATION_HELD_ENV]: undefined }

  it('refuses a direct unmarked run before it writes anything', async () => {
    const { args, scratchParent } = laneArgs()
    const result = await run([...lane, ...args], agent)
    expect(result.output).toContain('refusing to run outside a heavy-test lease')
    expect(result.exitCode).toBe(1)
    // Refused BEFORE the work: nothing was created, so there is no half-installed
    // worktree to reason about and nothing to clean up.
    expect(existsSync(scratchParent)).toBe(false)
  }, 60_000)

  it('accepts the wrapper, which leases first and forwards argv after', async () => {
    const { dir, log } = fakePodium()
    const { args, scratchParent } = laneArgs()
    const result = await run([...wrapper, ...args], {
      ...agent,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
    })
    expect(lockCalls(log).some((call) => call.startsWith('lock acquire test:heavy'))).toBe(true)
    expect(result.output).not.toContain('refusing to run outside a heavy-test lease')
    // Past the gate and into the lane's own body, which is the acceptance claim. Which
    // refusal it stops on next depends on whether the checkout running this suite is
    // clean, so the assertion is that the lane is the one talking.
    expect(result.output).toContain('[cache-admission]')
    // argv was forwarded and parsed: the usage line is what an unparsed argv produces,
    // and the no-arguments case below shows this run would have printed it.
    expect(result.output).not.toContain('usage: bun run deps:global-store-cache-admission')
    expect(result.exitCode).toBe(1)
    expect(existsSync(scratchParent)).toBe(false)
  }, 120_000)

  it("propagates the lane's own exit code through the wrapper", async () => {
    const { dir, log } = fakePodium()
    // No arguments: past the gate, the LANE's usage answers, with the lane's exit 2 and
    // not the wrapper's 1. A wrapper that flattened exit codes would be caught here.
    const result = await run(wrapper, { ...agent, PATH: `${dir}:${process.env.PATH ?? ''}` })
    expect(lockCalls(log).some((call) => call.startsWith('lock acquire test:heavy'))).toBe(true)
    expect(result.output).toContain('usage: bun run deps:global-store-cache-admission')
    expect(result.exitCode).toBe(2)
  }, 120_000)
})
