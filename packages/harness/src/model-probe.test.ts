import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { addSink, createRingBufferSink } from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type HarnessContext, harnessAccount, withHarnessHome } from './harness-context'
import {
  type FetchLike,
  parseCodexModels,
  parseCursorModels,
  parseGrokModels,
  parseOpencodeModels,
  parsePiModels,
  probeAgentModels,
  probeAllModels,
  probeClaudeModels,
} from './model-probe'

const GROK = `You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
  - grok-composer-2.5-fast
`

const CURSOR = `Available models

auto - Auto
gpt-5.3-codex - Codex 5.3
composer-2.5 - Composer 2.5 (current)
glm-5.2-max - GLM 5.2 Max

Tip: use --model <id> (or /model <id> in interactive mode) to switch.
`

const OPENCODE = `opencode/big-pickle
openai/gpt-5.5
xai/grok-4.3
`

/** `pi --list-models` (pi 0.84.4): a whitespace-columned table on stdout. */
const PI = `provider   model                    context  max-out  thinking  images
anthropic  claude-sonnet-4-5        200K     64K      yes       yes
fake       fake-model               128K     4.1K     no        no
`

const CODEX = JSON.stringify({
  models: [
    {
      slug: 'gpt-5.4',
      display_name: 'GPT-5.4',
      visibility: 'list',
      priority: 16,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
    },
    {
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      visibility: 'list',
      priority: 7,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'xhigh' }],
    },
    {
      slug: 'codex-auto-review',
      display_name: 'Codex Auto Review',
      visibility: 'hide',
      priority: 43,
    },
  ],
})

describe('model-probe parsers', () => {
  it('opencode: offers only the per-model variants reported by --verbose', () => {
    const verbose = [
      'provider/reasoning',
      JSON.stringify({ variants: { low: {}, high: {}, disabled: { disabled: true } } }, null, 2),
      'provider/plain',
      JSON.stringify({ variants: {} }, null, 2),
    ].join('\n')
    expect(parseOpencodeModels(verbose)).toEqual([
      { value: 'provider/reasoning', label: 'provider/reasoning', efforts: ['low', 'high'] },
      { value: 'provider/plain', label: 'provider/plain', efforts: [] },
    ])
  })

  it('grok: reads ACP model-specific efforts without guessing levels', () => {
    const frame = {
      result: {
        _meta: {
          modelState: {
            currentModelId: 'grok-reasoning',
            availableModels: [
              {
                modelId: 'grok-reasoning',
                name: 'Reasoning',
                _meta: {
                  supportsReasoningEffort: true,
                  reasoningEfforts: [{ value: 'high' }, { id: 'low' }],
                },
              },
              { modelId: 'plain', name: 'Plain' },
            ],
          },
        },
      },
    }
    expect(parseGrokModels(JSON.stringify(frame))).toEqual([
      { value: 'grok-reasoning', label: 'Reasoning', efforts: ['high', 'low'] },
      { value: 'plain', label: 'Plain', efforts: [] },
    ])
  })

  it('grok: reads the marker list under "Available models:", ignores header/default line', () => {
    expect(parseGrokModels(GROK)).toEqual([
      { value: 'grok-4.5', label: 'grok-4.5' },
      { value: 'grok-composer-2.5-fast', label: 'grok-composer-2.5-fast' },
    ])
  })

  it('cursor: parses "id - label", drops auto, strips (current)/(default), skips Tip line', () => {
    expect(parseCursorModels(CURSOR)).toEqual([
      { value: 'gpt-5.3-codex', label: 'Codex 5.3' },
      { value: 'composer-2.5', label: 'Composer 2.5' },
      { value: 'glm-5.2-max', label: 'GLM 5.2 Max' },
    ])
  })

  it('opencode: keeps only provider/model id lines', () => {
    expect(parseOpencodeModels(OPENCODE)).toEqual([
      { value: 'opencode/big-pickle', label: 'opencode/big-pickle' },
      { value: 'openai/gpt-5.5', label: 'openai/gpt-5.5' },
      { value: 'xai/grok-4.3', label: 'xai/grok-4.3' },
    ])
  })

  it('codex: parses debug-models JSON, drops hidden models, orders by priority, per-model effort', () => {
    expect(parseCodexModels(CODEX)).toEqual([
      { value: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'xhigh'] }, // priority 7 first
      { value: 'gpt-5.4', label: 'GPT-5.4', efforts: ['low', 'high'] },
    ])
  })

  it('parsers tolerate empty / junk output', () => {
    expect(parseGrokModels('')).toEqual([])
    expect(parseCursorModels('nonsense\n')).toEqual([])
    expect(parseOpencodeModels('not a model line')).toEqual([])
  })

  it('parses the pi table into provider/model ids with thinking levels only where offered', () => {
    expect(parsePiModels(PI).map((m) => [m.value, m.efforts?.length])).toEqual([
      ['anthropic/claude-sonnet-4-5', 7],
      ['fake/fake-model', 0],
    ])
    expect(parsePiModels('')).toEqual([])
    expect(parsePiModels('No models found')).toEqual([])
    expect(parseCodexModels('not json')).toEqual([])
  })
})

