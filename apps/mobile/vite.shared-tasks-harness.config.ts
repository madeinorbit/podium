// Harness config for the phone's shared tasks (POD-6297): the refresh-offer
// mapping (the `@podium/source` condition, the haptics stub) plus three
// stand-ins, each anchored to its import site: an open, in-place bottom sheet,
// a three-member roster with Bob reading, and the task's shared detail as the
// server answers it.
import { fileURLToPath } from 'node:url'
import base from './vite.harness.config'

const harness = (file: string) => fileURLToPath(new URL(`./harness/${file}`, import.meta.url))

export default async () => {
  const real = await base()
  return {
    ...real,
    resolve: {
      ...(real.resolve ?? {}),
      conditions: ['@podium/source', 'module', 'browser', 'development', 'import', 'default'],
      alias: [
        { find: /^\.\/BottomSheet$/, replacement: harness('stub-open-bottom-sheet.tsx') },
        { find: /^\.\.\/BottomSheet$/, replacement: harness('stub-open-bottom-sheet.tsx') },
        {
          find: /^(\.\.\/)+client\/member-roster$/,
          replacement: harness('shared-tasks-roster.ts'),
        },
        {
          find: /^(\.\.\/)+client\/use-issue-shared-detail$/,
          replacement: harness('shared-tasks-detail.ts'),
        },
        ...real.resolve.alias,
      ],
    },
    // Scan this page only: the root holds other harness pages whose graphs
    // reach Expo Router.
    optimizeDeps: { ...(real.optimizeDeps ?? {}), entries: ['shared-tasks-harness.html'] },
    server: { port: 8093, strictPort: true },
  }
}
