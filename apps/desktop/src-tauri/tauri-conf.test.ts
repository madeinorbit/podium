// apps/desktop/src-tauri/tauri-conf.test.ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const conf = JSON.parse(readFileSync(join(__dirname, 'tauri.conf.json'), 'utf8'))
const mainSource = readFileSync(join(__dirname, 'src/main.rs'), 'utf8')
const cargoSource = readFileSync(join(__dirname, 'Cargo.toml'), 'utf8')
const webStyles = readFileSync(join(__dirname, '../../web/src/styles.css'), 'utf8')

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
  it('ships the entitlements notarization requires', () => {
    // Without an entitlements file the hardened runtime kills the JIT the bundled Bun sidecar
    // needs, and without the hardened runtime Apple refuses to notarize at all.
    expect(conf.bundle.macOS.entitlements).toBe('entitlements.plist')
    for (const plist of ['entitlements.plist', 'entitlements.sidecar.plist']) {
      const path = join(__dirname, plist)
      expect(existsSync(path), plist).toBe(true)
      expect(readFileSync(path, 'utf8')).toContain('com.apple.security.cs.allow-jit')
      // codesign parses entitlements with AMFIUnserializeXML, a restricted reader that rejects
      // XML comments outright ("syntax error near line N") even though they are valid XML. The
      // natural instinct — explaining these entitlements inline — breaks every macOS build, so
      // the rationale lives in docs/desktop-releases.md instead.
      expect(readFileSync(path, 'utf8'), `${plist} must not contain XML comments`).not.toContain(
        '<!--',
      )
    }
    // The sidecar is the one that allocates writable-executable memory; the shell must not.
    expect(readFileSync(join(__dirname, 'entitlements.sidecar.plist'), 'utf8')).toContain(
      'com.apple.security.cs.allow-unsigned-executable-memory',
    )
    expect(readFileSync(join(__dirname, 'entitlements.plist'), 'utf8')).not.toContain(
      'com.apple.security.cs.allow-unsigned-executable-memory',
    )
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
    // Pin the pairing, not just the two chords: the bare ⌘B belongs to the
    // right dock and ⇧⌘B to the left work list. Asserting the id and the
    // accelerator separately stays green through a swap. `[^;]*` keeps each
    // match inside its own let-statement so it cannot borrow the other
    // item's accelerator.
    expect(mainSource).toMatch(/"toggle-right-sidebar"[^;]*\.accelerator\("CmdOrCtrl\+B"\)/)
    expect(mainSource).toMatch(/"toggle-left-sidebar"[^;]*\.accelerator\("Shift\+CmdOrCtrl\+B"\)/)
    expect(mainSource).toContain('__PODIUM_ABOUT__')
    expect(mainSource).toContain('__PODIUM_CHECK_UPDATES__')
    expect(mainSource).toContain('__PODIUM_ADD_PROJECT__')
    expect(mainSource).toContain('__PODIUM_TOGGLE_LEFT_SIDEBAR__')
    expect(mainSource).toContain('__PODIUM_TOGGLE_FLIGHT_DECK__')
    expect(mainSource).toContain('__PODIUM_TOGGLE_RIGHT_SIDEBAR__')
  })

  it('names Hide and Quit after the product, not the running binary', () => {
    // The predefined items default to NSRunningApplication.localizedName, which
    // under `tauri dev` is the bare cargo executable — "Quit podium-desktop".
    // The bundle reads CFBundleName ("Podium", from productName) and was always
    // right; explicit text is what keeps dev showing the shipped menu.
    expect(mainSource).toContain('.hide_with_text("Hide Podium")')
    expect(mainSource).toContain('.quit_with_text("Quit Podium")')
    expect(mainSource).not.toContain('.quit()')
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

  it('reveals a native semantic material only through the macOS command bar', () => {
    expect(cargoSource).toContain('"macos-private-api"')
    expect(mainSource).toContain('.transparent(true)')
    expect(mainSource).toContain('.effect(Effect::HeaderView)')
    expect(mainSource).toContain('.state(EffectState::FollowsWindowActiveState)')
    expect(webStyles).toContain(
      'html[data-podium-platform="macos"] .desktop-topbar {\n  background: transparent;',
    )
    expect(webStyles).toContain(
      'html[data-podium-platform="macos"] .desktop-shell-row {\n  background: var(--background);',
    )
  })
})
