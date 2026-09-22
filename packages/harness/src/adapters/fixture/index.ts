import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BuiltinHarnessKind } from '@podium/protocol'
import { transcriptEchoAcceptCorrelation } from '../../accept-correlation.js'
import { composeAgentInstructions } from '../../instructions.js'
import {
  type AgentManifest,
  isSet,
  promptArgv,
  selectRuntimeDriver,
  supported,
  unsupported,
} from '../../manifest.js'
import { createFixtureConversationProvider } from './discovery.js'
import { fixtureStateProvider } from './state.js'
import {
  fixtureChainPaths,
  fixtureHandoffTranscript,
  fixtureTranscript,
} from './transcript.js'
/**
 * Fixture harness (POD-4474, spec §7) — a seventh manifest with meaningful
 * SUPPORTED behaviour, proving a harness lands as `adapters/<name>/` plus one
 * registry line and that every mechanism serves it through the real route.
 *
 * What it IS: a terminal-family CLI double (`fixture-agent`) with a file
 * transcript grammar, local login detection and a polling state provider.
 * What it is NOT: a shipped harness — it is never in AGENT_MANIFESTS, never
 * in the support matrix, and only tests see it (via `registerTestManifest`).
 * Its declines name test-double facts, not placeholders.
 *
 * `kind` is cast because the closed `BuiltinHarnessKind` names only shipped
 * harnesses — the cast is the one registry line going the other way: the day
 * a real seventh harness ships, it joins the closed set instead.
 */

function fixtureAuthAccount(homeDir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(homeDir, '.fixture', 'auth.json'), 'utf8')) as {
      account?: unknown
    }
    return typeof parsed.account === 'string' && parsed.account.trim()
      ? parsed.account.trim()
      : undefined
  } catch {
    return undefined
  }
}

