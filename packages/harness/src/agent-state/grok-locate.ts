import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Same shape as `GrokSessionPaths` — kept local so this file does not import grok.ts. */
interface GrokSessionPaths {
  sessionId: string
  sessionDir: string
  summaryPath: string
  updatesPath: string
  chatHistoryPath: string
}

const SESSION_FILES = new Set(['chat_history.jsonl', 'updates.jsonl', 'summary.json'])

/**
 * Locate a Grok session directory (docs/spec/conversation-registry.md §3.3).
 *
 * Grok buckets sessions by the cwd the conversation was CREATED under
 * (`~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/`), while Podium's
 * `session.cwd` is the current worktree. Deriving the path from that cwd looks
 * in the wrong bucket when Grok stored the session under the git root (or any
 * earlier cwd) — parked chat then opens on an empty feed even though
 * `chat_history.jsonl` is intact. The session id IS unique across buckets, so
 * on an exact-path miss, sweep every bucket for it.
 *
 * Resolution order: recorded pathHint (the common parked-read case once the
 * segment exists — one stat) → exact derived path → bucket sweep. Newest
 * `chat_history.jsonl` mtime wins the freak case of the same id in two buckets.
 *
 * A Grok pathHint is often `summary.json` (discovery's source file), not
 * `chat_history.jsonl`. The hint is evidence for WHERE the session dir lives;
 * the parent directory must still be this session's id.
 */
export async function locateGrokSessionPaths(opts: {
  cwd: string
  sessionId: string
  pathHint?: string
  homeDir?: string
}): Promise<GrokSessionPaths | null> {
  const fromHint = opts.pathHint ? pathsFromHint(opts.pathHint, opts.sessionId) : null
  if (fromHint && (await sessionMtimeMs(fromHint)) !== null) return fromHint

  const exact = derivedPaths(opts.cwd, opts.sessionId, opts.homeDir)
  if ((await sessionMtimeMs(exact)) !== null) return exact

  const sessionsRoot = join(grokRoot(opts.homeDir), 'sessions')
  let buckets: string[]
  try {
    buckets = (await readdir(sessionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return null
  }

  const candidates: { paths: GrokSessionPaths; mtimeMs: number }[] = []
  for (const bucket of buckets) {
    const paths = pathsFromDir(join(sessionsRoot, bucket, opts.sessionId), opts.sessionId)
    const mtimeMs = await sessionMtimeMs(paths)
    if (mtimeMs !== null) candidates.push({ paths, mtimeMs })
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0]?.paths ?? null
}

export async function locateGrokChatHistory(opts: {
  cwd: string
  sessionId: string
  pathHint?: string
  homeDir?: string
  transcriptRoot?: string
}): Promise<string | null> {
  const authority = await locateCurrentTranscript(opts)
  if (authority) return authority
  const paths = await locateGrokSessionPaths(opts)
  if (!paths || !(await isFile(paths.chatHistoryPath))) return null
  return paths.chatHistoryPath
}

/** Grok 0.2.118+ writes the chat authority outside its account HOME. */
async function locateCurrentTranscript(opts: {
  sessionId: string
  pathHint?: string
  transcriptRoot?: string
}): Promise<string | null> {
  if (!opts.transcriptRoot) return null
  const lexicalRoot = resolve(opts.transcriptRoot)
  let root: string
  try {
    root = await realpath(lexicalRoot)
  } catch {
    return null
  }

  if (opts.pathHint) {
    const hinted = await confinedCurrentTranscript(root, lexicalRoot, opts.pathHint, opts.sessionId)
    if (hinted) return hinted.path
  }

  let projects: string[]
  try {
    projects = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return null
  }
  const candidates: { path: string; mtimeMs: number }[] = []
  for (const project of projects) {
    const candidate = await confinedCurrentTranscript(
      root,
      root,
      join(root, project, opts.sessionId + '.jsonl'),
      opts.sessionId,
    )
    if (candidate) candidates.push(candidate)
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates[0]?.path ?? null
}

export async function confinedCurrentTranscript(
  root: string,
  lexicalRoot: string,
  candidate: string,
  sessionId: string,
): Promise<{ path: string; mtimeMs: number } | null> {
  try {
    const lexicalWithinRoot = relative(lexicalRoot, resolve(candidate))
    const lexicalParts = lexicalWithinRoot.split(sep)
    if (
      candidate.split(sep).includes('..') ||
      !lexicalWithinRoot ||
      isAbsolute(lexicalWithinRoot) ||
      lexicalParts.length !== 2 ||
      lexicalParts[0] === '..' ||
      lexicalParts[1] !== sessionId + '.jsonl'
    ) {
      return null
    }
    const projectStats = await lstat(dirname(candidate))
    const candidateStats = await lstat(candidate)
    if (
      projectStats.isSymbolicLink() ||
      !projectStats.isDirectory() ||
      candidateStats.isSymbolicLink() ||
      !candidateStats.isFile()
    ) {
      return null
    }
    const path = await realpath(candidate)
    const withinRoot = relative(root, path)
    const parts = withinRoot.split(sep)
    if (
      !withinRoot ||
      isAbsolute(withinRoot) ||
      parts.length !== 2 ||
      parts[0] === '..' ||
      parts[1] !== sessionId + '.jsonl'
    ) {
      return null
    }
    return { path, mtimeMs: candidateStats.mtimeMs }
  } catch {
    return null
  }
}

function pathsFromHint(pathHint: string, sessionId: string): GrokSessionPaths | null {
  const base = basename(pathHint)
  const sessionDir = SESSION_FILES.has(base) ? dirname(pathHint) : pathHint
  if (basename(sessionDir) !== sessionId) return null
  return pathsFromDir(sessionDir, sessionId)
}

function derivedPaths(cwd: string, sessionId: string, homeDir?: string): GrokSessionPaths {
  return pathsFromDir(
    join(grokRoot(homeDir), 'sessions', encodeURIComponent(cwd), sessionId),
    sessionId,
  )
}

function pathsFromDir(sessionDir: string, sessionId: string): GrokSessionPaths {
  return {
    sessionId,
    sessionDir,
    summaryPath: join(sessionDir, 'summary.json'),
    updatesPath: join(sessionDir, 'updates.jsonl'),
    chatHistoryPath: join(sessionDir, 'chat_history.jsonl'),
  }
}

function grokRoot(homeDir: string | undefined): string {
  if (homeDir) return join(homeDir, '.grok')
  return process.env.GROK_HOME || join(homedir(), '.grok')
}

async function sessionMtimeMs(paths: GrokSessionPaths): Promise<number | null> {
  let newest: number | null = null
  for (const path of [paths.chatHistoryPath, paths.updatesPath, paths.summaryPath]) {
    try {
      const st = await stat(path)
      if (st.isFile() && (newest === null || st.mtimeMs > newest)) newest = st.mtimeMs
    } catch {
      // this file is not present in the session dir
    }
  }
  return newest
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
