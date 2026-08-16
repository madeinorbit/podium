import { describe, expect, it } from 'vitest'
import { describeUpdate, describeUpdateFailure } from './update-view'

const base = {
  localVersion: '0.4.1',
  server: { appVersion: '0.4.1', target: { version: '0.4.2', critical: false, artifacts: {} } },
  surface: 'web' as const,
  serverName: 'ludovico',
  fleet: { total: 3, behind: 3, converging: 0, failed: 0 },
  touched: { app: true, server: true, machines: true },
  skew: 'ok' as const,
}

describe('describeUpdate', () => {
  it('is none when everything is already on the target', () => {
    const v = describeUpdate({
      ...base,
      localVersion: '0.4.2',
      server: { appVersion: '0.4.2', target: { version: '0.4.2', critical: false, artifacts: {} } },
      fleet: { total: 3, behind: 0, converging: 0, failed: 0 },
      touched: { app: false, server: false, machines: false },
    } as never)
    expect(v.state).toBe('none')
  })

  it('names places, never components', () => {
    const v = describeUpdate(base as never)
    const text = JSON.stringify(v)
    expect(text).not.toMatch(/headless|bundle|daemon|artifact|tarball/i)
    expect(text).toMatch(/This app/)
    expect(text).toMatch(/Your server/)
  })

  it('names the server so the user knows WHICH server', () => {
    const v = describeUpdate(base as never)
    const server = (v as { places: { kind: string; label: string }[] }).places.find(
      (p) => p.kind === 'server',
    )
    expect(server?.label).toContain('ludovico')
  })

  it('folds the source browser rebuild into the coordinating server place', () => {
    const v = describeUpdate({
      ...base,
      server: {
        appVersion: 'dev+old1234',
        target: { version: 'dev+abc1234', critical: false, artifacts: {} },
      },
    } as never)
    expect((v as { places: { kind: string; label: string }[] }).places).toMatchObject([
      { kind: 'server', label: 'This app and your server (ludovico)' },
      { kind: 'machines' },
    ])
  })

  it('pluralises machines and says they are not interrupted', () => {
    const v = describeUpdate(base as never)
    const machines = (
      v as { places: { kind: string; label: string; effect: string }[] }
    ).places.find((p) => p.kind === 'machines')
    expect(machines?.label).toBe('3 machines')
    expect(machines?.effect).toMatch(/not be interrupted/i)
  })

  it('names the first three affected machines and summarizes the rest', () => {
    const v = describeUpdate({
      ...base,
      fleet: {
        total: 5,
        behind: 5,
        converging: 0,
        failed: 0,
        machines: ['flatblock', 'ludovico', 'workstation', 'builder', 'laptop'].map((name) => ({
          name,
          version: '0.4.1',
          state: 'current',
        })),
      },
    } as never)
    const machines = (v as { places: { kind: string; label: string }[] }).places.find(
      (place) => place.kind === 'machines',
    )
    expect(machines?.label).toBe('flatblock, ludovico, workstation, and 2 more')
  })

  it('says "1 machine" for exactly one', () => {
    const v = describeUpdate({
      ...base,
      fleet: { total: 1, behind: 1, converging: 0, failed: 0 },
    } as never)
    const machines = (v as { places: { kind: string; label: string }[] }).places.find(
      (p) => p.kind === 'machines',
    )
    expect(machines?.label).toBe('1 machine')
  })

  it('omits a place that is not being touched', () => {
    const v = describeUpdate({
      ...base,
      touched: { app: false, server: true, machines: false },
    } as never)
    const kinds = (v as { places: { kind: string }[] }).places.map((p) => p.kind)
    expect(kinds).toEqual(['server'])
  })

  it('says no restart is needed when nothing the user is looking at restarts', () => {
    const v = describeUpdate({
      ...base,
      touched: { app: false, server: false, machines: true },
    } as never)
    expect((v as { restartNote: string }).restartNote).toMatch(/no restart needed/i)
  })

  it('promises sessions keep running, and promises nothing more', () => {
    const v = describeUpdate(base as never)
    const note = (v as { restartNote: string }).restartNote
    expect(note).toMatch(/sessions keep running/i)
    expect(note).not.toMatch(/no downtime|instant|seamless|zero/i)
  })

  it('uses no em dashes anywhere in user-facing text', () => {
    expect(JSON.stringify(describeUpdate(base as never))).not.toContain('—')
  })

  it('carries release notes when the target has them', () => {
    const v = describeUpdate({
      ...base,
      server: {
        appVersion: '0.4.1',
        target: {
          version: '0.4.2',
          critical: false,
          artifacts: {},
          notes: { summary: 'Faster reconnects.', url: 'https://x.test/CHANGELOG.md' },
        },
      },
    } as never)
    expect((v as { notes?: { url?: string } }).notes?.url).toBe('https://x.test/CHANGELOG.md')
  })

  it('omits the notes affordance entirely when there are none', () => {
    expect((describeUpdate(base as never) as { notes?: unknown }).notes).toBeUndefined()
  })

  it('shows a native feed update in the shared app place', () => {
    const v = describeUpdate({
      ...base,
      server: { appVersion: '0.4.1' },
      surface: 'desktop-remote',
      fleet: { total: 0, behind: 0, converging: 0, failed: 0 },
      touched: { app: true, server: false, machines: false },
      desktopUpdate: { version: '0.4.2', critical: false, notes: 'A calmer update flow.' },
    } as never)
    expect(v).toMatchObject({
      state: 'available',
      version: '0.4.2',
      places: [{ kind: 'this-app' }],
      notes: { summary: 'A calmer update flow.' },
    })
  })

  it('is required, not available, for a critical target', () => {
    const v = describeUpdate({
      ...base,
      server: { appVersion: '0.4.1', target: { version: '0.4.2', critical: true, artifacts: {} } },
    } as never)
    expect(v.state).toBe('required')
  })

  it('is required when this client is outside the wire window', () => {
    const v = describeUpdate({ ...base, skew: 'client-too-old' } as never)
    expect(v.state).toBe('required')
  })

  it('names this app when it is too old even if the target flags no touched place', () => {
    const v = describeUpdate({
      ...base,
      touched: { app: false, server: false, machines: false },
      skew: 'client-too-old',
    } as never)
    expect((v as { places: { kind: string }[] }).places.map((place) => place.kind)).toEqual([
      'this-app',
    ])
  })

  it('tells the user to move the SERVER when this client is ahead of it', () => {
    const v = describeUpdate({
      ...base,
      touched: { app: false, server: false, machines: false },
      skew: 'client-too-new',
    } as never)
    expect(v.state).toBe('required')
    expect((v as { reason?: string }).reason).toMatch(/server/i)
    expect((v as { reason?: string }).reason).not.toMatch(/rebuild|reload/i)
    expect((v as { places: { kind: string }[] }).places.map((place) => place.kind)).toEqual([
      'server',
    ])
  })

  it('gives same-label schema skew an affected place and a complete source recovery path', () => {
    const v = describeUpdate({
      ...base,
      localVersion: 'dev+4915207',
      server: {
        appVersion: 'dev+4915207',
        wireSchemaDigest: '3ca64e6f388dbcf5',
        target: { version: 'dev+4915207', critical: false, artifacts: {} },
      },
      fleet: { total: 0, behind: 0, converging: 0, failed: 0 },
      touched: { app: false, server: false, machines: false },
      skew: 'schema-skew',
    } as never)

    expect(v).toMatchObject({
      state: 'required',
      version: 'dev+4915207',
      places: [
        {
          kind: 'server',
          label: 'This app and your server (ludovico)',
          effect: 'need matching builds and a restart',
        },
      ],
    })
    const note = (v as { restartNote: string }).restartNote
    expect(note).toContain('bun run build')
    expect(note).toContain('restart Podium on ludovico')
    expect(note).not.toMatch(/no restart needed/i)
  })

  it('folds the whole desktop all-in-one stack into one place', () => {
    const v = describeUpdate({ ...base, surface: 'desktop-all-in-one' } as never)
    const kinds = (v as { places: { kind: string }[] }).places.map((p) => p.kind)
    expect(kinds).not.toContain('server')
    expect(kinds).toContain('this-app')
  })

  /**
   * PROGRESS IS NOT DERIVED HERE ANY MORE (POD-2102). A running update is an
   * operation, and the operation says what is happening; this function is the
   * OFFER, so a converging fleet is simply not its question. The old
   * `in-progress` row is gone with the state itself — the replacement lives in
   * `operation-view.test.ts`.
   */
  it('still describes the offer while a wave happens to be converging', () => {
    const v = describeUpdate({
      ...base,
      fleet: { total: 3, behind: 1, converging: 2, failed: 0 },
    } as never)
    expect(v.state).toBe('available')
  })
})

