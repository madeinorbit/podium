import {
  CODE_FOR_UPDATE_FAILURE_TOKEN,
  UPDATE_FAILURE_EXAMPLES,
  UPDATE_FAILURE_TOKENS,
} from '@podium/protocol/update-refusal'
import { describe, expect, it } from 'vitest'
import {
  describeUpdate,
  describeUpdateFailure,
  machineFailureCopy,
  UNTRANSLATED_FAILURE_MESSAGE,
} from './update-view'

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

  it('makes a stale local page reload-only when the server cannot start an update', () => {
    const v = describeUpdate({
      ...base,
      fleet: {
        ...base.fleet,
        behind: 0,
        startability: {
          startable: false,
          reason: 'Podium is already at this version everywhere.',
        },
      },
      touched: { app: true, server: false, machines: false },
      skew: 'client-too-old',
    } as never)

    expect(v).toEqual({ state: 'local-stale', version: '0.4.2' })
  })

  it('offers no control when every affected machine is offline', () => {
    const v = describeUpdate({
      ...base,
      localVersion: '0.4.2',
      server: { appVersion: '0.4.2', target: base.server.target },
      fleet: {
        ...base.fleet,
        total: 1,
        behind: 1,
        startability: {
          startable: false,
          reason: 'No online machine can apply this update right now.',
        },
      },
      touched: { app: false, server: false, machines: true },
    } as never)

    expect(v).toEqual({ state: 'none' })
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
  /**
   * POD-2241 changed the third layer here on purpose. The diagnostic used to be
   * a HAND-WRITTEN sentence per arm ("The machines do not support this update's
   * delivery method"), which meant three tokens with three different causes
   * shared one message and were told apart only by prose this file invented.
   * The raw sentence is both more useful to the operator who has to act on it
   * and the thing the operation path already shows. What §7 keeps out of the
   * OPERATOR's two layers is the vocabulary — that is what is asserted.
   */
  it('translates an unsupported delivery failure into actionable language', () => {
    const v = describeUpdateFailure('cannot converge: unsupported-delivery', 'ludovico')
    expect(v).toEqual({
      state: 'failed',
      message: "ludovico cannot use this update's package.",
      guidance:
        "Ask the server operator to check the release includes that machine's platform and " +
        'delivery method, then try again.',
      diagnostic: 'cannot converge: unsupported-delivery',
    })
    expect(`${v.message} ${v.guidance}`).not.toContain('unsupported-delivery')
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
    expect(v.message).toMatch(/nothing was changed/i)
    expect(v.guidance).toMatch(/start it again/i)
    expect(v.guidance).toMatch(/podium setup/i)
    // Never the generic delivery copy, which would send them to the release
    // operator for a problem that lives in their own terminal.
    expect(v.message).not.toMatch(/cannot use this update/i)
    expect(`${v.message} ${v.guidance}`).not.toContain('foreground-all-in-one')
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
    expect(v.message).toMatch(/still running/i)
    expect(v.message).not.toMatch(/cannot use this update/i)
    // The prose stays jargon-free; the diagnostic keeps the one fact worth
    // keeping — WHICH migration the older build could not open.
    expect(`${v.message} ${v.guidance}`).not.toContain('schema-advanced')
    expect(v.diagnostic).toContain('transcript-segment-incarnations')
  })

  /**
   * POD-2233. The three schema tokens are NOT one failure, and this test used to
   * assert that they were — it pinned `schema-unknown` to the `schema-advanced`
   * sentence and so ratified the defect it should have caught.
   *
   * `schema-advanced` KNOWS two things: the target is behind this database, and
   * it would refuse to open it. `schema-unknown` knows NEITHER — the daemon
   * refuses precisely because nothing here can tell, and says so carefully. The
   * panel must not launder that care into a fact (§7: never assert what has not
   * been established).
   */
  it('does not claim the target is older when the daemon said it could not tell', () => {
    const v = describeUpdateFailure(
      'cannot converge: schema-unknown — 0.1.5 does not declare which schema migrations it ' +
        'can open, it is not a version this machine can prove is newer than the dev+03a2892 ' +
        'it runs',
      'ludovico',
    )

    expect(v.state).toBe('failed')
    expect(v.message).toMatch(/ludovico/)
    expect(v.message).toMatch(/still running/i)
    // Neither half of the schema-advanced sentence is known here.
    expect(v.message).not.toMatch(/older/i)
    expect(v.message).not.toMatch(/cannot open|can't open/i)
    // What IS known: the target did not declare what it can open.
    expect(v.message).toMatch(/does not say which data it can open/i)
    expect(`${v.message} ${v.guidance}`).not.toContain('schema-unknown')
    expect(v.diagnostic).toContain('dev+03a2892')
  })

  /**
   * POD-2233. The impossible next action. A coordinator running from source
   * reports `dev+<sha>`, which `isProvablyNewer` orders against NOTHING — so
   * every published release refuses with `schema-unknown` and "pick a version at
   * least as new as the one it is on" names a version that does not exist. §7
   * requires the one next action to be one that works.
   */
  it('never tells a machine that cannot order itself to pick something newer', () => {
    const v = describeUpdateFailure(
      'cannot converge: schema-unknown — 0.1.5 does not declare which schema migrations it can open',
    )

    expect(v.guidance).not.toMatch(/at least as new/i)
    expect(v.guidance).not.toMatch(/pick a (?:version|newer)/i)
    // The action that does exist is on the release, not on the operator's choice.
    expect(v.guidance).toMatch(/declares which data it can open/i)
  })

  /**
   * POD-2233. `schema-unreadable` is a third thing again: the database could not
   * be READ, so this says nothing about the target at all. It is also the only
   * one of the three where "try again" is the right next action, because a read
   * that failed on a lock or a permission can succeed on the next attempt.
   */
  it('sends an unreadable database at the machine, not at the version', () => {
    const v = describeUpdateFailure(
      "cannot converge: schema-unreadable — this machine's database could not be read " +
        '(SQLITE_CANTOPEN: unable to open database file), so there is no way to tell whether ' +
        '0.1.5 could open it',
      'ludovico',
    )

    expect(v.state).toBe('failed')
    expect(v.message).toMatch(/could not read/i)
    expect(v.message).not.toMatch(/older/i)
    expect(v.message).toMatch(/still running/i)
    expect(v.guidance).toMatch(/try again/i)
    expect(`${v.message} ${v.guidance}`).not.toContain('schema-unreadable')
    expect(v.diagnostic).toContain('SQLITE_CANTOPEN')
  })

  it('turns a dirty checkout into named, actionable copy', () => {
    const v = describeUpdateFailure('git delivery failed: dirty-working-tree', 'ludovico')

    expect(v).toMatchObject({
      state: 'failed',
      message: 'ludovico has local files or edits that prevent a safe update.',
      diagnostic: 'git delivery failed: dirty-working-tree',
    })
    expect(v.guidance).toMatch(/commit, stash, move, or locally exclude/i)
    expect(`${v.message} ${v.guidance}`).not.toContain('dirty-working-tree')
  })

  it('translates connection failures without exposing raw transport copy', () => {
    const v = describeUpdateFailure('Unable to connect. Is the computer able to access the url?')

    expect(v).toEqual({
      state: 'failed',
      message: 'Podium could not download this update.',
      guidance: 'Check the connection, then try the update again.',
      diagnostic: 'Unable to connect. Is the computer able to access the url?',
    })
    expect(`${v.message} ${v.guidance}`).not.toMatch(/unable to connect|access the url/i)
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

/**
 * THE GATE THAT MAKES A HALF-FIX IMPOSSIBLE ON THIS SIDE (POD-2241).
 *
 * The defect this closes: two readers classified the same daemon sentence, so
 * an arm added to one was half a fix and the missing half produced a CONFIDENT
 * WRONG ANSWER — "it stopped responding and will resume when it reconnects" —
 * rather than a blank. POD-2210 hit it once and POD-2239 hit it again, three
 * tokens at a time.
 *
 * There is one classifier now (`@podium/protocol`) and one copy table (this
 * file), and this block drives BOTH of this side's entry points off the shared
 * token list. Add a token to the table and this fails until somebody has said
 * what an operator should read; the mirror of it in apps/server's
 * `operation.test.ts` fails until the server has a §7 sentence for the code.
 * Between them, a token cannot exist on one side only — and it is a build
 * error, not a convention, because `MACHINE_FAILURE_COPY` is a
 * `Record<MachineFailureCode, …>`.
 */
describe('every token the daemon can produce reaches copy, on both entry points', () => {
  it('has a non-generic sentence for every token, identical on both paths', () => {
    expect(UPDATE_FAILURE_TOKENS.length).toBeGreaterThan(0)
    for (const token of UPDATE_FAILURE_TOKENS) {
      const detail = UPDATE_FAILURE_EXAMPLES[token]

      // Entry point one: the raw sentence, as an ActionError carries it.
      const described = describeUpdateFailure(detail, 'ludovico')
      expect(described.message, token).not.toBe(UNTRANSLATED_FAILURE_MESSAGE)
      expect(described.guidance.length, token).toBeGreaterThan(20)

      // Entry point two: the code, as the operation carries it. Same table, so
      // the two can no longer drift into two answers for one refusal.
      const copy = machineFailureCopy(CODE_FOR_UPDATE_FAILURE_TOKEN[token], 'ludovico')
      expect(copy, token).toBeDefined()
      expect(copy?.message, token).toBe(described.message)
      expect(copy?.nextAction, token).toBe(described.guidance)
    }
  })

  /**
   * The harm, stated directly. Only the machine that actually went quiet may be
   * described as having stopped responding, and only it may be promised a
   * recovery — everything else here is a machine that is running and answering,
   * for which both halves of that sentence are false and the second can never
   * become true.
   */
  it('never tells the operator a machine that answered on purpose stopped responding', () => {
    for (const token of UPDATE_FAILURE_TOKENS) {
      if (token === 'stopped-reporting-progress') continue
      const v = describeUpdateFailure(UPDATE_FAILURE_EXAMPLES[token], 'ludovico')
      const said = `${v.message} ${v.guidance}`
      expect(said, token).not.toMatch(/stopped responding/i)
      expect(said, token).not.toMatch(/resume when it reconnects/i)
    }
  })

  /** §7's layers stay separated: vocabulary in the diagnostic, never in the copy. */
  it('keeps the raw token out of the two layers a person reads', () => {
    for (const token of UPDATE_FAILURE_TOKENS) {
      const detail = UPDATE_FAILURE_EXAMPLES[token]
      const v = describeUpdateFailure(detail, 'ludovico')
      expect(`${v.message} ${v.guidance}`, token).not.toContain(token)
      expect(v.diagnostic, token).toBe(detail)
    }
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
