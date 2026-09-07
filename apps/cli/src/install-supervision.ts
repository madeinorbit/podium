/**
 * Can this box supervise Podium with a user systemd service? Ported from install.sh:384-428
 * (POD-3274).
 *
 * Decided ONCE, quietly, so every downstream step reads one answer. `systemctl --version`
 * only proves the BINARY exists; the *user* manager also needs a session bus at
 * /run/user/<uid>/bus, and without one every `systemctl --user` call prints
 * "Failed to connect to bus: No medium found". install.sh used to discover that by running
 * one and letting it complain mid-install.
 *
 * WHAT THIS DOES NOT DO: enabling linger. `installSystemd` (cli-systemd.ts) already runs
 * `loginctl enable-linger` as part of installing the unit, and already returns an actionable
 * `remedy` when there is no user bus. Duplicating either here would mean two places to keep
 * true. The only repair that has to happen BEFORE that call is the XDG_RUNTIME_DIR recovery,
 * because it changes whether the probe can see the bus at all.
 */
import { existsSync } from 'node:fs'
import {
  hasSystemctl as realHasSystemctl,
  hasUserSystemd as realHasUserSystemd,
} from './cli-systemd'

export interface SupervisionProbe {
  /** Can we install a user systemd service here? */
  systemd: boolean
  /** Why not, when `systemd` is false — one operator-readable sentence. */
  why?: string
  /** One actionable sentence, when there is one to give. */
  fix?: string
}

export interface ProbeSupervisionDeps {
  hasSystemctl?: () => boolean
  hasUserSystemd?: () => boolean
  /** Mutated in place on recovery, exactly as `export XDG_RUNTIME_DIR` did in the shell. */
  env?: NodeJS.ProcessEnv
  uid?: () => number
  socketExists?: (path: string) => boolean
}

export function probeSupervision(deps: ProbeSupervisionDeps = {}): SupervisionProbe {
  const env = deps.env ?? process.env
  const hasSystemctl = deps.hasSystemctl ?? realHasSystemctl
  const userSystemdOk = deps.hasUserSystemd ?? realHasUserSystemd
  const uid = deps.uid ?? (() => process.getuid?.() ?? 0)
  const socketExists = deps.socketExists ?? existsSync

  if (env.PODIUM_DISABLE_SYSTEMD) {
    return { systemd: false, why: 'PODIUM_DISABLE_SYSTEMD is set' }
  }
  if (!hasSystemctl()) {
    return {
      systemd: false,
      why: 'this host does not run systemd',
      fix: 'To start Podium at boot anyway, add an "@reboot" entry with `crontab -e`.',
    }
  }
  if (userSystemdOk()) return { systemd: true }

  // `sudo -i` / `su -` drop XDG_RUNTIME_DIR, so systemctl cannot find the bus that is sitting
  // right there. Point it at the socket ourselves — exported, because the daemon needs it too.
  if (env.XDG_RUNTIME_DIR === undefined) {
    const runtimeDir = `/run/user/${uid()}`
    if (socketExists(`${runtimeDir}/bus`)) {
      env.XDG_RUNTIME_DIR = runtimeDir
      if (userSystemdOk()) return { systemd: true }
    }
  }

  return {
    systemd: false,
    why:
      'systemd is installed, but this session has no user bus to reach it ' +
      '(usual on container VPSes and under sudo)',
    fix:
      'If the host does run a user manager, reconnect over SSH as this user and re-run the ' +
      'installer to get a real service.',
  }
}
