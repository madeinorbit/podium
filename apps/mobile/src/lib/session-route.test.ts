import { describe, expect, it } from 'vitest'
import { hasSessionBackTarget, sessionBackTarget, sessionHref } from './session-route'

describe('session routes', () => {
  it('carries the in-app return route in session links', () => {
    expect(sessionHref('session/a', '/issue/issue-1')).toEqual({
      pathname: '/session/[sessionId]',
      params: { sessionId: 'session/a', backTo: '/issue/issue-1' },
    })
    expect(sessionHref('session/a', '/')).toEqual({
      pathname: '/session/[sessionId]',
      params: { sessionId: 'session/a', backTo: '/work' },
    })
  })

  it.each([
    [undefined, '/work'],
    ['/', '/work'],
    ['/work', '/work'],
    ['%2Fissue%2Fissue-1', '/issue/issue-1'],
    ['https://example.com', '/work'],
    ['//example.com', '/work'],
    ['/session/other', '/work'],
  ])('normalizes back target %s to %s', (value, expected) => {
    expect(sessionBackTarget(value)).toBe(expected)
  })

  it('distinguishes an explicit home return from a bare or invalid link', () => {
    expect(hasSessionBackTarget('/')).toBe(true)
    expect(hasSessionBackTarget(undefined)).toBe(false)
    expect(hasSessionBackTarget('//example.com')).toBe(false)
  })
})
