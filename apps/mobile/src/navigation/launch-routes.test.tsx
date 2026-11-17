import { cleanup, render } from '@testing-library/react'
import { getReactNavigationConfig } from 'expo-router/build/getReactNavigationConfig'
import { getRoutes } from 'expo-router/build/getRoutesCore'
import type { RequireContext } from 'expo-router/build/types'
import { Children, isValidElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  reduceMotion: false,
  initialRouteName: '',
  options: {} as Record<string, unknown>,
  screens: {} as Record<string, Record<string, unknown>>,
  redirects: [] as string[],
}))

vi.mock('../lib/crypto-polyfill', () => ({}))
vi.mock('react-native-screens', () => ({ enableFreeze: vi.fn() }))
vi.mock('expo-router/unstable-native-tabs', () => ({ NativeTabs: () => null }))
vi.mock('../client/root-layout-shell', () => ({
  RootLayoutShell: ({
    Navigation,
  }: {
    Navigation: React.ComponentType<{ reduceMotion: boolean }>
  }) => <Navigation reduceMotion={native.reduceMotion} />,
}))
vi.mock('expo-router/stack', () => ({
  Stack: Object.assign(
    ({
      children,
      initialRouteName,
      screenOptions,
    }: {
      children: ReactNode
      initialRouteName: string
      screenOptions: Record<string, unknown>
    }) => {
      native.initialRouteName = initialRouteName
      native.options = screenOptions
      native.screens = {}
      Children.forEach(children, (child) => {
        if (
          !isValidElement<{
            name: string
            options:
              | Record<string, unknown>
              | ((args: { route: { key: string; name: string } }) => Record<string, unknown>)
          }>(child)
        )
          return
        const { name, options } = child.props
        const resolved =
          typeof options === 'function' ? options({ route: { key: name, name } }) : options
        native.screens[name] = { ...screenOptions, ...resolved }
      })
      return null
    },
    { Screen: () => null },
  ),
}))
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => {
    native.redirects.push(href)
    return null
  },
}))

// This lane prefers .web.tsx; pin the native entry to exercise its actual stack.
const { default: RootLayout, unstable_settings: rootSettings } =
  await vi.importActual<typeof import('../../app/_layout')>('../../app/_layout.tsx')
const { unstable_settings: tabsSettings } = await vi.importActual<
  typeof import('../../app/(tabs)/_layout')
>('../../app/(tabs)/_layout.ios.tsx')
const { default: Home } = await import('../../app/index')
const { default: SignedIn } = await import('../../app/signed-in')

afterEach(() => {
  cleanup()
  native.redirects = []
})

describe('native launch routes', () => {
  it('declares the tabs and Work anchors in Expo Router linking config', () => {
    const routes = {
      './_layout.tsx': { default: () => null, unstable_settings: rootSettings },
      './(tabs)/_layout.tsx': { default: () => null, unstable_settings: tabsSettings },
      './(tabs)/work/_layout.tsx': { default: () => null },
      './(tabs)/work/index.tsx': { default: () => null },
      './(tabs)/issues/_layout.tsx': { default: () => null },
      './(tabs)/issues/index.tsx': { default: () => null },
      './issue/[issueId].tsx': { default: () => null },
      './mission/[missionId].tsx': { default: () => null },
      './mission/[missionId]/details.tsx': { default: () => null },
    }
    const context = Object.assign((key: string) => routes[key as keyof typeof routes], {
      keys: () => Object.keys(routes),
    }) as RequireContext
    const tree = getRoutes(context, {
      skipGenerated: true,
      getSystemRoute: () => {
        throw new Error('The fixture supplies every route')
      },
    })
    if (!tree) throw new Error('Missing route tree')
    const config = getReactNavigationConfig(tree, true)
    expect(config.initialRouteName).toBe('(tabs)')
    expect(config.screens['(tabs)']).toMatchObject({ initialRouteName: 'work' })
  })

  it('fits Start Agent to its content while keeping its transparent native bar', () => {
    render(<RootLayout />)
    expect(native.screens['launch/[issueId]']).toMatchObject({
      presentation: 'formSheet',
      sheetAllowedDetents: 'fitToContents',
      headerShown: true,
      headerTransparent: true,
      headerLargeTitleEnabled: false,
    })
  })

  it('presents the flight deck as a full-screen card and leaves the iOS content pop gesture unrestricted', () => {
    render(<RootLayout />)
    expect(native.screens['mission/[missionId]/details']).toMatchObject({
      presentation: 'card',
      title: 'Flight deck',
    })
    expect(native.screens['mission/[missionId]/details']).not.toHaveProperty('sheetAllowedDetents')
    expect(native.options).not.toHaveProperty('gestureResponseDistance')
    expect(native.options).not.toHaveProperty('customAnimationOnGesture')
    expect(native.options).not.toHaveProperty('fullScreenGestureEnabled')
  })
  it.each([
    false,
    true,
  ])('declares headerless redirects and a nonanimated tabs destination before screens mount, reduce motion %s', (reduceMotion) => {
    native.reduceMotion = reduceMotion
    render(<RootLayout />)

    expect(native.initialRouteName).toBe('(tabs)')
    for (const name of ['index', 'signed-in', '(tabs)']) {
      expect(native.screens[name]).toMatchObject({ headerShown: false, animation: 'none' })
    }
    expect(native.screens['(tabs)']?.title).toBe('Work')
    // Pushed screens retain the normal native navigation behavior.
    expect(native.options.animation).toBe(reduceMotion ? 'fade' : 'default')
    expect(native.screens['new-issue']).toMatchObject({
      presentation: 'formSheet',
      sheetAllowedDetents: [1],
      sheetGrabberVisible: false,
      title: 'New Task',
      headerTransparent: true,
      headerLargeTitleEnabled: false,
      headerBackVisible: false,
    })
  })

  it.each([
    ['/', Home],
    ['/signed-in', SignedIn],
  ] as const)('%s redirects straight to Work without rendering a header or callback text', (_, Route) => {
    const view = render(<Route />)
    expect(native.redirects).toEqual(['/work'])
    expect(view.container.textContent).toBe('')
  })
})
