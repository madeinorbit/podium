import { describe, expect, it } from 'vitest'
// CommonJS because `expo prebuild` requires the plugin directly, outside this
// repo's TypeScript pipeline.
import plugin from './with-scene-lifecycle.js'

const { adoptSceneLifecycle, SCENE_MANIFEST } = plugin as unknown as {
  adoptSceneLifecycle: (appDelegate: string) => string
  SCENE_MANIFEST: { UISceneConfigurations: Record<string, Array<Record<string, string>>> }
}

// A trimmed copy of the AppDelegate the SDK 57 template generates.
const APP_DELEGATE = `internal import Expo
import React

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`

describe('adoptSceneLifecycle', () => {
  it('hands the window to SceneDelegate instead of creating it at launch', () => {
    const patched = adoptSceneLifecycle(APP_DELEGATE)

    expect(patched).toContain('class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {')
    expect(patched).not.toContain('UIWindow(frame:')
    expect(patched).not.toContain('startReactNative')
    expect(patched).toContain('return super.application(application, didFinishLaunchingWithOptions: launchOptions)')
  })

  it('stays a single rewrite when prebuild runs over an existing ios directory', () => {
    const once = adoptSceneLifecycle(APP_DELEGATE)
    expect(adoptSceneLifecycle(once)).toBe(once)
  })

  it('refuses an AppDelegate it cannot anchor to, rather than shipping the iOS 27 launch crash', () => {
    expect(() => adoptSceneLifecycle(APP_DELEGATE.replace(/#if os[\s\S]*?#endif\n/, ''))).toThrow(/window/)
    expect(() => adoptSceneLifecycle(APP_DELEGATE.replace('ExpoAppDelegate {', 'NSObject {'))).toThrow(/declaration/)
  })
})

describe('SCENE_MANIFEST', () => {
  it('points the application role at the module-qualified SceneDelegate', () => {
    const [scene] = SCENE_MANIFEST.UISceneConfigurations.UIWindowSceneSessionRoleApplication
    expect(scene.UISceneDelegateClassName).toBe('$(PRODUCT_MODULE_NAME).SceneDelegate')
  })
})
