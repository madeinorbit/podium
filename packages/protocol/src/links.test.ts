import { describe, expect, it } from 'vitest'
import {
  canonicalPodiumOrigin,
  formatPodiumLink,
  formatPodiumLinkFallback,
  isInternalPodiumLink,
  parsePodiumLink,
  podiumTargetForPath,
  podiumTargetPath,
} from './links'

const HOME = 'http://127.0.0.1:8787'
const known = { knownOrigins: [HOME, 'https://podium.example'] }

describe('parsePodiumLink — which Podium is ours', () => {
  it('reads a known server origin as internal, whatever the page origin is', () => {
    // The bug this whole module exists for: in the packaged macOS app the page
    // is tauri://localhost and the server is 127.0.0.1, so an origin comparison
    // against the PAGE sent the reader's own Podium to Safari.
    const link = parsePodiumLink(`${HOME}/issues/POD-1606`, known)
    expect(link).toEqual({
      kind: 'internal',
      origin: HOME,
      target: { kind: 'issue', issue: 'POD-1606' },
    })
  })

  it('reads any other origin as external', () => {
    expect(parsePodiumLink('https://preview.example.com/login', known)).toEqual({
      kind: 'external',
      href: 'https://preview.example.com/login',
    })
  })

  it('knows more than one Podium at once', () => {
    expect(isInternalPodiumLink('https://podium.example/usage', known)).toBe(true)
    expect(isInternalPodiumLink('https://podium.example.evil.test/usage', known)).toBe(false)
  })

  it('has no opinion without known origins — everything is someone else', () => {
    expect(parsePodiumLink(`${HOME}/issues/POD-1606`)).toEqual({
      kind: 'external',
      href: `${HOME}/issues/POD-1606`,
    })
  })

  it('accepts a ws(s) relay URL as a known origin', () => {
    expect(
      isInternalPodiumLink('https://relay.example/issues/POD-1', {
        knownOrigins: ['wss://relay.example'],
      }),
    ).toBe(true)
  })

  it('matches the port, not just the host', () => {
    expect(isInternalPodiumLink('http://127.0.0.1:9999/issues/POD-1', known)).toBe(false)
  })

  it('refuses a userinfo host that only looks like ours', () => {
    expect(parsePodiumLink(`http://127.0.0.1:8787@evil.test/issues/POD-1`, known)).toEqual({
      kind: 'external',
      href: 'http://127.0.0.1:8787@evil.test/issues/POD-1',
    })
  })
})

describe('parsePodiumLink — schemes', () => {
  it('drops a scheme that is not worth linking at all', () => {
    expect(parsePodiumLink('javascript:alert(1)', known)).toBeNull()
    expect(parsePodiumLink('data:text/html,<b>x</b>', known)).toBeNull()
    expect(parsePodiumLink('', known)).toBeNull()
  })

  it('keeps mailto and tel as external, for the OS to answer', () => {
    expect(parsePodiumLink('mailto:a@b.test', known)?.kind).toBe('external')
    expect(parsePodiumLink('tel:+15551234', known)?.kind).toBe('external')
  })

  it('reads a podium:// link as this Podium, with no origin', () => {
    expect(parsePodiumLink('podium://issues/POD-1606')).toEqual({
      kind: 'internal',
      origin: null,
      target: { kind: 'issue', issue: 'POD-1606' },
    })
  })

  it('leaves a pairing URL to the pairing parser', () => {
    // parseMobilePairingUrl owns this one: it carries a credential, and routing
    // it as navigation would drop the pairing handshake on the floor.
    expect(parsePodiumLink('podium://pair/eyJ2IjoyfQ')).toBeNull()
  })
})

