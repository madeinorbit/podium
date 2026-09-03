import { effectivePanelMode } from '@podium/client-core/ui-state'
import { describe, expect, it } from 'vitest'

/** Sole panel-mode derivation — lives in client-core ui-state (POD-329). */
describe('effectivePanelMode', () => {
  it('opens native by default', () =>
    expect(
      effectivePanelMode({
        startScreen: 'native',
        chatCapable: true,
        isMobile: false,
        terminalCapable: true,
      }),
    ).toBe('native'))

  it('auto uses device heuristic', () =>
    expect(
      effectivePanelMode({
        startScreen: 'auto',
        chatCapable: true,
        isMobile: true,
        terminalCapable: true,
      }),
    ).toBe('chat'))

  it('auto uses device heuristic (desktop)', () =>
    expect(
      effectivePanelMode({
        startScreen: 'auto',
        chatCapable: true,
        isMobile: false,
        terminalCapable: true,
      }),
    ).toBe('native'))

  it('per-session saved override wins', () =>
    expect(
      effectivePanelMode({
        startScreen: 'native',
        chatCapable: true,
        isMobile: false,
        terminalCapable: true,
        saved: 'chat',
      }),
    ).toBe('chat'))

  it('personal default wins when no per-session save', () =>
    expect(
      effectivePanelMode({
        startScreen: 'native',
        chatCapable: true,
        isMobile: false,
        terminalCapable: true,
        deviceDefault: 'chat',
      }),
    ).toBe('chat'))

  it('non-chat-capable forced native', () =>
    expect(
      effectivePanelMode({
        startScreen: 'chat',
        chatCapable: false,
        isMobile: true,
        terminalCapable: true,
      }),
    ).toBe('native'))

  it('chat setting opens chat when capable', () =>
    expect(
      effectivePanelMode({
        startScreen: 'chat',
        chatCapable: true,
        isMobile: false,
        terminalCapable: true,
      }),
    ).toBe('chat'))

  it('saved override ignored when not chat-capable', () =>
    expect(
      effectivePanelMode({
        startScreen: 'auto',
        chatCapable: false,
        isMobile: true,
        terminalCapable: true,
        saved: 'chat',
      }),
    ).toBe('native'))

  // POD-2290 — a session with no PTY has ONE view, so nothing that expresses a
  // preference between two of them may be consulted. Each case below is a rule
  // that used to win and must now lose, because every one of them was a way for
  // an opencode/codex/grok server session to land on a pane whose attach can
  // never confirm.
  describe('a session with no terminal', () => {
    it('opens chat even when the startScreen setting says native', () =>
      expect(
        effectivePanelMode({
          startScreen: 'native',
          chatCapable: true,
          isMobile: false,
          terminalCapable: false,
        }),
      ).toBe('chat'))

    it('opens chat over a per-session save made while it still had one', () =>
      expect(
        effectivePanelMode({
          startScreen: 'chat',
          chatCapable: true,
          isMobile: false,
          terminalCapable: false,
          saved: 'native',
        }),
      ).toBe('chat'))

    it('opens chat over the per-device default', () =>
      expect(
        effectivePanelMode({
          startScreen: 'auto',
          chatCapable: true,
          isMobile: false,
          terminalCapable: false,
          deviceDefault: 'native',
        }),
      ).toBe('chat'))

    // The two "always" rules collide only here, and the tie goes to the one
    // whose alternative is unusable: a native pane with no PTY behind it is a
    // permanent spinner, while a chat pane with no transcript is merely empty.
    it('opens chat even when nothing says it is chat-capable', () =>
      expect(
        effectivePanelMode({
          startScreen: 'native',
          chatCapable: false,
          isMobile: false,
          terminalCapable: false,
        }),
      ).toBe('chat'))
  })
})
