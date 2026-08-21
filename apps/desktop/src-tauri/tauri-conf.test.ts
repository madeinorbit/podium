// apps/desktop/src-tauri/tauri-conf.test.ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const conf = JSON.parse(readFileSync(join(__dirname, 'tauri.conf.json'), 'utf8'))
const mainSource = readFileSync(join(__dirname, 'src/main.rs'), 'utf8')
const bootstrapSource = readFileSync(join(__dirname, 'src/bootstrap.rs'), 'utf8')
const cargoSource = readFileSync(join(__dirname, 'Cargo.toml'), 'utf8')
const webStyles = readFileSync(join(__dirname, '../../web/src/styles.css'), 'utf8')
const webMainSource = readFileSync(join(__dirname, '../../web/src/app/main.tsx'), 'utf8')

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
  it('bundles one complete headless payload as the first-run seed', () => {
    expect(conf.bundle.resources).toEqual(['resources/payload'])
    expect(mainSource).toContain('"PODIUM_MOBILE_WEB_DIR"')
    expect(mainSource).toContain('.join("mobile")')
  })

  it('strips quarantine before publishing the one-time external seed', () => {
    expect(bootstrapSource).toContain('Command::new("/usr/bin/xattr")')
    expect(bootstrapSource).toContain('.args(["-dr", "com.apple.quarantine"])')
    const seed = bootstrapSource.slice(
      bootstrapSource.indexOf('pub fn seed_payload_if_absent'),
      bootstrapSource.indexOf('pub fn ensure_executable'),
    )
    expect(seed.indexOf('strip_payload_quarantine(&staging)')).toBeGreaterThan(-1)
    expect(seed.indexOf('std::fs::rename(&staging, install)')).toBeGreaterThan(
      seed.indexOf('strip_payload_quarantine(&staging)'),
    )
  })

  it('keeps repair reachable from the baked fallback when the payload cannot serve', () => {
    expect(mainSource).toContain('window.__PODIUM_PAYLOAD_UNAVAILABLE__ = true')
    expect(mainSource).toContain('repairPayload: () =>')
    expect(mainSource).toContain("invoke('repair_payload')")
    expect(webMainSource).toContain('function PayloadUnavailablePage()')
    expect(webMainSource).toContain("label: repairing ? 'Repairing…' : 'Repair payload'")
    expect(webMainSource).toContain('nativeDesktopBridge()?.repairPayload')
  })

  it('loads the all-in-one UI from the local server with a stable port (POD-2510)', () => {
    // Served-local: prefer the sidecar origin; baked frontendDist is fallback only.
    expect(mainSource).toContain('resolve_local_port')
    expect(mainSource).toContain('local_window_target')
    expect(mainSource).toContain('local_served_http_url')
    // frontendDist remains packaged as the offline / boot-race fallback.
    expect(conf.build.frontendDist).toBe('../../web/dist')
  })

  it('keeps the baked document at the URL the fallback navigates to (POD-2510)', () => {
    // bootstrap::baked_document_url() hard-codes `tauri://localhost` (and the Windows
    // `http://tauri.localhost` form). Two config keys would move that URL out from under it:
    // a devUrl replaces it in dev, and useHttpsScheme makes the Windows form https.
    expect(conf.build.devUrl).toBeUndefined()
    for (const window of conf.app?.windows ?? []) {
      expect(window.useHttpsScheme).toBeUndefined()
    }
  })
})

/**
 * The shell tells the page which launch mode it is in, and the update dialog renders one row
 * (all-in-one) or two (a device driving a remote server) off that answer. Since POD-2510 the
 * all-in-one page is SERVED — `http://127.0.0.1:<port>` — which is the same http shape a
 * transferred remote page has, so the shell emits the served origin it chose and the page
 * compares against it.
 *
 * The bug this replaces was a JS expression that read correctly and returned the wrong string,
 * so this lifts the real expression out of main.rs and EVALUATES it. A substring assertion
 * could not have failed on it.
 */
