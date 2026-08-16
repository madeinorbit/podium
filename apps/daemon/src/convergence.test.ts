import { describe, expect, it } from 'vitest'
import {
  disarmExitSeam,
  FOREGROUND_ALL_IN_ONE_REFUSAL,
  MAX_CONVERGENCE_ATTEMPTS,
  refuseConvergence,
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
    expect(
      disarmExitSeam({ provided: () => {}, shape: { exitStopsServer: true, env: {} } }),
    ).toBe(false)
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
