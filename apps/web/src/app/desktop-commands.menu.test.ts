/**
 * The macOS menu and the TypeScript registry are ONE list, across a language
 * boundary a compiler cannot see across.
 *
 * `main.rs` builds a menu item per command, gives it an accelerator, and evals
 * a global by name. `desktop-commands.ts` declares the same commands so that
 * every OTHER platform — which has no menu bar at all — can bind, label and
 * search them. Nothing links the two files, so this test does: it reads the
 * Rust source and fails when a command is added, renamed, re-keyed or re-hooked
 * on one side only. That drift is exactly how Linux ended up with four of the
 * shell's nine commands (POD-1532).
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DesktopChord, DesktopCommandId } from './desktop-commands'
import { DESKTOP_COMMANDS, desktopCommand } from './desktop-commands'

// Resolved from cwd rather than import.meta.url: the web suite runs under
// happy-dom, where import.meta.url is not a file: URL. Vitest's cwd is the
// package root, but tolerate a repo-root run too.
const MAIN_RS = ['../desktop/src-tauri/src/main.rs', 'apps/desktop/src-tauri/src/main.rs']
  .map((path) => resolve(process.cwd(), path))
  .find(existsSync)
const source = MAIN_RS ? readFileSync(MAIN_RS, 'utf8') : ''

/** `MenuItemBuilder::with_id("id", "Label")`, with the `.accelerator("…")` that
 *  may follow it before the item is built. */
function menuItems(): Map<string, { label: string; accelerator: string | null }> {
  const items = new Map<string, { label: string; accelerator: string | null }>()
  const pattern = /MenuItemBuilder::with_id\("([^"]+)",\s*"([^"]*)"\)([\s\S]*?)\.build\(app\)\?/g
  for (const [, id, label, tail] of source.matchAll(pattern)) {
    const accelerator = /\.accelerator\("([^"]+)"\)/.exec(tail ?? '')?.[1] ?? null
    items.set(id as string, { label: label as string, accelerator })
  }
  return items
}

/** `"id" => eval_menu_hook(app, "__PODIUM_X__")` from `on_menu_event`. */
function menuHooks(): Map<string, string> {
  const hooks = new Map<string, string>()
  const pattern = /"([a-z-]+)"\s*=>\s*eval_menu_hook\(app,\s*"([^"]+)"\)/g
  for (const [, id, hook] of source.matchAll(pattern)) hooks.set(id as string, hook as string)
  return hooks
}

/** The registry chord in Tauri's accelerator grammar, as `main.rs` writes it. */
function accelerator(chord: DesktopChord): string {
  const parts: string[] = []
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  parts.push('CmdOrCtrl')
  parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key)
  return parts.join('+')
}

/** Everything the macOS menu carries — i.e. everything but the palette, which
 *  has no menu item because AppShell answers its chord itself. */
const MENU_COMMANDS = DESKTOP_COMMANDS.filter((command) => command.hook !== null)

describe('the macOS menu and the command registry', () => {
  it('build a menu item for every command that has a hook', () => {
    const items = menuItems()
    expect([...items.keys()].sort()).toEqual(MENU_COMMANDS.map((c) => c.id).sort())
  })

  it('give every menu item the registry label', () => {
    const items = menuItems()
    for (const command of MENU_COMMANDS) {
      expect(items.get(command.id)?.label, command.id).toBe(command.label)
    }
  })

  it('give every menu item the registry chord', () => {
    const items = menuItems()
    for (const command of MENU_COMMANDS) {
      const expected = command.chord ? accelerator(command.chord) : null
      expect(items.get(command.id)?.accelerator, command.id).toBe(expected)
    }
  })

  it('eval the registry hook for every menu item', () => {
    const hooks = menuHooks()
    expect([...hooks.keys()].sort()).toEqual(MENU_COMMANDS.map((c) => c.id).sort())
    for (const [id, hook] of hooks) {
      expect(hook, id).toBe(desktopCommand(id as DesktopCommandId).hook)
    }
  })

  // The parser is the load-bearing part of this test: a regex that silently
  // matched nothing would make every assertion above pass against an empty menu.
  it('actually read the Rust source', () => {
    expect(MAIN_RS, 'apps/desktop/src-tauri/src/main.rs not found from the test cwd').toBeTruthy()
    expect(menuItems().size).toBeGreaterThan(0)
    expect(menuHooks().size).toBeGreaterThan(0)
  })
})