describe('parsePodiumLink — relative hrefs', () => {
  it('treats a root-relative href as internal without any origin', () => {
    expect(parsePodiumLink('/issues/POD-1606')).toEqual({
      kind: 'internal',
      origin: null,
      target: { kind: 'issue', issue: 'POD-1606' },
    })
  })

  it('does not mistake a protocol-relative URL for a relative one', () => {
    expect(parsePodiumLink('//evil.test/issues/POD-1', known)).toEqual({
      kind: 'external',
      href: '//evil.test/issues/POD-1',
    })
  })

  it('splits the query off a relative address', () => {
    expect(parsePodiumLink('/file?path=%2Fw%2Fa.ts&root=%2Fw')).toEqual({
      kind: 'internal',
      origin: null,
      target: { kind: 'file', path: '/w/a.ts', root: '/w', machineId: null },
    })
  })
})

describe('podiumTargetForPath', () => {
  it('names an issue by id or by ref', () => {
    expect(podiumTargetForPath('/issues/iss_abc')).toEqual({ kind: 'issue', issue: 'iss_abc' })
    expect(podiumTargetForPath('/issue/POD-1606')).toEqual({ kind: 'issue', issue: 'POD-1606' })
  })

  it('names a session, including a draft ref', () => {
    expect(podiumTargetForPath('/sessions/POD-1606-A')).toEqual({
      kind: 'session',
      session: 'POD-1606-A',
    })
    expect(podiumTargetForPath('/session/POD-DRAFT-3')).toEqual({
      kind: 'session',
      session: 'POD-DRAFT-3',
    })
  })

  it('names an artifact, with and without an entry inside it', () => {
    expect(podiumTargetForPath('/issues/POD-1606/artifacts/art1')).toEqual({
      kind: 'artifact',
      issue: 'POD-1606',
      artifactId: 'art1',
      entry: null,
    })
    expect(podiumTargetForPath('/issues/POD-1606/artifacts/art1/shots/a.png')).toEqual({
      kind: 'artifact',
      issue: 'POD-1606',
      artifactId: 'art1',
      entry: 'shots/a.png',
    })
  })

  it('names a file by its query, because a path has slashes in it', () => {
    expect(podiumTargetForPath('/file', '?path=%2Fw%2Fsrc%2Fa.ts&root=%2Fw&machineId=m1')).toEqual({
      kind: 'file',
      path: '/w/src/a.ts',
      root: '/w',
      machineId: 'm1',
    })
  })

  it('retains file query keys that are not part of its identity', () => {
    expect(
      podiumTargetForPath(
        '/file',
        '?path=%2Fw%2Fsrc%2Fa.ts&root=%2Fw&server=wss%3A%2F%2FB&line=42',
      ),
    ).toEqual({
      kind: 'file',
      path: '/w/src/a.ts',
      root: '/w',
      machineId: null,
      search: '?server=wss%3A%2F%2FB&line=42',
    })
  })

  it('preserves unconsumed file query bytes instead of normalizing them', () => {
    const target = podiumTargetForPath(
      '/file',
      '?path=%2Fw%2Fa.ts&root=%2Fw&label=hello%20world&signature=a%2Fb%3D',
    )
    expect(target).toEqual({
      kind: 'file',
      path: '/w/a.ts',
      root: '/w',
      machineId: null,
      search: '?label=hello%20world&signature=a%2Fb%3D',
    })
    expect(podiumTargetPath(target)).toBe(
      '/file?path=%2Fw%2Fa.ts&root=%2Fw&label=hello%20world&signature=a%2Fb%3D',
    )
  })

  it('preserves the complete validated root-relative href for fallback', () => {
    const href =
      '/file?label=hello%20world&&root=%2fw&path=%2fw%2fa.ts&path=%2Fduplicate&signature=a%2Fb%3D'
    const link = parsePodiumLink(href)
    expect(link?.kind).toBe('internal')
    if (link?.kind !== 'internal') throw new Error('expected internal link')
    expect(link.target).toMatchObject({
      kind: 'file',
      path: '/w/a.ts',
      root: '/w',
      search: '?label=hello%20world&&signature=a%2Fb%3D',
    })
    expect(formatPodiumLinkFallback(HOME, href, link)).toBe(`${HOME}${href}`)
  })

  it('preserves a custom-scheme file suffix byte-for-byte for HTTP fallback', () => {
    const href =
      'podium://file?label=hello%20world&&root=%2fw&path=%2fw%2fa.ts&path=%2Fduplicate&signature=a%2Fb%3D#x%2fy'
    const link = parsePodiumLink(href)
    expect(link?.kind).toBe('internal')
    if (link?.kind !== 'internal') throw new Error('expected internal link')
    expect(formatPodiumLinkFallback(HOME, href, link)).toBe(
      `${HOME}/file?label=hello%20world&&root=%2fw&path=%2fw%2fa.ts&path=%2Fduplicate&signature=a%2Fb%3D#x%2fy`,
    )
  })

  it('falls back to a plain view rather than failing', () => {
    expect(podiumTargetForPath('/settings/general')).toEqual({
      kind: 'view',
      path: '/settings/general',
      search: '',
      hash: '',
    })
    // An address a newer build understands is still inside Podium.
    expect(podiumTargetForPath('/some/future/page').kind).toBe('view')
    // A file address with no path names no file.
    expect(podiumTargetForPath('/file', '?root=%2Fw').kind).toBe('view')
  })

  it('decodes segments that were encoded on the way in', () => {
    expect(podiumTargetForPath('/issues/POD-1606/artifacts/art1/my%20shot.png')).toEqual({
      kind: 'artifact',
      issue: 'POD-1606',
      artifactId: 'art1',
      entry: 'my shot.png',
    })
  })
})

