// Throwaway harness config for the phone refresh offer (POD-2511). The
// working-mark harness's mapping plus the two things this component needs:
// the `@podium/source` export condition (it reads the product-version meta
// name from @podium/protocol, and this checkout serves those packages unbuilt)
// and a haptics stub, because reaching expo-haptics drags expo-modules-core's
// native TS declarations into a browser bundle that cannot parse them.
import { fileURLToPath } from 'node:url'
import { defineConfig, type UserConfig } from 'vite'
import base from './vite.harness.config'

const real = base as UserConfig
const alias = (real.resolve?.alias ?? []) as Array<{ find: RegExp | string; replacement: string }>

export default defineConfig({
  ...real,
  resolve: {
    ...(real.resolve ?? {}),
    conditions: ['@podium/source', 'module', 'browser', 'development', 'import', 'default'],
    alias: [
      {
        find: /^expo-haptics$/,
        replacement: fileURLToPath(new URL('./harness/expo-haptics-stub.ts', import.meta.url)),
      },
      ...alias,
    ],
  },
  server: { port: 8092, strictPort: true },
})
