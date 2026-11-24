import { parsePodiumLink } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { consoleRoute, consoleSessionTarget } from './console-route'

describe('console link destinations', () => {
  it.each([
    ['podium://session/lead/terminal', 'lead'],
    ['podium:///session/lead/terminal', 'lead'],
    ['podium://sessions/REP-138-A/terminal', 'REP-138-A'],
    ['/session/seat%20one/terminal', 'seat one'],
  ])('uses shared session resolution for %s', (href, session) => {
    const link = parsePodiumLink(href)
    if (link?.kind !== 'internal') throw new Error('Expected internal link')
    expect(consoleSessionTarget(link.target)).toEqual({ kind: 'session', session })
    expect(consoleRoute('/session/resolved-id', link.target)).toBe('/session/resolved-id/terminal')
  })

  it.each([
    '/session/lead',
    '/session/lead/terminal/extra',
    '/session/%ZZ/terminal',
    '/session/lead/terminal?unknown=1',
    '/session/lead/terminal#unknown',
    '/issue/task',
  ])('does not reinterpret or discard detail from %s', (href) => {
    const link = parsePodiumLink(href)
    if (link?.kind !== 'internal') throw new Error('Expected internal link')
    expect(consoleSessionTarget(link.target)).toBeNull()
    expect(consoleRoute('/resolved', link.target)).toBe('/resolved')
  })
})