describe('podiumTargetPath / formatPodiumLink', () => {
  it('round-trips every target through its canonical path', () => {
    const targets = [
      { kind: 'issue', issue: 'POD-1606' },
      { kind: 'session', session: 'POD-1606-A' },
      { kind: 'artifact', issue: 'POD-1606', artifactId: 'art1', entry: null },
      { kind: 'artifact', issue: 'POD-1606', artifactId: 'art1', entry: 'shots/a b.png' },
      { kind: 'file', path: '/w/src/a.ts', root: '/w', machineId: 'm1' },
      { kind: 'file', path: '/w/src/a.ts', root: '/w', machineId: null, search: '?line=42' },
      { kind: 'file', path: '/w/src/a.ts', root: null, machineId: null },
      { kind: 'view', path: '/settings/general', search: '?tab=x', hash: '#advanced' },
    ] as const
    for (const target of targets) {
      const path = podiumTargetPath(target)
      const query = path.indexOf('?')
      const fragment = path.indexOf('#')
      const end = fragment === -1 ? path.length : fragment
      const parsed = podiumTargetForPath(
        query === -1 || query > end ? path.slice(0, end) : path.slice(0, query),
        query === -1 || query > end ? '' : path.slice(query, end),
        fragment === -1 ? '' : path.slice(fragment),
      )
      expect(parsed, path).toEqual(target)
    }
  })

  it('builds a shareable address on the SERVER origin, not the page origin', () => {
    expect(formatPodiumLink(`${HOME}/`, { kind: 'issue', issue: 'POD-1606' })).toBe(
      `${HOME}/issues/POD-1606`,
    )
  })
})

describe('canonicalPodiumOrigin', () => {
  it('normalizes scheme, default port and trailing path away', () => {
    expect(canonicalPodiumOrigin('wss://h.test/')).toBe('https://h.test')
    expect(canonicalPodiumOrigin('https://h.test:443')).toBe('https://h.test')
    expect(canonicalPodiumOrigin('HTTP://H.test:8787')).toBe('http://h.test:8787')
  })

  it('declines anything that is not an http(s) origin', () => {
    expect(canonicalPodiumOrigin('tauri://localhost')).toBeNull()
    expect(canonicalPodiumOrigin('not a url')).toBeNull()
  })
})