const claudeFetch =
  (status: number, data: unknown): FetchLike =>
  async () => ({ ok: status >= 200 && status < 300, status, json: async () => ({ data }) })

/** A claude /v1/models mock that records the auth headers it was called with. */
function capturingClaudeFetch(status: number, data: unknown) {
  const calls: Array<Record<string, string>> = []
  const fetchImpl: FetchLike = async (_url, init) => {
    calls.push(init.headers)
    return { ok: status >= 200 && status < 300, status, json: async () => ({ data }) }
  }
  return { fetchImpl, calls }
}

describe('probeClaudeModels (Anthropic /v1/models — subscription OAuth OR API key)', () => {
  const logs = createRingBufferSink()
  let removeSink: () => void
  beforeEach(() => {
    logs.clear()
    removeSink = addSink(logs)
  })
  afterEach(() => removeSink())

  const eff = (...levels: string[]) => ({
    effort: {
      supported: levels.length > 0,
      ...Object.fromEntries(levels.map((l) => [l, { supported: true }])),
    },
  })
  const MODELS = [
    { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', capabilities: eff('low', 'high') },
  ]

  it('subscription: sends the OAuth token as a Bearer token', async () => {
    const { fetchImpl, calls } = capturingClaudeFetch(200, MODELS)
    const models = await probeClaudeModels({ token: 'oat-123', fetchImpl })
    expect(models).toEqual([
      { value: 'claude-sonnet-5', label: 'Claude Sonnet 5', efforts: ['low', 'high'] },
    ])
    expect(calls[0]?.authorization).toBe('Bearer oat-123')
    expect(calls[0]?.['x-api-key']).toBeUndefined()
  })

  it('API-based: sends x-api-key, and the key wins over any OAuth token', async () => {
    const { fetchImpl, calls } = capturingClaudeFetch(200, MODELS)
    const models = await probeClaudeModels({
      apiKey: 'sk-ant-api-key',
      token: 'oat-ignored',
      fetchImpl,
    })
    expect(models[0]?.value).toBe('claude-sonnet-5')
    expect(calls[0]?.['x-api-key']).toBe('sk-ant-api-key')
    expect(calls[0]?.authorization).toBeUndefined()
  })

  it('per-model effort: reads capabilities.effort; a no-effort model yields efforts: []', async () => {
    const { fetchImpl } = capturingClaudeFetch(200, [
      {
        id: 'claude-opus-4-8',
        display_name: 'Opus',
        capabilities: eff('low', 'high', 'xhigh', 'max'),
      },
      { id: 'claude-haiku-4-5', display_name: 'Haiku' }, // no capabilities → no effort
    ])
    const models = await probeClaudeModels({ token: 't', fetchImpl })
    expect(models.find((m) => m.value === 'claude-opus-4-8')?.efforts).toEqual([
      'low',
      'high',
      'xhigh',
      'max',
    ])
    expect(models.find((m) => m.value === 'claude-haiku-4-5')?.efforts).toEqual([])
  })

  it('skips the lookup and logs when neither an API key nor a token is available', async () => {
    const { fetchImpl } = capturingClaudeFetch(200, MODELS)
    expect(await probeClaudeModels({ token: null, fetchImpl })).toEqual([])
    expect(logs.snapshot()).toContainEqual(
      expect.objectContaining({
        level: 'debug',
        msg: 'Claude model probe skipped: no credentials',
      }),
    )
  })

  it.each([
    401, 429, 503,
  ])('logs HTTP %s and returns [] without exposing credentials', async (status) => {
    const { fetchImpl } = capturingClaudeFetch(status, null)
    expect(await probeClaudeModels({ token: 'oat-secret', fetchImpl })).toEqual([])
    expect(logs.snapshot()).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'Claude model probe rejected', status }),
    )
    expect(JSON.stringify(logs.snapshot())).not.toContain('oat-secret')
  })

  it.each([
    new TypeError('fetch failed'),
    new DOMException('The operation timed out', 'TimeoutError'),
  ])('logs request failures and returns [] for $name', async (err) => {
    const fetchImpl: FetchLike = async () => {
      throw err
    }
    expect(await probeClaudeModels({ token: 'oat-secret', fetchImpl })).toEqual([])
    expect(logs.snapshot()).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        msg: 'Claude model probe failed',
        err: expect.objectContaining({ name: err.name, message: err.message }),
      }),
    )
    expect(JSON.stringify(logs.snapshot())).not.toContain('oat-secret')
  })
})

