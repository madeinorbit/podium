import { Popover } from '@base-ui/react/popover'
import { observer } from '@podium/client-graph/react'
import { Check, RotateCcw, Send, X } from 'lucide-react'
import { useContext, useState } from 'react'
import { TipContext } from './tip-context'
import { TIP_IDS, type TipId } from './types'

const GUIDE: Record<TipId, { title: string; when: string }> = {
  'first-prompt': { title: 'Your first prompt', when: 'you start your first task.' },
  'first-send': { title: 'Your list and flight deck', when: 'you send your first task.' },
  'ask-anything': { title: 'Ask your agents anything', when: 'your first agent finishes a turn.' },
  'team-forms': { title: 'Working with a team', when: 'your task gets a team.' },
  'first-proposal': { title: 'Work your agent finds', when: 'an agent proposes more work.' },
  'first-offer': { title: 'Your next move', when: 'an agent offers a next step.' },
  'first-artifact': { title: 'Things your agents make', when: 'an agent attaches something.' },
}
export const FirstFlightsBadge = observer(function FirstFlightsBadge() {
  const engine = useContext(TipContext)
  const [open, setOpen] = useState(false)
  if (!engine?.badgeVisible) return null
  return (
    <div className="first-flights-footer">
      <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
        <Popover.Trigger
          className="first-flights-badge"
          data-first-flights-badge=""
          aria-label={`First flights ${engine.progress}/7. Open guide`}
        >
          <svg
            width="21"
            height="21"
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="first-flights-ring"
          >
            <circle cx="12" cy="12" r="9" className="first-flights-ring-track" />
            <circle
              cx="12"
              cy="12"
              r="9"
              pathLength="7"
              strokeDasharray={`${engine.progress} 7`}
              transform="rotate(-90 12 12)"
            />
          </svg>
          <span>
            First flights <span className="first-flights-count">{engine.progress}/7</span>
          </span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            side="top"
            align="start"
            sideOffset={10}
            collisionPadding={12}
            className="tip-positioner"
          >
            <Popover.Popup
              className="flights-guide"
              initialFocus={(type) => (type === 'keyboard' ? undefined : false)}
            >
              <div className="tip-eyebrow">
                <Send size={13} aria-hidden="true" />
                <span>Your field guide</span>
                <Popover.Close className="tip-close" aria-label="Close guide">
                  <X size={14} />
                </Popover.Close>
              </div>
              <Popover.Title className="tip-title">First flights</Popover.Title>
              <Popover.Description className="tip-body">
                A few pointers, when you need them.
              </Popover.Description>
              <ol className="flights-guide-list">
                {TIP_IDS.map((id) => {
                  const seen = engine.log.isSeen(id)
                  // Read when the guide opens: Replay needs the moment's first
                  // anchor on screen now, else it would do nothing.
                  const available = engine.canReplay(id)
                  return (
                    <li key={id}>
                      <span className="flights-guide-check">
                        {seen ? (
                          <Check size={14} aria-label="Logged" />
                        ) : (
                          <span className="flights-guide-dot" />
                        )}
                      </span>
                      <div>
                        <span className="flights-guide-name">{GUIDE[id].title}</span>
                        {seen ? (
                          <button
                            className="flights-replay"
                            type="button"
                            disabled={!available}
                            onClick={() => {
                              setOpen(false)
                              engine.replay(id)
                            }}
                          >
                            <RotateCcw size={11} aria-hidden="true" />
                            {available ? 'Replay' : 'Return to this moment to replay'}
                          </button>
                        ) : (
                          <p>Shows up when {GUIDE[id].when}</p>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ol>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
})