/**
 * The failure COPY, tested directly.
 *
 * These cases used to arrive through `describeUpdate` from a fleet snapshot —
 * one of the three competing progress/outcome models spec §1.2 catalogues. The
 * routing is gone; the accumulated knowledge about what a raw delivery sentence
 * means to a person is not, because a server older than §7's typed codes still
 * reports free text and `presentOperationError` falls through to exactly this.
 */
describe('describeUpdateFailure', () => {
  it('translates an unsupported delivery failure into actionable language', () => {
    const v = describeUpdateFailure('cannot converge: unsupported-delivery')
    expect(v).toEqual({
      state: 'failed',
      message: 'One or more machines cannot use this update.',
      guidance:
        'Ask the server operator to check the release package for those machines, then try again.',
      diagnostic: "The machines do not support this update's delivery method.",
    })
    expect(JSON.stringify(v)).not.toContain('unsupported-delivery')
  })

  /**
   * POD-2210. The refusal a foreground `podium all` sends instead of dying. The
   * daemon's exact sentence is pinned in apps/daemon's `convergence.test.ts`;
   * what matters here is that this side recognizes the token and answers with
   * the ONE action that actually works, rather than "try again".
   */
  it('tells a foreground Podium how to finish an update it cannot apply itself', () => {
    const v = describeUpdateFailure(
      'cannot converge: foreground-all-in-one — this daemon shares its process with the ' +
        'Podium server and nothing would start that process again, so updating it here would ' +
        'stop the server and it would not come back',
    )

    expect(v.state).toBe('failed')
    expect(v.message).toMatch(/single foreground process/i)
    expect(v.message).toMatch(/cannot update itself/i)
    // "Nothing was changed" is the load-bearing half: the operator has to know
    // whether their checkout moved before deciding what to do next.
    expect(v.guidance).toMatch(/nothing was changed/i)
    expect(v.guidance).toMatch(/start it again/i)
    expect(v.guidance).toMatch(/podium setup/i)
    // Never the generic delivery copy, which would send them to the release
    // operator for a problem that lives in their own terminal.
    expect(v.message).not.toMatch(/one or more machines/i)
    expect(JSON.stringify(v)).not.toContain('foreground-all-in-one')
  })

  it('names the machine when the refusal came from one', () => {
    const v = describeUpdateFailure('cannot converge: foreground-all-in-one — …', 'ludovico')
    expect(v.message).toMatch(/^Podium on ludovico/)
  })

  /**
   * POD-2213. The refusal that keeps a machine ALIVE: an older build cannot open
   * a database the newer one has already migrated, so the daemon declines the
   * downgrade instead of swapping into a server that will not start. "Try again"
   * is the wrong next action here too — this is a target problem, not a
   * transient one.
   */
  it('explains a downgrade that was refused because the database moved on', () => {
    const v = describeUpdateFailure(
      "cannot converge: schema-advanced — this machine's database has applied migration " +
        "'20260809112031_transcript-segment-incarnations', which 0.1.3 does not define",
      'ludovico',
    )

    expect(v.state).toBe('failed')
    expect(v.message).toMatch(/ludovico/)
    expect(v.message).toMatch(/older/i)
    expect(v.guidance).toMatch(/still running/i)
    expect(v.message).not.toMatch(/one or more machines/i)
    // The prose stays jargon-free; the diagnostic keeps the one fact worth
    // keeping — WHICH migration the older build could not open.
    expect(`${v.message} ${v.guidance}`).not.toContain('schema-advanced')
    expect(v.diagnostic).toContain('transcript-segment-incarnations')
  })

  it('uses the same copy when the target would not say what schema it opens', () => {
    const v = describeUpdateFailure('cannot converge: schema-unknown — 0.1.3 does not declare …')
    expect(v.state).toBe('failed')
    expect(v.message).toMatch(/older/i)
    expect(v.guidance).toMatch(/still running/i)
  })

  it('turns a dirty checkout into named, actionable copy', () => {
    const v = describeUpdateFailure('git delivery failed: dirty-working-tree', 'ludovico')

    expect(v).toMatchObject({
      state: 'failed',
      message: 'ludovico has local files or edits that prevent a safe update.',
      diagnostic: 'Git delivery stopped because the checkout is not clean.',
    })
    expect(v.guidance).toMatch(/commit, stash, move, or locally exclude/i)
    expect(JSON.stringify(v)).not.toContain('dirty-working-tree')
  })

  it('translates connection failures without exposing raw transport copy', () => {
    const v = describeUpdateFailure('Unable to connect. Is the computer able to access the url?')

    expect(v).toEqual({
      state: 'failed',
      message: 'Podium could not reach the update source.',
      guidance: "Check this server's internet connection, then try the update again.",
      diagnostic: 'The update could not be downloaded.',
    })
    expect(JSON.stringify(v)).not.toMatch(/unable to connect|access the url/i)
  })

  it('keeps an unknown failure as support detail', () => {
    const v = describeUpdateFailure('ludovico did not come back')

    expect(v).toMatchObject({
      state: 'failed',
      message: 'Podium could not finish the update.',
      diagnostic: 'ludovico did not come back',
    })
  })

  it('tells the operator a silent machine was given up on, and that retry is the fix', () => {
    const v = describeUpdateFailure('The machine stopped reporting progress while updating.')

    expect(v.state).toBe('failed')
    expect(v.message).toBe('A machine stopped responding while updating.')
    expect(v.guidance).toMatch(/apply the update again/i)
  })
})

