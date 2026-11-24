/**
 * WHAT A SESSION SAYS ABOUT ITS LAUNCH TERMS (POD-6858 Task 11,
 * docs/design/harness-session-posture.md §4.9 and §5).
 *
 * The daemon reports, once per launch, the harness mode Podium asked for and
 * every requirement the launch could not meet (`SessionMeta.launchPosture`).
 * Web and phone draw the same words from it, so both live here.
 */
import type { AgentKind, LaunchPostureReport, SessionMeta } from '@podium/model'
import type { HarnessDescriptorWire } from '@podium/protocol'
import { agentLabel } from './quota'

/** Explain the interruption and the next step, without exposing adapter diagnostics. */
export function postureNotices(
  session: {
    agentKind: AgentKind | (string & {})
    launchPosture?: LaunchPostureReport | undefined
  },
  served?: readonly HarnessDescriptorWire[],
): string[] {
  const unmet = session.launchPosture?.unmet ?? []
  if (unmet.length === 0) return []
  const label = agentLabel(session.agentKind, served)
  const notices: Record<LaunchPostureReport['unmet'][number]['requirement'], string> = {
    'workspace-trust': `${label} may wait for you to trust this folder. Open the terminal and answer its trust question.`,
    'podium-cli': `${label} may ask before updating tasks or messaging other agents. Approve Podium commands when prompted to let that work continue.`,
    autonomy:
      session.agentKind === 'pi'
        ? 'Pi edits files and runs commands without asking for approval. If you need approval prompts, choose another agent in the new-task box.'
        : `${label}'s permissions could not be set as requested. Check its own permission controls before continuing.`,
    'quiet-start': `${label} may pause at a setup or update screen. Open the terminal and finish that step to continue.`,
    'podium-material': `${label} may ask before opening chat attachments or using connected tools. Approve the request if you want it to use them.`,
  }
  return unmet.map((entry) => notices[entry.requirement])
}

const ASK = 'Asks before file edits and commands unless your rules already allow them.'
const EDITS = 'Edits files without asking; commands may still need your approval.'
const REVIEW = 'Reviews tool requests automatically and may refuse actions it considers unsafe.'
const BYPASS = 'Edits files and runs commands without permission prompts.'
const PLAN = 'Reads and plans without changing your files or running commands that change them.'
const DENY = 'Refuses actions that need approval instead of asking you.'

/** Native mode names are agent-specific: "auto" is not the same promise everywhere. */
const MODE_HELP: Readonly<Partial<Record<AgentKind, Readonly<Record<string, string>>>>> = {
  'claude-code': {
    default: ASK,
    manual: ASK,
    acceptEdits: EDITS,
    auto: REVIEW,
    bypassPermissions: BYPASS,
    plan: PLAN,
    dontAsk: DENY,
  },
  codex: {
    'on-request': 'Can edit within its allowed folders; asks you before running beyond its limits.',
    'auto-review': 'Automatically reviews requests to run beyond its limits and may refuse them.',
    never: 'Never asks for approval; actions outside its allowed access are refused.',
  },
  grok: {
    default: ASK,
    acceptEdits: EDITS,
    auto: REVIEW,
    dontAsk: DENY,
    bypassPermissions: BYPASS,
    plan: PLAN,
  },
  opencode: {
    ask: ASK,
    auto: 'Runs file edits and commands without asking unless your permission rules block them.',
  },
  cursor: {
    allowlist: 'Asks before actions that are not on your allowed list.',
    'auto-review': REVIEW,
    plan: PLAN,
    ask: 'Answers questions without making changes to your files.',
  },
  antigravity: {
    default: ASK,
    auto: 'Reviews actions automatically while keeping them within its restricted environment.',
    'accept-edits': EDITS,
    'always-proceed': BYPASS,
    plan: PLAN,
  },
}

const MODE_ACTION: Readonly<Partial<Record<AgentKind, string>>> = {
  'claude-code': "Use Shift+Tab in Claude Code's terminal to change permissions.",
  codex: "Use /permissions in Codex's terminal to change permissions.",
  grok: "Use Grok's permission controls in the terminal to change permissions.",
  opencode: "Change OpenCode's permission settings before starting a new session.",
  cursor: "Change Cursor's permission settings before starting a new session.",
  antigravity: "Change Antigravity's permission settings before starting a new session.",
}

/** The chip never offers a permission switch, and a request is not confirmation. */
export function sessionModeHelp(agentKind: string, readout: SessionModeReadout): string {
  const modes = Object.hasOwn(MODE_HELP, agentKind) ? MODE_HELP[agentKind as AgentKind] : undefined
  const meaning = modes && Object.hasOwn(modes, readout.mode) ? modes[readout.mode] : undefined
  if (!meaning) {
    return `Podium cannot explain the permissions for "${readout.mode}"${readout.source === 'requested' ? ' (requested, not yet confirmed)' : ''}. Check the agent's own permission controls before continuing.`
  }
  const current =
    readout.source === 'requested'
      ? `Requested, not yet confirmed: ${meaning.charAt(0).toLowerCase()}${meaning.slice(1)}`
      : meaning
  return `${current} ${MODE_ACTION[agentKind as AgentKind]}`
}

const AGENT_HELP: Readonly<Record<AgentKind, string>> = {
  'claude-code':
    'Claude Code handles the conversation, file changes and command approvals for this task.',
  codex: 'Codex runs the task with file access limited by its permission settings.',
  grok: 'Grok handles the conversation, file changes and command approvals for this task.',
  opencode: 'OpenCode runs the task with models from the provider you select.',
  cursor: 'Cursor runs the task using its own tools and permission rules.',
  pi: 'Pi runs the task without asking before file edits or commands.',
  antigravity: 'Antigravity runs the task using its own tools and permission rules.',
  shell: 'A terminal lets you run commands yourself, without an AI agent.',
}

export function agentControlHelp(agentKind: string): string {
  const meaning = Object.hasOwn(AGENT_HELP, agentKind)
    ? AGENT_HELP[agentKind as AgentKind]
    : 'This agent will run the task with its own tools and permission rules.'
  return `${meaning} Choose an agent here before starting; that choice is fixed for the session.`
}

export function sessionInterfaceHelp(terminal: boolean): string {
  return `${terminal ? "You will work in the agent's own terminal interface" : "You will work in Podium's chat while the agent runs in the background"}. Choose an interface here before starting; it is fixed for that session.`
}

/** The mode a session shows, and where it came from. */
export interface SessionModeReadout {
  readonly mode: string
  /** `observed`: the harness reported it. `requested`: what Podium asked for. */
  readonly source: 'observed' | 'requested'
}

/**
 * THE MODE A SESSION SHOWS (§4.9): the one the harness itself reports when it
 * reports one, otherwise the one Podium asked for at launch. Undefined when
 * neither is known; a requested mode is never shown as if it were in force.
 */
export function sessionModeReadout(
  session: Partial<Pick<SessionMeta, 'observedMode' | 'launchPosture'>>,
): SessionModeReadout | undefined {
  const observed = session.observedMode?.trim()
  if (observed) return { mode: observed, source: 'observed' }
  const requested = session.launchPosture?.requestedMode?.trim()
  if (requested) return { mode: requested, source: 'requested' }
  return undefined
}
