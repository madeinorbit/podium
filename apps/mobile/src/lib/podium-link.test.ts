import { afterEach, describe, expect, it } from 'vitest'
import { internalPodiumTarget, mobilePodiumRoute, setKnownPodiumOrigins } from './podium-link'

const PAIRED = 'https://ludovico.example'

const issues = [{ id: 'iss_abc', prefix: 'POD', seq: 1606, displayRef: 'POD-1606' }]
const sessions = [{ sessionId: 'sess-1', displayRef: 'POD-1606-A' }]

afterEach(() => setKnownPodiumOrigins([]))

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
})
