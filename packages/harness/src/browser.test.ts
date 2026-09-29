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
import {
  BUNDLED_DESCRIPTORS,
  bundledDescriptorFor,
  composerRulesFor,
  effectiveCatalogModel,
  HARNESS_NO_TOOLS,
  harnessSupportsNoTools,
  markOf,
  parseServedDescriptors,
  resolveDescriptors,
} from './browser.js'
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

/**
 * The bundled composer rules (POD-4477): CODE the browser may carry, stating
 * the same fact each manifest's `composer` section states. The daemon reads
 * the section through the manifest; the client reads this bundle — the
 * reference-equality assertion below is what makes them "the same pure
 * functions" rather than two copies that can drift.
 *
 * Importing the registry from a TEST is fine; the point of the split is that a
 * BUNDLE never does.
 */
describe('@podium/harness/browser — the bundled composer rules', () => {
  it('agrees with every manifest about which harnesses declare composer rules', () => {
    for (const kind of BUILTIN_HARNESS_KINDS) {
      const declared = declaredValue(AGENT_MANIFESTS[kind].composer)
      const bundled = composerRulesFor(kind)
      expect(bundled !== undefined, `${kind} bundled`).toBe(declared !== undefined)
      // Same object, not an equal copy: both consumers read one definition.
      if (declared && bundled) expect(bundled).toBe(declared)
    }
  })

  it('fails closed on harnesses this build knows no rules for', () => {
    // The open wire type: a newer peer may name anything. The honest answer is
    // "no rules", not another CLI's row — and never a truthy `undefined`.
    expect(composerRulesFor('some-future-cli')).toBe(undefined)
    expect(composerRulesFor('')).toBe(undefined)
    // `shell` is a spawnable kind and NOT a harness, so it has no manifest.
    expect(composerRulesFor('shell')).toBe(undefined)
    // Declined sections bundle nothing: grok runs, but has no composer rules.
    expect(composerRulesFor('grok')).toBe(undefined)
    // Inherited object properties must not answer for a harness.
    expect(composerRulesFor('toString')).toBe(undefined)
    expect(composerRulesFor('constructor')).toBe(undefined)
  })
})

describe('@podium/harness/browser — the descriptor mark (POD-4737)', () => {
  it('states one arbitrary mark per harness in the bundled rows', () => {
    // Literals allowed: tests sit outside the vendor-boundary lint, and these
    // rows are what the meter assertions elsewhere pin against.
    const marks = Object.fromEntries(BUNDLED_DESCRIPTORS.map((d) => [d.kind, d.mark]))
    expect(marks).toMatchObject({
      'claude-code': 'CC',
      codex: 'CX',
      grok: 'GR',
      opencode: 'OC',
      cursor: 'CU',
      pi: 'PI',
    })
  })

  it('resolves the stated mark, else the generic initialism', () => {
    expect(markOf('codex', 'CX')).toBe('CX')
    expect(markOf('codex', 'C2')).toBe('C2')
    // The generic cannot derive the arbitrary spellings — 'CX', not 'CO'.
    expect(markOf('codex')).toBe('C')
    expect(markOf('claude-code')).toBe('CC')
    expect(markOf('some-future-harness')).toBe('SF')
    expect(markOf('codex', '  ')).toBe('C')
  })

  it('parses the mark when stated and omits it when absent', () => {
    const frame = { kind: 'codex', label: 'Codex' }
    expect(parseServedDescriptors([{ ...frame, mark: 'C2' }])[0]).toHaveProperty('mark', 'C2')
    expect(parseServedDescriptors([frame])[0]).not.toHaveProperty('mark')
  })

  it('merges served per field: stated fields win, absent ones inherit bundled', () => {
    // An older daemon's row (no mark) keeps this build's mark but takes the
    // served availability; a stated mark wins over bundled.
    const merged = resolveDescriptors(
      parseServedDescriptors([
        { kind: 'codex', label: 'Codex', available: { installed: true, loggedIn: true } },
      ]),
    )
    expect(merged.find((d) => d.kind === 'codex')).toMatchObject({
      mark: 'CX',
      available: { installed: true, loggedIn: true },
    })
    const overridden = resolveDescriptors(
      parseServedDescriptors([{ kind: 'codex', label: 'Codex', mark: 'C2' }]),
    )
    expect(overridden.find((d) => d.kind === 'codex')).toMatchObject({ mark: 'C2' })
  })

  it('never resurrects a login or sections a served row omits (POD-4737)', () => {
    // Only INHERITABLE_WHEN_ABSENT (provider, mark — fields an older daemon
    // cannot know) falls back to bundled. A served row without login or
    // sections omits them deliberately (a newer daemon whose harness needs
    // no login flow), so the merged row must not regain the bundled copy.
    // Stated through two served rows for the same kind: the second omits
    // what the first stated, and the merge must not carry it over.
    const merged = resolveDescriptors(
      parseServedDescriptors([
        { kind: 'codex', label: 'Codex', login: { command: 'codex-login' } },
        { kind: 'codex', label: 'Codex' },
      ]),
    )
    expect(merged.find((d) => d.kind === 'codex')).not.toHaveProperty('login')
    const withSections = resolveDescriptors(
      parseServedDescriptors([
        { kind: 'codex', label: 'Codex', sections: [{ section: 'usage', supported: true }] },
        { kind: 'codex', label: 'Codex' },
      ]),
    )
    expect(withSections.find((d) => d.kind === 'codex')).not.toHaveProperty('sections')
  })
})

/**
 * The effective catalog model (POD-4805): the ONE function the server's
 * one-shot Codex client and the settings page's effective-model line both
 * read, so the displayed model and the called model cannot disagree.
 */
describe('@podium/harness/browser — effectiveCatalogModel', () => {
  it("resolves 'auto' to the catalog head (the list the harness uses)", () => {
    const codex = bundledDescriptorFor('codex')
    expect(codex?.catalog.models[0]?.value).toBeTruthy()
    expect(effectiveCatalogModel(codex, 'auto')).toBe(codex?.catalog.models[0]?.value)
  })

  it('passes explicit models through untouched', () => {
    const codex = bundledDescriptorFor('codex')
    expect(effectiveCatalogModel(codex, 'gpt-5.5')).toBe('gpt-5.5')
    expect(effectiveCatalogModel(codex, 'a-custom-slug')).toBe('a-custom-slug')
  })

  it('prefers the live list when the probe answered', () => {
    const codex = bundledDescriptorFor('codex')
    const live = [{ value: 'live-model', label: 'Live' }]
    expect(effectiveCatalogModel(codex, 'auto', live)).toBe('live-model')
  })

  it('fails closed without a catalog (never a guessed slug)', () => {
    expect(effectiveCatalogModel(undefined, 'auto')).toBeUndefined()
    expect(effectiveCatalogModel(bundledDescriptorFor('some-future-cli'), 'auto')).toBeUndefined()
  })
})
