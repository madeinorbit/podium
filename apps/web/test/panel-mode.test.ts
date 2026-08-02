import { effectivePanelMode } from '@podium/client-core/ui-state'
import { describe, expect, it } from 'vitest'

/** Sole panel-mode derivation — lives in client-core ui-state (POD-329). */
describe('effectivePanelMode', () => {
  it('opens native by default', () =>
    expect(effectivePanelMode({ startScreen: 'native', chatCapable: true, isMobile: false })).toBe(
      'native',
    ))

  it('auto uses device heuristic', () =>
    expect(effectivePanelMode({ startScreen: 'auto', chatCapable: true, isMobile: true })).toBe(
      'chat',
    ))

  it('auto uses device heuristic (desktop)', () =>
    expect(effectivePanelMode({ startScreen: 'auto', chatCapable: true, isMobile: false })).toBe(
      'native',
    ))

  it('per-session saved override wins', () =>
    expect(
      effectivePanelMode({
        startScreen: 'native',
        chatCapable: true,
        isMobile: false,
        saved: 'chat',
      }),
    ).toBe('chat'))

  it('personal default wins when no per-session save', () =>
    expect(
      effectivePanelMode({
        startScreen: 'native',
        chatCapable: true,
        isMobile: false,
        deviceDefault: 'chat',
      }),
    ).toBe('chat'))

  it('non-chat-capable forced native', () =>
    expect(effectivePanelMode({ startScreen: 'chat', chatCapable: false, isMobile: true })).toBe(
      'native',
    ))

  it('chat setting opens chat when capable', () =>
    expect(effectivePanelMode({ startScreen: 'chat', chatCapable: true, isMobile: false })).toBe(
      'chat',
    ))

  it('saved override ignored when not chat-capable', () =>
    expect(
      effectivePanelMode({
        startScreen: 'auto',
        chatCapable: false,
        isMobile: true,
        saved: 'chat',
      }),
    ).toBe('native'))
})
