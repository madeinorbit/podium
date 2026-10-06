import {
  isMachinePathWithinRoot,
  machinePathHasSuffix,
  machinePathRelativeToRoot,
  machinePathSeparator,
  resolveMachinePath,
} from '@podium/model/browser'
import type { ILink, ILinkProvider } from '@xterm/xterm'
import { type BufferLike, type Cell, stitchLogicalLine } from './buffer-line'

export interface FileLinkConfig {
  cwd: string
  /** Read-only, caller-owned path index. The provider never mutates it. */
  knownPaths: ReadonlySet<string>
  onOpen: (absPath: string) => void
}

// A run of these characters is a path candidate. Trailing punctuation is trimmed.
const PATH_CHARS = /[\w./@~-]/
const PATHISH =
  /[\\/][\w./\\@~-]+|[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|css|scss|html|htm|rs|go|sh|yml|yaml|toml)/
// A trailing file extension. The cwd-relative fallback requires this so that branch
// refs like "feat/studio" (which resolve under cwd but are not files) aren't linked.
const HAS_EXT = /\.[A-Za-z0-9]{1,8}$/
// Real paths are short; cap the token so a pathological styled run can't trigger
// expensive regex backtracking in provideLinks (which xterm calls per render on hover).
const MAX_TOKEN = 1024

/** A candidate is accepted if its resolved absolute path is a known transcript
 *  path, or a known path ends with the candidate (suffix match for truncated
 *  TUI paths), or it resolves under cwd and looks path-like. */
function accept(token: string, cfg: FileLinkConfig): string | null {
  if (
    token.length > MAX_TOKEN ||
    !PATHISH.test(token) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token)
  )
    return null
  const abs = resolveMachinePath(cfg.cwd, token)
  if (cfg.knownPaths.has(abs)) return abs
  const windows = machinePathSeparator(cfg.cwd) === '\\'
  for (const k of cfg.knownPaths) {
    // The ordinary POSIX hover lane only needs a literal suffix check.
    if (!windows) {
      if (k.endsWith(`/${token}`) || k === token) return k
    } else if (machinePathRelativeToRoot(k, abs) === '' || machinePathHasSuffix(k, token)) {
      return resolveMachinePath(cfg.cwd, k)
    }
  }
  // cwd-relative fallback: only paths with a real file extension. Without this a styled
  // branch ref like "feat/studio" resolves under cwd and gets wrongly linked as a file.
  if (HAS_EXT.test(token) && isMachinePathWithinRoot(cfg.cwd, abs)) return abs
  return null
}

export function findStyledPathMatches(
  cells: Cell[],
  cfg: FileLinkConfig,
): Array<{ path: string; cells: Cell[] }> {
  const matches: Array<{ path: string; cells: Cell[] }> = []
  let run: Cell[] = []
  const flush = (): void => {
    if (run.length) {
      let token = run.map((c) => c.char).join('')
      let trimmed = run
      // Trim trailing sentence punctuation that isn't part of a path.
      while (trimmed.length && /[.,;:)\]]$/.test(token) && !/\.\w+$/.test(token)) {
        trimmed = trimmed.slice(0, -1)
        token = trimmed.map((c) => c.char).join('')
      }
      // Line/column suffixes belong to the clickable run, never the file sent to onOpen.
      const abs = accept(token.replace(/:\d+(?::\d+)?$/, ''), cfg)
      if (abs) matches.push({ path: abs, cells: trimmed })
    }
    run = []
  }
  const windowsCwd = machinePathSeparator(cfg.cwd) === '\\'
  let skipUrl = false
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!
    if (!c.styled) {
      flush()
      skipUrl = false
      continue
    }
    if (skipUrl) {
      if (/\s|["'<>()[\]]/.test(c.char)) skipUrl = false
      continue
    }
    if (c.char === ':') {
      const token = run.map((cell) => cell.char).join('')
      if (
        /^[A-Za-z][A-Za-z0-9+.-]*$/.test(token) &&
        cells[i + 1]?.char === '/' &&
        cells[i + 2]?.char === '/'
      ) {
        // Consume the URL as one non-file run, including a URL after a prose label.
        run = []
        skipUrl = true
      } else if (/^[A-Za-z]$/.test(token) && /^[\\/]$/.test(cells[i + 1]?.char ?? '')) {
        run.push(c) // A drive-letter colon is part of the path.
      } else {
        let suffixEnd = i
        while (suffixEnd < cells.length && suffixEnd - i < 32 && cells[suffixEnd]?.styled)
          suffixEnd++
        const suffixCells = cells.slice(i, suffixEnd)
        const suffix = /^:\d+(?::\d+)?(?=$|[.,;)\]\s])/.exec(
          suffixCells.map((cell) => cell.char).join(''),
        )?.[0]
        if (token && suffix) {
          run.push(...suffixCells.slice(0, suffix.length))
          i += suffix.length - 1
        }
        // Other colons delimit tokens (error:src/a.ts, src/a.ts:12-15).
        flush()
      }
    } else if (PATH_CHARS.test(c.char)) {
      run.push(c)
    } else if (
      c.char === '\\' &&
      (windowsCwd ||
        /^[A-Za-z]:/.test(run.map((cell) => cell.char).join('')) ||
        run[0]?.char === '\\' ||
        (run.length === 0 && cells[i + 1]?.char === '\\'))
    ) {
      run.push(c)
    } else flush()
  }
  flush()
  return matches
}

/** Build an xterm ILinkProvider from a config + a live buffer accessor. */
export function makeFileLinkProvider(
  getBuffer: () => BufferLike,
  getConfig: () => FileLinkConfig | null,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const cfg = getConfig()
      if (!cfg) {
        callback(undefined)
        return
      }
      const cells = stitchLogicalLine(getBuffer(), bufferLineNumber - 1) // xterm rows are 1-based here
      const onThisRow = (m: { cells: Cell[] }): boolean =>
        m.cells.some((c) => c.y === bufferLineNumber - 1)
      const links: ILink[] = findStyledPathMatches(cells, cfg)
        .filter(onThisRow)
        .map((m) => {
          const first = m.cells[0]!
          const last = m.cells[m.cells.length - 1]!
          return {
            text: m.path,
            range: {
              start: { x: first.x + 1, y: first.y + 1 },
              end: { x: last.x + 1, y: last.y + 1 },
            },
            activate: (_event: MouseEvent, _text: string) => {
              cfg.onOpen(m.path)
            },
          }
        })
      callback(links.length ? links : undefined)
    },
  }
}
