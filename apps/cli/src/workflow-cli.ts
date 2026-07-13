import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { type IssueTrpc, makeIssueClient, makeRelayIssueClient } from '@podium/issue-client'
import type {
  ApprovalOp,
  WorkflowGitObservation,
  WorkflowNextActionWire,
  WorkflowRunWire,
  WorkflowStep,
  WorkflowWire,
} from '@podium/protocol'
import { resolvePort } from '@podium/runtime/config'
import { requestApproval } from './approval-cli'

type WorkflowClient = Pick<IssueTrpc, 'workflows'>
type ArgValue = string | boolean

export class WorkflowCliError extends Error {}

export interface WorkflowCliDeps {
  client: WorkflowClient
  cwd: string
  relayEndpoint?: string
  readText?(path: string): Promise<string>
  observeGit?(cwd: string): WorkflowGitObservation
  approve?(endpoint: string, op: ApprovalOp): Promise<{ text: string; exitCode: number }>
}

export function parseWorkflowArgs(argv: string[]): {
  command?: string
  args: Record<string, ArgValue>
  positionals: string[]
} {
  const [command, ...rest] = argv
  const args: Record<string, ArgValue> = {}
  const positionals: string[] = []
  const booleans = new Set(['json', 'outside-scope', 'no-git', 'help'])
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (!token?.startsWith('--')) {
      if (token !== undefined) positionals.push(token)
      continue
    }
    const eq = token.indexOf('=')
    if (eq >= 0) {
      args[token.slice(2, eq)] = token.slice(eq + 1)
      continue
    }
    const key = token.slice(2)
    const next = rest[i + 1]
    if (booleans.has(key) || next === undefined || next.startsWith('--')) args[key] = true
    else {
      args[key] = next
      i++
    }
  }
  return { ...(command ? { command } : {}), args, positionals }
}

export function workflowHelpText(): string {
  return [
    'podium workflow <command> [arguments]',
    '',
    'Context and progress:',
    '  prime',
    '  status [--run <run-id>] [--json]',
    '  checkpoint <active|blocked|complete> [--step <id>] [--summary <text>]',
    '      [--tests <csv>] [--artifacts <csv>] [--no-git] [--run <run-id>]',
    '  assign-step <step-id> <session-id|none> [--run <run-id>]',
    '  skip <step-id> [--reason <text>] [--run <run-id>]',
    '  retry <step-id> [--run <run-id>]',
    '  adopt <revision-id> [--start-step <id>] [--run <run-id>]',
    '',
    'Library:',
    '  list [--scope <global|repository|task>] [--scope-ref <id>] [--json]',
    '  show <workflow-id> [--json]',
    '  create <name> --scope <scope> [--scope-ref <id>] [--description <text>]',
    '      [--instructions <markdown>|--instructions-file <path>]',
    '      [--steps-json <json>|--steps-file <path>]',
    '  revise <workflow-id> [--instructions ...] [--steps-json ...]',
    '  fork <revision-id> <name> --scope <scope> [--scope-ref <id>]',
    '  publish <revision-id>                 Global publication requires approval',
    '  assign <issue|session> <target-id> <revision-id>',
    '  default global <revision-id>',
    '  default repository <repo-id> <revision-id>',
    '  bindings [--json]',
    '',
    'Execution profiles (named, non-secret presets):',
    '  profiles [--json]',
    '  profile-save <name> --account <id> --harness <name>',
    '      [--id <id>] [--machine <id|any>] [--model <name>] [--effort <level>]',
    '',
    'Shared defaults and global publication requested by an agent pause for',
    'operator approval. Workflow steps never run arbitrary enforcement commands.',
  ].join('\n')
}

const KNOWN_FLAGS = new Set([
  'json',
  'outside-scope',
  'no-git',
  'scope',
  'scope-ref',
  'description',
  'instructions',
  'instructions-file',
  'steps-json',
  'steps-file',
  'run',
  'step',
  'summary',
  'tests',
  'artifacts',
  'reason',
  'start-step',
  'id',
  'account',
  'machine',
  'harness',
  'model',
  'effort',
])

function value(args: Record<string, ArgValue>, key: string): string | undefined {
  const candidate = args[key]
  return typeof candidate === 'string' ? candidate : undefined
}

function requiredValue(args: Record<string, ArgValue>, key: string): string {
  const candidate = value(args, key)
  if (!candidate) throw new WorkflowCliError(`--${key} is required`)
  return candidate
}

