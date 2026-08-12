import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MOBILE_HOME, MOBILE_TABS } from './navigation'

describe('mobile navigation', () => {
  it('opens on Work and exposes exactly four non-Tray tabs', () => {
    expect(MOBILE_HOME).toBe('/work')
    expect(MOBILE_TABS).toEqual([
      { name: 'work', title: 'Work' },
      { name: 'issues', title: 'Tasks' },
      { name: 'superagent', title: 'Super' },
      { name: 'pulse', title: 'Pulse' },
    ])
    expect(MOBILE_TABS.map((tab) => String(tab.name))).not.toContain('index')
    expect(MOBILE_TABS.map((tab) => String(tab.title))).not.toContain('Tray')
  })

  it('has no hidden Tray tab route for a deep link to reopen', () => {
    const files = readdirSync(resolve(process.cwd(), 'app/(tabs)'))
      .filter((file) => file.endsWith('.tsx') && file !== '_layout.tsx')
      .sort()
    expect(files).toEqual(['issues.tsx', 'pulse.tsx', 'superagent.tsx', 'work.tsx'])
  })
})
