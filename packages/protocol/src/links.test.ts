import { describe, expect, it } from 'vitest'
import {
  canonicalPodiumOrigin,
  formatPodiumLink,
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

  it('falls back to a plain view rather than failing', () => {
    expect(podiumTargetForPath('/settings/general')).toEqual({
      kind: 'view',
      path: '/settings/general',
      search: '',
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
      { kind: 'file', path: '/w/src/a.ts', root: null, machineId: null },
    ] as const
    for (const target of targets) {
      const path = podiumTargetPath(target)
      const query = path.indexOf('?')
      const parsed =
        query === -1
          ? podiumTargetForPath(path)
          : podiumTargetForPath(path.slice(0, query), path.slice(query))
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
