import { describe, expect, it } from 'vitest'
import type { UiSource } from '@/lib/ui-source'
import { type ComponentVersionsInput, componentVersions } from './version-rows'

const live: UiSource = { kind: 'live', label: 'Live server' }
const cached: UiSource = {
  kind: 'cache',
  label: 'Offline cache',
  note: 'This page came from the copy saved on this device, not from the server.',
}
const baked: UiSource = { kind: 'baked', label: 'Built-in copy', note: 'fell back' }

function input(over: Partial<ComponentVersionsInput> = {}): ComponentVersionsInput {
  return {
    serverVersion: '0.1.1-edge.1',
    serverDigest: '47a01e3',
    page: { version: '0.1.1-edge.1', digest: '47a01e3', source: live },
    phone: { present: true, appVersion: '0.1.1-edge.1', digest: '47a01e3' },
    servedWebDigest: '47a01e3',
    channel: 'edge',
    ...over,
  }
}

function row(view: ReturnType<typeof componentVersions>, key: string) {
  return view.rows.find((candidate) => candidate.key === key)
}

describe('componentVersions', () => {
  it('collapses to one line when every present component agrees', () => {
    const view = componentVersions(input({ desktopVersion: '0.1.1-edge.1' }))
    expect(view.single).toBe('0.1.1-edge.1')
  })

  it('collapses in a plain browser, where there is no shell to report', () => {
    expect(componentVersions(input()).single).toBe('0.1.1-edge.1')
  })

  it('collapses when display labels differ but source digests agree', () => {
    const view = componentVersions(
      input({
        serverVersion: 'dev+a5f041c',
        serverDigest: 'a5f041c',
        page: { version: '0.1.1-edge.1', digest: 'a5f041c', source: live },
        phone: { present: true, appVersion: '0.1.1-edge.1', digest: 'a5f041c' },
        servedWebDigest: 'a5f041c',
      }),
    )
    expect(view.single).toBe('dev+a5f041c')
  })

  it('collapses when the offline cache holds the build the server is on', () => {
    expect(
      componentVersions(input({ page: { version: '0.1.1-edge.1', source: cached } })).single,
    ).toBe('0.1.1-edge.1')
  })

  it('claims nothing while the server version is unknown', () => {
    const view = componentVersions(input({ serverVersion: undefined }))
    expect(view.single).toBeNull()
    expect(row(view, 'server')).toBeUndefined()
    expect(row(view, 'interface')?.mark).toBeUndefined()
  })

  it('marks a shell that trails its server on Development as expected', () => {
    const view = componentVersions(input({ channel: 'dev', desktopVersion: '0.1.0-edge.20' }))
    expect(view.single).toBeNull()
    const desktop = row(view, 'desktop')
    expect(desktop?.value).toBe('0.1.0-edge.20')
    expect(desktop?.mark).toBe('expected')
    expect(desktop?.note).toContain('Edge')
  })

  it('marks a trailing shell on a released channel as expected too', () => {
    const view = componentVersions(input({ channel: 'stable', desktopVersion: '0.1.0' }))
    expect(row(view, 'desktop')?.mark).toBe('expected')
    expect(row(view, 'desktop')?.note).toContain('only when the frame itself changes')
  })

  it('lists every component once anything diverges', () => {
    const view = componentVersions(input({ channel: 'dev', desktopVersion: '0.1.0-edge.20' }))
    expect(view.rows.map((r) => r.key)).toEqual(['server', 'interface', 'phone', 'desktop'])
  })

  it('marks a page that trails the server as expected, and says reloading fixes it', () => {
    const view = componentVersions(input({ page: { version: '0.1.0', source: live } }))
    expect(view.single).toBeNull()
    expect(row(view, 'interface')?.mark).toBe('expected')
    expect(row(view, 'interface')?.note).toContain('Reloading')
  })

  it('opens the breakdown for the built-in copy even when the versions agree', () => {
    const view = componentVersions(input({ page: { version: '0.1.1-edge.1', source: baked } }))
    expect(view.single).toBeNull()
    expect(row(view, 'interface')?.prefix).toBe('Built-in copy')
    expect(row(view, 'interface')?.mark).toBe('expected')
  })

  it('marks a phone bundle from another build as unexpected', () => {
    const view = componentVersions(input({ phone: { present: true, appVersion: '0.1.0' } }))
    expect(row(view, 'phone')?.mark).toBe('unexpected')
  })

  it('compares an unversioned phone bundle by digest without printing one', () => {
    const differs = componentVersions(input({ phone: { present: true, digest: 'aaaaaaa' } }))
    expect(row(differs, 'phone')?.value).toBe('Different build from this window')
    expect(row(differs, 'phone')?.mark).toBe('unexpected')
    expect(JSON.stringify(differs)).not.toContain('aaaaaaa')

    const same = componentVersions(input({ phone: { present: true, digest: '47a01e3' } }))
    expect(same.single).toBe('0.1.1-edge.1')
  })

  it('refuses to read an unreportable phone bundle as agreement', () => {
    const view = componentVersions(input({ phone: { present: true } }))
    expect(view.single).toBeNull()
    expect(row(view, 'phone')?.value).toBe('Build identity unavailable')
    expect(row(view, 'phone')?.mark).toBeUndefined()
  })

  it('leaves out the phone row where no phone bundle is served', () => {
    const view = componentVersions(input({ phone: { present: false } }))
    expect(row(view, 'phone')).toBeUndefined()
    expect(view.single).toBe('0.1.1-edge.1')
  })
})

describe('componentVersions phone source', () => {
  it('flags a phone bundle built from different source even at the same version', () => {
    const view = componentVersions(
      input({ phone: { present: true, appVersion: '0.1.1-edge.1', digest: 'aaaaaaa' } }),
    )
    expect(view.single).toBeNull()
    const phone = view.rows.find((r) => r.key === 'phone')
    expect(phone?.value).toBe('0.1.1-edge.1')
    expect(phone?.mark).toBe('unexpected')
    expect(phone?.note).toContain('different source')
  })
})
