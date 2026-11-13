import { SETTINGS_CLASSIFICATION } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SETTINGS_PAGES } from './page-definitions'
import {
  adminSectionOf,
  NOT_ON_THIS_SCREEN,
  PAGE_SETTINGS_TIER,
  pathIsUnder,
  SETTINGS_SURFACES,
  TAB_PATHS,
  TAB_SURFACE,
  tabsOnSurface,
  visibleSettingsGroups,
} from './surfaces'

const pages = SETTINGS_PAGES.map((page) => page.key)

describe('settings page classification', () => {
  it('declares all thirteen pages in the Personal and Workspace groups', () => {
    expect(SETTINGS_CLASSIFICATION.length).toBeGreaterThanOrEqual(39)
    expect(SETTINGS_SURFACES).toEqual(['personal', 'workspace'])
    expect(pages).toHaveLength(13)
    expect(Object.keys(TAB_SURFACE)).toEqual(pages)
    for (const page of SETTINGS_PAGES) expect(TAB_SURFACE[page.key]).toBe(page.group)
  })

  for (const page of pages) {
    const prefixes = TAB_PATHS[page]
    if (prefixes.length === 0) continue
    it(`${page} retains each leaf’s write tier when re-homing controls`, () => {
      for (const prefix of prefixes) {
        const matches = SETTINGS_CLASSIFICATION.filter((entry) => pathIsUnder(entry.path, prefix))
        expect(matches.length, `${page}: ${prefix} matches no classified leaf`).toBeGreaterThan(0)
        for (const entry of matches) {
          // Secret rows may be re-homed alongside preferences. Each still
          // writes through the secret contract, never the page's record tier.
          if (entry.tier === 'server-secret') continue
          expect(entry.tier, entry.path).toBe(PAGE_SETTINGS_TIER[page])
        }
      }
    })
  }

  it('accounts for every classified leaf with exactly one home or an absence reason', () => {
    for (const entry of SETTINGS_CLASSIFICATION) {
      const homes = pages.filter((page) =>
        TAB_PATHS[page].some((prefix) => pathIsUnder(entry.path, prefix)),
      )
      const reason = NOT_ON_THIS_SCREEN[entry.path]
      expect(homes.length + (reason ? 1 : 0), entry.path).toBe(1)
    }
    for (const [path, reason] of Object.entries(NOT_ON_THIS_SCREEN)) {
      expect(
        SETTINGS_CLASSIFICATION.some((entry) => entry.path === path),
        path,
      ).toBe(true)
      expect(reason.trim().length, path).toBeGreaterThan(0)
    }
  })

  it('homes integration secrets beside their features and retires workspace provider keys', () => {
    const home = (path: string) =>
      pages.filter((page) => TAB_PATHS[page].some((prefix) => pathIsUnder(path, prefix)))
    const expectedHomes = {
      'integrations.linearApiKey': 'projects',
      'notifications.telegramBotToken': 'notifications',
    }
    for (const entry of SETTINGS_CLASSIFICATION.filter((entry) => entry.tier === 'server-secret')) {
      if (entry.path.startsWith('apiKeys.')) {
        expect(home(entry.path)).toEqual([])
        expect(NOT_ON_THIS_SCREEN[entry.path]).toContain('personal managed accounts')
      } else
        expect(home(entry.path)).toEqual([expectedHomes[entry.path as keyof typeof expectedHomes]])
    }
    expect(TAB_SURFACE.projects).toBe('workspace')
    expect(PAGE_SETTINGS_TIER.projects).toBe('instance-preference')
  })

  it('matches prefixes on a dot boundary', () => {
    expect(pathIsUnder('roles.coding', 'roles.coding')).toBe(true)
    expect(pathIsUnder('roles.coding.model', 'roles.coding')).toBe(true)
    expect(pathIsUnder('roles.codingAssistant.model', 'roles.coding')).toBe(false)
    expect(pathIsUnder('apiKeys.openaiLegacy', 'apiKeys.openai')).toBe(false)
  })
})

describe('page visibility comes from the admin viewer', () => {
  const groups = SETTINGS_SURFACES.map((surface) => ({
    surface,
    tabs: tabsOnSurface(surface).map((key) => ({ key, label: key })),
  }))
  const rail = (sections: readonly string[]) =>
    Object.fromEntries(
      visibleSettingsGroups(groups, sections).map((group) => [
        group.surface,
        group.tabs.map((page) => page.key),
      ]),
    )
  it('offers all pages to an admin', () => {
    expect(rail(['people', 'access', 'machines', 'instance', 'audit'])).toEqual({
      personal: ['agents', 'accounts', 'notifications', 'appearance', 'account'],
      workspace: [
        'machines',
        'projects',
        'members',
        'access',
        'audit',
        'privacy',
        'updates',
        'labs',
      ],
    })
  })
  it('keeps the four shared workspace pages for members', () => {
    expect(rail([])).toEqual({
      personal: ['agents', 'accounts', 'notifications', 'appearance', 'account'],
      workspace: ['machines', 'projects', 'members', 'updates'],
    })
    expect(pages.filter((page) => adminSectionOf(page) !== undefined)).toEqual([
      'access',
      'audit',
      'privacy',
      'labs',
    ])
  })
})
