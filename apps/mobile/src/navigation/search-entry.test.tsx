import { existsSync } from 'node:fs'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkRouteParams } from '../screens/work-navigation'

const state = vi.hoisted(() => ({
  params: {} as WorkRouteParams,
  redirect: null as { pathname: string; params: object } | null,
}))
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => state.params,
  Redirect: ({ href }: { href: NonNullable<typeof state.redirect> }) => {
    state.redirect = href
    return null
  },
}))
vi.mock('expo-router/unstable-native-tabs', () => {
  const Box = ({ children }: { children: ReactNode }) => <div>{children}</div>
  return {
    NativeTabs: Object.assign(Box, {
      Trigger: Object.assign(
        ({
          children,
          name,
          hidden,
          role,
        }: {
          children: ReactNode
          name: string
          hidden?: boolean
          role?: string
        }) =>
          hidden ? null : (
            <div role="tab" tabIndex={0} data-route={name} data-native-role={role}>
              {children}
            </div>
          ),
        { Icon: () => null, Label: Box },
      ),
    }),
  }
})
const { default: TabsLayout } = await import('../../app/(tabs)/_layout.ios')
const { default: SearchRedirect } = await import('../../app/search')
afterEach(() => {
  cleanup()
  state.params = {}
  state.redirect = null
})

it('shows Work, Tasks, Pulse and Settings with no native search role', () => {
  render(<TabsLayout />)
  const tabs = screen.getAllByRole('tab')
  expect(tabs.map((tab) => [tab.getAttribute('data-route'), tab.textContent])).toEqual([
    ['work', 'Work'],
    ['issues', 'Tasks'],
    ['pulse', 'Pulse'],
    ['settings', 'Settings'],
  ])
  expect(tabs.every((tab) => !tab.hasAttribute('data-native-role'))).toBe(true)
  // Keeping a search route inside NativeTabs would create an automatic fifth tab.
  expect(existsSync(new URL('../../app/(tabs)/search', import.meta.url))).toBe(false)
})

it('redirects old search URLs to Work', () => {
  render(<SearchRedirect />)
  expect(state.redirect?.pathname).toBe('/work')
})

it('keeps the query and lane on old search links', () => {
  state.params = { workQuery: 'POD-123', workLane: 'closed' }
  render(<SearchRedirect />)
  expect(state.redirect).toMatchObject({
    pathname: '/work',
    params: { workQuery: 'POD-123', workLane: 'closed' },
  })
})