describe('the guards the reviewer went looking for', () => {
  it('refuses every spelling of a pairing URL, not just the lowercase host', () => {
    // `podium:` is not a special scheme, so the parser leaves its host's case
    // alone and `podium:///pair` moves the same word into the path. Both carry a
    // credential and both belong to parseMobilePairingUrl.
    expect(parsePodiumLink('podium://pair?token=abc')).toBeNull()
    expect(parsePodiumLink('podium://PAIR?token=abc')).toBeNull()
    expect(parsePodiumLink('podium:///pair?token=abc')).toBeNull()
    expect(parsePodiumLink('podium:///Pair/eyJ2IjoyfQ')).toBeNull()
  })

  it('keeps the fragment, which names the part of the page the writer meant', () => {
    expect(parsePodiumLink(`${HOME}/settings/general#advanced`, known)).toEqual({
      kind: 'internal',
      origin: HOME,
      target: { kind: 'view', path: '/settings/general', search: '', hash: '#advanced' },
    })
    expect(parsePodiumLink('/usage#by-agent')).toEqual({
      kind: 'internal',
      origin: null,
      target: { kind: 'view', path: '/usage', search: '', hash: '#by-agent' },
    })
  })

  it('keeps query and fragment detail on typed targets too', () => {
    const target = {
      kind: 'issue',
      issue: 'POD-1606',
      search: '?tab=activity',
      hash: '#latest',
    } as const
    expect(parsePodiumLink(`${HOME}/issues/POD-1606?tab=activity#latest`, known)).toEqual({
      kind: 'internal',
      origin: HOME,
      target,
    })
    expect(podiumTargetPath(target)).toBe('/issues/POD-1606?tab=activity#latest')
  })

  it('sees the address the BROWSER will see, not the one the text spells', () => {
    // A URL parser strips tab/LF/CR and reads a backslash as a slash, so both of
    // these resolve to evil.example — they are not root-relative at all, and
    // "root-relative is always ours" would hand an attacker the internal path.
    expect(parsePodiumLink('/\\evil.example/issues/POD-1', known)?.kind).toBe('external')
    expect(parsePodiumLink('/\t/evil.example/issues/POD-1', known)?.kind).toBe('external')
    expect(parsePodiumLink('\\\\evil.example/issues/POD-1', known)?.kind).toBe('external')
    // And a path that only LOOKS like one of those is still an ordinary page:
    // `/evil.example/x` is one slash and names something on this server.
    expect(parsePodiumLink('/evil.example/issues/POD-1', known)?.kind).toBe('internal')
  })

  it('hands a malformed http address to the OS rather than dropping the click', () => {
    // A trailing-dot host fails the IPv4 parse. null means "not a link at all",
    // which on the phone is a tap that does nothing; external is a tap the
    // browser can answer.
    expect(parsePodiumLink('http://127.0.0.1:8787./issues/POD-1', known)).toEqual({
      kind: 'external',
      href: 'http://127.0.0.1:8787./issues/POD-1',
    })
    expect(parsePodiumLink('not a url at all', known)).toBeNull()
  })

  it('drops a knownOrigins entry that is not an origin instead of matching on it', () => {
    for (const bogus of ['', 'evil', '/relative', 'tauri://localhost']) {
      expect(isInternalPodiumLink(`${HOME}/issues/POD-1`, { knownOrigins: [bogus] }), bogus).toBe(
        false,
      )
    }
  })

  it('cannot round-trip a slash inside one artifact entry segment, and says so', () => {
    // `entry` is a slash-separated relpath; a segment containing a literal slash
    // has no spelling in the address. Asserted so the round-trip test above is
    // not read as proof of a property that does not hold.
    const target = { kind: 'artifact', issue: 'i', artifactId: 'a', entry: 'x/y' } as const
    expect(podiumTargetPath(target)).toBe('/issues/i/artifacts/a/x/y')
    expect(podiumTargetForPath('/issues/i/artifacts/a/x%2Fy')).toEqual(target)
  })
})
