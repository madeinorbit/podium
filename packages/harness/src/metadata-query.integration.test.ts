import { afterEach, describe, expect, it, vi } from 'vitest'
import { harnessCommand } from './bound-command.js'
import { testHarnessContext } from './driver/testing/harness-context.js'
import { executeMetadataQuery, queryMetadataServer } from './metadata-query.js'
import { noAgentTerms } from './posture.js'

afterEach(() => vi.unstubAllEnvs())

describe('account-bound metadata commands', () => {
  const context = testHarnessContext({
    kind: 'pi',
    executable: process.execPath,
    env: { HOME: '/selected-account', PATH: '/no-harness-on-path', METADATA_PROBE: 'selected' },
  })
  const command = (script: string) =>
    harnessCommand(context, { args: ['-e', script] }, noAgentTerms('metadata query fixture'))

  it('uses the pinned executable and account env, and sends the metadata request through stdin', async () => {
    vi.stubEnv('METADATA_PROBE', 'ambient-decoy')
    const stdout = await executeMetadataQuery(
      {
        context,
        command: command(
          `let input='';process.stdin.on('data',data=>input+=data);process.stdin.on('end',()=>console.log(JSON.stringify({home:process.env.HOME,selected:process.env.METADATA_PROBE,input})))`,
        ),
        stdin: 'get_state\n',
      },
      5000,
    )
    expect(JSON.parse(stdout)).toEqual({
      home: '/selected-account',
      selected: 'selected',
      input: 'get_state\n',
    })
  })

  it('stops the private metadata server when its read completes', async () => {
    let pid = 0
    const result = await queryMetadataServer(
      {
        context,
        command: command(`console.log(JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)`),
        endpoint(line) {
          pid = JSON.parse(line).pid
          return 'http://127.0.0.1'
        },
        read: async () => 'models',
      },
      5000,
    )
    expect(result).toBe('models')
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('fails a startup deadline and stops the process that never announced an endpoint', async () => {
    let pid = 0
    await expect(
      queryMetadataServer(
        {
          context,
          command: command(
            `console.log(JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)`,
          ),
          endpoint(line) {
            pid = JSON.parse(line).pid
            return undefined
          },
          read: async () => 'never',
        },
        1000,
      ),
    ).rejects.toThrow('timed out')
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).toThrow()
  })
})
