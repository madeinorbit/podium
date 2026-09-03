/**
 * PATH persistence for the installer — ported from install.sh:294-382 (POD-3274).
 *
 * WHY THIS EXISTS AT ALL: the copy-paste install runs in ONE shell, so exporting PATH there
 * dies with that process — the next SSH login had no `podium` at all (POD-327). A snippet
 * appended to the startup files of every shell we support is what makes `$BIN` survive
 * future logins.
 *
 * Service contexts never read these files: user units carry an explicit `Environment=PATH`
 * (renderDaemonUnit in apps/cli/src/cli-systemd.ts). Opt out with PODIUM_NO_MODIFY_PATH=1,
 * which the caller honours by not calling this.
 *
 * Every write here is BEST-EFFORT. A read-only or partly-unwritable $HOME is a real state on
 * locked-down images, and losing the snippet is a degraded install, not a failed one.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const PATH_MARKER = '# >>> podium installer (PATH) >>>'
const PATH_MARKER_END = '# <<< podium installer (PATH) <<<'

export interface PersistPathDeps {
  /** `command -v <shell>` — injected so a test can describe a box without zsh or fish. */
  shellExists?: (shell: string) => boolean
}

export interface PathPersistResult {
  /** Startup files THIS run appended the snippet to. */
  written: string[]
  /** The snippet is present — whether this run wrote it or a previous install did. */
  persisted: boolean
}

/**
 * Written UNEXPANDED, deliberately: the snippet re-resolves $HOME and re-checks PATH on every
 * source, so it stays correct if $HOME moves and never stacks a duplicate entry.
 */
const POSIX_SNIPPET = [
  '',
  PATH_MARKER,
  '# Keeps ~/.local/bin (where podium is installed) on PATH. Delete this block to opt out.',
  'case ":${PATH-}:" in',
  '  *":$HOME/.local/bin:"*) ;;',
  '  *) PATH="$HOME/.local/bin${PATH:+:$PATH}"; export PATH ;;',
  'esac',
  PATH_MARKER_END,
  '',
].join('\n')

/** fish cannot parse the POSIX snippet; conf.d/ is auto-sourced, so it gets its own file. */
const FISH_SNIPPET = [
  PATH_MARKER,
  '# Keeps ~/.local/bin (where podium is installed) on PATH. Delete this file to opt out.',
  'if not contains -- $HOME/.local/bin $PATH',
  '    set -gx PATH $HOME/.local/bin $PATH',
  'end',
  PATH_MARKER_END,
  '',
].join('\n')

/** install.sh's `command -v <shell>`: only touch a shell's rc when that shell is here. */
function shellOnPath(shell: string): boolean {
  try {
    execFileSync('command', ['-v', shell], { stdio: 'ignore', shell: true })
    return true
  } catch {
    return false
  }
}

function hasMarker(file: string): boolean {
  try {
    return existsSync(file) && readFileSync(file, 'utf8').includes(PATH_MARKER)
  } catch {
    return false
  }
}

export function persistPath(
  binDir: string,
  home: string = homedir(),
  deps: PersistPathDeps = {},
): PathPersistResult {
  const written: string[] = []
  let persisted = false
  const shellExists = deps.shellExists ?? shellOnPath

  const append = (rc: string): void => {
    if (hasMarker(rc)) {
      persisted = true // a previous install already wrote it
      return
    }
    try {
      mkdirSync(dirname(rc), { recursive: true })
      appendFileSync(rc, POSIX_SNIPPET)
    } catch {
      return // never fatal
    }
    written.push(rc)
    persisted = true
  }

  // Only meaningful for the standard location the snippet hard-codes; a custom bin dir is the
  // caller's to put on PATH.
  if (binDir !== join(home, '.local/bin')) return { written, persisted }

  append(join(home, '.profile')) // sh/dash login, and bash's last resort
  for (const shadowing of ['.bash_profile', '.bash_login', '.zprofile']) {
    // PRESENT-ONLY: each of these SHADOWS ~/.profile for its shell, so skipping them would
    // silently lose the snippet; CREATING them would shadow ~/.profile where it isn't today.
    const rc = join(home, shadowing)
    if (existsSync(rc)) append(rc)
  }
  // Present-file OR shell-installed, exactly as install.sh gated these: writing a ~/.zshrc
  // onto a box with no zsh creates a file that shell would then start honouring.
  const bashrc = join(home, '.bashrc')
  if (existsSync(bashrc) || shellExists('bash')) append(bashrc) // interactive non-login bash
  const zshrc = join(process.env.ZDOTDIR ?? home, '.zshrc')
  if (existsSync(zshrc) || shellExists('zsh')) append(zshrc)

  const fishConf = join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'fish/conf.d')
  const fishFile = join(fishConf, 'podium-path.fish')
  if (!existsSync(dirname(fishConf)) && !shellExists('fish')) {
    // no fish here, and no fish config to extend
  } else if (hasMarker(fishFile)) {
    persisted = true
  } else {
    try {
      mkdirSync(fishConf, { recursive: true })
      writeFileSync(fishFile, FISH_SNIPPET)
      written.push(fishFile)
      persisted = true
    } catch {
      // never fatal
    }
  }

  return { written, persisted }
}

/**
 * What the operator still has to do, if anything. The snippet only reaches FUTURE shells —
 * the one running the installer is already past reading its startup files.
 */
export function pathHint(
  binDir: string,
  persisted: boolean,
  command: string,
  path: string = process.env.PATH ?? '',
): string | undefined {
  if (path.split(':').includes(binDir)) return undefined
  return persisted
    ? `New shells will find ${command}. For this one: export PATH="${binDir}:$PATH"`
    : `First add ${binDir} to your PATH.`
}
