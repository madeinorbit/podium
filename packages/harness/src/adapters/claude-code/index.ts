import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  claudeCodeStateProvider,
  configureClaudeTranscriptClassifier,
} from '../../agent-state/claude-code.js'
import { claudeProjectSlug, locateClaudeSessionFile } from '../../agent-state/claude-locate.js'
import { createTranscriptClassifier } from '../../agent-state/transcript-classifier.js'
import { createClaudeCodeConversationProvider } from '../../discovery/providers/claude-code.js'
import { composeAgentInstructions } from '../../instructions.js'
import {
  type AgentManifest,
  type DriverId,
  credentialFileReader,
  type HarnessEnvironment,
  isSet,
  promptArgv,
  type SelectionContext,
  selectRuntimeDriver,
  supported,
  unsupported,
} from '../../manifest.js'
import { claudeChainPaths, claudeCodeTranscript } from './transcript.js'
import { claudeCredentials } from './credentials.js'
import { claudeCodeInstall } from './install.js'
import { claudeUsage } from './usage.js'
import { claudeHookAcceptCorrelation, transcriptEchoAcceptCorrelation } from '../../accept-correlation.js'
import { claudeTranscriptClassifierRules } from '../../manifests/claude-code-classifier.js'
import { classifyClaudeLoginStatus } from '../../manifests/claude-login-status.js'

configureClaudeTranscriptClassifier(createTranscriptClassifier(claudeTranscriptClassifierRules))

const CLAUDE_SDK_AUTH = new Set(['subscription', 'api-key', 'bedrock', 'vertex'])

function selectClaudeRuntime(ctx: SelectionContext): DriverId {
  if (ctx.preference === 'claude-pty' || ctx.preference === 'generic-pty') {
    return selectRuntimeDriver(ctx, ['generic-pty'])
  }
  if (ctx.available.includes('claude-sdk')) {
    if (ctx.preference === 'claude-sdk' || CLAUDE_SDK_AUTH.has(ctx.auth)) return 'claude-sdk'
  }
  return selectRuntimeDriver(ctx, ['generic-pty'])
}

