import { describe, expect, it } from 'vitest'
import { describeUpdate } from './update-view'

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

  it('tells the user to move the SERVER when this client is ahead of it', () => {
    const v = describeUpdate({ ...base, skew: 'client-too-new' } as never)
    expect(v.state).toBe('required')
    expect((v as { reason?: string }).reason).toMatch(/server/i)
    expect((v as { reason?: string }).reason).not.toMatch(/rebuild|reload/i)
  })

  it('folds the whole desktop all-in-one stack into one place', () => {
    const v = describeUpdate({ ...base, surface: 'desktop-all-in-one' } as never)
    const kinds = (v as { places: { kind: string }[] }).places.map((p) => p.kind)
    expect(kinds).not.toContain('server')
    expect(kinds).toContain('this-app')
  })

  it('reports progress while a wave is running', () => {
    const v = describeUpdate({
      ...base,
      fleet: { total: 3, behind: 1, converging: 2, failed: 0 },
    } as never)
    expect(v).toMatchObject({ state: 'in-progress', done: 0, total: 3 })
  })

  it('translates an unsupported delivery failure into actionable language', () => {
    const v = describeUpdate({
      ...base,
      fleet: {
        total: 3,
        behind: 0,
        converging: 0,
        failed: 1,
        machines: [{ state: 'rejected', detail: 'cannot converge: unsupported-delivery' }],
      },
      touched: { app: false, server: false, machines: false },
    } as never)
    expect(v).toEqual({
      state: 'failed',
      message: 'One or more machines cannot use this update.',
      guidance:
        'Ask the server operator to check the release package for those machines, then try again.',
      diagnostic: "The machines do not support this update's delivery method.",
    })
    expect(JSON.stringify(v)).not.toContain('unsupported-delivery')
  })

  it('turns a dirty checkout into named, actionable copy', () => {
    const v = describeUpdate({
      ...base,
      fleet: {
        total: 1,
        behind: 0,
        converging: 0,
        failed: 1,
        machines: [
          { name: 'ludovico', state: 'stuck', detail: 'git delivery failed: dirty-working-tree' },
        ],
      },
    } as never)

    expect(v).toMatchObject({
      state: 'failed',
      message: 'ludovico has local files or edits that prevent a safe update.',
      diagnostic: 'Git delivery stopped because the checkout is not clean.',
    })
    expect((v as { guidance: string }).guidance).toMatch(/commit, stash, move, or locally exclude/i)
    expect(JSON.stringify(v)).not.toContain('dirty-working-tree')
  })

  it('translates connection failures without exposing raw transport copy', () => {
    const v = describeUpdate({
      ...base,
      fleet: {
        total: 1,
        behind: 0,
        converging: 0,
        failed: 1,
        machines: [
          {
            state: 'stuck',
            detail: 'Unable to connect. Is the computer able to access the url?',
          },
        ],
      },
    } as never)

    expect(v).toEqual({
      state: 'failed',
      message: 'Podium could not reach the update source.',
      guidance: "Check this server's internet connection, then try the update again.",
      diagnostic: 'The update could not be downloaded.',
    })
    expect(JSON.stringify(v)).not.toMatch(/unable to connect|access the url/i)
  })

  it('keeps an unknown failure as support detail', () => {
    const v = describeUpdate({
      ...base,
      fleet: {
        total: 1,
        behind: 0,
        converging: 0,
        failed: 1,
        machines: [{ state: 'stuck', detail: 'ludovico did not come back' }],
      },
    } as never)

    expect(v).toMatchObject({
      state: 'failed',
      message: 'Podium could not finish the update.',
      diagnostic: 'ludovico did not come back',
    })
  })

  it('tells the operator a silent machine was given up on, and that retry is the fix', () => {
    const v = describeUpdate({
      ...base,
      fleet: {
        total: 1,
        behind: 0,
        converging: 0,
        failed: 1,
        machines: [
          { state: 'stuck', detail: 'The machine stopped reporting progress while updating.' },
        ],
      },
    } as never)

    expect(v).toMatchObject({ state: 'failed' })
    const failure = v as { message: string; guidance: string }
    expect(failure.message).toBe('A machine stopped responding while updating.')
    expect(failure.guidance).toMatch(/apply the update again/i)
  })

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
})