describe('served-local launchMode classification (POD-2510)', () => {
  const SERVED_ORIGIN = 'http://127.0.0.1:18787'
  const template = mainSource.match(/const LOCAL_LAUNCH_MODE_EXPRESSION: &str = "([^"]*)";/)?.[1]

  function classify(location: Record<string, string>, launchMode = 'all-in-one'): unknown {
    if (!template) throw new Error('LOCAL_LAUNCH_MODE_EXPRESSION not found in main.rs')
    const expression = template
      .replaceAll('{served_origin_literal}', JSON.stringify(SERVED_ORIGIN))
      .replaceAll('{launch_mode_literal}', JSON.stringify(launchMode))
    return new Function('window', `return ${expression}`)({ location })
  }

  it('finds the expression in the shell source', () => {
    expect(template).toBeTruthy()
  })

  it('calls the served-local page this shell served exactly what it launched as', () => {
    for (const mode of ['all-in-one', 'server']) {
      expect(
        classify({ protocol: 'http:', hostname: '127.0.0.1', origin: SERVED_ORIGIN }, mode),
      ).toBe(mode)
    }
  })

  it('calls the baked fallback document local too', () => {
    expect(
      classify({
        protocol: 'tauri:',
        hostname: 'localhost',
        origin: 'tauri://localhost',
      }),
    ).toBe('all-in-one')
    expect(
      classify({
        protocol: 'http:',
        hostname: 'tauri.localhost',
        origin: 'http://tauri.localhost',
      }),
    ).toBe('all-in-one')
  })

  it('calls a page transferred to a remote server daemon', () => {
    expect(
      classify({
        protocol: 'https:',
        hostname: 'podium.example',
        origin: 'https://podium.example',
      }),
    ).toBe('daemon')
    // A different loopback port is a different server — someone else's, not ours.
    expect(
      classify({
        protocol: 'http:',
        hostname: '127.0.0.1',
        origin: 'http://127.0.0.1:19999',
      }),
    ).toBe('daemon')
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

  it('owns About, updates, Settings, Add Project, and View sidebar toggles', () => {
    expect(mainSource).toContain('MenuItemBuilder::with_id("about-podium", "About Podium ADE")')
    expect(mainSource).toContain('MenuItemBuilder::with_id("check-updates", "Check for Updates…")')
    expect(mainSource).toContain('MenuItemBuilder::with_id("open-settings", "Settings…")')
    // ⌘, is where macOS users look for preferences, and only a menu item can
    // claim it — an unowned accelerator never reaches WKWebView.
    expect(mainSource).toMatch(/"open-settings"[^;]*\.accelerator\("CmdOrCtrl\+,"\)/)
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
    expect(mainSource).toContain('__PODIUM_SETTINGS__')
    expect(mainSource).toContain('__PODIUM_ADD_PROJECT__')
    expect(mainSource).toContain('__PODIUM_TOGGLE_LEFT_SIDEBAR__')
    expect(mainSource).toContain('__PODIUM_TOGGLE_FLIGHT_DECK__')
    expect(mainSource).toContain('__PODIUM_TOGGLE_RIGHT_SIDEBAR__')
  })

  it('names Hide and Quit after the product, not the running binary', () => {
    // The predefined items default to NSRunningApplication.localizedName, which
    // under `tauri dev` is the bare cargo executable — "Quit Podium", the bin
    // target name. The bundle reads the display name below; explicit text is
    // what keeps dev showing the shipped menu.
    expect(mainSource).toContain('.hide_with_text("Hide Podium ADE")')
    expect(mainSource).toContain('.quit_with_text("Quit Podium ADE")')
    expect(mainSource).not.toContain('.quit()')
  })

  /**
   * The app is called "Podium ADE" everywhere a person reads it, WITHOUT
   * renaming the product. `productName` is not just a label: it names the .app,
   * the DMG, the AppImage and the `.app.tar.gz` the updater manifest points at,
   * and GitHub rewrites spaces in release asset names to dots — so a
   * "Podium ADE" productName would publish `Podium.ADE.app.tar.gz` under a
   * manifest URL claiming `Podium ADE.app.tar.gz` and break auto-update.
   *
   * macOS separates the two on purpose. CFBundleName (Tauri's `bundleName`)
   * titles the menu bar, the Dock tile, ⌘-Tab and Force Quit; CFBundleDisplayName
   * titles the item in Finder. Neither touches a filename.
   */
  it('shows the product name without renaming the bundle (POD-1199)', () => {
    expect(conf.productName).toBe('Podium')
    expect(conf.bundle.macOS.bundleName).toBe('Podium ADE')
    expect(conf.bundle.macOS.infoPlist).toBe('Info.plist')
    const plist = readFileSync(join(__dirname, conf.bundle.macOS.infoPlist), 'utf8')
    expect(plist).toContain('<key>CFBundleDisplayName</key>')
    expect(plist).toContain('<string>Podium ADE</string>')
    // The window title is the one name that is not macOS-only.
    expect(mainSource).toContain('.title("Podium ADE")')
  })

  it('names the executable after the product, for the Dock (POD-1119)', () => {
    // The menu bar can be titled from Rust (above); the Dock tile cannot. For an
    // unbundled process macOS reads ProcessInfo.processName — argv[0]'s basename
    // — so under `tauri dev` the app name IS this bin target's name, and a
    // `podium-desktop` here surfaces as a "podium-desktop" tile. Packaged builds
    // read the display name and are unaffected either way. It stays the bare
    // product word because cargo derives the crate name from the target name,
    // so the target cannot carry the space in "Podium ADE".
    expect(cargoSource).toMatch(/\[\[bin\]\][\s\S]*?\nname = "Podium"\n/)
    expect(cargoSource).not.toContain('name = "podium-desktop"\npath')
    // rustc derives the crate name from the target name and warns about the
    // capital; the allow is what keeps that from being a build-log surprise.
    expect(mainSource).toContain('#![allow(non_snake_case)]')
  })

  /**
   * POD-1199. ⌘Q used to hang and then be force quit by macOS. Both exit
   * handlers reap the backend child from the MAIN thread, and both lock the
   * child slot to do it — while supervision sat in a blocking `Child::wait()`
   * holding that same lock for the child's whole lifetime. The main thread
   * waited on a lock released only by the child dying, and the only thing that
   * would have killed the child was the main thread.
   *
   * The behaviour is covered by a Rust test (`the_quit_path_can_reap_the_backend
   * _while_supervision_waits`). This pins the shape, because the deadlock is
   * invisible at the call site: it reads as an ordinary wait.
   */
  it('never blocks on the backend while holding the child slot (POD-1199)', () => {
    const between = (from: string, to: string): string => {
      const start = mainSource.indexOf(from)
      const end = mainSource.indexOf(to)
      expect(start, `no ${from} in main.rs`).toBeGreaterThan(-1)
      expect(end, `no ${to} in main.rs`).toBeGreaterThan(start)
      return mainSource.slice(start, end)
    }
    const waiter = between('fn await_child_exit(', '/// Supervise the backend child.')
    // `try_wait` + sleep, never `wait` — the whole point is that the lock is free
    // between checks. (`child.try_wait()` does not contain `child.wait()`.)
    expect(waiter).toContain('child.try_wait()')
    expect(waiter).not.toContain('child.wait()')
    expect(waiter).toContain('std::thread::sleep(poll)')
    // And supervision goes through it rather than waiting on the child itself.
    const monitor = between('fn spawn_respawn_monitor', '/// Best-effort, log-only read')
    expect(monitor).toContain('await_child_exit(&child_state, &shutting_down, SUPERVISION_POLL)')
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
    // Sidebar, not HeaderView, and the difference is measured rather than a taste
    // call. HeaderView is the semantic pick for a command bar, so it is what the
    // next reader will reach for — but the material composites with the WINDOW's
    // NSAppearance, and in dark mode it lands within ~3% luminance of the opaque
    // bar it replaces (#232628 against --bar #1b1d21). That reads as opaque: the
    // translucency ships, and no one can see it. Sidebar is the visibly
    // translucent chrome material (Finder, Notes) and is what POD-1034's effect
    // was actually for. Swapping back needs a new measurement, not a rename.
    expect(mainSource).toContain('.effect(Effect::Sidebar)')
    expect(mainSource).not.toContain('Effect::HeaderView')
    expect(mainSource).toContain('.state(EffectState::FollowsWindowActiveState)')
    expect(webStyles).toContain(
      'html[data-podium-platform="macos"] .desktop-topbar {\n  background: transparent;',
    )
    expect(webStyles).toContain(
      'html[data-podium-platform="macos"] .desktop-shell-row {\n  background: var(--background);',
    )
  })

  /**
   * POD-2150. `install_update` reports progress by emitting
   * `podium://update-progress`, and the page subscribes with
   * `plugin:event|listen` — which is a PERMISSION, not an ambient capability.
   * The static `default.json` grants it through `core:default`, but declares no
   * remote block, so it stops at the local origin. In remote mode the page is
   * served by the remote server, and a shell that lets that page start an
   * install but not hear it report gives the user a spinner that never moves:
   * the one silence the progress events exist to end.
   *
   * Both grants are checked because they are two different lives of the same
   * bridge — startup, and the re-grant after a server transfer — and POD-2150
   * was exactly one of them being forgotten.
   */
  it('lets both update-bridge grants hear the progress event (POD-2150)', () => {
    const grant = (name: string): string => {
      const start = mainSource.indexOf(`CapabilityBuilder::new("${name}")`)
      expect(start, `no ${name} capability in main.rs`).toBeGreaterThan(-1)
      const end = mainSource.indexOf(';', start)
      return mainSource.slice(start, end)
    }
    for (const name of ['update-bridge', 'transfer-update-bridge']) {
      const block = grant(name)
      expect(block, name).toContain('.permission("allow-install-update")')
      expect(block, name).toContain('.permission("core:event:allow-listen")')
      expect(block, name).toContain('.permission("core:event:allow-unlisten")')
    }
  })
})
