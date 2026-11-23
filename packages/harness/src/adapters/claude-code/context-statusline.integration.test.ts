import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { startHookIngest } from '../../driver/families/terminal/instrumentation.js'
import fixtures from './__fixtures__/context-reports.json' with { type: 'json' }
import { claudeContext } from './context.js'
import { claudeStatusBridgeCommand } from './context-statusline.js'

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
function run(
  command: string,
  input: string,
  dir: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], {
      cwd: dir,
      env: { PATH: '/usr/bin:/bin', TMPDIR: dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = '',
      stderr = ''
    const deadline = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('bounded status bridge did not exit'))
    }, 5000)
    child.stdout.on('data', (value) => {
      stdout += String(value)
    })
    child.stderr.on('data', (value) => {
      stderr += String(value)
    })
    child.once('error', (error) => {
      clearTimeout(deadline)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(deadline)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

describe('Claude status bridge through the real observation channel', () => {
  it('preserves exact stdin, ANSI output/exit and cleanup, while publishing input-only context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-context-boundary-'))
    const lifetime = new AbortController()
    const declared = claudeContext.forDriver('generic-pty')
    if (!declared.supported) throw new Error(declared.reason)
    const bound = declared.value.bind({
      harness: 'claude-code',
      driver: 'generic-pty',
      nativeSessionId: fixtures.terminal['after-2'].session_id,
      revision: { bindingVersion: 1, observerGeneration: 1, turnEpoch: 0, contextRevision: 0 },
      signal: lifetime.signal,
      publish: () => {},
    })
    const observations: unknown[] = []
    const ingest = await startHookIngest({
      port: 0,
      onPayload(sessionId, payload) {
        expect(sessionId).toBe('invented-session-capability')
        observations.push(
          bound.observe(payload, {
            at: '2026-11-21T12:00:00.000Z',
            provenance: 'live',
            cursor: { segmentId: 'fixture', components: { seq: 1 } },
            observerGeneration: 1,
            turnEpoch: 0,
          }),
        )
      },
    })
    try {
      const input = `${JSON.stringify(fixtures.terminal['after-2'])}\n\n`
      const command = `sentinel=(USER_STATUS_SENTINEL); cat > ${quote(join(dir, 'original-input'))}; printf '\\033[32m%s\\033[0m\\n' "\${sentinel[0]}"; printf 'user-stderr' >&2; exit 7`
      const result = await run(
        claudeStatusBridgeCommand(
          ingest.endpointFor(asSessionId('invented-session-capability')),
          command,
        ),
        input,
        dir,
      )
      expect(result).toEqual({
        code: 7,
        stdout: '\u001b[32mUSER_STATUS_SENTINEL\u001b[0m\n',
        stderr: 'user-stderr',
      })
      expect(await readFile(join(dir, 'original-input'), 'utf8')).toBe(input)
      expect(observations).toHaveLength(1)
      expect(observations[0]).toMatchObject({
        context: {
          status: 'available',
          occupancy: { usedTokens: { value: 24000 }, percent: { value: 12 } },
        },
      })
      expect((await readdir(dir)).filter((name) => name.startsWith('podium-status.'))).toEqual([])
      const noUserCommand = await run(
        claudeStatusBridgeCommand('http://127.0.0.1:1/hooks/invented'),
        input,
        dir,
      )
      expect(noUserCommand).toEqual({ code: 0, stdout: '', stderr: '' })
      const failedObservation = await run(
        claudeStatusBridgeCommand('http://127.0.0.1:1/hooks/invented', 'printf retained; exit 9'),
        input,
        dir,
      )
      expect(failedObservation).toEqual({ code: 9, stdout: 'retained', stderr: '' })
      expect((await readdir(dir)).filter((name) => name.startsWith('podium-status.'))).toEqual([])
      console.info(
        'CLAUDE_CONTEXT_BOUNDARY_TRACE',
        JSON.stringify({
          source: 'invented captured status payload',
          channel: 'existing loopback hook ingest',
          observed: observations.length,
          inclusiveInput: 24000,
          lastOutput: 6000,
          nativePercent: 12,
          stdout: 'exact original ANSI sentinel only',
          exit: 7,
          exactStdinIncludingTrailingNewlines: true,
          failedSideChannelPreservesOutputAndExit: true,
          tempDirectoriesRemaining: 0,
        }),
      )
    } finally {
      lifetime.abort()
      await ingest.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
