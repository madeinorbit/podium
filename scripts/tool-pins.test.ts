/**
 * mise.toml is the one pin site for the non-node build toolchain [POD-3187]; these
 * tests hold the two ends of that contract together. The parser must read the real
 * checked-in mise.toml (so a reshaping of that file cannot silently unpin a tool),
 * and the resolvers must actually REFUSE an off-pin binary — a pin nothing enforces
 * is documentation, not a pin.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveZig } from './abduco-cross'
import { readToolPins } from './tool-pins'

const SEMVER = /^\d+\.\d+\.\d+$/

describe('readToolPins', () => {
  it('reads both pins from the checked-in mise.toml', () => {
    const pins = readToolPins()
    expect(pins.zig).toMatch(SEMVER)
    expect(pins.rcodesign).toMatch(SEMVER)
  })

  it('throws when mise.toml no longer carries the expected pins', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-pins-'))
    writeFileSync(join(root, 'mise.toml'), '[tools]\nnode = "22"\n')
    expect(() => readToolPins(root)).toThrow(/mise\.toml no longer carries/)
  })

  it('reads pins from a well-formed mise.toml', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-pins-'))
    writeFileSync(
      join(root, 'mise.toml'),
      '[tools]\nzig = "9.9.9"\n' +
        '"github:indygreg/apple-platform-rs" = { version = "apple-codesign/8.8.8", exe = "rcodesign" }\n',
    )
    expect(readToolPins(root)).toEqual({ zig: '9.9.9', rcodesign: '8.8.8' })
  })
})

describe('resolveZig pin enforcement', () => {
  const saved = { zig: process.env.PODIUM_ZIG, skip: process.env.PODIUM_SKIP_TOOL_PIN_CHECK }
  afterEach(() => {
    if (saved.zig === undefined) delete process.env.PODIUM_ZIG
    else process.env.PODIUM_ZIG = saved.zig
    if (saved.skip === undefined) delete process.env.PODIUM_SKIP_TOOL_PIN_CHECK
    else process.env.PODIUM_SKIP_TOOL_PIN_CHECK = saved.skip
  })

  /** A fake zig that prints an arbitrary version — what a drifted dev install looks like. */
  function fakeZig(version: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'fake-zig-'))
    mkdirSync(dir, { recursive: true })
    const bin = join(dir, 'zig')
    writeFileSync(bin, `#!/bin/sh\necho ${version}\n`)
    chmodSync(bin, 0o755)
    return bin
  }

  it('refuses a zig whose version is off the mise.toml pin', () => {
    delete process.env.PODIUM_SKIP_TOOL_PIN_CHECK
    process.env.PODIUM_ZIG = fakeZig('0.0.1-definitely-wrong')
    expect(() => resolveZig()).toThrow(/mise\.toml pins/)
  })

  it('accepts a zig printing exactly the pinned version', () => {
    delete process.env.PODIUM_SKIP_TOOL_PIN_CHECK
    const bin = fakeZig(readToolPins().zig)
    process.env.PODIUM_ZIG = bin
    expect(resolveZig()).toBe(bin)
  })

  it('waives the check under PODIUM_SKIP_TOOL_PIN_CHECK=1', () => {
    process.env.PODIUM_SKIP_TOOL_PIN_CHECK = '1'
    const bin = fakeZig('0.0.1-definitely-wrong')
    process.env.PODIUM_ZIG = bin
    expect(resolveZig()).toBe(bin)
  })
})
