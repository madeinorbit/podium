import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { piRecordToItems, piRuntime } from '@podium/transcript'
import { observePiState, piStateProvider } from '../agent-state/pi.js'
import { withStateChannel } from '../agent-state/types.js'
import { createPiConversationProvider } from '../discovery/providers/pi.js'
import { composeAgentInstructions } from '../instructions.js'
import {
  type AgentManifest,
  fileTranscript,
  type HarnessEnvironment,
  isSet,
  promptArgv,
  selectRuntimeDriver,
  supported,
  type TranscriptSourceInput,
  unsupported,
} from '../manifest.js'
import { locatePiSessionFile, piAgentDir } from '../pi/paths.js'

/**
 * Pi (`pi`, @earendil-works/pi-coding-agent). Everything below was verified
 * against pi 0.84.4 driven by a fake OpenAI-compatible provider — see
 * docs/superpowers/specs/2026-09-02-pi-headless-driver-design.md and
 * docs/agent-harness-reference/pi.md.
 *
 * Pi's thinking levels double as Podium's effort: `--thinking` accepts these.
 */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function thinkingArgs(effort: string | undefined): string[] {
  return isSet(effort) && THINKING_LEVELS.has(effort) ? ['--thinking', effort] : []
}

function modelArgs(model: string | undefined): string[] {
  return isSet(model) ? ['--model', model] : []
}

function systemPromptArgs(...parts: (string | undefined)[]): string[] {
  return parts.flatMap((part) => {
    const text = part?.trim()
    return text ? ['--append-system-prompt', text] : []
  })
}

/** Modes in which Podium expects the harness to proceed without asking. Pi's
 *  only non-interactive gate is project trust, so these map to `--approve`. */
const AUTO_PERMISSION_MODES = new Set(['auto', 'acceptEdits', 'bypassPermissions', 'dontAsk'])

/** The flags that leave NOTHING but the model: no built-in or extension tools,
 *  no extensions, skills, prompt templates or AGENTS.md context. Verified: with
 *  `--no-tools` a model-emitted tool call is refused ("Tool bash not found"). */
const NO_TOOLS_ARGS = [
  '--no-tools',
  '--no-extensions',
  '--no-skills',
  '--no-context-files',
  '--no-prompt-templates',
  '--no-approve',
]

interface PiAuthRecord {
  type?: unknown
  key?: unknown
  access?: unknown
  refresh?: unknown
}

function readPiAuth(
  homeDir: string,
  env?: HarnessEnvironment,
): Record<string, PiAuthRecord> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(piAgentDir(homeDir, env), 'auth.json'), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, PiAuthRecord>)
      : undefined
  } catch {
    return undefined
  }
}

function credentialedProviders(auth: Record<string, PiAuthRecord>): string[] {
  return Object.entries(auth)
    .filter(([, record]) => record && (record.key || record.access || record.refresh))
    .map(([provider]) => provider)
    .sort()
}

/** A stable identity for the stored credential set: which providers, and a hash
 *  of each credential — never the credential itself. Changes when the user
 *  re-authenticates, which is exactly when a tool-less headless account must be
 *  re-verified before launch. */
function piIdentity(homeDir: string, env?: HarnessEnvironment) {
  const auth = readPiAuth(homeDir, env)
  if (!auth) return undefined
  const providers = credentialedProviders(auth)
  if (providers.length === 0) return undefined
  const digest = createHash('sha256')
  for (const provider of providers) {
    digest.update(provider)
    digest.update(':')
    digest.update(createHash('sha256').update(JSON.stringify(auth[provider])).digest('hex'))
    digest.update('\n')
  }
  return { fingerprint: digest.digest('hex'), providerAccountId: providers.join(',') }
}

async function chainPaths(input: TranscriptSourceInput): Promise<string[]> {
  if (!input.resumeValue) return []
  const path = await locatePiSessionFile({
    cwd: input.cwd,
    sessionId: input.resumeValue,
    ...(input.pathHint !== undefined ? { pathHint: input.pathHint } : {}),
    ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
  })
  return path ? [path] : []
}

