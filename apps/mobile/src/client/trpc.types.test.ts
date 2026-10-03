import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const config = require('../../metro.config.js')
const worker = require(config.transformerPath)
const projectRoot = dirname(require.resolve('../../package.json'))
const source = readFileSync(require.resolve('./trpc.ts'), 'utf8')

describe('the mobile API type import at the Metro boundary', () => {
  it.each(['ios', 'web'])('erases the API import and client generics on %s', async (platform) => {
    const transform = (code: string) => worker.transform(
      config.transformer,
      projectRoot,
      'src/client/trpc.ts',
      Buffer.from(code),
      {
        type: 'module', platform, dev: false, minify: false, hot: false,
        inlineRequires: false, experimentalImportSupport: false,
        unstable_disableES6Transforms: false, unstable_transformProfile: 'default',
        customTransformOptions: { routerRoot: 'app' },
      },
    )
    const actual = await transform(source)
    const withoutTypeImport = await transform(source.replace(/^import type .*@podium\/api-types.*\n/m, ''))
    expect(actual.dependencies).toEqual(withoutTypeImport.dependencies)
    expect(actual.dependencies.map((dependency: { name: string }) => dependency.name))
      .not.toContain('@podium/api-types')
    expect(actual.output[0].data.code).toEqual(withoutTypeImport.output[0].data.code)
    expect(actual.output[0].data.code).not.toContain('AppRouter')
  })
})
