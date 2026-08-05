/**
 * THE SCREEN'S CLASSIFICATION, CHECKED AGAINST THE MODEL'S (POD-421).
 *
 * The three surfaces are a claim about which class each tab belongs to. A
 * heading in JSX makes that claim where nothing can check it; `surfaces.ts`
 * makes it as data so this file can hold it against POD-418's shipped
 * `SETTINGS_CLASSIFICATION` — the same "bind to the SHIPPED table" discipline
 * POD-305 established, applied to a UI.
 *
 * WHAT THIS CANNOT DO, stated so a green run is not over-read: it compares two
 * declarations, not a declaration against the JSX. A row that edited
 * `hibernation.enabled` from a tab declared `your-preferences` would still
 * render. What it DOES catch is what actually happens — a leaf added to the
 * model and to no screen, and a tab whose declared class disagrees with the
 * tiers of the paths it says it edits.
 */

import { SETTINGS_CLASSIFICATION, type SettingsTier } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { SettingsTab } from './SettingsView'
import {
  NOT_ON_THIS_SCREEN,
  pathIsUnder,
  SETTINGS_SURFACES,
  type SettingsSurface,
  SURFACE_COPY,
  TAB_PATHS,
  TAB_SURFACE,
  tabsOnSurface,
} from './surfaces'

/** Which tier a surface claims. The one place the two vocabularies meet. */
const SURFACE_TIER: Readonly<Record<SettingsSurface, SettingsTier>> = {
  'your-preferences': 'personal-preference',
  instance: 'instance-preference',
  secrets: 'server-secret',
}

const CLASSIFIED = SETTINGS_CLASSIFICATION
const TABS = Object.keys(TAB_SURFACE) as SettingsTab[]

describe('the tables are not empty — nothing below is vacuous', () => {
  it('there are classified leaves, tabs, and all three surfaces', () => {
    // Every claim in this file is a for-loop over one of these. An empty
    // classification would make "every path matches its tab's tier" true by
    // finding nothing, which is the POD-363 shape exactly.
    expect(CLASSIFIED.length).toBeGreaterThanOrEqual(39)
    expect(TABS.length).toBeGreaterThan(10)
    expect(SETTINGS_SURFACES).toHaveLength(3)
    for (const surface of SETTINGS_SURFACES) {
      expect(tabsOnSurface(surface).length).toBeGreaterThan(0)
    }
  })
})

describe("every tab's declared paths are classified in its surface's tier", () => {
  for (const tab of TABS) {
    const prefixes = TAB_PATHS[tab]
    if (prefixes.length === 0) continue
    const tier = SURFACE_TIER[TAB_SURFACE[tab]]

    it(`${tab}: every path under its prefixes is ${tier}`, () => {
      const matched = CLASSIFIED.filter((c) => prefixes.some((p) => pathIsUnder(c.path, p)))
      // The per-tab non-vacuity floor: a prefix that matches NOTHING would make
      // the tier assertion below pass without checking anything, and a renamed
      // model path is exactly how that happens.
      expect(
        matched.length,
        `${tab} declares prefixes that match no classified path`,
      ).toBeGreaterThan(0)
      for (const c of matched) {
        expect(c.tier, `${c.path} is ${c.tier} but sits on a ${tier} tab`).toBe(tier)
      }
    })
  }
})

describe('TOTALITY — every classified leaf is on a tab or is named as absent', () => {
  it('no leaf is silently on neither list', () => {
    // The check that matters: without it, "a leaf is on no screen" and "a leaf
    // was forgotten" are the same silence. A leaf added to the model and to no
    // tab fails HERE rather than shipping unreachable.
    const unaccounted = CLASSIFIED.filter((c) => {
      const onATab = TABS.some((tab) => TAB_PATHS[tab].some((p) => pathIsUnder(c.path, p)))
      return !onATab && NOT_ON_THIS_SCREEN[c.path] === undefined
    }).map((c) => c.path)
    expect(unaccounted).toEqual([])
  })

  it('and nothing is on BOTH lists', () => {
    // The other direction. A path named as absent while a tab also edits it
    // means the exception list is stale, and a stale exception list is how a
    // real omission later hides behind an explanation.
    const both = Object.keys(NOT_ON_THIS_SCREEN).filter((path) =>
      TABS.some((tab) => TAB_PATHS[tab].some((p) => pathIsUnder(path, p))),
    )
    expect(both).toEqual([])
  })

  it('every named exception is a REAL classified path', () => {
    // A licence is checked, per `MACHINE_USE_OFFLINE_EXCEPTIONS`' rule: an
    // exception for a path that does not exist would silently pre-excuse
    // whoever next used that name.
    const known = new Set(CLASSIFIED.map((c) => c.path))
    for (const path of Object.keys(NOT_ON_THIS_SCREEN)) {
      expect(known.has(path), `${path} is excused but is not a classified leaf`).toBe(true)
    }
  })
})

describe('the SECRETS surface is exactly the closed vocabulary', () => {
  it('its tab declares all five server secrets and nothing else', () => {
    const secretTabs = tabsOnSurface('secrets')
    expect(secretTabs).toEqual(['secrets'])
    const declared = [...TAB_PATHS.secrets].sort()
    const fromModel = CLASSIFIED.filter((c) => c.tier === 'server-secret')
      .map((c) => c.path)
      .sort()
    // Whole-set equality in BOTH directions: a sixth secret added to the model
    // and not to the screen fails, and a path on the screen that is not a
    // secret fails too.
    expect(declared).toEqual(fromModel)
  })

  it('no OTHER tab claims a server-secret path', () => {
    for (const tab of TABS) {
      if (tab === 'secrets') continue
      const leaked = CLASSIFIED.filter(
        (c) => c.tier === 'server-secret' && TAB_PATHS[tab].some((p) => pathIsUnder(c.path, p)),
      )
      expect(
        leaked.map((c) => c.path),
        `${tab} claims a secret path`,
      ).toEqual([])
    }
  })
})

describe('pathIsUnder matches on a DOT BOUNDARY', () => {
  it('claims the prefix itself and its descendants', () => {
    expect(pathIsUnder('roles.coding', 'roles.coding')).toBe(true)
    expect(pathIsUnder('roles.coding.model', 'roles.coding')).toBe(true)
  })

  it('does NOT claim a sibling that merely starts with the same characters', () => {
    // The canonicalisation collision POD-420's fingerprint separator was written
    // against, arriving in a path matcher: a bare `startsWith` would let
    // `roles.coding` claim `roles.codingAssistant`, silently absorbing a leaf
    // onto the wrong surface AND satisfying the totality check while doing it.
    expect(pathIsUnder('roles.codingAssistant.model', 'roles.coding')).toBe(false)
    expect(pathIsUnder('apiKeys.openaiLegacy', 'apiKeys.openai')).toBe(false)
  })
})

describe('each class is NAMED, and says nothing else (POD-407)', () => {
  it('carries a label per surface and no per-tab banner copy', () => {
    // The `hint` these used to carry rendered at the top of every tab on the
    // surface — the same paragraph on seven preference tabs and eight instance
    // tabs. Asserting its ABSENCE keeps the banner from growing back one
    // helpful sentence at a time; the class stays legible through the rail's
    // group headings, which is what §3.1.1 asks for.
    for (const surface of SETTINGS_SURFACES) {
      const copy = SURFACE_COPY[surface] as { label: string; hint?: string }
      expect(copy.label.length).toBeGreaterThan(0)
      expect(copy.hint).toBeUndefined()
    }
  })
})