export const piManifest: AgentManifest = {
  kind: 'pi',
  displayName: 'Pi',
  capabilities: {
    argvPrompt: true,
    effortFlag: 'effort',
    systemPromptFlag: true,
    // `--session-id <id>` is create-or-resume, so a spawned-and-idle session is
    // already bound to the id Podium chose (same posture as Grok, POD-386).
    newSessionIdFlag: true,
    quota: false,
    cloud: false,
    composerScrape: false,
    // Pi emits no OSC title of its own; only an installed titlebar extension would.
    oscTitle: false,
    subagentModelEnv: false,
    promptModeHints: false,
    handoff: false,
    mcp: 'none',
    hookInstall: 'none',
    observationProvider: 'none',
    observationProtocol: 'generic',
    // UNMEASURED: the interactive TUI was not driven on the host this was written
    // on. Conservative defaults, matching Cursor's unverified posture.
    submitVerification: false,
    rawFirstTurn: false,
    // Pi documents "one writer per session JSONL" as a hard invariant.
    exclusiveInteractiveResume: true,
    // No native auto-title: the first user prompt is the best title available.
    promptTitleFallback: true,
    mcpConfigTransport: 'none',
    // Documented (keybindings.md): Escape cancels the running action; Ctrl+C
    // clears/quits. Esc at an idle prompt does not exit.
    interruptKey: 'esc',
    interruptQuitsWhenIdle: false,
    composerReadiness: 'on-bind',
  },
  resumeKind: 'pi-session',
  // PI_CODING_AGENT_DIR relocates the whole config/session/auth root, so an
  // instance-owned agent home keeps one Podium instance's Pi state to itself.
  environment: {
    removeInherited: [],
    instanceHome: { variable: 'PI_CODING_AGENT_DIR', relativeDir: '.pi/agent' },
  },

  inventory: {
    executable: {
      names: ['pi'],
      versionArgs: ['--version'],
      // `pi` is a tiny name; refuse anything that is not the coding agent.
      identityProbe: {
        args: ['--help'],
        accepts: (output) => /\bpi - AI coding assistant\b/.test(output),
      },
    },
    // Sign-in is the in-TUI `/login` flow; `pi auth` only prints/checks.
    loginCommand: unsupported('Pi signs in through its interactive /login command'),
    loginCommandProbe: unsupported('Pi login detection reads its local auth.json'),
    loginIdentity: supported((homeDir, env) => piIdentity(homeDir, env)),
    portableCredential: unsupported('Pi credential portability is not supported yet'),
    // Provider API keys pi reads from the environment (providers.md). auth.json
    // beats them, but with no stored entry they select the account.
    foreignCredentialEnv: [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'XAI_API_KEY',
      'OPENROUTER_API_KEY',
      'GROQ_API_KEY',
      'MISTRAL_API_KEY',
      'DEEPSEEK_API_KEY',
    ],
    detectLogin(homeDir, env?: HarnessEnvironment) {
      const auth = readPiAuth(homeDir, env)
      // No file, or nothing in it: Pi may still authenticate from provider env
      // vars, which a file probe cannot see — so this is unknown, not out.
      if (!auth) return { state: 'unknown' }
      const providers = credentialedProviders(auth)
      if (providers.length === 0) return { state: 'unknown' }
      const identity = piIdentity(homeDir, env)
      return {
        state: 'in',
        account: providers.join(', '),
        ...(identity ? { identity } : {}),
      }
    },
  },

  launch(opts) {
    const instructions = composeAgentInstructions(opts.instructions)
    return {
      cmd: 'pi',
      args: [
        ...(opts.resume
          ? ['--session', opts.resume.value]
          : opts.newSessionId
            ? ['--session-id', opts.newSessionId]
            : []),
        ...modelArgs(opts.model),
        ...thinkingArgs(opts.effort),
        ...systemPromptArgs(instructions),
        // `--` ends option parsing (documented: `pi -p -- "- Summarize…"`).
        ...promptArgv(opts.initialPrompt),
      ],
      cwd: opts.cwd,
    }
  },

  // One-shot full-harness turn: print the final answer, keep no session. The
  // prompt rides stdin (merged verbatim into the user message), so its length
  // is never an argv concern.
  exec: supported((opts) => ({
    cmd: 'pi',
    args: [
      '-p',
      '--no-session',
      ...modelArgs(opts.model),
      ...thinkingArgs(opts.effort),
      ...systemPromptArgs(opts.systemPrompt),
    ],
    stdin: opts.prompt,
  })),

  headless: supported({
    driver: 'resume-exec',
    outputFormat: 'pi-jsonl',
    // The server pre-mints a UUID; `--session-id` creates it on the first turn
    // and resumes it on every later one — the same id both ways.
    resumeIdAllocation: 'daemon-minted-uuid',
    noTools: 'enforced',
    buildExec: supported((opts) => {
      const sessionId = opts.resumeValue ?? opts.sessionId ?? ''
      const toolLess = opts.toolPolicy === 'none'
      return {
        cmd: 'pi',
        args: [
          '-p',
          '--mode',
          'json',
          '--session-id',
          sessionId,
          ...modelArgs(opts.model),
          ...thinkingArgs(opts.effort),
          ...systemPromptArgs(opts.systemPrompt, opts.contextPrompt),
          ...(toolLess
            ? NO_TOOLS_ARGS
            : AUTO_PERMISSION_MODES.has(opts.permissionMode ?? '')
              ? ['--approve']
              : ['--no-approve']),
        ],
        stdin: opts.prompt,
      }
    }),
  }),

  state: supported(piStateProvider),
  stateChannels: [
    {
      source: 'poll',
      confidence: 0.7,
      mechanism:
        'Pi session JSONL tail; an assistant entry with stopReason stop/error/aborted is the turn boundary',
    },
  ],

  // No hook channel — locate the session file (cwd bucket + `*_<id>.jsonl`)
  // and tail it for both state and transcript.
  observer: supported((input, host) => {
    const obs = observePiState({
      cwd: input.cwd,
      ...(input.statTick ? { statTick: input.statTick } : {}),
      ...(input.resumeValue ? { resumeValue: input.resumeValue } : {}),
      ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      ...(input.pathHint ? { pathHint: input.pathHint } : {}),
      ...(input.startedAtMs !== undefined ? { startedAtMs: input.startedAtMs } : {}),
      onSession: (sessionId, path) => {
        host.onResumeValue(sessionId)
        host.tailFile(path)
      },
      onEvents: (events) => host.onStateEvents(withStateChannel(events, 'poll')),
    })
    return { stop: () => obs.stop() }
  }),

  runtime: {
    server: unsupported(
      'pi --mode rpc is a real JSONL-over-stdio server mode, but Podium has not driven it yet — verify before turning it into a spec',
    ),
    embedded: unsupported('pi ships an SDK, but it is not hosted in-process yet'),
    terminal: { driverId: 'generic-pty', sendProof: ['transcript-echo'] },
    select: (ctx) => selectRuntimeDriver(ctx, ['generic-pty']),
  },

  discovery: createPiConversationProvider(),

  transcript: supported(fileTranscript(chainPaths, piRecordToItems, piRuntime)),

  handoffTranscript: unsupported('cross-machine handoff is not supported for pi sessions'),

  classifyBrowserOpen: unsupported(
    'no catalogued pi login/link domains yet — the daemon generic redirect_uri heuristic decides',
  ),
}
