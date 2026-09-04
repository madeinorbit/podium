/**
 * The identity that lets `@podium/harness/browser` state a manifest fact without
 * loading the manifests (POD-2206).
 *
 * `HARNESS_NO_TOOLS` is a second statement of something each manifest already
 * declares in its own `headless.noTools`. That is deliberate — the browser
 * cannot load a manifest — and this file is the reason it is safe: the two
 * statements are asserted equal for every harness, so a manifest that flips
 * without its table entry fails here and names the harness.
 *
 * Importing the registry from a TEST is fine; the point of the split is that a
 * BUNDLE never does.
 */

import { BUILTIN_HARNESS_KINDS } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { HARNESS_NO_TOOLS, harnessSupportsNoTools } from './browser.js'
import { declaredValue } from './manifest.js'
import { AGENT_MANIFESTS } from './registry.js'

describe('@podium/harness/browser — the no-tools table', () => {
  it('agrees with every manifest that declares headless.noTools', () => {
    const fromManifests = Object.fromEntries(
      BUILTIN_HARNESS_KINDS.map((kind) => {
        const headless = AGENT_MANIFESTS[kind].headless
        return [kind, declaredValue(headless)?.noTools === 'enforced']
      }),
    )
    expect(HARNESS_NO_TOOLS).toEqual(fromManifests)
  })

  it('covers every builtin harness — no kind may be absent', () => {
    expect(Object.keys(HARNESS_NO_TOOLS).sort()).toEqual([...BUILTIN_HARNESS_KINDS].sort())
  })

  it('fails closed on a harness this build has never heard of', () => {
    // The open wire type: a newer peer may name anything. The honest answer is
    // "no", never another CLI's row — and never a truthy `undefined`.
    expect(harnessSupportsNoTools('some-future-cli')).toBe(false)
    expect(harnessSupportsNoTools('')).toBe(false)
    // `shell` is a spawnable kind and NOT a harness, so it has no manifest.
    expect(harnessSupportsNoTools('shell')).toBe(false)
    // Inherited object properties must not answer for a harness.
    expect(harnessSupportsNoTools('toString')).toBe(false)
    expect(harnessSupportsNoTools('constructor')).toBe(false)
  })

  it('answers true only for the harnesses with a native all-tools-off mechanism', () => {
    expect(BUILTIN_HARNESS_KINDS.filter((kind) => harnessSupportsNoTools(kind))).toEqual([
      'claude-code',
      'pi',
    ])
  })
})
