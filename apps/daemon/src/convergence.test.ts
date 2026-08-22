import { describe, expect, it, vi } from 'vitest'
import {
  createSchemaGate,
  disarmExitSeam,
  FOREGROUND_ALL_IN_ONE_REFUSAL,
  MAX_CONVERGENCE_ATTEMPTS,
  refuseConvergence,
  refuseSchemaRegression,
  restartAfterGrant,
  resolveOnBoot,
} from './convergence'

const pending = {
  grantId: 'g1',
  targetVersion: '0.4.2',
  previousVersion: '0.4.1',
  attempts: 1,
  startedAt: 1_000,
}

describe('resolveOnBoot', () => {
  it('does nothing on an ordinary boot with no pending grant', () => {
    expect(resolveOnBoot({ pending: null, runningVersion: '0.4.2' })).toBeNull()
  })

  it('confirms when the daemon came back on the target', () => {
    expect(resolveOnBoot({ pending, runningVersion: '0.4.2' })).toEqual({
      action: 'confirm',
      state: 'current',
    })
  })

  it('retries when the swap did not take and attempts remain', () => {
    expect(resolveOnBoot({ pending, runningVersion: '0.4.1' })).toEqual({
      action: 'retry',
      attempts: 2,
    })
  })

  it('gives up and pins to last-known-good once attempts are exhausted', () => {
    const verdict = resolveOnBoot({
      pending: { ...pending, attempts: MAX_CONVERGENCE_ATTEMPTS },
      runningVersion: '0.4.1',
    })
    expect(verdict).toMatchObject({ action: 'rollback', state: 'stuck' })
  })

  it('confirms at the attempt ceiling if the daemon actually made it', () => {
    expect(
      resolveOnBoot({
        pending: { ...pending, attempts: MAX_CONVERGENCE_ATTEMPTS },
        runningVersion: '0.4.2',
      }),
    ).toEqual({ action: 'confirm', state: 'current' })
  })

  it('treats an unexpected third version as a failure, not a success', () => {
    const verdict = resolveOnBoot({
      pending: { ...pending, attempts: MAX_CONVERGENCE_ATTEMPTS },
      runningVersion: '0.3.0',
    })
    expect(verdict).toMatchObject({ action: 'rollback' })
  })

  it('bounds at two attempts', () => {
    expect(MAX_CONVERGENCE_ATTEMPTS).toBe(2)
  })
})

describe('refuseConvergence', () => {
  it('refuses when this daemon shares its process with the server and nothing would restart it', () => {
    // The `podium all` / bare-`podium`-with-no-persistence shape (POD-2210):
    // the daemon's exit IS the server's exit and no manager exists to undo it.
    expect(refuseConvergence({ exitStopsServer: true, env: {} })).toBe(
      FOREGROUND_ALL_IN_ONE_REFUSAL,
    )
  })

  it('lets an ordinary split daemon converge', () => {
    // The systemd daemon unit, the detached daemon, every remote machine: their
    // exit stops a daemon and nothing else, which is what convergence is FOR.
    expect(refuseConvergence({ exitStopsServer: false, env: {} })).toBeUndefined()
    expect(refuseConvergence({ env: {} })).toBeUndefined()
  })

  it('lets an all-in-one under a service manager converge', () => {
    // An operator may run `podium all` from a unit of their own. `INVOCATION_ID`
    // is systemd's mark on the process, and it is the SAME signal the server
    // uses to decide it may restart itself — see source-redeploy.ts.
    expect(refuseConvergence({ exitStopsServer: true, env: { INVOCATION_ID: 'abc' } })).toBe(
      undefined,
    )
  })

  it('lets the desktop sidecar converge, because the shell respawns it', () => {
    expect(
      refuseConvergence({ exitStopsServer: true, env: { PODIUM_DESKTOP_SUPERVISED: '1' } }),
    ).toBeUndefined()
    // Exactly '1', matching every other reader of this flag: a stray '0' is not
    // a supervisor, and reading it as one would restore the silent stop.
    expect(
      refuseConvergence({ exitStopsServer: true, env: { PODIUM_DESKTOP_SUPERVISED: '0' } }),
    ).toBe(FOREGROUND_ALL_IN_ONE_REFUSAL)
  })

  it('disarms the exit seam in exactly the shape it refuses, and nowhere else', () => {
    // The grant path never reaches the seam — it is refused first — so what this
    // covers is the OTHER exit: the protocol-mismatch self-update, and whatever
    // is added next. The refusal has to be a property of the process, not of one
    // code path.
    expect(disarmExitSeam({ shape: { exitStopsServer: true, env: {} } })).toBe(true)
    expect(disarmExitSeam({ shape: { exitStopsServer: false, env: {} } })).toBe(false)
    expect(
      disarmExitSeam({ shape: { exitStopsServer: true, env: { INVOCATION_ID: 'abc' } } }),
    ).toBe(false)
  })

  it('leaves an injected restart alone', () => {
    // A test or embedder that passed its own restart has already said what
    // happens instead of an exit; overriding it would break every harness that
    // drives a co-hosted daemon.
    expect(disarmExitSeam({ provided: () => {}, shape: { exitStopsServer: true, env: {} } })).toBe(
      false,
    )
  })

  it('says why, in a sentence a person can act on, carrying the token the panel matches', () => {
    // §6.2/§7: a failure must name itself. The token is the contract with
    // `describeUpdateFailure` in apps/web; the prose is the contract with the
    // operator reading the daemon log.
    expect(FOREGROUND_ALL_IN_ONE_REFUSAL).toContain('foreground-all-in-one')
    expect(FOREGROUND_ALL_IN_ONE_REFUSAL).toMatch(/shares its process with the Podium server/)
    expect(FOREGROUND_ALL_IN_ONE_REFUSAL).toMatch(/would not come back/)
  })
})

