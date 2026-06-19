import { describe, expect, it } from 'vitest'
import { initialPanelMode } from '../src/AgentPanel'

describe('initialPanelMode', () => {
  it('opens native by default', () =>
    expect(initialPanelMode({ startScreen: 'native', chatCapable: true, isMobile: false })).toBe('native'))

  it('auto uses device heuristic', () =>
    expect(initialPanelMode({ startScreen: 'auto', chatCapable: true, isMobile: true })).toBe('chat'))

  it('auto uses device heuristic (desktop)', () =>
    expect(initialPanelMode({ startScreen: 'auto', chatCapable: true, isMobile: false })).toBe('native'))

  it('per-session saved override wins', () =>
    expect(initialPanelMode({ startScreen: 'native', chatCapable: true, isMobile: false, saved: 'chat' })).toBe('chat'))

  it('non-chat-capable forced native', () =>
    expect(initialPanelMode({ startScreen: 'chat', chatCapable: false, isMobile: true })).toBe('native'))

  it('chat setting opens chat when capable', () =>
    expect(initialPanelMode({ startScreen: 'chat', chatCapable: true, isMobile: false })).toBe('chat'))

  it('saved override ignored when not chat-capable', () =>
    expect(initialPanelMode({ startScreen: 'auto', chatCapable: false, isMobile: true, saved: 'chat' })).toBe('native'))
})
