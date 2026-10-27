// @vitest-environment node
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, it } from 'vitest'

it('resolves shared envelope text without loading command contracts or daemon schemas', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const entry = `${root}message-envelope-boundary-fixture.js`
  let modules: string[] = []
  await build({
    configFile: false,
    root,
    logLevel: 'silent',
    resolve: { conditions: ['@podium/source', 'browser', 'module', 'production'] },
    plugins: [
      {
        name: 'message-envelope-boundary-fixture',
        resolveId: (id) => (id === entry ? entry : undefined),
        load: (id) =>
          id === entry
            ? "import { parseMessageEnvelope } from '@podium/client-core/values'; window.parseMessageEnvelope = parseMessageEnvelope"
            : undefined,
        generateBundle() {
          // Inspect loaded modules too: tree shaking must not hide a broad import.
          modules = [...this.getModuleIds()]
        },
      },
    ],
    build: { write: false, rolldownOptions: { input: entry } },
  })
  expect(modules).toContain(
    fileURLToPath(
      new URL('../../../packages/client-core/src/values/message-envelope.ts', import.meta.url),
    ),
  )
  expect(modules.filter((id) => id.includes('/packages/commands/')).sort()).toEqual([
    fileURLToPath(new URL('../../../packages/commands/src/mail/mail-command.ts', import.meta.url)),
    fileURLToPath(new URL('../../../packages/commands/src/mail/pointer-nudge.ts', import.meta.url)),
    fileURLToPath(
      new URL('../../../packages/commands/src/mail/turn-close-rule.ts', import.meta.url),
    ),
  ])
  expect(modules.filter((id) => /\/packages\/protocol\/src\/daemon(?:\.|\/)/.test(id))).toEqual([])
}, 30_000)
