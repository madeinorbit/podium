// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from 'vite'
import { describe, expect, it } from 'vitest'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const viteConfigPath = resolve(webRoot, 'vite.config.ts')
const viteConfig = readFileSync(viteConfigPath, 'utf8')

describe('workspace source resolution', () => {
  it('resolves domain source without requiring a generated workspace link', () => {
    expect(viteConfig).toContain("'@podium/model': fileURLToPath(")
    expect(viteConfig).toContain("new URL('../../packages/model/src/index.ts', import.meta.url)")
  })

  it('resolves terminal subpaths through the production Vite config', async () => {
    const config = await resolveConfig(
      {
        root: webRoot,
        configFile: viteConfigPath,
        logLevel: 'silent',
      },
      'build',
      'production',
    )
    expect(config.command).toBe('build')
    expect(config.mode).toBe('production')

    const resolveId = config.createResolver()
    const importer = resolve(webRoot, 'src/features/terminal/AgentPanel.tsx')
    const terminalClientSource = resolve(webRoot, '../../packages/terminal-client/src')
    const entryPoints = {
      '@podium/terminal-client/appearance': 'appearance.ts',
      '@podium/terminal-client/keys': 'keys.ts',
      '@podium/terminal-client/session-mount': 'session-mount.ts',
      '@podium/terminal-client/terminal-view': 'terminal-view.ts',
    }

    for (const [specifier, source] of Object.entries(entryPoints)) {
      expect(await resolveId(specifier, importer)).toBe(resolve(terminalClientSource, source))
    }
  })
})