describe('probe (injected exec — no shelling out)', () => {
  it('returns parsed models on success', async () => {
    const models = await probeAgentModels('grok', { exec: async () => GROK })
    expect(models.map((m) => m.value)).toEqual(['grok-4.5', 'grok-composer-2.5-fast'])
  })

  it('swallows a failing/absent CLI as []', async () => {
    const models = await probeAgentModels('cursor', {
      exec: async () => {
        throw new Error('command not found')
      },
    })
    expect(models).toEqual([])
  })

  it('probeAllModels fans out over all six agents, keyed by agent kind', async () => {
    const byAgent = await probeAllModels({
      exec: async (argv) => {
        if (argv[0] === 'grok') return GROK
        if (argv[0] === 'cursor-agent') return CURSOR
        if (argv[0] === 'opencode') return OPENCODE
        if (argv[0] === 'codex') return CODEX
        if (argv[0] === 'pi') return PI
        return ''
      },
      claude: {
        token: 'sk-ant-oat01-test',
        fetchImpl: claudeFetch(200, [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }]),
      },
    })
    expect(Object.keys(byAgent).sort()).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'grok',
      'opencode',
      'pi',
    ])
    expect(byAgent.pi).toEqual([
      {
        value: 'anthropic/claude-sonnet-4-5',
        label: 'anthropic/claude-sonnet-4-5',
        efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      },
      { value: 'fake/fake-model', label: 'fake/fake-model', efforts: [] },
    ])
    expect(byAgent['claude-code']?.[0]?.value).toBe('claude-sonnet-5')
    expect(byAgent.codex?.length).toBe(2)
  })

  it('omits claude-code when the OAuth call yields nothing so the cache can retain it', async () => {
    const byAgent = await probeAllModels({
      exec: async () => '',
      claude: { token: null, fetchImpl: claudeFetch(200, []) },
    })
    expect(byAgent['claude-code']).toBeUndefined()
  })
})

/** Every path under `dir` with its size, so a write anywhere below shows. */
function treeListing(dir: string): string[] {
  const out: string[] = []
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name)
      const stat = lstatSync(path)
      out.push(`${relative(dir, path)}:${stat.isDirectory() ? 'dir' : stat.size}`)
      if (stat.isDirectory()) walk(path)
    }
  }
  walk(dir)
  return out
}

function externalContext(
  kind: 'grok' | 'opencode' | 'codex' | 'pi',
  home: string,
  executable: string,
  env: Record<string, string> = {},
): HarnessContext {
  const account = harnessAccount(kind, home, { HOME: home, PATH: '/usr/bin:/bin', ...env })
  return {
    installation: { kind, executable, version: '1.0.0', generation: 1, provenance: 'external' },
    home: account.home,
    env: account.env,
    roots: account.roots,
  }
}

