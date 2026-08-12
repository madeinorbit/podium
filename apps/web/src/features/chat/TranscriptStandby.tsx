import { panelLabel } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model'
import type { JSX } from 'react'
import { modelLabel } from '@/lib/agent-models'

/**
 * STANDBY (POD-701, redrawn POD-746) — the chat that has not started.
 *
 * It was a bordered card in the middle of the pane: an icon in a box, a title,
 * a two-line lede explaining what a transcript is, a three-row AGENT/FOLDER/
 * SESSION table, and a closing instruction to use the composer. Six objects to
 * say one thing. Nobody reads a definition of "transcript" on their way to
 * typing, and a card floated in a void is the exact "content stopped halfway"
 * tell — so the card is gone.
 *
 * What is left is the question, asked where the answer gets typed: bottom of
 * the pane, sitting on the composer, so the eye goes question → cursor with
 * nothing in between. A yellow caret in the margin marks it as the one thing
 * waiting on the operator (The Signal Rule — and the composer's own send button
 * is still grey at this moment, so the region has exactly one yellow voice).
 * Under it, one mono line of coordinates: who is answering and from which
 * folder — the wrong worktree being the expensive mistake here, and the only
 * fact from the old table that the surrounding chrome does not already state.
 *
 * Three states, because "empty" means three different things: a shell (no
 * transcript BY DESIGN — the terminal is the product), a session that stopped
 * without writing one, and an agent standing by. Only the third asks anything,
 * so only the third gets the caret and the question.
 *
 * It holds still after one authored moment. An agent that has not been asked
 * anything is waiting on YOU, and stillness is how this system says that.
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
  /** Present only where the reader would otherwise be stuck — a state they can
   *  do nothing about needs to say where the output went. The state that IS
   *  actionable needs no note: the composer is directly below the question. */
  note?: string
  /** Something is being asked of the operator. Drives the caret, which is the
   *  only yellow this pane spends. */
  asking: boolean
}

/** What "empty" means for THIS session. Keyed on the two facts that change the
 *  answer — whether the harness writes a transcript at all, and whether the
 *  process is still running. */
export function standbyCopy(session: SessionMeta | undefined): StandbyCopy {
  if (session?.agentKind === 'shell')
    return {
      title: 'A shell keeps no transcript',
      note: 'Every command and its output is in Native view.',
      asking: false,
    }
  const running = session?.status === 'live' || session?.status === 'starting'
  if (session && !running)
    return {
      title: 'This session wrote nothing',
      note: 'Whatever it printed is still in Native view.',
      asking: false,
    }
  return { title: 'What do you want to work on?', asking: true }
}

/** Who is answering, and from where. Omitted rather than shown empty. */
function coordinates(session: SessionMeta | undefined, cwd: string): readonly string[] {
  const out: string[] = []
  if (session) {
    // A shell has no model — whatever a spawn-time selection left on the row is
    // not a fact about the process running in this pane.
    const model =
      session.agentKind === 'shell'
        ? undefined
        : modelLabel(session.agentKind, session.observedModel ?? session.model)
    out.push(panelLabel(session.agentKind))
    if (model && model !== 'Auto') out.push(model)
  }
  if (cwd !== '/') out.push(shortPath(cwd))
  return out
}

export function TranscriptStandby({
  session,
  cwd,
}: {
  session: SessionMeta | undefined
  cwd: string
}): JSX.Element {
  const copy = standbyCopy(session)
  const where = coordinates(session, cwd)

  return (
    <div
      className={copy.asking ? 'transcript-standby is-asking' : 'transcript-standby'}
      data-testid="transcript-empty-state"
    >
      <p className="transcript-standby-ask shell-type-column-title">
        {copy.asking && (
          <span className="transcript-standby-caret" aria-hidden="true">
            ❯
          </span>
        )}
        <span>{copy.title}</span>
      </p>
      {copy.note && <p className="transcript-standby-note">{copy.note}</p>}
      {where.length > 0 && (
        <p className="transcript-standby-where">
          {where.map((part, i) => (
            // The path is the one part that can be abbreviated, so it keeps the
            // full value in `title`; the rest are already whole.
            <span key={part} title={part.startsWith('…/') ? cwd : undefined}>
              {i > 0 && (
                <span className="transcript-standby-sep" aria-hidden="true">
                  ·
                </span>
              )}
              {part}
            </span>
          ))}
        </p>
      )}
    </div>
  )
}
