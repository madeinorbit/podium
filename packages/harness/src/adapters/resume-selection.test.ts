import { describe, expect, it } from 'vitest'
import { AGENT_MANIFESTS } from '../registry.js'
import { fixtureManifest } from './fixture/index.js'

const manifests = [...Object.values(AGENT_MANIFESTS), fixtureManifest]
const resumeFlags: Record<string, string> = {
  'claude-code': '--resume', codex: 'resume', cursor: '--resume', grok: '--resume',
  opencode: '--session', pi: '--session', fixture: '--resume',
}

describe('each harness owns its resume selection (POD-3911)', () => {
  for (const manifest of manifests) {
    it.each([undefined, 'auto'])(`${manifest.kind} resumes with no model or effort override (%s)`, (auto) => {
      const command = manifest.launch({
        cwd: '/work', homeDir: '/home/agent', runtimeDir: '/runtime/session',
        resume: { kind: manifest.resumeKind, value: 'native-resume-id' },
        ...(auto ? { model: auto, effort: auto } : {}),
      })
      expect(command.args).toContain(resumeFlags[manifest.kind])
      expect(command.args).toContain('native-resume-id')
      for (const flag of ['--model', '-m', '--effort', '--thinking', '--variant']) {
        expect(command.args).not.toContain(flag)
        expect(command.args.some((arg) => arg.startsWith(`${flag}=`))).toBe(false)
      }
      // Codex effort rides -c; OpenCode effort rides a seeded model.json file.
      // Neither transport may inject a selection when the frame omitted it.
      const config = JSON.stringify({ args: command.args, env: command.env, files: command.files })
      expect(config).not.toMatch(/model_reasoning_effort|reasoningEffort|thinkingLevel|"variant"/)
      expect(command.files?.some((file) => file.path.endsWith('/model.json')) ?? false).toBe(false)
    })
  }
})
