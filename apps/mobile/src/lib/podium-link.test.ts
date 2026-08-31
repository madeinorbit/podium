import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  followPodiumLink,
  internalPodiumTarget,
  mobilePodiumRoute,
  setActivePodiumOrigin,
  setKnownPodiumOrigins,
  setPodiumTargetActivator,
} from './podium-link'

const PAIRED = 'https://ludovico.example'

const issues = [{ id: 'iss_abc', prefix: 'POD', seq: 1606, displayRef: 'POD-1606' }]
const sessions = [{ sessionId: 'sess-1', displayRef: 'POD-1606-A' }]

afterEach(() => {
  setKnownPodiumOrigins([])
  setActivePodiumOrigin(null)
  setPodiumTargetActivator(null)
})

describe('a link on a paired server', () => {
  it('is ours once the server is paired, and nobody else’s before that', () => {
    expect(internalPodiumTarget(`${PAIRED}/issues/POD-1606`)).toBeNull()
    setKnownPodiumOrigins([PAIRED])
    expect(internalPodiumTarget(`${PAIRED}/issues/POD-1606`)).toEqual({
      kind: 'issue',
      issue: 'POD-1606',
    })
  })

  it('does not claim a different server', () => {
    setKnownPodiumOrigins([PAIRED])
    expect(internalPodiumTarget('https://elsewhere.example/issues/POD-1606')).toBeNull()
  })
})

describe('mobilePodiumRoute', () => {
  it('routes an issue ref to the screen, by the id the screen wants', () => {
    // The address space is plural (`/issues/…`), the route tree singular
    // (`/issue/[issueId]`) — the reason the resolver returns a target, not a path.
    expect(mobilePodiumRoute({ kind: 'issue', issue: 'POD-1606' }, { issues, sessions })).toBe(
      '/issue/iss_abc',
    )
  })

  it('routes a session by its birth ref as well as its id', () => {
    expect(
      mobilePodiumRoute({ kind: 'session', session: 'POD-1606-A' }, { issues, sessions }),
    ).toBe('/session/sess-1')
    expect(mobilePodiumRoute({ kind: 'session', session: 'sess-1' }, { issues, sessions })).toBe(
      '/session/sess-1',
    )
  })

  it('has no screen for an artifact or a file, and says so', () => {
    expect(
      mobilePodiumRoute(
        { kind: 'artifact', issue: 'POD-1606', artifactId: 'a', entry: null },
        {
          issues,
          sessions,
        },
      ),
    ).toBeNull()
    expect(
      mobilePodiumRoute(
        { kind: 'file', path: '/w/a.ts', root: '/w', machineId: null },
        {
          issues,
          sessions,
        },
      ),
    ).toBeNull()
  })

  it('routes nothing for a row this phone has not received', () => {
    expect(mobilePodiumRoute({ kind: 'issue', issue: 'POD-9999' }, { issues, sessions })).toBeNull()
    expect(
      mobilePodiumRoute({ kind: 'session', session: 'POD-9999-A' }, { issues, sessions }),
    ).toBeNull()
  })

  it('does not claim a typed target when doing so would drop its detail', () => {
    expect(
      mobilePodiumRoute(
        { kind: 'issue', issue: 'POD-1606', search: '?tab=activity', hash: '#latest' },
        { issues, sessions },
      ),
    ).toBeNull()
  })
})