export const claudeCodeManifest: AgentManifest = {
  kind: 'claude-code',
  displayName: 'Claude',
  capabilities: {
    argvPrompt: true,
    effortFlag: 'effort',
    systemPromptFlag: true,
    newSessionIdFlag: false,
    quota: true,
    cloud: true,
    composerScrape: true,
    oscTitle: true,
    subagentModelEnv: true,
    promptModeHints: true,
    handoff: true,
    mcp: 'full',
    hookInstall: 'settings-args',
    observationProvider: 'claude-code',
    observationProtocol: 'claude-causal',
    submitVerification: true,
    composerReadiness: 'confirmed-turn',
    rawFirstTurn: false,
    exclusiveInteractiveResume: false,
    promptTitleFallback: true,
    mcpConfigTransport: 'path',
    // Measured (2.x, POD-1214): one Esc mid-turn prints "Interrupted" and
    // recalls the prompt into the composer; at an idle prompt it only clears the
    // composer. Background Task subagents keep running — the harness owns those,
    // and no keystroke reaches them.
    interruptKey: 'esc',
    interruptQuitsWhenIdle: false,
  },
  resumeKind: 'claude-session',
  environment: {
    // A daemon started inside Claude carries another conversation's identity.
    // Passing it on makes the child subordinate itself to that session and
    // disables transcript saving — also Podium's state/history channel.
    removeInherited: [
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_EXECPATH',
    ],
  },

  inventory: {
    executable: { names: ['claude'], versionArgs: ['--version'] },
    loginCommandProbe: supported({
      args: ['auth', 'status'],
      timeoutMs: 12_000,
      classify: classifyClaudeLoginStatus,
    }),
    // `claude auth login`, NOT `claude login`: the CLI has no `login` subcommand, so a
    // bare `login` argument is parsed as the PROMPT — the login terminal came up with
    // Claude answering the word "login" and no auth flow ever ran. `claude auth login`
    // is the real sign-in entry point [POD-1307].
    loginCommand: supported({ cmd: 'claude', args: ['auth', 'login'] }),
    loginIdentity: supported((homeDir, env?: HarnessEnvironment) =>
      claudeCredentials.identity(credentialFileReader(claudeCredentials, homeDir, env)),
    ),
    portableCredential: supported({
      // Read off the credentials section: one file layout, two readers would
      // drift the way the daemon's two Codex credential lists did.
      files: claudeCredentials.files.map((file) => join(file.dirName, file.fileName)),
      compareFreshness: (a, b) =>
        claudeCredentials.files.find((file) => file.propagatable)?.compareFreshness(a, b) ??
        null,
    }),
    // Either one flips Claude Code off the home's OAuth login and onto API-usage
    // billing; an interactive session first stops at a "Detected a custom API key
    // in your environment" modal, whose one-time approval is then remembered per
    // key in `.claude.json` — after which the switch is permanently silent.
    foreignCredentialEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    detectLogin(homeDir, env?: HarnessEnvironment) {
      const configDir = (env ?? process.env).CLAUDE_CONFIG_DIR?.trim() || join(homeDir, '.claude')
      let contents: string
      try {
        contents = readFileSync(join(configDir, '.credentials.json'), 'utf8')
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined
        return { state: code === 'ENOENT' ? 'out' : 'unknown' }
      }
      if (!contents.trim()) return { state: 'out' }
      let credentials: unknown
      try {
        credentials = JSON.parse(contents)
      } catch {
        return { state: 'unknown' }
      }
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
        return { state: 'unknown' }
      }
      if (Object.keys(credentials).length === 0) return { state: 'out' }
      const identity = claudeCredentials.identity(
        credentialFileReader(claudeCredentials, homeDir, env),
      )
      return identity?.email
        ? { state: 'in', account: identity.email, identity }
        : { state: 'in', account: 'Claude login' }
    },
  },

  credentials: supported(claudeCredentials),
  usage: supported(claudeUsage),
  install: supported(claudeCodeInstall),

  launch(opts) {
    const instructions = composeAgentInstructions(opts.instructions)
    return {
      cmd: 'claude',
      args: [
        ...(opts.resume ? ['--resume', opts.resume.value] : []),
        ...(isSet(opts.model) ? ['--model', opts.model] : []),
        ...(isSet(opts.effort) ? ['--effort', opts.effort] : []),
        ...(instructions ? ['--append-system-prompt', instructions] : []),
        // `--` LAST, immediately before the prompt: it ends option parsing so a
        // prompt starting with `-` reaches Claude as the prompt, not as an unknown
        // option [POD-1317]. Nothing may be appended after it.
        ...promptArgv(opts.initialPrompt),
      ],
      cwd: opts.cwd,
    }
  },

  exec: supported((opts) => {
    const model = opts.model && opts.model !== 'auto' ? opts.model : undefined
    const sys = opts.systemPrompt?.trim() ? opts.systemPrompt.trim() : undefined
    return {
      cmd: 'claude',
      args: [
        '-p',
        ...(sys ? ['--append-system-prompt', sys] : []),
        ...(model ? ['--model', model] : []),
        // MCP gives the orchestrator Podium's own tools (list/start/steer agents);
        // --allowedTools pre-approves them (and read-only built-ins) so they run
        // without a permission prompt in headless print mode.
        ...(opts.mcpConfigPath ? ['--mcp-config', opts.mcpConfigPath] : []),
        ...(opts.allowedTools && opts.allowedTools.length > 0
          ? ['--allowedTools', opts.allowedTools.join(',')]
          : []),
      ],
      // NO trailing prompt positional: --allowedTools is variadic and would
      // swallow it as junk tool rules, leaving claude promptless ("Input must
      // be provided either through stdin or as a prompt argument"). `-p` with
      // stdin is the documented headless mode and dodges ARG_MAX too.
      stdin: opts.prompt,
    }
  }),

  // §2's load-bearing selection: subscription / API-key / Bedrock / Vertex can
  // run the Agent SDK in a runtime-owned worker child when that driver is
  // explicitly requested. On unknown/logged-out auth, the interactive PTY
  // remains the total fallback.
  runtime: {
    server: unsupported(
      'Claude Code ships no server mode — the Agent SDK is in-process and `claude -p` is one-shot',
    ),
    embedded: supported({
      driverId: 'claude-sdk',
      module: 'claude-agent-sdk',
      auth: ['subscription', 'api-key', 'bedrock', 'vertex'],
    }),
    terminal: {
      driverId: 'generic-pty',
      acceptCorrelation: {
        hook: claudeHookAcceptCorrelation,
        'transcript-echo': transcriptEchoAcceptCorrelation,
      },
      // Claude's hook channel is the richest of any harness, so `UserPromptSubmit`
      // anchors an accept the way a protocol ack would — the same signal
      // reattachment-design anchors turn epochs to. Transcript echo is the
      // fallback, and `unverified` is the honest answer when even that times out.
      sendProof: ['hook', 'transcript-echo'],
    },
    // An explicit terminal preference still opts out; a machine-wide SDK
    // default is stripped before this function runs, so unknown auth cannot
    // silently move every Claude session off the PTY path.
    select: selectClaudeRuntime,
  },
  headless: supported({
    // One turn through the Claude Agent SDK; the first turn mints the session id
    // via the SDK's `sessionId` (a server-minted UUID) so the thread ↔ transcript
    // binding is deterministic.
    driver: 'claude-sdk',
    outputFormat: 'claude-stream-json',
    resumeIdAllocation: 'sdk-session-uuid',
    noTools: 'enforced',
    buildExec: unsupported('the Claude Agent SDK builds its own invocation in-process'),
  }),

  state: supported(claudeCodeStateProvider),
  stateChannels: [
    {
      source: 'hook',
      confidence: 1,
      mechanism: 'Claude Code lifecycle hooks (Stop is the turn boundary)',
    },
    {
      source: 'classifier',
      confidence: 0.3,
      mechanism: 'Claude transcript and terminal-screen rules classify otherwise untyped state',
      fallbackWhen: 'the hook has no structured needs-human verdict',
    },
  ],

  // Claude Code needs no polling state observer — state arrives on the hook
  // channel. Observation here is the transcript-tail bootstrap: eagerly tail
  // the session's resume transcript (the JSONL the harness is already writing)
  // so the chat view has history before the first hook fires. Essential on
  // reattach: a fresh daemon's tail registry is empty and an idle survivor
  // fires no hook to register one, so chat would stay blank while the PTY
  // scrollback (native view) still shows the whole conversation. Hooks remain
  // a fast-path: when one lands, its transcript_path re-points the tail at the
  // live file.
  observer: supported((input, host) => {
    // Honor a discovery homeDir override (tests / isolated HOME) so the live
    // tail reads the SAME location the on-demand read source does — otherwise
    // a daemon run against an isolated home would tail the real ~/.claude and
    // find nothing.
    const home = input.homeDir ?? homedir()
    const resumeValue = input.resumeValue
    if (resumeValue) {
      void (async () => {
        // Locate, don't derive: after a worktree move the file lives in the
        // ORIGINAL cwd's bucket (docs/spec/conversation-registry.md §3.3). Fall
        // back to the derived path when nothing exists yet — a fresh resume
        // creates the file a moment later and the tailer waits on it. Reattach
        // carries the server's recorded segment path (pathHint) — evidence
        // beats cwd derivation.
        const located = await locateClaudeSessionFile({
          cwd: input.cwd,
          resumeValue,
          ...(input.pathHint ? { pathHint: input.pathHint } : {}),
          homeDir: home,
        })
        host.tailFile(
          located ??
            join(home, '.claude', 'projects', claudeProjectSlug(input.cwd), `${resumeValue}.jsonl`),
        )
      })()
    } else {
      // No resume ref (a fresh spawn that hasn't yet reported a session id, or
      // a reattach where the server never learned the resume value): fall back
      // to the cwd bucket's chain. NOTE: chainPaths resolves the SPECIFIC
      // conversation by resume value, so without one this resolves nothing
      // today — the first hook's transcript_path binds the tail instead.
      void (async () => {
        const paths = await claudeChainPaths({ cwd: input.cwd, homeDir: home })
        const newest = paths.at(-1)
        if (newest) host.tailFile(newest)
      })()
    }
    // Nothing to stop — the host owns the tail registry, and hooks (not a
    // poller) drive state.
    return { stop() {} }
  }),

  discovery: createClaudeCodeConversationProvider(),

  transcript: claudeCodeTranscript,

  handoffTranscript: supported({
    transcriptPlacement: ({ cwd, homeDir, resumeValue }) =>
      join(homeDir, '.claude', 'projects', claudeProjectSlug(cwd), `${resumeValue}.jsonl`),
    async transcriptForExport({ cwd, homeDir, resumeValue }) {
      const path = await locateClaudeSessionFile({
        cwd,
        resumeValue,
        homeDir,
      })
      if (!path) throw new Error('Claude transcript not found')
      return { path }
    },
  }),

  // Claude Code's own domains: only the OAuth authorize path is a login; every
  // other claude.ai/console.anthropic.com URL the CLI opens (artifacts, docs,
  // usage pages) is a plain link. Unknown hosts fall to the generic heuristic.
  classifyBrowserOpen: supported((url) => {
    const host = url.hostname.toLowerCase()
    if (host !== 'claude.ai' && host !== 'console.anthropic.com') return undefined
    return { intent: url.pathname.startsWith('/oauth/') ? 'login' : 'link' }
  }),
}
