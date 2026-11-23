import { join } from 'node:path'
import { transcriptEchoAcceptCorrelation } from '../../accept-correlation.js'
import { declinedContext } from '../../context-types.js'
import { composeAgentInstructions } from '../../instructions.js'
import {
  type AgentManifest,
  isSet,
  selectRuntimeDriver,
  supported,
  unsupported,
} from '../../manifest.js'
import { antigravityCatalog } from './catalog.js'
import { antigravityContext } from './context.js'
import {
  antigravityCredentialIdentity,
  antigravityCredentials,
  hasValidAntigravityCredential,
  readAntigravityCredential,
} from './credentials.js'
import { antigravityDescriptor } from './descriptor.js'
import { createAntigravityConversationProvider } from './discovery.js'
import { antigravityInstrumentation } from './instrumentation.js'
import { ANTIGRAVITY_HOME, antigravityAccountCommand, antigravityRoots } from './paths.js'
import { antigravityPosture } from './posture.js'
import { antigravityState, observeAntigravity } from './state.js'
import { antigravityTranscript } from './transcript.js'
import { antigravityUsage } from './usage.js'

export { antigravityHomeSharing, prepareAntigravityHomeLaunch } from './home.js'
export { createAntigravityStreamReducer } from './stream.js'

function modelArgs(model?: string, effort?: string) {
  return [
    ...(isSet(model) ? ['--model', model] : []),
    ...(isSet(effort) ? ['--effort', effort] : []),
  ]
}

