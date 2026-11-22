/**
 * WHAT A HEADLESS TURN RUNS (POD-4614). The argv suite moved from
 * apps/daemon/src/headless-drivers.test.ts with the builder it pins; the
 * composition cases below are new with the one merged invocation shape.
 */
import { asAccountId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { harnessInstallation } from '../../../harness-context.js'
import { testHarnessContext, testTurnPosture } from '../../testing/harness-context.js'
import {
  assertHeadlessToolPolicy,
  buildHeadlessExec,
  composeHeadlessInvocation,
  headlessInstallation,
} from './invocation.js'
import { testHarnessSnapshot } from './test-support.js'

const snapshot = testHarnessSnapshot()
const POSTURE = testTurnPosture()

describe('fresh invocation installation witness', () => {
  it.each([
    '/selected/codex',
    '/unobserved/codex',
  ])('uses only the exact selected executable snapshot: %s', (selected) => {
    const creation = testHarnessContext({
      kind: 'codex',
      executable: selected,
      version: 'codex-cli 0.169.0',
      generation: 1,
    })
    const current = {
      ...testHarnessSnapshot({}, 2),
      executables: new Map([
        [
          'codex' as const,
          {
            kind: 'codex' as const,
            path: '/selected/codex',
            version: 'codex-cli 0.170.0',
            generation: 2,
          },
        ],
      ]),
    }
    const installation = headlessInstallation({ agent: 'codex', harnessContext: creation }, current)
    expect(installation).toEqual({
      kind: 'codex',
      executable: selected,
      version: selected === '/selected/codex' ? 'codex-cli 0.170.0' : '',
      generation: 2,
    })
    expect(creation.installation.version).toBe('codex-cli 0.169.0')
    expect(
      headlessInstallation(
        { agent: 'codex', harnessContext: creation, executablePath: '/explicit/unobserved' },
        current,
      ),
    ).toMatchObject({ executable: '/explicit/unobserved', version: '' })
  })
})

/**
 * What Codex's posture section puts right after `exec` on a turn under the
 * default posture (POD-6858 §4.8). Moved to posture: a turn used to carry
 * none of these.
 */
const CODEX_TURN_POSTURE_ARGS = [
  '-c',
  'projects={"/work/podium-test"={trust_level="trusted"}}',
  '-c',
  'sandbox_workspace_write.network_access=true',
  '--approve-for-me',
]
/** What Grok's posture section puts before `--single` on a turn under the
 *  default posture (POD-6858 §4.8). Moved to posture: a turn carried none. */
const GROK_TURN_POSTURE_ARGS = ['--permission-mode', 'auto', '--allow', 'Bash(podium *)']

const identity = {
  launchPosture: POSTURE,
  accountId: asAccountId('native:claude-code:test'),
  requestDigest: 'a'.repeat(64),
}

describe('buildHeadlessExec argv shapes', () => {
  it('refuses a no-tools turn for adapters without a native all-tools-off mechanism', () => {
    expect(() =>
      assertHeadlessToolPolicy({
        agent: 'codex',
        ...identity,
        cwd: '/repo',
        prompt: 'repair',
        toolPolicy: 'none',
      }),
    ).toThrow(/cannot enforce a no-tools headless turn/)
  })
  it('codex first turn: exec --json with positional prompt, no resume subcommand', () => {
    const { cmd, args } = buildHeadlessExec(
      'codex',
      { prompt: 'hi there' },
      harnessInstallation(snapshot, 'codex'),
      POSTURE,
    )
    expect(cmd).toBe('/opt/codex')
    expect(args).toEqual([
      'exec',
      ...CODEX_TURN_POSTURE_ARGS,
      '--json',
      '--skip-git-repo-check',
      'hi there',
    ])
  })

  it('codex resume turn: `exec resume <id>` subcommand before flags', () => {
    const { args } = buildHeadlessExec(
      'codex',
      { prompt: 'go on', resumeValue: '019f-abc', model: 'gpt-5.2-codex' },
      harnessInstallation(snapshot, 'codex'),
      POSTURE,
    )
    expect(args).toEqual([
      'exec',
      ...CODEX_TURN_POSTURE_ARGS,
      'resume',
      '019f-abc',
      '--json',
      '--skip-git-repo-check',
      '--model',
      'gpt-5.2-codex',
      'go on',
    ])
  })

  it('codex effort rides a -c model_reasoning_effort override', () => {
    const { args } = buildHeadlessExec(
      'codex',
      { prompt: 'p', effort: 'low' },
      harnessInstallation(snapshot, 'codex'),
      POSTURE,
    )
    expect(args[args.indexOf('model_reasoning_effort="low"') - 1]).toBe('-c')
  })

  it('codex MCP config becomes -c TOML overrides and a bad config throws', () => {
    const mcpConfig = JSON.stringify({
      mcpServers: { podium: { url: 'http://127.0.0.1:1/mcp', headers: { 'x-a': 'b' } } },
    })
    const { args } = buildHeadlessExec(
      'codex',
      { prompt: 'p', mcpConfig },
      harnessInstallation(snapshot, 'codex'),
      POSTURE,
    )
    expect(args).toContain('mcp_servers."podium".url="http://127.0.0.1:1/mcp"')
    expect(args).toContain('mcp_servers."podium".http_headers={"x-a"="b"}')
    expect(() =>
      buildHeadlessExec(
        'codex',
        { prompt: 'p', mcpConfig: '{oops' },
        harnessInstallation(snapshot, 'codex'),
        POSTURE,
      ),
    ).toThrow(/malformed MCP config/)
  })

  it('codex routes the MCP auth token to a bearer env var, not argv (POD-1021)', () => {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        podium: {
          url: 'http://127.0.0.1:1/mcp',
          headers: { 'x-podium-mcp-token': 'sekret', 'x-podium-mcp-thread': 'thr' },
        },
      },
    })
    const { args, env } = buildHeadlessExec(
      'codex',
      { prompt: 'p', mcpConfig },
      harnessInstallation(snapshot, 'codex'),
      POSTURE,
    )
    expect(args).toContain('mcp_servers."podium".bearer_token_env_var="PODIUM_MCP_BEARER_PODIUM"')
    expect(env).toMatchObject({ PODIUM_MCP_BEARER_PODIUM: 'sekret' })
    expect(args).toContain('mcp_servers."podium".http_headers={"x-podium-mcp-thread"="thr"}')
    // The token never leaks into argv.
    expect(args.some((a) => a.includes('sekret'))).toBe(false)
  })

  it('grok: options precede --single so its required prompt is consumed correctly', () => {
    const { cmd, args } = buildHeadlessExec(
      'grok',
      { prompt: 'hello', sessionId: 'uuid-1', model: 'grok-4' },
      harnessInstallation(snapshot, 'grok'),
      POSTURE,
    )
    expect(cmd).toBe('/opt/grok')
    // Moved to posture (POD-6858): the mode and the CLI rule, also before
    // --single.
    expect(args).toEqual([
      '--session-id',
      'uuid-1',
      '--model',
      'grok-4',
      ...GROK_TURN_POSTURE_ARGS,
      '--single',
      'hello',
    ])
    const resumed = buildHeadlessExec(
      'grok',
      { prompt: 'again', resumeValue: 'uuid-1' },
      harnessInstallation(snapshot, 'grok'),
      POSTURE,
    )
    expect(resumed.args).toEqual([
      '--resume',
      'uuid-1',
      ...GROK_TURN_POSTURE_ARGS,
      '--single',
      'again',
    ])
  })

  it('refuses Grok repair turns because hook/config isolation is not proven', () => {
    expect(() =>
      composeHeadlessInvocation(
        { agent: 'grok', ...identity, cwd: '/repo', prompt: 'repair', toolPolicy: 'none' },
        snapshot,
        { isRoot: false },
      ),
    ).toThrow(/cannot enforce a no-tools headless turn/)
  })

  it('pi: pinned --session-id on every turn, prompt on stdin, JSON event stream', () => {
    const first = buildHeadlessExec(
      'pi',
      { prompt: 'hello', sessionId: 'uuid-1', model: 'openai/gpt-5.5', effort: 'high' },
      harnessInstallation(snapshot, 'pi'),
      POSTURE,
    )
    expect(first.cmd).toBe('/opt/pi')
    expect(first.args).toEqual([
      '-p',
      '--mode',
      'json',
      '--session-id',
      'uuid-1',
      '--model',
      'openai/gpt-5.5',
      '--thinking',
      'high',
      '--approve',
    ])
    expect(first.stdin).toBe('hello')
    const resumed = buildHeadlessExec(
      'pi',
      { prompt: 'again', resumeValue: 'uuid-1' },
      harnessInstallation(snapshot, 'pi'),
      POSTURE,
    )
    expect(resumed.args).toEqual(['-p', '--mode', 'json', '--session-id', 'uuid-1', '--approve'])
  })

  it('pi: a repair turn is accepted and runs tool-less', () => {
    const { args } = buildHeadlessExec(
      'pi',
      { prompt: 'repair', sessionId: 'uuid-1', toolPolicy: 'none' },
      harnessInstallation(snapshot, 'pi'),
      POSTURE,
    )
    expect(args).toContain('--no-tools')
    expect(args).toContain('--no-extensions')
  })

  it('opencode: forwards model and variant on first and resumed turns', () => {
    const first = buildHeadlessExec(
      'opencode',
      { prompt: 'hi', model: 'opencode/deepseek-v4-flash-free', effort: 'high' },
      harnessInstallation(snapshot, 'opencode'),
      POSTURE,
    )
    expect(first.cmd).toBe('/opt/opencode')
    // Moved to posture: `--auto` (the default posture, right after `run`).
    expect(first.args).toEqual([
      'run',
      '--auto',
      '--format',
      'json',
      '-m',
      'opencode/deepseek-v4-flash-free',
      '--variant',
      'high',
      'hi',
    ])
    const resumed = buildHeadlessExec(
      'opencode',
      { prompt: 'go on', resumeValue: 'ses_1', effort: 'max' },
      harnessInstallation(snapshot, 'opencode'),
      POSTURE,
    )
    expect(resumed.args).toEqual([
      'run',
      '--auto',
      '--format',
      'json',
      '-s',
      'ses_1',
      '--variant',
      'max',
      'go on',
    ])
  })

  it('cursor: pins Auto unless a named model overrides it', () => {
    const { cmd, args } = buildHeadlessExec(
      'cursor',
      { prompt: 'hi', sessionId: 'chat-1' },
      harnessInstallation(snapshot, 'cursor'),
      POSTURE,
    )
    expect(cmd).toBe('/opt/cursor-agent')
    expect(args).toEqual([
      '-p',
      '--resume',
      'chat-1',
      '--model',
      'auto',
      '--trust',
      '--auto-review',
      'hi',
    ])
    const named = buildHeadlessExec(
      'cursor',
      { prompt: 'hi', sessionId: 'chat-1', model: 'composer-2.5' },
      harnessInstallation(snapshot, 'cursor'),
      POSTURE,
    )
    expect(named.args).toContain('composer-2.5')
    expect(named.args).not.toContain('auto')
  })

  it('uses Grok native rules and auto permission mode without polluting the prompt', () => {
    const { args } = buildHeadlessExec(
      'grok',
      {
        prompt: 'task',
        systemPrompt: 'orchestrate',
        contextPrompt: 'repo context',
        sessionId: 'u',
      },
      harnessInstallation(snapshot, 'grok'),
      POSTURE,
    )
    expect(args).toContain('--rules')
    expect(args[args.indexOf('--rules') + 1]).toBe('orchestrate\n\nrepo context')
    expect(args).toContain('--permission-mode')
    expect(args.at(-1)).toBe('task')
  })

  it('uses Codex developer instructions without polluting the user prompt', () => {
    const { args } = buildHeadlessExec(
      'codex',
      { prompt: 'task', systemPrompt: 'orchestrate', contextPrompt: 'repo context' },
      harnessInstallation(snapshot, 'codex'),
      POSTURE,
    )
    expect(args).toContain('developer_instructions="orchestrate\\n\\nrepo context"')
    expect(args.at(-1)).toBe('task')
  })

  it("model 'auto' means no model flag", () => {
    const { args } = buildHeadlessExec(
      'grok',
      { prompt: 'p', sessionId: 'u', model: 'auto' },
      harnessInstallation(snapshot, 'grok'),
      POSTURE,
    )
    expect(args).not.toContain('--model')
  })
})

