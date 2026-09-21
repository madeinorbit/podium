/**
 * POD-4447 — the MobX arm entry: a tracked object graph with enforcement on
 * (methodology §5.3). Implements shared/src/arm.ts; see README.md for the
 * idiom, the write path, and how to add a field.
 */

import './config'
import { createElement, type ReactElement } from 'react'
import type { Arm, ArmHandle, RowSource } from '../../shared/src/arm'
import type { SliceLocals } from '../../shared/src/slice-types'
import { MobXStore } from './store'

// DYNAMIC on purpose (not a bundle nicety): `./native` imports
// `react-native`, whose Flow-typed source the root node/unit lanes cannot
// parse. A static import would put that chain in every file importing this
// arm and break `bun run test:file` for the whole package (the POD-1220
// hazard, same as the hand arm and the legacy control). The chunk loads only
// via `preloadMobxNative()`; web entries never preload it.
type NativeModule = typeof import('./native/list')
let nativeModule: NativeModule | null = null

export function preloadMobxNative(): Promise<void> {
  if (nativeModule !== null) return Promise.resolve()
  return import('./native/list').then((module) => {
    nativeModule = module
  })
}

function NativeHost({ store }: { store: MobXStore }): ReactElement {
  if (nativeModule === null) {
    throw new Error('[mobx] native list not preloaded — call preloadMobxNative() first')
  }
  return createElement(nativeModule.MobxNativeList, { store })
}

export const mobxArm: Arm = {
  create(source: RowSource, locals: SliceLocals): ArmHandle {
    const store = new MobXStore(source, locals)
    return {
      snapshot: () => store.snapshot(),
      stats: store.stats,
      dispose: () => store.dispose(),
      mountWeb: (el: Element) => store.mountWeb(el),
      mountNative: (): ReactElement => createElement(NativeHost, { store }),
      // Test hook (parity checks, native lane): the live store.
      store,
    } as ArmHandle & { store: MobXStore }
  },
}
