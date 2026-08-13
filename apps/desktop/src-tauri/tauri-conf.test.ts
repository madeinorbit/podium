// apps/desktop/src-tauri/tauri-conf.test.ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const conf = JSON.parse(readFileSync(join(__dirname, 'tauri.conf.json'), 'utf8'))
const mainSource = readFileSync(join(__dirname, 'src/main.rs'), 'utf8')

describe('tauri desktop config', () => {
  it('keeps stable as the packaged fallback endpoint', () => {
    expect(conf.plugins.updater.endpoints).toEqual([
      'https://github.com/madeinorbit/podium/releases/latest/download/latest.json',
    ])
  })
  it('bundles native icon formats for every desktop platform', () => {
    expect(conf.bundle.icon).toEqual([
      'icons/32x32.png',
      'icons/128x128.png',
      'icons/128x128@2x.png',
      'icons/icon.icns',
      'icons/icon.ico',
    ])
    for (const icon of conf.bundle.icon) {
      expect(existsSync(join(__dirname, icon)), icon).toBe(true)
    }
  })
  it('claims ⌘N in the macOS menu and routes it to the web app (POD-790)', () => {
    // An accelerator no menu item owns never reaches the webview, so this item
    // IS the shortcut — a JS keydown handler alone could not see ⌘N.
    expect(mainSource).toContain('MenuItemBuilder::with_id("new-agent", "New Agent")')
    expect(mainSource).toContain('.accelerator("CmdOrCtrl+N")')
    // The web app's half of the contract: apps/web/src/features/worklist/spawn-row.tsx.
    expect(mainSource).toContain('__PODIUM_NEW_AGENT__')
  })

  it('owns About, updates, Add Project, and View sidebar toggles', () => {
    expect(mainSource).toContain('MenuItemBuilder::with_id("about-podium", "About Podium")')
    expect(mainSource).toContain('MenuItemBuilder::with_id("check-updates", "Check for Updates…")')
    expect(mainSource).toContain('MenuItemBuilder::with_id("add-project", "Add Project…")')
    expect(mainSource).toContain(
      'MenuItemBuilder::with_id("toggle-left-sidebar", "Toggle Left Sidebar")',
    )
    expect(mainSource).toContain(
      'MenuItemBuilder::with_id("toggle-flight-deck", "Toggle Flight Deck")',
    )
    expect(mainSource).toContain(
      'MenuItemBuilder::with_id("toggle-right-sidebar", "Toggle Right Sidebar")',
    )
    expect(mainSource).toContain('.accelerator("CmdOrCtrl+B")')
    expect(mainSource).toContain('.accelerator("Shift+CmdOrCtrl+B")')
    expect(mainSource).toContain('__PODIUM_ABOUT__')
    expect(mainSource).toContain('__PODIUM_CHECK_UPDATES__')
    expect(mainSource).toContain('__PODIUM_ADD_PROJECT__')
    expect(mainSource).toContain('__PODIUM_TOGGLE_LEFT_SIDEBAR__')
    expect(mainSource).toContain('__PODIUM_TOGGLE_FLIGHT_DECK__')
    expect(mainSource).toContain('__PODIUM_TOGGLE_RIGHT_SIDEBAR__')
  })

  it('never closes the main window from Cmd+W', () => {
    expect(mainSource).toContain('MenuItemBuilder::with_id("close-tab", "Close Tab")')
    expect(mainSource).toContain('.accelerator("CmdOrCtrl+W")')
    expect(mainSource).not.toContain('MenuItemBuilder::with_id("close-window"')
    expect(mainSource).not.toContain('__PODIUM_DESKTOP__.close()')
  })
  it('uses native traffic lights on macOS and custom chrome elsewhere', () => {
    expect(mainSource).toContain('.title_bar_style(tauri::TitleBarStyle::Overlay)')
    expect(mainSource).toContain('.hidden_title(true)')
    expect(mainSource).toContain('.traffic_light_position(tauri::LogicalPosition::new(14.0, 22.0))')
    expect(mainSource).toContain('let window_builder = window_builder.decorations(false);')
  })
})