describe('followPodiumLink', () => {
  it('prefers the screen, and falls back to the browser for what has none', async () => {
    const { Linking } = await import('react-native')
    const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(true)
    const activate = vi.fn(() => true)
    setKnownPodiumOrigins([PAIRED])
    setActivePodiumOrigin(PAIRED)
    setPodiumTargetActivator(activate)

    followPodiumLink(`${PAIRED}/issues/POD-1606`)
    expect(activate).toHaveBeenCalledWith({ kind: 'issue', issue: 'POD-1606' })
    expect(openURL).not.toHaveBeenCalled()

    // An artifact has no screen on the phone; the browser can render the bytes,
    // which beats a tap that does nothing.
    activate.mockReturnValue(false)
    followPodiumLink(`${PAIRED}/issues/POD-1606/artifacts/art1`)
    expect(openURL).toHaveBeenCalledWith(`${PAIRED}/issues/POD-1606/artifacts/art1`)

    setPodiumTargetActivator(null)
    openURL.mockRestore()
  })

  it('drops a host-less address rather than handing the OS a broken URL', async () => {
    const { Linking } = await import('react-native')
    const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(true)
    setPodiumTargetActivator(() => false)
    followPodiumLink('podium://issues/POD-1606')
    expect(openURL).not.toHaveBeenCalled()
    setPodiumTargetActivator(null)
    openURL.mockRestore()
  })

  it('uses the active server when a host-less address needs browser fallback', async () => {
    const { Linking } = await import('react-native')
    const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(true)
    setActivePodiumOrigin('https://configured.example')
    setPodiumTargetActivator(() => false)

    followPodiumLink('podium://issues/POD-1606/artifacts/art1')
    expect(openURL).toHaveBeenCalledWith(
      'https://configured.example/issues/POD-1606/artifacts/art1',
    )

    setPodiumTargetActivator(null)
    openURL.mockRestore()
  })

  it('retains a file server selector in browser fallback instead of opening active A', async () => {
    const { Linking } = await import('react-native')
    const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(true)
    setActivePodiumOrigin('https://active-a.example')

    followPodiumLink('/file?path=%2Fw%2Fa.ts&root=%2Fw&server=wss%3A%2F%2Fselected-b.example')
    expect(openURL).toHaveBeenCalledWith(
      'https://active-a.example/file?path=%2Fw%2Fa.ts&root=%2Fw&server=wss%3A%2F%2Fselected-b.example',
    )

    openURL.mockRestore()
  })

  it('keeps unknown file fallback query bytes exact', async () => {
    const { Linking } = await import('react-native')
    const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(true)
    const active = 'https://active-a.example'
    const href =
      '/file?label=hello%20world&&root=%2fw&path=%2fw%2fa.ts&path=%2Fduplicate&signature=a%2Fb%3D'
    setActivePodiumOrigin(active)

    followPodiumLink(href)
    expect(openURL).toHaveBeenCalledWith(`${active}${href}`)

    openURL.mockRestore()
  })

  it('keeps custom-scheme file fallback query bytes exact', async () => {
    const { Linking } = await import('react-native')
    const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(true)
    const active = 'https://active-a.example'
    const href =
      'podium://file?label=hello%20world&&root=%2fw&path=%2fw%2fa.ts&path=%2Fduplicate&signature=a%2Fb%3D#x%2fy'
    setActivePodiumOrigin(active)

    followPodiumLink(href)
    expect(openURL).toHaveBeenCalledWith(
      `${active}/file?label=hello%20world&&root=%2fw&path=%2fw%2fa.ts&path=%2Fduplicate&signature=a%2Fb%3D#x%2fy`,
    )

    openURL.mockRestore()
  })

  it('never resolves another paired server against the active replica', async () => {
    const { Linking } = await import('react-native')
    const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(true)
    const activate = vi.fn(() => true)
    const other = 'https://other-paired.example'
    setKnownPodiumOrigins([PAIRED, other])
    setActivePodiumOrigin(PAIRED)
    setPodiumTargetActivator(activate)

    followPodiumLink(`${other}/issues/POD-1606`)
    expect(activate).not.toHaveBeenCalled()
    expect(openURL).toHaveBeenCalledWith(`${other}/issues/POD-1606`)

    setPodiumTargetActivator(null)
    openURL.mockRestore()
  })

  it('gives every accepted protocol-relative spelling an OS-openable scheme', async () => {
    const { Linking } = await import('react-native')
    const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(true)
    setActivePodiumOrigin('http://127.0.0.1:8787')

    for (const href of [
      '//example.test/guide',
      '/\\example.test/guide',
      '\\/example.test/guide',
      '\\\\example.test\\guide',
    ]) {
      followPodiumLink(href)
    }
    expect(openURL.mock.calls.map(([href]) => href)).toEqual([
      'http://example.test/guide',
      'http://example.test/guide',
      'http://example.test/guide',
      'http://example.test/guide',
    ])

    openURL.mockRestore()
  })

  it('does not rewrite backslashes inside protocol-relative query or fragment detail', async () => {
    const { Linking } = await import('react-native')
    const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(true)
    setActivePodiumOrigin('http://127.0.0.1:8787')
    const href = String.raw`//example.test/search?q=C:\Users#x\y`

    followPodiumLink(href)
    expect(openURL).toHaveBeenCalledWith(`http:${href}`)

    openURL.mockRestore()
  })
})

describe('the two origin slots (POD-1606 finding 4)', () => {
  it('survives the profile gate rewriting its list after the host set the active one', () => {
    // <PodiumLinkHost> is a DESCENDANT of <ServerProfileGate>, so its effect
    // runs first; a single shared array meant the gate's next write erased the
    // active server — and with EXPO_PUBLIC_PODIUM_SERVER there is no profile
    // row to put it back.
    setActivePodiumOrigin('https://configured.example')
    setKnownPodiumOrigins([])
    expect(internalPodiumTarget('https://configured.example/issues/POD-1606')).not.toBeNull()

    setKnownPodiumOrigins([PAIRED])
    expect(internalPodiumTarget('https://configured.example/issues/POD-1606')).not.toBeNull()
    expect(internalPodiumTarget(`${PAIRED}/issues/POD-1606`)).not.toBeNull()
    setActivePodiumOrigin(null)
  })

  it('forgets the active server when the client provider goes away', () => {
    setActivePodiumOrigin('https://configured.example')
    setActivePodiumOrigin(null)
    expect(internalPodiumTarget('https://configured.example/issues/POD-1606')).toBeNull()
  })
})