export const antigravityManifest: AgentManifest = {
  kind: 'antigravity',
  descriptor: antigravityDescriptor,
  catalog: antigravityCatalog,
  capabilities: {
    argvPrompt: true,
    effortFlag: 'effort',
    systemPromptFlag: false,
    newSessionIdFlag: false,
    quota: true,
    cloud: false,
    oscTitle: true,
    subagentModelEnv: false,
    promptModeHints: false,
    handoff: false,
    mcp: 'full',
    hookInstall: 'settings-args',
    observationProvider: 'antigravity',
    observationProtocol: 'generic',
    submitVerification: true,
    composerReadiness: 'confirmed-turn',
    rawFirstTurn: false,
    exclusiveInteractiveResume: true,
    promptTitleFallback: true,
    mcpConfigTransport: 'path',
    interruptKey: 'esc',
    interruptQuitsWhenIdle: false,
  },
  resumeKind: 'antigravity-conversation',
  roots: antigravityRoots,
  environment: {
    managedHomeVariable: ANTIGRAVITY_HOME,
    namedAccountEnv: (home) => ({ [ANTIGRAVITY_HOME]: join(home, '.gemini') }),
    operatorSelectors: [ANTIGRAVITY_HOME],
    command: antigravityAccountCommand,
    removeInherited: [
      'ANTIGRAVITY_CONVERSATION_ID',
      'ANTIGRAVITY_TRAJECTORY_ID',
      'ANTIGRAVITY_LS_ADDRESS',
      'ANTIGRAVITY_CSRF_TOKEN',
      'ANTIGRAVITY_APP_DATA_DIR',
      'ANTIGRAVITY_GEMINI_DIR',
    ],
    set: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
  },
  inventory: {
    executable: {
      names: ['agy'],
      versionArgs: ['--version'],
      identityProbe: { args: ['--help'], accepts: (out) => /Antigravity|Usage of agy/u.test(out) },
      fallbackCandidates: (home) => [join(home, '.local', 'bin', 'agy')],
    },
    loginCommand: supported({ args: ['acp', '--login'] }),
    loginCommandProbe: unsupported(
      'Antigravity has no non-interactive login-status command; readiness reads its native token store',
    ),
    loginIdentity: supported((home, env = {}) => {
      const raw = readAntigravityCredential(home, env)
      return raw ? antigravityCredentialIdentity(raw) : undefined
    }),
    portableCredential: unsupported(
      'Google logins are signed into isolated homes on each machine; shared OS-keyring credentials are never automatically propagated',
    ),
    foreignCredentialEnv: [
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'AGY_ADC_AUTH',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'AGY_LLM_GATEWAY_API_KEY',
    ],
    accepts: [
      { type: 'google.antigravity-login', deliver: { kind: 'home' } },
      {
        type: 'google.api-key',
        deliver: { kind: 'env', variable: 'GEMINI_API_KEY' },
        startArgs: ['--settings', '{"modelProvider":"gemini"}'],
      },
    ],
    detectLogin(home, env) {
      const raw = readAntigravityCredential(home, env)
      if (!raw) return { state: env[ANTIGRAVITY_HOME] ? 'out' : 'unknown' }
      if (!hasValidAntigravityCredential(raw)) return { state: 'out' }
      const identity = antigravityCredentialIdentity(raw)
      return {
        state: 'in',
        ...(identity ? { identity, ...(identity.email ? { account: identity.email } : {}) } : {}),
      }
    },
  },
  credentials: supported(antigravityCredentials),
  usage: supported(antigravityUsage),
  install: supported({
    binary: 'agy',
    url: () => 'https://antigravity.google/cli/install.sh',
    runInstaller: (script, binDir, ports) => {
      ports.runTool('bash', [script, '--dir', binDir], ports.env)
    },
  }),
  // Managed installs (POD-6865): Antigravity's release channel, archive and
  // updater were never measured, so Podium does not keep its own copy yet.
  managedInstall: unsupported(
    'Antigravity releases and updater not yet measured for a Podium-managed install',
  ),
  conversationFile: unsupported(
    'antigravity declares no conversation file to move between its homes',
  ),
  posture: antigravityPosture,
  launch(opts) {
    const context = antigravityContext(opts.runtimeDir, composeAgentInstructions(opts.instructions))
    return {
      args: [
        ...modelArgs(opts.model, opts.effort),
        ...(opts.resume ? ['--conversation', opts.resume.value] : []),
        ...context.args,
        ...(opts.initialPrompt ? [`--prompt-interactive=${opts.initialPrompt}`] : []),
      ],
      files: context.files,
      cwd: opts.cwd,
    }
  },
  exec: supported((opts) => {
    const context = antigravityContext(opts.runtimeDir, opts.systemPrompt, opts.mcpConfig)
    return {
      args: [...modelArgs(opts.model, opts.effort), ...context.args, '--print', opts.prompt],
      files: context.files,
    }
  }),
  headless: supported({
    driver: 'resume-exec',
    outputFormat: 'antigravity-jsonl',
    resumeIdAllocation: 'stream-captured',
    noTools: 'unsupported',
    buildExec: supported((opts) => {
      if (opts.toolPolicy === 'none')
        throw new Error('Antigravity has no verified all-tools-off mode')
      const context = antigravityContext(
        opts.runtimeDir,
        [opts.systemPrompt, opts.contextPrompt].filter(Boolean).join('\n\n'),
        opts.mcpConfig,
      )
      return {
        args: [
          ...modelArgs(opts.model, opts.effort),
          ...(opts.resumeValue ? ['--conversation', opts.resumeValue] : []),
          ...context.args,
          ...(opts.credentialVariables?.includes('GEMINI_API_KEY')
            ? ['--settings', '{"modelProvider":"gemini"}']
            : []),
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--disable-slash-commands',
        ],
        stdin: `${JSON.stringify({ event: 'user', message: { content: opts.prompt } })}\n`,
        files: context.files,
      }
    }),
  }),
  runtime: {
    context: declinedContext(
      'Antigravity context occupancy and effective capacity are not yet verified for this driver',
    ),
    server: unsupported(
      'agy acp is available upstream; Podium currently drives Antigravity headless sessions with the verified structured print protocol',
    ),
    embedded: unsupported(
      'Antigravity is a native executable; Podium does not embed its Python SDK',
    ),
    terminal: {
      driverId: 'generic-pty',
      sendProof: ['transcript-echo'],
      acceptCorrelation: { 'transcript-echo': transcriptEchoAcceptCorrelation },
      transcriptTimestamps: { resolutionMs: 1000 },
    },
    select: (ctx) => selectRuntimeDriver(ctx, ['generic-pty']),
  },
  discovery: createAntigravityConversationProvider(),
  transcript: antigravityTranscript,
  state: supported(antigravityState),
  instrumentation: supported(antigravityInstrumentation),
  observer: supported(observeAntigravity),
  stateChannels: [
    {
      source: 'hook',
      confidence: 1,
      mechanism:
        'Session-scoped native lifecycle hooks; Stop is terminal only when fullyIdle is true',
    },
    {
      source: 'classifier',
      confidence: 0.3,
      mechanism:
        'Native permission dialogs, first-run setup and workspace trust on the terminal screen',
    },
  ],
  composer: unsupported(
    'Antigravity composer rendering varies by terminal; submit receipt verification uses native transcript echoes',
  ),
  handoffTranscript: unsupported(
    'The native conversation SQLite/protobuf stores have no verified portable export contract',
  ),
  classifyBrowserOpen: supported((url) => {
    try {
      return {
        intent:
          new URL(url).hostname === 'accounts.google.com' ? ('login' as const) : ('link' as const),
      }
    } catch {
      return undefined
    }
  }),
}
