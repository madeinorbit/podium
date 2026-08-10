import { panelLabel } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model'
import { SquareTerminal } from 'lucide-react'
import type { JSX } from 'react'
import { agentIconFor } from '@/lib/agent-tone'

/**
 * STANDBY (POD-701) — the chat that has not started.
 *
 * The empty transcript used to be the same grey strip as "loading", carrying
 * one line that said only what was ABSENT ("No transcript yet"). It is in fact
 * the FIRST thing a reader sees on every freshly spawned agent, and the moment
 * they most need the pane to answer three questions: which agent is this,
 * where is it running, and what happens next.
 *
 * So it states the session's coordinates and points at the composer directly
 * below it. Three states, because "empty" means three different things here and
 * one sentence cannot serve them: a shell (no transcript BY DESIGN — the
 * terminal is the product), a session that has stopped without writing one, and
 * an agent standing by for its first prompt.
 *
 * It holds still. An agent that has not been asked anything is waiting on YOU,
 * and stillness is how this system says that — no pulse on the mark, no
 * skeleton rows pretending content is on the way.
 */

/** The tail of a path, for a 430px column. The client has no idea what the
 *  machine's home directory is — it may not even be the machine the browser is
 *  on — so this abbreviates from the LEFT rather than guessing at a `~`, which
 *  would be wrong on every remote machine in a fleet. The full path stays in
 *  `title`, and the trailing segments are the ones that identify a worktree. */
export function shortPath(cwd: string): string {
  if (cwd.length <= 34) return cwd
  const parts = cwd.split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : cwd
}

interface StandbyCopy {
  title: string
  lede: string
  hint?: string
}

/** What "empty" means for THIS session. Keyed on the two facts that change the
 *  answer — whether the harness writes a transcript at all, and whether the
 *  process is still running. */
export function standbyCopy(session: SessionMeta | undefined): StandbyCopy {
  const name = session ? panelLabel(session.agentKind) : 'This agent'
  if (session?.agentKind === 'shell')
    return {
      title: 'A shell keeps no transcript',
      lede: 'Shell sessions are raw terminal — every command and its output lives in Native view, which is the whole point of running one.',
      hint: 'Switch this pane to Native to use it.',
    }
  const running = session?.status === 'live' || session?.status === 'starting'
  if (session && !running)
    return {
      title: 'This session wrote nothing',
      lede: `${name} stopped before it produced any output. Whatever the terminal printed is still in Native view.`,
    }
  return {
    title: `${name} is standing by`,
    lede: 'Everything it writes lands here — its reasoning as it works, the tools it runs, and the answer at the end.',
    hint: 'Send the first prompt below.',
  }
}

export function TranscriptStandby({
  session,
  cwd,
}: {
  session: SessionMeta | undefined
  cwd: string
}): JSX.Element {
  const copy = standbyCopy(session)
  const AgentIcon = session ? agentIconFor(session.agentKind) : undefined
  // A shell has no model — whatever a spawn-time selection left on the row is
  // not a fact about the process running in this pane.
  const model =
    session?.agentKind === 'shell' ? undefined : (session?.observedModel ?? session?.model)
  const agentLine = session
    ? [panelLabel(session.agentKind), model].filter(Boolean).join(' · ')
    : undefined

  return (
    <div className="transcript-standby" data-testid="transcript-empty-state">
      <span className="transcript-standby-mark" aria-hidden="true">
        {AgentIcon ? (
          <AgentIcon size={17} strokeWidth={1.6} />
        ) : (
          <SquareTerminal size={17} strokeWidth={1.6} />
        )}
      </span>
      <strong className="transcript-standby-title">{copy.title}</strong>
      <p className="transcript-standby-lede">{copy.lede}</p>
      {/* The coordinates. A reader who just spawned an agent checks these before
          typing — the wrong worktree is the expensive mistake here, not the
          wrong model. Rows are omitted rather than shown empty. */}
      {(agentLine || cwd !== '/' || session?.displayRef) && (
        <dl className="transcript-standby-facts">
          {agentLine && (
            <>
              <dt>Agent</dt>
              <dd>{agentLine}</dd>
            </>
          )}
          {cwd !== '/' && (
            <>
              <dt>Folder</dt>
              <dd title={cwd}>{shortPath(cwd)}</dd>
            </>
          )}
          {session?.displayRef && (
            <>
              <dt>Session</dt>
              <dd>{session.displayRef}</dd>
            </>
          )}
        </dl>
      )}
      {copy.hint && <p className="transcript-standby-hint">{copy.hint}</p>}
    </div>
  )
}