export const fixtureManifest: AgentManifest = {
  kind: 'fixture' as BuiltinHarnessKind,
  displayName: 'Fixture',
  capabilities: {
    argvPrompt: true,
    effortFlag: 'effort',
    systemPromptFlag: true,
    newSessionIdFlag: false,
    quota: false,
    cloud: false,
    composerScrape: false,
    oscTitle: true,
    subagentModelEnv: false,
    promptModeHints: false,
    handoff: true,
    mcp: 'none',
    hookInstall: 'none',
    observationProvider: 'none',
    observationProtocol: 'generic',
    submitVerification: false,
    composerReadiness: 'on-bind',
    rawFirstTurn: false,
    exclusiveInteractiveResume: false,
    promptTitleFallback: true,
    mcpConfigTransport: 'none',
    // A test double has no TUI to measure: Esc is the conservative guess, the
    // same one an unknown harness gets.
    interruptKey: 'esc',
    interruptQuitsWhenIdle: false,
  },
  resumeKind: 'fixture-session',
  environment: { removeInherited: [] },

  inventory: {
    executable: { names: ['fixture-agent'], versionArgs: ['--version'] },
    loginCommandProbe: unsupported(
      'Fixture login detection reads its local auth.json — there is no status command to probe',
    ),
    loginCommand: supported({ cmd: 'fixture-agent', args: ['login'] }),
    loginIdentity: supported((homeDir) => {
      const account = fixtureAuthAccount(homeDir)
      return account ? { fingerprint: `fixture:${account}` } : undefined
    }),
    portableCredential: unsupported(
      'Fixture credentials are local-only test doubles with no portable layout to declare',
    ),
    // An inherited key must not silently reselect the double's account — the
    // same hazard the shipped harnesses declare, at fixture scale.
    foreignCredentialEnv: ['FIXTURE_API_KEY'],
    detectLogin(homeDir) {
      let contents: string
      try {
        contents = readFileSync(join(homeDir, '.fixture', 'auth.json'), 'utf8')
      } catch {
        return { state: 'out' }
      }
      const account = fixtureAuthAccount(homeDir)
      return account ? { state: 'in', account } : { state: 'unknown' }
    },
  },

  credentials: unsupported(
    'The fixture keeps no portable credential files — login is one local auth.json',
  ),
  usage: unsupported(
    'The fixture runs no vendor quota endpoint and keeps no usage history to harvest',
  ),
  install: unsupported(
    'The fixture CLI is not distributed — tests point PATH at a double, there is no installer to run',
  ),

  launch(opts) {
    const instructions = composeAgentInstructions(opts.instructions)
    return {
      cmd: 'fixture-agent',
      args: [
        ...(opts.resume ? ['--resume', opts.resume.value] : []),
        ...(isSet(opts.model) ? ['--model', opts.model] : []),
        ...(isSet(opts.effort) ? ['--effort', opts.effort] : []),
        ...(instructions ? ['--instructions', instructions] : []),
        // `--` ends option parsing so a prompt starting with `-` reaches the
        // double as the prompt, not as an unknown option — the same POD-1317
        // discipline the shipped harnesses follow.
        ...promptArgv(opts.initialPrompt),
      ],
      cwd: opts.cwd,
    }
  },

  exec: supported((opts) => {
    const model = opts.model && opts.model !== 'auto' ? opts.model : undefined
    const sys = opts.systemPrompt?.trim() ? opts.systemPrompt.trim() : undefined
    const prompt = sys ? `${sys}\n\n---\n\n${opts.prompt}` : opts.prompt
    return {
      cmd: 'fixture-agent',
      args: ['exec', ...(model ? ['--model', model] : []), prompt],
    }
  }),

  runtime: {
    server: unsupported('The fixture CLI is a process double with no server mode to drive'),
    embedded: unsupported('The fixture ships no library to host in-process'),
    terminal: {
      driverId: 'generic-pty',
      sendProof: ['transcript-echo'],
      acceptCorrelation: { 'transcript-echo': transcriptEchoAcceptCorrelation },
    },
    select: (ctx) => selectRuntimeDriver(ctx, ['generic-pty']),
  },
  headless: supported({
    driver: 'resume-exec',
    outputFormat: 'text',
    // The double mints nothing: the daemon names the session up front and the
    // double resumes it, the same create-or-resume posture as grok/pi.
    resumeIdAllocation: 'daemon-minted-uuid',
    noTools: 'unsupported',
    buildExec: supported((opts) => ({
      cmd: 'fixture-agent',
      args: [
        'exec',
        '--session-id',
        opts.resumeValue ?? opts.sessionId ?? '',
        ...(opts.model && opts.model !== 'auto' ? ['--model', opts.model] : []),
        opts.prompt,
      ],
    })),
  }),

  state: supported(fixtureStateProvider),
  instrumentation: unsupported(
    'The fixture posts no hook payloads; the terminal driver proves sends by transcript echo',
  ),
  stateChannels: [
    {
      source: 'poll',
      confidence: 0.7,
      mechanism: 'Fixture phase markers; a done turn is the turn boundary',
    },
  ],

  // No hook channel and no poller of its own: on a known session, bind the
  // resume value and tail its chain file so chat has history before the first
  // turn; without one there is nothing to point at yet.
  observer: supported((input, host) => {
    if (input.resumeValue) host.onResumeValue(input.resumeValue)
    void (async () => {
      if (!input.resumeValue) return
      const paths = await fixtureChainPaths({
        cwd: input.cwd,
        resumeValue: input.resumeValue,
        ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      })
      const newest = paths.at(-1)
      if (newest) host.tailFile(newest)
    })()
    return { stop() {} }
  }),

  discovery: createFixtureConversationProvider(),

  transcript: fixtureTranscript,

  composer: unsupported('the fixture CLI double has no composer to scrape'),

  handoffTranscript: supported(fixtureHandoffTranscript),

  classifyBrowserOpen: unsupported(
    'The fixture opens no browser URLs — there are no login/link domains to catalogue',
  ),
}