describe('describeUpdate, continued', () => {
  /**
   * The live dev coordinator publishes `headless` artifacts only: nothing in its
   * target updates this app. Reproduced here because it is the shape that made
   * the desktop dialog speak for "This app" alone (POD-1883 repro 3).
   */
  describe('a target that carries no artifact for this app', () => {
    const headlessOnly = {
      version: 'dev+4f36e8e',
      critical: false,
      artifacts: { headless: { delivery: 'bundle', platforms: {} } },
    }

    it('still labels a desktop-only dialog from the release feed when the target only stamps a source SHA', () => {
      const v = describeUpdate({
        ...base,
        localVersion: '1.2.0',
        server: {
          appVersion: 'dev+4f36e8e',
          target: {
            version: 'dev+4f36e8e',
            critical: false,
            artifacts: { web: { digest: '4f36e8e' } },
          },
        },
        surface: 'desktop-all-in-one' as const,
        fleet: { total: 0, behind: 0, converging: 0, failed: 0 },
        touched: { app: true, server: false, machines: false },
        desktopUpdate: { version: '1.3.0', critical: false },
      } as never)

      const view = v as { version: string; places: { kind: string }[] }
      expect(view.places.map((place) => place.kind)).toEqual(['this-app'])
      expect(view.version).toBe('1.3.0')
    })

    it('labels an app-only dialog with the release feed version, not the target label', () => {
      const v = describeUpdate({
        ...base,
        localVersion: '1.2.0',
        server: { appVersion: 'dev+4f36e8e', target: headlessOnly },
        surface: 'desktop-all-in-one' as const,
        fleet: { total: 0, behind: 0, converging: 0, failed: 0 },
        touched: { app: true, server: false, machines: false },
        desktopUpdate: { version: '1.3.0', critical: false },
      } as never)

      const view = v as { version: string; places: { kind: string }[] }
      expect(view.places.map((place) => place.kind)).toEqual(['this-app'])
      expect(view.version).toBe('1.3.0')
    })

    it('still names the machines behind the target once the fleet read succeeds', () => {
      const withFleet = describeUpdate({
        ...base,
        server: { appVersion: 'dev+4f36e8e', target: headlessOnly },
        surface: 'desktop-remote' as const,
        fleet: { total: 2, behind: 1, converging: 0, failed: 0 },
        touched: { app: true, server: false, machines: true },
        desktopUpdate: { version: '1.3.0', critical: false },
      } as never)

      const view = withFleet as { version: string; places: { kind: string }[] }
      expect(view.places.map((place) => place.kind)).toContain('machines')
      // Places beyond this app come from the SERVER's target, so the dialog is
      // labelled with the target again rather than the release feed.
      expect(view.version).toBe('dev+4f36e8e')
    })

    it('reports no places at all when the fleet read failed and left an empty snapshot', () => {
      const v = describeUpdate({
        ...base,
        server: { appVersion: 'dev+4f36e8e', target: headlessOnly },
        surface: 'desktop-remote' as const,
        fleet: { total: 0, behind: 0, converging: 0, failed: 0 },
        touched: { app: false, server: false, machines: false },
      } as never)

      expect(v.state).toBe('none')
    })
  })

  /**
   * POD-1980. Before the phone export carried a stamp there was nothing to put
   * in this row, so an installation whose phone was weeks behind showed an empty
   * dialog and no button — the Update panel had no way to say the one thing that
   * was wrong.
   */
  describe('the phone website', () => {
    const sourceTarget = {
      version: 'dev+47a01e3',
      critical: false,
      artifacts: { web: { digest: '47a01e3' } },
    }
    const currentEverywhereElse = {
      ...base,
      localVersion: 'dev+47a01e3',
      server: { appVersion: 'dev+47a01e3', target: sourceTarget },
      fleet: { total: 1, behind: 0, converging: 0, failed: 0 },
    }

    it('CAN SAY NO: a stale phone alone is a dialog with one place', () => {
      const v = describeUpdate({
        ...currentEverywhereElse,
        touched: { app: false, server: false, machines: false, phone: true },
      } as never)

      const view = v as { state: string; places: { kind: string; label: string }[] }
      expect(view.state).toBe('available')
      expect(view.places.map((place) => place.kind)).toEqual(['phone'])
      expect(view.places[0]?.label).toMatch(/phone/i)
    })

    it('says nothing when the phone is on the same commit as everything else', () => {
      const v = describeUpdate({
        ...currentEverywhereElse,
        touched: { app: false, server: false, machines: false, phone: false },
      } as never)
      expect(v.state).toBe('none')
    })

    it('is its own row, never folded into the page the operator is reading', () => {
      const v = describeUpdate({
        ...currentEverywhereElse,
        touched: { app: true, server: false, machines: false, phone: true },
      } as never)

      const view = v as { places: { kind: string }[] }
      expect(view.places.map((place) => place.kind)).toEqual(['this-app', 'phone'])
    })
  })
})
