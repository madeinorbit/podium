import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { delimiter, extname, isAbsolute, join, resolve as resolvePath } from 'node:path'

const PATH_START = '__PODIUM_PATH_START__'
const PATH_END = '__PODIUM_PATH_END__'

export type CommandEnvironmentFailure =
  | 'account-unavailable'
  | 'shell-probe-failed'
  | 'shell-probe-malformed'
  | 'shell-path-empty'

export interface CommandEnvironment {
  readonly env: Readonly<Record<string, string>>
  readonly pathEntries: readonly string[]
  readonly source: 'inherited' | 'login-shell' | 'registry' | 'fallback'
  readonly generation: number
  readonly machineHome: string
  readonly loginShell: string
  readonly failure?: CommandEnvironmentFailure
  resolve(commandOrPath: string): string | undefined
}

export interface ShellProbeRequest {
  shell: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  timeoutMs: number
  outputLimit: number
}

export type ShellProbeRunner = (request: ShellProbeRequest) => Promise<string>

/** Reads one registry value's raw `reg query` output (Windows only; injectable for tests). */
export type RegistryQueryRunner = (key: string, value: string) => Promise<string>

export interface CreateCommandEnvironmentOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  machineHome?: string
  loginShell?: string
  generation?: number
  supervised?: boolean
  accountInfo?: () => { homedir?: string; shell?: string }
  runShell?: ShellProbeRunner
  queryRegistry?: RegistryQueryRunner
  timeoutMs?: number
  outputLimit?: number
}

