/** Codex-owned managed-daemon cleanup before its credential home is removed. */

/** The measured files a second Codex login shares with the person's default. */
export const codexHomeSharing = ['codex', ['config.toml', 'AGENTS.md', 'skills']] as const

/** A process and its command line, as `ps` prints it. */
export interface RunningProcess {
  pid: number
  args: string
}

export interface CodexHomeStopPorts {
  codexExecutable(): string | undefined
  commandEnv(): Readonly<Record<string, string>>
  run(command: string, args: readonly string[], env: Record<string, string>): Promise<void>
  listProcesses(): Promise<RunningProcess[]>
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
  sleep(ms: number): Promise<void>
}

/** How long a process started from the home gets to exit after SIGTERM. */
const GRACE_MS = 5_000
const POLL_MS = 250

export async function stopCodexHome(
  home: { harness: string; dir: string },
  ports: CodexHomeStopPorts,
): Promise<void> {
  if (home.harness !== 'codex') return
  const codex = ports.codexExecutable()
  if (codex) {
    try {
      await ports.run(codex, ['app-server', 'daemon', 'stop'], {
        ...ports.commandEnv(),
        CODEX_HOME: home.dir,
      })
    } catch {
      // An older Codex has no such command, or none was running: what still
      // runs from the home is found below either way.
    }
  }
  await killRunningFrom(home.dir, ports)
}

/** Stop every process whose executable lives under `dir`. */
async function killRunningFrom(dir: string, ports: CodexHomeStopPorts): Promise<void> {
  const prefix = dir.endsWith('/') ? dir : `${dir}/`
  const inside = async () =>
    (await ports.listProcesses()).filter((process) => process.args.startsWith(prefix))
  const first = await inside()
  if (first.length === 0) return
  for (const process of first) ports.signal(process.pid, 'SIGTERM')
  for (let waited = 0; waited < GRACE_MS; waited += POLL_MS) {
    if ((await inside()).length === 0) return
    await ports.sleep(POLL_MS)
  }
  for (const process of await inside()) ports.signal(process.pid, 'SIGKILL')
}
