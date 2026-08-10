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
})
