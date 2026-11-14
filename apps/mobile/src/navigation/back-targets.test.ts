import { describe, expect, it } from 'vitest'
import { deckBackReturnsToChat, tabsBackTitle } from './back-targets'

describe('tabsBackTitle', () => {
  it.each([
    ['work', 'Work'],
    ['issues', 'Tasks'],
    ['pulse', 'Pulse'],
    ['settings', 'Settings'],
    ['issues/index', 'Tasks'],
  ])('names the %s tab as its tab bar does', (route, title) => {
    expect(tabsBackTitle(route)).toBe(title)
  })

  it('falls back to the first tab before the tabs report a focused route', () => {
    expect(tabsBackTitle(undefined)).toBe('Work')
    expect(tabsBackTitle('unknown')).toBe('Work')
  })
})

describe('deckBackReturnsToChat', () => {
  it.each(['GO_BACK', 'POP'])('pages a %s on the deck back to the chat', (type) => {
    expect(deckBackReturnsToChat({ type })).toBe(true)
  })

  it.each(['REPLACE', 'RESET', 'NAVIGATE', 'POP_TO_TOP'])('lets %s leave the screen', (type) => {
    expect(deckBackReturnsToChat({ type })).toBe(false)
  })
})
