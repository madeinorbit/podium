import type { ILink, ILinkProvider } from '@xterm/xterm'
import { type BufferLike, type Cell, stitchLogicalLine } from './buffer-line'

export interface FileLinkConfig {
  cwd: string
  knownPaths: Set<string>
  onOpen: (absPath: string) => void
}

// A run of these characters is a path candidate. Trailing punctuation is trimmed.
const PATH_CHARS = /[\w./@~-]/
const PATHISH =
  /\/[\w./@~-]+|[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|css|scss|html|htm|rs|go|sh|yml|yaml|toml)/
// A trailing file extension. The cwd-relative fallback requires this so that branch
// refs like "feat/studio" (which resolve under cwd but are not files) aren't linked.
const HAS_EXT = /\.[A-Za-z0-9]{1,8}$/
// Real paths are short; cap the token so a pathological styled run can't trigger
// expensive regex backtracking in provideLinks (which xterm calls per render on hover).
const MAX_TOKEN = 1024

function resolveAgainstCwd(cwd: string, path: string): string {
  const abs = path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`
  const out: string[] = []
  for (const seg of abs.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return `/${out.join('/')}`
}

/** A candidate is accepted if its resolved absolute path is a known transcript
 *  path, or a known path ends with the candidate (suffix match for truncated
 *  TUI paths), or it resolves under cwd and looks path-like. */
function accept(token: string, cfg: FileLinkConfig): string | null {
  if (token.length > MAX_TOKEN || !PATHISH.test(token)) return null
  const abs = resolveAgainstCwd(cfg.cwd, token)
  if (cfg.knownPaths.has(abs)) return abs
  for (const k of cfg.knownPaths) if (k.endsWith(`/${token}`) || k === token) return k
  // cwd-relative fallback: only paths with a real file extension. Without this a styled
  // branch ref like "feat/studio" resolves under cwd and gets wrongly linked as a file.
  if (HAS_EXT.test(token) && abs.startsWith(`${cfg.cwd.replace(/\/+$/, '')}/`)) return abs
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
      const abs = accept(token, cfg)
      if (abs) matches.push({ path: abs, cells: trimmed })
    }
    run = []
  }
  for (const c of cells) {
    if (c.styled && PATH_CHARS.test(c.char)) run.push(c)
    else flush()
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
    provideLinks(
      bufferLineNumber: number,
      callback: (links: ILink[] | undefined) => void,
    ): void {
      const cfg = getConfig()
      if (!cfg) return callback(undefined)
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