const defaultShellRunner: ShellProbeRunner = (request) =>
  new Promise((resolve, reject) => {
    execFile(
      request.shell,
      [...request.args],
      {
        encoding: 'utf8',
        env: request.env,
        timeout: request.timeoutMs,
        maxBuffer: request.outputLimit,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })

function stringEnv(input: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

function accountInfo(): { homedir?: string; shell?: string } {
  const info = userInfo()
  return { homedir: info.homedir, shell: info.shell || undefined }
}

function defaultShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  return platform === 'win32' ? env.COMSPEC || 'cmd.exe' : '/bin/sh'
}

const defaultRegistryQuery: RegistryQueryRunner = (key, value) =>
  new Promise((resolve, reject) => {
    execFile(
      'reg.exe',
      ['query', key, '/v', value],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })

/** The machine-then-user `Path` order Windows itself builds a new process's PATH in. */
const WINDOWS_PATH_KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
] as const

/** `%VAR%` references in a REG_EXPAND_SZ value, case-insensitively, left as-is when unset. */
function expandWindowsVariables(value: string, env: NodeJS.ProcessEnv): string {
  const lower = new Map(Object.entries(env).map(([key, v]) => [key.toLowerCase(), v]))
  return value.replace(
    /%([^%]+)%/g,
    (whole, name: string) => lower.get(name.toLowerCase()) ?? whole,
  )
}

/**
 * Windows' equivalent of asking a login shell for PATH: the CURRENT user and machine
 * `Path` from the registry. The app's own environment is a snapshot from when it was
 * started, so an agent installed afterwards (and the Path entry its installer added)
 * would otherwise stay invisible until the user restarts Podium.
 */
async function windowsRegistryPath(
  query: RegistryQueryRunner,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const entries: string[] = []
  for (const key of WINDOWS_PATH_KEYS) {
    const stdout = await query(key, 'Path').catch(() => '')
    const line = stdout.split(/\r?\n/).find((row) => /^\s+Path\s+REG_(?:EXPAND_)?SZ\s/i.test(row))
    const raw = line?.replace(/^\s+Path\s+REG_(?:EXPAND_)?SZ\s+/i, '') ?? ''
    entries.push(...expandWindowsVariables(raw, env).split(';').filter(Boolean))
  }
  return entries
}

function fallbacks(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv = {}): string[] {
  if (platform === 'win32') {
    // Where agent installers put their binaries without always adding the folder to
    // Path: Claude Code's native installer (~\.local\bin, it only prints a hint),
    // bun, npm's global prefix and mise's shims.
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [
      join(home, '.local', 'bin'),
      join(home, '.bun', 'bin'),
      join(appData, 'npm'),
      join(localAppData, 'mise', 'shims'),
    ]
  }
  const entries = [join(home, 'bin'), join(home, '.local', 'bin'), join(home, '.bun', 'bin')]
  if (platform === 'darwin') entries.push('/opt/homebrew/bin', '/opt/homebrew/sbin')
  entries.push('/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin')
  return entries
}

function splitPath(value: string | undefined): string[] {
  return (value ?? '').split(delimiter).filter(Boolean)
}

function dedupe(entries: readonly string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = platform === 'win32' ? entry.toLowerCase() : entry
    if (!entry || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseShellPath(stdout: string): string | undefined {
  const clean = stdout.replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, '')
  const start = clean.lastIndexOf(PATH_START)
  if (start < 0) return undefined
  const valueStart = start + PATH_START.length
  const end = clean.indexOf(PATH_END, valueStart)
  return end < 0 ? undefined : clean.slice(valueStart, end).trim()
}

function environmentPathKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? (Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path')
    : 'PATH'
}

function runnableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function hasPath(command: string, platform: NodeJS.Platform): boolean {
  return (
    isAbsolute(command) || command.includes('/') || (platform === 'win32' && command.includes('\\'))
  )
}

function resolveExecutable(
  command: string,
  entries: readonly string[],
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): string | undefined {
  if (!command) return undefined
  if (hasPath(command, platform)) {
    const candidate = isAbsolute(command) ? command : resolvePath(command)
    return runnableFile(candidate, platform) ? candidate : undefined
  }
  const extensions =
    platform === 'win32'
      ? (env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
          .map((extension) => extension.toLowerCase())
      : []
  for (const entry of entries) {
    const base = join(entry, command)
    const candidates =
      platform === 'win32' && !extname(command)
        ? [base, ...extensions.map((extension) => `${base}${extension}`)]
        : [base]
    for (const candidate of candidates) {
      if (runnableFile(candidate, platform)) return candidate
    }
  }
  return undefined
}

export async function createCommandEnvironment(
  options: CreateCommandEnvironmentOptions = {},
): Promise<CommandEnvironment> {
  const platform = options.platform ?? process.platform
  const input = options.env ?? process.env
  const baseEnv = stringEnv(input)
  let account: { homedir?: string; shell?: string } = {}
  let accountFailed = false
  try {
    account = (options.accountInfo ?? accountInfo)()
  } catch {
    accountFailed = true
  }
  const machineHome = options.machineHome || input.HOME || account.homedir || homedir()
  const accountShell =
    account.shell &&
    account.shell !== 'unknown' &&
    (platform === 'win32' || account.shell.startsWith('/'))
      ? account.shell
      : undefined
  const loginShell =
    options.loginShell || accountShell || input.SHELL || defaultShell(platform, input)
  const inherited = splitPath(input[environmentPathKey(input, platform)])
  let shellEntries: string[] = []
  let failure: CommandEnvironmentFailure | undefined = accountFailed
    ? 'account-unavailable'
    : undefined

  let registryEntries: string[] = []
  if (platform === 'win32')
    registryEntries = await windowsRegistryPath(
      options.queryRegistry ?? defaultRegistryQuery,
      input,
    )
  if ((options.supervised ?? input.PODIUM_DESKTOP_SUPERVISED === '1') && platform !== 'win32') {
    try {
      const stdout = await (options.runShell ?? defaultShellRunner)({
        shell: loginShell,
        args: ['-ilc', `printf '${PATH_START}%s${PATH_END}\\n' "$PATH"`],
        env: Object.freeze({ ...baseEnv, HOME: machineHome }),
        timeoutMs: options.timeoutMs ?? 5_000,
        outputLimit: options.outputLimit ?? 256 * 1024,
      })
      const shellPath = parseShellPath(stdout)
      if (shellPath === undefined) failure = 'shell-probe-malformed'
      else if (splitPath(shellPath).length === 0) failure = 'shell-path-empty'
      else shellEntries = splitPath(shellPath)
    } catch {
      failure = 'shell-probe-failed'
    }
  }

  const entries = Object.freeze(
    dedupe(
      [
        ...shellEntries,
        ...registryEntries,
        ...inherited,
        ...fallbacks(platform, machineHome, input),
      ],
      platform,
    ),
  )
  const key = environmentPathKey(input, platform)
  const env = Object.freeze({ ...baseEnv, HOME: machineHome, [key]: entries.join(delimiter) })
  const result: CommandEnvironment = {
    env,
    pathEntries: entries,
    source: shellEntries.length
      ? 'login-shell'
      : registryEntries.length
        ? 'registry'
        : inherited.length
          ? 'inherited'
          : 'fallback',
    generation: options.generation ?? 0,
    machineHome,
    loginShell,
    ...(failure ? { failure } : {}),
    resolve: (command) => resolveExecutable(command, entries, env, platform),
  }
  return Object.freeze(result)
}

export const commandEnvironmentSentinels = Object.freeze({ start: PATH_START, end: PATH_END })