describe('composeHeadlessInvocation', () => {
  const base = { ...identity, cwd: '/repo', prompt: 'the prompt' }

  it('claude: a bounded `claude -p` run with the prompt on stdin, pinned to the minted session', () => {
    const invocation = composeHeadlessInvocation(
      { agent: 'claude-code', ...base, sessionUuid: 'u-1' },
      snapshot,
      { isRoot: false },
    )
    expect(invocation.command.cmd).toBe('/opt/claude')
    expect(invocation.command.args.slice(0, 4)).toEqual([
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
    ])
    expect(invocation.command.args).toContain('--session-id')
    expect(invocation.stdin).toEqual({ kind: 'bytes', data: 'the prompt' })
    expect(invocation.pinnedSessionId).toBe('u-1')
  })

  it('claude: MCP rides argv as inline JSON — no staged file outlives the turn', () => {
    const mcpConfig = JSON.stringify({
      mcpServers: { podium: { url: 'http://127.0.0.1:1/mcp', headers: { 'x-a': 'b' } } },
    })
    const {
      command: { args },
    } = composeHeadlessInvocation({ agent: 'claude-code', ...base, mcpConfig }, snapshot, {
      isRoot: false,
    })
    const inline = args[args.indexOf('--mcp-config') + 1] as string
    expect(JSON.parse(inline)).toEqual({
      mcpServers: {
        podium: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { 'x-a': 'b' } },
      },
    })
  })

  it('claude: a tool-less turn mounts no MCP at all', () => {
    const {
      command: { args },
    } = composeHeadlessInvocation(
      {
        agent: 'claude-code',
        ...base,
        toolPolicy: 'none',
        mcpConfig: JSON.stringify({ mcpServers: { p: { url: 'http://x' } } }),
      },
      snapshot,
      { isRoot: false },
    )
    expect(args).not.toContain('--mcp-config')
    expect(args).toContain('--tools')
  })

  it('claude: a structured turn is the stream-json conversation with a live stdin', () => {
    const invocation = composeHeadlessInvocation(
      { agent: 'claude-code', ...base, structuredPermissions: true, resumeValue: 'r-1' },
      snapshot,
      { isRoot: false },
    )
    expect(invocation.command.args).toContain('--input-format')
    expect(invocation.command.args).toContain('--permission-prompt-tool')
    expect(invocation.stdin).toEqual({ kind: 'live' })
    expect(invocation.pinnedSessionId).toBe('r-1')
  })

  it('codex: stdin closed at once, the MCP bearer as per-invocation env, no pin on a first turn', () => {
    const invocation = composeHeadlessInvocation(
      {
        agent: 'codex',
        ...base,
        mcpConfig: JSON.stringify({
          mcpServers: { podium: { url: 'http://x', headers: { 'x-podium-mcp-token': 't' } } },
        }),
      },
      snapshot,
      { isRoot: false },
    )
    expect(invocation.stdin).toEqual({ kind: 'none' })
    expect(invocation.execEnv).toMatchObject({ PODIUM_MCP_BEARER_PODIUM: 't' })
    expect(invocation.pinnedSessionId).toBeUndefined()
  })

  it("resume-exec: the server's pre-minted id wins (POD-782), and pi's prompt rides stdin", () => {
    const invocation = composeHeadlessInvocation(
      { agent: 'pi', ...base, sessionUuid: 'minted-by-server' },
      snapshot,
      { isRoot: false },
    )
    expect(invocation.pinnedSessionId).toBe('minted-by-server')
    expect(invocation.command.args).toContain('minted-by-server')
    expect(invocation.stdin).toEqual({ kind: 'bytes', data: 'the prompt' })
  })

  it('cursor: mints a first chat id and preserves an already supplied id', () => {
    const fresh = composeHeadlessInvocation({ agent: 'cursor', ...base }, snapshot, {
      isRoot: false,
    })
    expect(fresh.pinnedSessionId).toMatch(/^[\da-f-]{36}$/)
    expect(fresh.command.args).toContain(fresh.pinnedSessionId)
    const invocation = composeHeadlessInvocation({ agent: 'cursor', ...base }, snapshot, {
      allocated: 'chat-9',
      isRoot: false,
    })
    expect(invocation.pinnedSessionId).toBe('chat-9')
    expect(invocation.command.args).toEqual([
      '-p',
      '--resume',
      'chat-9',
      '--model',
      'auto',
      // Moved to posture (POD-6858).
      '--trust',
      '--auto-review',
      'the prompt',
    ])
  })
})