describe('restartAfterGrant', () => {
  it('asks a supervising parent to hand over to the granted version', () => {
    const requestHandover = vi.fn(() => ({ ok: true as const, pid: 42 }))
    restartAfterGrant(
      '2.0.0',
      { releaseHadMigrations: false },
      {
        parentManaged: true,
        requestHandover,
        exit: vi.fn(),
      },
    )
    expect(requestHandover).toHaveBeenCalledWith({
      expectedVersion: '2.0.0',
      releaseHadMigrations: false,
    })
  })

  it('exits a direct daemon for its shell or service manager to respawn', () => {
    const exit = vi.fn()
    restartAfterGrant(
      '2.0.0',
      {},
      {
        parentManaged: false,
        requestHandover: vi.fn(),
        exit,
      },
    )
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('reports a vanished parent instead of pretending to restart', () => {
    expect(() =>
      restartAfterGrant(
        '2.0.0',
        {},
        {
          parentManaged: true,
          requestHandover: () => ({ ok: false, reason: 'no-parent' }),
          exit: vi.fn(),
        },
      ),
    ).toThrow(/machine-cannot-restart/)
  })
})

describe('refuseSchemaRegression', () => {
  const baseline = '20260715135845_baseline'
  const advanced = '20260809112031_transcript-segment-incarnations'

  it('lets a machine that owns no database converge anywhere, declared or not', () => {
    // §13.3: "Daemon: always safe; a daemon owns no database." Every remote
    // worker machine is this case, and its rollback must stay automatic.
    expect(
      refuseSchemaRegression({
        applied: undefined,
        targetDefines: undefined,
        currentVersion: 'dev+03a2892',
        targetVersion: '0.1.3',
      }),
    ).toBeUndefined()
  })

  it('lets a database with nothing applied converge anywhere', () => {
    expect(
      refuseSchemaRegression({
        applied: [],
        targetDefines: undefined,
        currentVersion: 'dev+03a2892',
        targetVersion: '0.1.3',
      }),
    ).toBeUndefined()
  })

  it('lets a downgrade whose schema did not advance converge — the rollback path', () => {
    // THE ARM THE DESIGN DELIBERATELY KEEPS. Expand-only releases mean the
    // common rollback crosses no migration boundary at all, and refusing it
    // would make rollback structurally impossible again.
    expect(
      refuseSchemaRegression({
        applied: [baseline],
        targetDefines: [baseline, advanced],
        currentVersion: '0.1.4',
        targetVersion: '0.1.3',
      }),
    ).toBeUndefined()
  })

  it('refuses a downgrade past a migration the target cannot open, and names it', () => {
    const refusal = refuseSchemaRegression({
      applied: [baseline, advanced],
      targetDefines: [baseline],
      currentVersion: 'dev+03a2892',
      targetVersion: '0.1.3',
    })
    expect(refusal).toContain('cannot converge: schema-advanced')
    expect(refusal).toContain(advanced)
    expect(refusal).toContain('0.1.3')
    expect(refusal).toContain('dev+03a2892')
  })

  it('refuses an undeclared target it cannot prove is ahead of this machine', () => {
    // Every release published before this gate existed. Unproven is not the
    // same as unsafe, but a machine that guesses wrong cannot start and cannot
    // update itself back, so the guess is not ours to make.
    const refusal = refuseSchemaRegression({
      applied: [baseline],
      targetDefines: undefined,
      currentVersion: 'dev+03a2892',
      targetVersion: '0.1.3',
    })
    expect(refusal).toContain('cannot converge: schema-unknown')
    expect(refusal).toContain('0.1.3')
  })

  it('lets an UPGRADE to an undeclared target through — an unprovable step FORWARD has no downgrade hazard', () => {
    // THE CASE THAT WOULD HAVE BEEN A WORSE BUG THAN THE ONE THIS GATE FIXES.
    // No release published to date declares a schema, so gating every
    // undeclared target alike would have left no installed machine able to
    // accept ANY published release until a new one is cut — and a dev-only
    // drive would never have seen it, exactly like the hardcoded channel.
    //
    // Unprovable-and-BEHIND and unprovable-and-AHEAD are not the same case.
    // Going forward carries no downgrade hazard at all: the database is only
    // ever moved by migrations the NEW build carries.
    expect(
      refuseSchemaRegression({
        applied: [baseline],
        targetDefines: undefined,
        currentVersion: '0.1.3',
        targetVersion: '0.1.4',
      }),
    ).toBeUndefined()
  })

  it('still refuses an undeclared target at the same version, or one it cannot order', () => {
    // FAILS CLOSED on both. Equal versions never reach here through
    // `planConvergence`, and a label with no ordering at all — `dev+<sha>` on
    // either side — is not evidence of anything.
    expect(
      refuseSchemaRegression({
        applied: [baseline],
        targetDefines: undefined,
        currentVersion: '0.1.4',
        targetVersion: 'dev+03a2892',
      }),
    ).toContain('cannot converge: schema-unknown')
    expect(
      refuseSchemaRegression({
        applied: [baseline],
        targetDefines: undefined,
        currentVersion: '0.1.4',
        targetVersion: '0.1.4',
      }),
    ).toContain('cannot converge: schema-unknown')
  })

  it('lets a prerelease step forward through, and refuses the step back', () => {
    // Podium's own versions ARE prereleases; an ordering that cannot read
    // `0.1.4-edge.4` would answer "cannot prove" for every edge machine there
    // is, which is the same shipping stall in a smaller blast radius.
    expect(
      refuseSchemaRegression({
        applied: [baseline],
        targetDefines: undefined,
        currentVersion: '0.1.4-edge.3',
        targetVersion: '0.1.4-edge.4',
      }),
    ).toBeUndefined()
    expect(
      refuseSchemaRegression({
        applied: [baseline],
        targetDefines: undefined,
        currentVersion: '0.1.4-edge.4',
        targetVersion: '0.1.4-edge.3',
      }),
    ).toContain('cannot converge: schema-unknown')
  })

  it('refuses a DECLARED target the database has outgrown even when it is newer', () => {
    // The forward allowance is only for targets that will not say. One that
    // DOES say is judged on what it says, in both directions — a newer build
    // that genuinely dropped a migration is still a build that cannot open
    // this database.
    expect(
      refuseSchemaRegression({
        applied: [baseline, advanced],
        targetDefines: [baseline],
        currentVersion: '0.1.3',
        targetVersion: '0.1.4',
      }),
    ).toContain('cannot converge: schema-advanced')
  })

  it('accepts a migration applied under its pre-rebase name when the target defines the canonical one', () => {
    expect(
      refuseSchemaRegression({
        applied: ['20260722210552_session-spawn-failure'],
        targetDefines: ['20260724134702_session-spawn-failure'],
        currentVersion: '0.1.4',
        targetVersion: '0.1.3',
      }),
    ).toBeUndefined()
  })

  it('says what a person has to do, because Podium cannot do it for them', () => {
    // The whole point of refusing BEFORE the swap: from the bricked state there
    // is no path back through Podium — the thing that applies an update is the
    // server that will not start.
    const refusal = refuseSchemaRegression({
      applied: [baseline, advanced],
      targetDefines: [baseline],
      currentVersion: '0.1.4',
      targetVersion: '0.1.3',
    })
    expect(refusal).toMatch(/nothing was fetched|nothing has been fetched/i)
    expect(refusal).toMatch(/restore/i)
  })
})

describe('createSchemaGate', () => {
  const targetAt = (version: string, migrations?: string[]) =>
    ({
      version,
      critical: false,
      artifacts: {},
      ...(migrations ? { schema: { migrations } } : {}),
    }) as never

  it('lets a target through when this machine can open it', () => {
    const gate = createSchemaGate({
      readApplied: () => ['20260715135845_baseline'],
      currentVersion: '0.1.4',
    })
    expect(gate(targetAt('0.1.3', ['20260715135845_baseline']))).toBeUndefined()
  })

  it('refuses a target this machine database has outgrown', () => {
    const gate = createSchemaGate({
      readApplied: () => ['20260715135845_baseline', '20260816092917_operations-table'],
      currentVersion: 'dev+03a2892',
    })
    expect(gate(targetAt('0.1.3', ['20260715135845_baseline']))).toContain(
      'cannot converge: schema-advanced',
    )
  })

  it('refuses rather than guesses when the ledger cannot be read', () => {
    // Fail CLOSED. An unreadable ledger is not "no database" — reading it as
    // one would let through exactly the swap this gate exists to stop.
    const gate = createSchemaGate({
      readApplied: () => {
        throw new Error('database is locked')
      },
      currentVersion: 'dev+03a2892',
    })
    const refusal = gate(targetAt('0.1.3', ['20260715135845_baseline']))
    expect(refusal).toContain('cannot converge: schema-unreadable')
    expect(refusal).toContain('database is locked')
  })
})