describe.skipIf(platform() === 'win32')(
  "the person's own install lists its models without writing their folders (POD-7390, POD-7392)",
  () => {
    let home: string
    let bin: string
    let observed: string
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'podium-model-probe-home-'))
      bin = mkdtempSync(join(tmpdir(), 'podium-model-probe-bin-'))
      observed = mkdtempSync(join(tmpdir(), 'podium-model-probe-seen-'))
    })
    afterEach(() => {
      for (const dir of [home, bin, observed]) rmSync(dir, { recursive: true, force: true })
    })

    it('Grok: GROK_HOME moves aside, the login and settings are still the ones read', async () => {
      // Grok 1.0.92 appends to its log and opens its session index under
      // GROK_HOME for `grok models`, and writes config.toml on first start.
      const exe = join(bin, 'grok')
      writeFileSync(
        exe,
        [
          '#!/bin/sh',
          'state="$HOME/.grok"; [ -n "$GROK_HOME" ] && state="$GROK_HOME"',
          'auth="$state/auth.json"; [ -n "$GROK_AUTH_PATH" ] && auth="$GROK_AUTH_PATH"',
          `{ echo "home=$state"; echo "auth=$auth"; echo "cwd=$(pwd)"; } > "${observed}/grok"`,
          'mkdir -p "$state/logs" "$state/sessions"',
          'echo started >> "$state/logs/unified.jsonl"; echo index > "$state/sessions/session_search.sqlite"',
          'echo "# written on first start" >> "$state/config.toml"',
          'grep -q signed-in "$auth" && echo "You are logged in with grok.com."',
          'echo; echo "Available models:"',
          'sed -n "s/^default_model = \\"\\(.*\\)\\"/  * \\1 (default)/p" "$state/config.toml"',
          'echo "  - grok-4.6"',
          '',
        ].join('\n'),
        { mode: 0o755 },
      )
      const grokHome = join(home, '.grok')
      mkdirSync(join(grokHome, 'logs'), { recursive: true })
      writeFileSync(join(grokHome, 'auth.json'), '{"signed-in": true}\n')
      writeFileSync(join(grokHome, 'config.toml'), 'default_model = "grok-custom"\n')
      writeFileSync(join(grokHome, 'logs', 'unified.jsonl'), 'personal log\n')
      const before = treeListing(home)
      const leftBefore = readdirSync(tmpdir()).filter((n) => n.startsWith('podium-models-grok-'))

      const models = await probeAgentModels('grok', {
        contexts: { grok: externalContext('grok', home, exe) },
      })

      expect(models.map((m) => m.value)).toEqual(['grok-custom', 'grok-4.6'])
      expect(treeListing(home)).toEqual(before)
      expect(readFileSync(join(grokHome, 'config.toml'), 'utf8')).toBe(
        'default_model = "grok-custom"\n',
      )
      const seen = readFileSync(join(observed, 'grok'), 'utf8')
      expect(seen).toContain(`auth=${join(grokHome, 'auth.json')}`)
      expect(seen).not.toContain(`home=${grokHome}`)
      expect(seen).not.toContain(`cwd=${home}`)
      // The temporary folder is gone.
      expect(readdirSync(tmpdir()).filter((n) => n.startsWith('podium-models-grok-'))).toEqual(
        leftBefore,
      )
    })

    it('OpenCode: data, state and cache move aside, the login, config and model cache are read', async () => {
      // OpenCode 1.19.6 boots an instance for `opencode models`: log and
      // database under the data folder, project locks under the state folder,
      // a models.dev refresh in the cache folder.
      const exe = join(bin, 'opencode')
      writeFileSync(
        exe,
        [
          '#!/bin/sh',
          'data="$HOME/.local/share/opencode"; [ -n "$XDG_DATA_HOME" ] && data="$XDG_DATA_HOME/opencode"',
          'state="$HOME/.local/state/opencode"; [ -n "$XDG_STATE_HOME" ] && state="$XDG_STATE_HOME/opencode"',
          'cache="$HOME/.cache/opencode"; [ -n "$XDG_CACHE_HOME" ] && cache="$XDG_CACHE_HOME/opencode"',
          'config="$HOME/.config/opencode"; [ -n "$XDG_CONFIG_HOME" ] && config="$XDG_CONFIG_HOME/opencode"',
          'db="$data/opencode.db"; [ -n "$OPENCODE_DB" ] && db="$OPENCODE_DB"',
          'catalog="$cache/models.json"; [ -n "$OPENCODE_MODELS_PATH" ] && catalog="$OPENCODE_MODELS_PATH"',
          `{ echo "data=$data"; echo "cwd=$(pwd)"; } > "${observed}/opencode"`,
          'mkdir -p "$data/log" "$state/locks/abc.lock" "$cache" "$(dirname "$db")"',
          'echo boot >> "$data/log/opencode.log"; echo rows >> "$db"; echo meta > "$state/locks/abc.lock/meta.json"',
          'echo refreshed > "$cache/models.json"',
          'cat "$catalog"',
          'grep -q key "$data/auth.json" && echo "openai/gpt-6"',
          'cat "$config/providers.txt"',
          '',
        ].join('\n'),
        { mode: 0o755 },
      )
      const data = join(home, '.local', 'share', 'opencode')
      mkdirSync(join(data, 'log'), { recursive: true })
      writeFileSync(join(data, 'auth.json'), '{"openai": {"key": "sk-test"}}\n')
      writeFileSync(join(data, 'opencode.db'), 'personal sessions\n')
      mkdirSync(join(home, '.cache', 'opencode'), { recursive: true })
      writeFileSync(join(home, '.cache', 'opencode', 'models.json'), 'opencode/big-pickle\n')
      mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
      writeFileSync(join(home, '.config', 'opencode', 'providers.txt'), 'custom/local-model\n')
      const before = treeListing(home)

      const models = await probeAgentModels('opencode', {
        contexts: { opencode: externalContext('opencode', home, exe) },
      })

      expect(models.map((m) => m.value)).toEqual([
        'opencode/big-pickle',
        'openai/gpt-6',
        'custom/local-model',
      ])
      expect(treeListing(home)).toEqual(before)
      const seen = readFileSync(join(observed, 'opencode'), 'utf8')
      expect(seen).not.toContain(`data=${data}`)
      expect(seen).not.toContain(`cwd=${home}`)
    })

    it('an OPENCODE_DB in the account environment does not take the listing back into a store', async () => {
      const exe = join(bin, 'opencode')
      writeFileSync(exe, '#!/bin/sh\necho rows >> "$OPENCODE_DB"\necho "opencode/big-pickle"\n', {
        mode: 0o755,
      })
      const store = join(home, 'store.db')
      writeFileSync(store, 'personal sessions\n')

      const models = await probeAgentModels('opencode', {
        contexts: { opencode: externalContext('opencode', home, exe, { OPENCODE_DB: store }) },
      })

      expect(models.map((m) => m.value)).toEqual(['opencode/big-pickle'])
      expect(readFileSync(store, 'utf8')).toBe('personal sessions\n')
    })

    /** A fake `codex` that writes what 0.171.0 was measured to write: an arg0
     *  helper folder under CODEX_HOME, and a refreshed login written beside
     *  the login's resolved file and renamed over it, under auth.lock. */
    function fakeCodex(): string {
      const exe = join(bin, 'codex')
      writeFileSync(
        exe,
        [
          '#!/bin/sh',
          'state="$HOME/.codex"; [ -n "$CODEX_HOME" ] && state="$CODEX_HOME"',
          `{ echo "home=$state"; echo "args=$*"; echo "cwd=$(pwd)"; } > "${observed}/codex"`,
          'mkdir -p "$state/tmp/arg0-linux/codex-arg0Ab12"; : > "$state/tmp/arg0-linux/codex-arg0Ab12/.lock"',
          'login="$state/auth.json"',
          'if grep -q rt-old "$login" 2>/dev/null; then',
          '  : >> "$state/auth.lock"',
          '  target=$(readlink -f "$login")',
          '  sed s/rt-old/rt-new/ "$target" > "$(dirname "$target")/.auth-Xy12"',
          '  mv "$(dirname "$target")/.auth-Xy12" "$target"',
          'fi',
          'model=$(sed -n "s/^model = \\"\\(.*\\)\\"/\\1/p" "$state/config.toml")',
          'printf \'{"models":[{"slug":"%s","visibility":"list","priority":1}\' "$model"',
          'grep -q rt-new "$login" 2>/dev/null && printf \',{"slug":"gpt-account","visibility":"list","priority":2}\'',
          'echo "]}"',
          '',
        ].join('\n'),
        { mode: 0o755 },
      )
      return exe
    }

    it('Codex: CODEX_HOME moves aside, a refreshed login lands in the person’s auth.json', async () => {
      const exe = fakeCodex()
      const codexHome = join(home, '.codex')
      mkdirSync(codexHome, { recursive: true })
      writeFileSync(join(codexHome, 'auth.json'), '{"tokens":{"refresh_token":"rt-old"}}\n')
      writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-custom"\n')
      const before = treeListing(home)
      const leftBefore = readdirSync(tmpdir()).filter((n) => n.startsWith('podium-models-codex-'))

      const models = await probeAgentModels('codex', {
        contexts: { codex: externalContext('codex', home, exe) },
      })

      expect(models.map((m) => m.value)).toEqual(['gpt-custom', 'gpt-account'])
      // The rotated token is in the person's file, which is still a file.
      expect(readFileSync(join(codexHome, 'auth.json'), 'utf8')).toContain('rt-new')
      expect(lstatSync(join(codexHome, 'auth.json')).isFile()).toBe(true)
      // The refresh took the person's own lock; nothing else was written.
      expect(treeListing(home).sort()).toEqual([...before, '.codex/auth.lock:0'].sort())
      const seen = readFileSync(join(observed, 'codex'), 'utf8')
      expect(seen).not.toContain(`home=${codexHome}`)
      expect(seen).toContain('args=-c cli_auth_credentials_store="file" debug models')
      expect(seen).not.toContain(`cwd=${home}`)
      expect(readdirSync(tmpdir()).filter((n) => n.startsWith('podium-models-codex-'))).toEqual(
        leftBefore,
      )
    })

    it('Codex: a login kept in the keyring, or no login file, is listed in place', async () => {
      const exe = fakeCodex()
      const codexHome = join(home, '.codex')
      mkdirSync(codexHome, { recursive: true })
      writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-custom"\n')
      const context = externalContext('codex', home, exe)

      expect((await probeAgentModels('codex', { contexts: { codex: context } }))[0]?.value).toBe(
        'gpt-custom',
      )
      expect(readFileSync(join(observed, 'codex'), 'utf8')).toContain(`home=${codexHome}\n`)

      writeFileSync(join(codexHome, 'auth.json'), '{"tokens":{"refresh_token":"rt-old"}}\n')
      writeFileSync(
        join(codexHome, 'config.toml'),
        'model = "gpt-custom"\n[profiles.work]\ncli_auth_credentials_store = "auto"\n',
      )
      await probeAgentModels('codex', { contexts: { codex: context } })
      const seen = readFileSync(join(observed, 'codex'), 'utf8')
      expect(seen).toContain(`home=${codexHome}\n`)
      expect(seen).toContain('args=debug models')
    })

    it('Pi: the agent folder moves aside, the login, extensions and settings are the ones read', async () => {
      // Pi 1.6.0 creates settings.json and models-store.json when absent,
      // refreshes the provider catalogs, and writes a refreshed login in place.
      const exe = join(bin, 'pi')
      writeFileSync(
        exe,
        [
          '#!/bin/sh',
          'dir="$HOME/.pi/agent"; [ -n "$PI_CODING_AGENT_DIR" ] && dir="$PI_CODING_AGENT_DIR"',
          `{ echo "dir=$dir"; echo "cwd=$(pwd)"; } > "${observed}/pi"`,
          '[ -e "$dir/auth.json" ] || echo "{}" > "$dir/auth.json"',
          '[ -e "$dir/settings.json" ] || echo "{}" > "$dir/settings.json"',
          'echo refreshed > "$dir/models-store.json"',
          'login=$(sed s/access-old/access-new/ "$dir/auth.json"); printf "%s\\n" "$login" > "$dir/auth.json"',
          'echo "provider  model  context  max-out  thinking  images"',
          'grep -q anthropic "$dir/auth.json" && echo "anthropic  claude-x  200K  64K  yes  yes"',
          '[ -d "$dir/extensions/provider-ext" ] && echo "ext  ext-model  1K  1K  no  no"',
          'grep -q custom "$dir/models.json" && echo "custom  local  8K  1K  no  no"',
          '',
        ].join('\n'),
        { mode: 0o755 },
      )
      const agent = join(home, '.pi', 'agent')
      mkdirSync(join(agent, 'extensions', 'provider-ext'), { recursive: true })
      writeFileSync(join(agent, 'auth.json'), '{"anthropic":{"access":"access-old"}}\n')
      writeFileSync(join(agent, 'models.json'), '{"providers":{"custom":{}}}\n')
      writeFileSync(join(agent, 'models-store.json'), '{"personal":true}\n')
      const before = treeListing(home)
      const leftBefore = readdirSync(tmpdir()).filter((n) => n.startsWith('podium-models-pi-'))

      const models = await probeAgentModels('pi', {
        contexts: { pi: externalContext('pi', home, exe) },
      })

      expect(models.map((m) => m.value)).toEqual([
        'anthropic/claude-x',
        'ext/ext-model',
        'custom/local',
      ])
      expect(readFileSync(join(agent, 'auth.json'), 'utf8')).toBe(
        '{"anthropic":{"access":"access-new"}}\n',
      )
      expect(lstatSync(join(agent, 'auth.json')).isFile()).toBe(true)
      expect(readFileSync(join(agent, 'models-store.json'), 'utf8')).toBe('{"personal":true}\n')
      expect(treeListing(home)).toEqual(before)
      const seen = readFileSync(join(observed, 'pi'), 'utf8')
      expect(seen).not.toContain(`dir=${agent}`)
      expect(seen).not.toContain(`cwd=${home}`)
      expect(readdirSync(tmpdir()).filter((n) => n.startsWith('podium-models-pi-'))).toEqual(
        leftBefore,
      )
    })

    it('Pi: with no login yet, the empty login Pi creates is not left in the person’s folder', async () => {
      const exe = join(bin, 'pi')
      writeFileSync(
        exe,
        '#!/bin/sh\n[ -e "$PI_CODING_AGENT_DIR/auth.json" ] || echo "{}" > "$PI_CODING_AGENT_DIR/auth.json"\necho "No models found"\n',
        { mode: 0o755 },
      )
      mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
      const before = treeListing(home)

      expect(
        await probeAgentModels('pi', { contexts: { pi: externalContext('pi', home, exe) } }),
      ).toEqual([])
      expect(treeListing(home)).toEqual(before)
    })

    it('a Podium home is listed in place: it is already Podium’s own folder', async () => {
      const exe = join(bin, 'grok')
      writeFileSync(
        exe,
        `#!/bin/sh\necho "$GROK_HOME" > "${observed}/grok"\necho "Available models:"; echo "  - grok-4.6"\n`,
        { mode: 0o755 },
      )
      const podiumHome = join(home, '.podium', 'homes', 'cred_1', 'grok')
      mkdirSync(podiumHome, { recursive: true })
      const context = withHarnessHome(externalContext('grok', home, exe), {
        id: 'cred_1',
        dir: podiumHome,
      })

      const models = await probeAgentModels('grok', { contexts: { grok: context } })

      expect(models.map((m) => m.value)).toEqual(['grok-4.6'])
      expect(readFileSync(join(observed, 'grok'), 'utf8').trim()).toBe(podiumHome)
    })
  },
)
