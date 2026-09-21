// packages/harness/src/driver/families/claude-sdk/spawn-site.test.ts
//
// THE SPAWN SITE ITSELF, and it has its own file because of how POD-3057 was
// missed the first time. (Moved from apps/daemon/src/claude-sdk-spawn-site.test.ts
// in 1.5 with the code it pins.)
//
// So this pins the call, not a helper the call happens to use today: the real
// `runClaudeSdkChildTurn` with no injected host, `node:child_process.spawn`
// intercepted, and the assertion made on the options that spawn ACTUALLY
// received. The env is handed in composed (the supervisor owns the
// stored-login precedence merge); the pin is that the spawn uses it exactly —
// a refactor that recomputes the child env from `process.env` inside the
// family, the exact way the defect arrived, turns this red.
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawns: Array<{ env?: NodeJS.ProcessEnv; cwd?: string }> = []

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (_cmd: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
      spawns.push({ ...(options.env ? { env: options.env } : {}), ...(options.cwd ? { cwd: options.cwd } : {}) })
      // A REAL child, so the turn machinery downstream (readline over stdout,
      // the exit handler) has real pipes to attach to. It exits immediately;
      // the turn fails, which is not what is under test here.
      return actual.spawn(process.execPath, ['-e', ''], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcess
    },
  }
})

const { runClaudeSdkChildTurn } = await import('./child-turn.js')
const { HeadlessTurnFailure } = await import('./child-turn.js')
type Spec = Parameters<typeof runClaudeSdkChildTurn>[0]

afterEach(() => {
  spawns.length = 0
})

describe('the SDK host spawn site', () => {
  it('spawns the host with the HOME the turn spec carries (POD-3057)', async () => {
    const home = '/state/p3057/agent-home'
    const spec = {
      cwd: process.cwd(),
      prompt: 'hello',
      env: { HOME: home, CLAUDE_CONFIG_DIR: `${home}/.claude` },
    } as unknown as Spec

    const child = runClaudeSdkChildTurn(spec, () => {}, {
      childEnv: { HOME: home, CLAUDE_CONFIG_DIR: `${home}/.claude` },
    })
    await child.done.catch((error: unknown) => {
      // The stub host dies without answering, which this turn reports honestly.
      expect(error).toBeInstanceOf(HeadlessTurnFailure)
    })

    expect(spawns).toHaveLength(1)
    expect(spawns[0]?.env?.HOME).toBe(home)
    expect(spawns[0]?.env?.CLAUDE_CONFIG_DIR).toBe(`${home}/.claude`)
    expect(spawns[0]?.cwd).toBe(process.cwd())
  })

  it('hands spawn exactly the composed env, reintroducing no ambient key', async () => {
    // The supervisor strips inherited credential overrides when it composes
    // the child env (stored-login precedence); the family must not undo that
    // by merging the ambient environment back in at the spawn.
    process.env.PODIUM_155_AMBIENT_PROBE = 'ambient'
    try {
      const spec = { cwd: process.cwd(), prompt: 'hello' } as unknown as Spec
      const child = runClaudeSdkChildTurn(spec, () => {}, { childEnv: { HOME: '/handed' } })
      await child.done.catch(() => {})
      expect(spawns).toHaveLength(1)
      expect(spawns[0]?.env?.HOME).toBe('/handed')
      expect(spawns[0]?.env?.PODIUM_155_AMBIENT_PROBE).toBeUndefined()
    } finally {
      delete process.env.PODIUM_155_AMBIENT_PROBE
    }
  })

  /** No home on the spec — the default instance — must not acquire one here.
   *  The daemon's own environment is the right answer there, and inventing a
   *  different one would split the reader and the child the other way. */
  it('leaves the daemon HOME alone when the spec names none', async () => {
    const spec = {
      cwd: process.cwd(),
      prompt: 'hello',
    } as unknown as Spec

    const child = runClaudeSdkChildTurn(spec, () => {}, { childEnv: { ...process.env } })
    await child.done.catch(() => {})

    expect(spawns).toHaveLength(1)
    expect(spawns[0]?.env?.HOME).toBe(process.env.HOME)
  })
})