function splitCsv(raw: string | undefined): string[] {
  return raw
    ? raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : []
}

async function bodyInput(
  args: Record<string, ArgValue>,
  deps: WorkflowCliDeps,
): Promise<{ instructions: string; steps: WorkflowStep[] }> {
  const instructions = value(args, 'instructions')
  const instructionsFile = value(args, 'instructions-file')
  const stepsJson = value(args, 'steps-json')
  const stepsFile = value(args, 'steps-file')
  if (instructions !== undefined && instructionsFile) {
    throw new WorkflowCliError('use only one of --instructions and --instructions-file')
  }
  if (stepsJson !== undefined && stepsFile) {
    throw new WorkflowCliError('use only one of --steps-json and --steps-file')
  }
  const load = deps.readText ?? ((path: string) => readFile(path, 'utf8'))
  const instructionText = instructionsFile ? await load(instructionsFile) : (instructions ?? '')
  const rawSteps = stepsFile ? await load(stepsFile) : (stepsJson ?? '[]')
  let steps: unknown
  try {
    steps = JSON.parse(rawSteps)
  } catch (error) {
    throw new WorkflowCliError(
      `invalid steps JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!Array.isArray(steps)) throw new WorkflowCliError('steps JSON must be an array')
  return { instructions: instructionText, steps: steps as WorkflowStep[] }
}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return result.status === 0 ? result.stdout.trim() : null
}

/** Fixed, read-only observations. Workflow data never supplies an executable. */
export function observeWorkflowGit(cwd: string): WorkflowGitObservation {
  const worktree = git(cwd, ['rev-parse', '--show-toplevel'])
  const branch = git(cwd, ['branch', '--show-current']) || null
  const head = git(cwd, ['rev-parse', 'HEAD'])
  const porcelain = git(cwd, ['status', '--porcelain=v1'])
  const upstream = git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  const divergence = upstream
    ? git(cwd, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])
    : null
  const counts = divergence?.split(/\s+/).map(Number)
  return {
    cwd,
    worktree,
    branch,
    head,
    dirty: porcelain === null ? null : porcelain.length > 0,
    behind: counts && Number.isFinite(counts[0]) ? (counts[0] ?? null) : null,
    ahead: counts && Number.isFinite(counts[1]) ? (counts[1] ?? null) : null,
    observedAt: new Date().toISOString(),
  }
}

function pretty(result: unknown): string {
  return JSON.stringify(result, null, 2)
}

function formatWorkflows(workflows: WorkflowWire[]): string {
  if (workflows.length === 0) return 'No workflows.'
  return workflows
    .map(
      (workflow) =>
        `${workflow.id}  v${workflow.latestVersion}  ${workflow.name}  [${workflow.scope}${workflow.scopeRef ? `:${workflow.scopeRef}` : ''}]`,
    )
    .join('\n')
}

function formatRun(run: WorkflowRunWire): string {
  const current =
    run.steps.find((step) => step.status === 'active' || step.status === 'blocked') ??
    run.steps.find((step) => step.status === 'pending')
  return [
    `${run.id}: ${run.status} · revision ${run.revision.id}`,
    `subject: ${run.subjectKind} ${run.subjectId} · coordinator: ${run.coordinatorSessionId}`,
    current
      ? `current: ${current.stepId} — ${current.title} [${current.status}] attempt ${current.attempt}${current.assignedSessionId ? ` · assigned ${current.assignedSessionId}` : ''}`
      : run.steps.length === 0
        ? 'prompt-only workflow'
        : 'no remaining step',
  ].join('\n')
}

function formatNext(next: WorkflowNextActionWire): string {
  const warnings = next.warnings.map((warning) => `warning: ${warning}`)
  return [
    next.message,
    ...(next.currentStep
      ? [`current: ${next.currentStep.stepId} — ${next.currentStep.title}`]
      : []),
    ...warnings,
  ].join('\n')
}

async function call(
  client: WorkflowClient,
  proc: keyof WorkflowClient['workflows'],
  input: Record<string, unknown> = {},
  query = false,
): Promise<unknown> {
  const endpoint = client.workflows[proc]
  return query ? endpoint.query(input) : endpoint.mutate(input)
}

async function approved(deps: WorkflowCliDeps, op: ApprovalOp): Promise<string> {
  if (!deps.relayEndpoint)
    throw new WorkflowCliError('this workflow change requires an agent relay')
  const decide = deps.approve ?? requestApproval
  const outcome = await decide(deps.relayEndpoint, op)
  if (outcome.exitCode !== 0) throw new WorkflowCliError(outcome.text)
  return outcome.text
}

export async function runWorkflowCli(argv: string[], deps: WorkflowCliDeps): Promise<string> {
  if (argv.includes('--help') || argv.includes('-h')) return workflowHelpText()
  const { command, args, positionals } = parseWorkflowArgs(argv)
  if (!command || command === 'help') return workflowHelpText()
  const unknown = Object.keys(args).filter((key) => !KNOWN_FLAGS.has(key))
  if (unknown.length) {
    throw new WorkflowCliError(
      `unknown flag${unknown.length > 1 ? 's' : ''} ${unknown.map((key) => `--${key}`).join(', ')}`,
    )
  }
  const json = args.json === true
  let result: unknown

  if (command === 'prime') return String(await call(deps.client, 'prime', {}, true))
  if (command === 'status') {
    result = await call(
      deps.client,
      'status',
      { ...(value(args, 'run') ? { runId: value(args, 'run') } : {}) },
      true,
    )
    return json ? pretty(result) : formatRun(result as WorkflowRunWire)
  }
  if (command === 'list') {
    result = await call(
      deps.client,
      'list',
      {
        ...(value(args, 'scope') ? { scope: value(args, 'scope') } : {}),
        ...(value(args, 'scope-ref') ? { scopeRef: value(args, 'scope-ref') } : {}),
      },
      true,
    )
    return json ? pretty(result) : formatWorkflows(result as WorkflowWire[])
  }
  if (command === 'show') {
    const id = positionals[0]
    if (!id) throw new WorkflowCliError('show needs a workflow id')
    result = await call(deps.client, 'get', { id }, true)
    return pretty(result)
  }
  if (command === 'bindings' || command === 'profiles') {
    result = await call(deps.client, command, {}, true)
    return pretty(result)
  }
  if (command === 'create') {
    const name = positionals[0]
    if (!name) throw new WorkflowCliError('create needs a workflow name')
    const body = await bodyInput(args, deps)
    result = await call(deps.client, 'create', {
      name,
      description: value(args, 'description') ?? '',
      scope: requiredValue(args, 'scope'),
      ...(value(args, 'scope-ref') ? { scopeRef: value(args, 'scope-ref') } : {}),
      ...body,
    })
  } else if (command === 'revise') {
    const workflowId = positionals[0]
    if (!workflowId) throw new WorkflowCliError('revise needs a workflow id')
    result = await call(deps.client, 'revise', { workflowId, ...(await bodyInput(args, deps)) })
  } else if (command === 'fork') {
    const [revisionId, name] = positionals
    if (!revisionId || !name) throw new WorkflowCliError('fork needs a revision id and name')
    result = await call(deps.client, 'fork', {
      revisionId,
      name,
      description: value(args, 'description') ?? '',
      scope: requiredValue(args, 'scope'),
      ...(value(args, 'scope-ref') ? { scopeRef: value(args, 'scope-ref') } : {}),
    })
  } else if (command === 'publish') {
    const revisionId = positionals[0]
    if (!revisionId) throw new WorkflowCliError('publish needs a revision id')
    try {
      result = await call(deps.client, 'publish', { revisionId })
    } catch (error) {
      if (!deps.relayEndpoint || !String(error).includes('approval required')) throw error
      return approved(deps, { kind: 'workflow-publish', revisionId })
    }
  } else if (command === 'assign') {
    const [targetKind, targetId, revisionId] = positionals
    if (!targetKind || !targetId || !revisionId) {
      throw new WorkflowCliError('assign needs target kind, target id, and revision id')
    }
    if (targetKind !== 'issue' && targetKind !== 'session') {
      throw new WorkflowCliError(
        'assign target must be issue or session; use default for shared defaults',
      )
    }
    result = await call(deps.client, 'assign', { targetKind, targetId, revisionId })
  } else if (command === 'default') {
    const [targetKind, first, second] = positionals
    if (targetKind === 'global' && first && !second) {
      if (deps.relayEndpoint) {
        return approved(deps, {
          kind: 'workflow-set-default',
          targetKind: 'global',
          targetId: '',
          revisionId: first,
        })
      }
      result = await call(deps.client, 'assign', {
        targetKind: 'global',
        targetId: '',
        revisionId: first,
      })
    } else if (targetKind === 'repository' && first && second) {
      if (deps.relayEndpoint) {
        return approved(deps, {
          kind: 'workflow-set-default',
          targetKind: 'repository',
          targetId: first,
          revisionId: second,
        })
      }
      result = await call(deps.client, 'assign', {
        targetKind: 'repository',
        targetId: first,
        revisionId: second,
      })
    } else {
      throw new WorkflowCliError(
        'usage: workflow default global <revision> | repository <repo-id> <revision>',
      )
    }
  } else if (command === 'profile-save') {
    const name = positionals[0]
    if (!name) throw new WorkflowCliError('profile-save needs a name')
    const machine = value(args, 'machine')
    result = await call(deps.client, 'profileSave', {
      ...(value(args, 'id') ? { id: value(args, 'id') } : {}),
      name,
      accountId: requiredValue(args, 'account'),
      machineId: machine && machine !== 'any' ? machine : null,
      harness: requiredValue(args, 'harness'),
      model: value(args, 'model') ?? 'auto',
      effort: value(args, 'effort') ?? 'auto',
    })
  } else if (command === 'checkpoint') {
    const status = positionals[0]
    if (status !== 'active' && status !== 'blocked' && status !== 'complete') {
      throw new WorkflowCliError('checkpoint status must be active, blocked, or complete')
    }
    const summary = value(args, 'summary') ?? ''
    result = await call(deps.client, 'checkpoint', {
      status,
      summary,
      evidence: {
        summary,
        tests: splitCsv(value(args, 'tests')),
        artifacts: splitCsv(value(args, 'artifacts')),
      },
      observation:
        args['no-git'] === true ? null : (deps.observeGit ?? observeWorkflowGit)(deps.cwd),
      ...(value(args, 'run') ? { runId: value(args, 'run') } : {}),
      ...(value(args, 'step') ? { stepId: value(args, 'step') } : {}),
    })
    return json ? pretty(result) : formatNext(result as WorkflowNextActionWire)
  } else if (command === 'assign-step') {
    const [stepId, sessionId] = positionals
    if (!stepId || !sessionId)
      throw new WorkflowCliError('assign-step needs a step id and session id (or none)')
    result = await call(deps.client, 'assignStep', {
      stepId,
      sessionId: sessionId === 'none' ? null : sessionId,
      ...(value(args, 'run') ? { runId: value(args, 'run') } : {}),
    })
  } else if (command === 'skip') {
    const stepId = positionals[0]
    if (!stepId) throw new WorkflowCliError('skip needs a step id')
    result = await call(deps.client, 'skip', {
      stepId,
      reason: value(args, 'reason') ?? '',
      ...(value(args, 'run') ? { runId: value(args, 'run') } : {}),
    })
  } else if (command === 'retry') {
    const stepId = positionals[0]
    if (!stepId) throw new WorkflowCliError('retry needs a step id')
    result = await call(deps.client, 'retry', {
      stepId,
      ...(value(args, 'run') ? { runId: value(args, 'run') } : {}),
    })
  } else if (command === 'adopt') {
    const revisionId = positionals[0]
    if (!revisionId) throw new WorkflowCliError('adopt needs a revision id')
    result = await call(deps.client, 'adopt', {
      revisionId,
      ...(value(args, 'start-step') ? { startStepId: value(args, 'start-step') } : {}),
      ...(value(args, 'run') ? { runId: value(args, 'run') } : {}),
    })
  } else {
    throw new WorkflowCliError(`unknown command: ${command}\n\n${workflowHelpText()}`)
  }
  return json ? pretty(result) : pretty(result)
}

export async function workflowCliMain(argv: string[]): Promise<void> {
  const relayEndpoint = process.env.PODIUM_ISSUE_RELAY
  const outsideScope = argv.includes('--outside-scope')
  const client = relayEndpoint
    ? makeRelayIssueClient(relayEndpoint, { outsideScope })
    : makeIssueClient(`http://localhost:${resolvePort()}`)
  try {
    console.log(
      await runWorkflowCli(argv, {
        client,
        cwd: process.cwd(),
        ...(relayEndpoint ? { relayEndpoint } : {}),
      }),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: message }))
    else console.error(`podium workflow: ${message}`)
    process.exitCode = 1
  }
}
