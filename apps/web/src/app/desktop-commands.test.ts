import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chordHint,
  commandShortcutLabel,
  DESKTOP_COMMANDS,
  desktopCommand,
  desktopCommandBound,
  desktopCommandForEvent,
  installDesktopCommandHook,
  modLabel,
  runDesktopCommand,
  terminalOwnsChord,
  usesCommandKey,
} from './desktop-commands'

const desktopGlobal = globalThis as { __PODIUM_DESKTOP__?: { platform: string } }

function shell(platform: 'macos' | 'linux' | 'windows'): void {
  desktopGlobal.__PODIUM_DESKTOP__ = { platform }
}

const key = (
  k: string,
  mods: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>> = {},
  code?: string,
) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods, code })

afterEach(() => {
  delete desktopGlobal.__PODIUM_DESKTOP__
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('the registry', () => {
  it('gives every command a unique id and hook', () => {
    const ids = DESKTOP_COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    const hooks = DESKTOP_COMMANDS.map((c) => c.hook).filter((hook): hook is string => !!hook)
    expect(new Set(hooks).size).toBe(hooks.length)
  })

  it('claims no chord twice', () => {
    const chords = DESKTOP_COMMANDS.filter((c) => c.chord).map(
      (c) => `${c.chord?.alt ? 'alt+' : ''}${c.chord?.shift ? 'shift+' : ''}${c.chord?.key}`,
    )
    expect(new Set(chords).size).toBe(chords.length)
  })
})

describe('platform labels', () => {
  it('spells the modifier ⌘ on the macOS shell and Ctrl on Linux and Windows', () => {
    shell('macos')
    expect(usesCommandKey()).toBe(true)
    expect(modLabel()).toBe('⌘')
    shell('linux')
    expect(usesCommandKey()).toBe(false)
    expect(modLabel()).toBe('Ctrl')
    shell('windows')
    expect(modLabel()).toBe('Ctrl')
  })

  it('stacks glyphs on macOS and spells the words out everywhere else', () => {
    shell('macos')
    expect(commandShortcutLabel('toggle-right-sidebar')).toBe('⌘B')
    expect(commandShortcutLabel('toggle-left-sidebar')).toBe('⇧⌘B')
    expect(commandShortcutLabel('toggle-flight-deck')).toBe('⌥⌘F')
    expect(commandShortcutLabel('open-settings')).toBe('⌘,')
    expect(commandShortcutLabel('toggle-session-view')).toBe('⇧⌘L')

    shell('linux')
    expect(commandShortcutLabel('toggle-right-sidebar')).toBe('Ctrl+B')
    expect(commandShortcutLabel('toggle-left-sidebar')).toBe('Ctrl+Shift+B')
    expect(commandShortcutLabel('toggle-flight-deck')).toBe('Ctrl+Alt+F')
    expect(commandShortcutLabel('open-settings')).toBe('Ctrl+,')
    expect(commandShortcutLabel('close-tab')).toBe('Ctrl+W')
    expect(commandShortcutLabel('focus-session-prompt')).toBe('Ctrl+L')
  })

  it('has no label for a command with no chord', () => {
    shell('linux')
    expect(commandShortcutLabel('about-podium')).toBeNull()
  })

  it('renders the one-off hints — submit, save, and a modifier-less chord', () => {
    shell('macos')
    expect(chordHint('Enter')).toBe('⌘↵')
    expect(chordHint('s')).toBe('⌘S')
    expect(chordHint('s', { alt: true, mod: false })).toBe('⌥S')
    shell('linux')
    expect(chordHint('Enter')).toBe('Ctrl+↵')
    expect(chordHint('s')).toBe('Ctrl+S')
    expect(chordHint('s', { alt: true, mod: false })).toBe('Alt+S')
  })
})

describe('desktopCommandForEvent', () => {
  it('reads ⌘ chords on macOS and refuses the Ctrl spelling there', () => {
    shell('macos')
    expect(desktopCommandForEvent(key('b', { metaKey: true }))?.id).toBe('toggle-right-sidebar')
    expect(desktopCommandForEvent(key('B', { metaKey: true, shiftKey: true }))?.id).toBe(
      'toggle-left-sidebar',
    )
    expect(desktopCommandForEvent(key('b', { ctrlKey: true }))).toBeNull()
  })

  it('reads Ctrl chords on Linux', () => {
    shell('linux')
    expect(desktopCommandForEvent(key('b', { ctrlKey: true }))?.id).toBe('toggle-right-sidebar')
    expect(desktopCommandForEvent(key('b', { ctrlKey: true, shiftKey: true }))?.id).toBe(
      'toggle-left-sidebar',
    )
    expect(desktopCommandForEvent(key(',', { ctrlKey: true }))?.id).toBe('open-settings')
    expect(desktopCommandForEvent(key('w', { ctrlKey: true }))?.id).toBe('close-tab')
    expect(desktopCommandForEvent(key('l', { ctrlKey: true }))?.id).toBe('focus-session-prompt')
    expect(desktopCommandForEvent(key('L', { ctrlKey: true, shiftKey: true }))?.id).toBe(
      'toggle-session-view',
    )
    expect(desktopCommandForEvent(key('f', { ctrlKey: true, altKey: true }))?.id).toBe(
      'toggle-flight-deck',
    )
    expect(desktopCommandForEvent(key('n', { ctrlKey: true }))?.id).toBe('new-agent')
    expect(desktopCommandForEvent(key('k', { ctrlKey: true }))?.id).toBe('command-palette')
  })

  // The whole point of the Ctrl spelling: Super belongs to the compositor.
  it('refuses Super chords on Linux even when one reaches the webview', () => {
    shell('linux')
    expect(desktopCommandForEvent(key('b', { metaKey: true }))).toBeNull()
    expect(desktopCommandForEvent(key('b', { metaKey: true, ctrlKey: true }))).toBeNull()
  })

  it('does not answer a chord that carries a modifier the command did not ask for', () => {
    shell('linux')
    expect(desktopCommandForEvent(key('b', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(desktopCommandForEvent(key('f', { ctrlKey: true }))).toBeNull()
    expect(desktopCommandForEvent(key('b'))).toBeNull()
  })

  it('falls back to the physical key when the layout or Option mangles it', () => {
    shell('macos')
    // ⌥F types ƒ on a US Mac layout; the code still says which key it was.
    expect(desktopCommandForEvent(key('ƒ', { metaKey: true, altKey: true }, 'KeyF'))?.id).toBe(
      'toggle-flight-deck',
    )
    shell('linux')
    expect(desktopCommandForEvent(key(';', { ctrlKey: true }, 'Comma'))?.id).toBe('open-settings')
  })
})

describe('terminalOwnsChord', () => {
  it('leaves the control range to a focused terminal off Apple', () => {
    shell('linux')
    document.body.innerHTML = '<div class="xterm"><span id="cell"></span></div><input id="field" />'
    expect(terminalOwnsChord(document.getElementById('cell'))).toBe(true)
    expect(terminalOwnsChord(document.getElementById('field'))).toBe(false)
    expect(terminalOwnsChord(null)).toBe(false)
  })

  it('never applies on macOS, where the chords are ⌘ and collide with nothing', () => {
    shell('macos')
    document.body.innerHTML = '<div class="xterm"><span id="cell"></span></div>'
    expect(terminalOwnsChord(document.getElementById('cell'))).toBe(false)
  })
})

describe('dispatch', () => {
  it('installs, runs and uninstalls a hook under the registry name', () => {
    const handler = vi.fn()
    expect(desktopCommandBound('toggle-flight-deck')).toBe(false)
    const uninstall = installDesktopCommandHook('toggle-flight-deck', handler)
    const hook = desktopCommand('toggle-flight-deck').hook as string
    expect((globalThis as Record<string, unknown>)[hook]).toBe(handler)
    expect(desktopCommandBound('toggle-flight-deck')).toBe(true)
    expect(runDesktopCommand('toggle-flight-deck')).toBe(true)
    expect(handler).toHaveBeenCalledOnce()
    uninstall()
    expect(desktopCommandBound('toggle-flight-deck')).toBe(false)
    expect(runDesktopCommand('toggle-flight-deck')).toBe(false)
  })

  // A remount installs the arriving copy before the departing one tears down.
  it('does not let a stale uninstall unbind the handler that replaced it', () => {
    const first = vi.fn()
    const second = vi.fn()
    const uninstallFirst = installDesktopCommandHook('close-tab', first)
    installDesktopCommandHook('close-tab', second)
    uninstallFirst()
    expect(runDesktopCommand('close-tab')).toBe(true)
    expect(second).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()
  })

  it('reports a hook that DECLINED — no tab to close — as unanswered', () => {
    const uninstall = installDesktopCommandHook('close-tab', () => false)
    expect(runDesktopCommand('close-tab')).toBe(false)
    uninstall()
  })

  it('has nothing to dispatch for a command that owns its own keystroke', () => {
    expect(desktopCommand('command-palette').hook).toBeNull()
    expect(runDesktopCommand('command-palette')).toBe(false)
  })
})
