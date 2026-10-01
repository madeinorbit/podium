import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Both clients use React, but isolated linking permits different installed
// versions. Bundle this DOM fixture with the phone's one React/renderer pair,
// just as Metro does; never share node_modules between checkout graphs.
const resolvePhone = createRequire(new URL('../../../apps/mobile/package.json', import.meta.url))
const output = process.argv[2]!
const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL('./transcript-scroll.tsx', import.meta.url))],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'phone-dom-boundary',
      setup(builder) {
        builder.onResolve(
          { filter: /^(react(?:\/.*)?|react-dom(?:\/.*)?|react-native)$/ },
          ({ path }) => ({
            path:
              path === 'react-native'
                ? fileURLToPath(new URL('./scrollview-entry.ts', import.meta.url))
                : resolvePhone.resolve(path),
          }),
        )
        builder.onResolve({ filter: /^react-native-web\// }, ({ path }) => ({
          path: resolvePhone.resolve(path),
        }))
      },
    },
  ],
})
if (!build.success) throw new Error(build.logs.map(String).join('\n'))
await Bun.write(output, build.outputs[0]!)
