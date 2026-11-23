import type { TranscriptItem } from '@podium/model/browser'

export function ToolEffectNotes({ effects }: { effects: TranscriptItem['toolEffects'] }) {
  return effects?.map((effect) => {
    let text: string | undefined
    switch (effect.kind) {
      case 'file-edit':
        break
      case 'git-operation':
        text = `Git (reported by harness): ${JSON.stringify(effect.operation)}`
        break
      case 'background-task':
        text = `Background task: ${effect.taskId}`
        break
      case 'termination':
        text = [
          effect.interrupted ? 'Interrupted' : '',
          effect.timedOutAfterMs !== undefined
            ? `Timed out after ${effect.timedOutAfterMs} ms`
            : '',
          effect.interpretation,
        ]
          .filter(Boolean)
          .join(' · ')
        break
      case 'unknown':
        text = `Unrecognized tool effect: ${effect.key}`
        break
    }
    return text ? (
      <div
        className="tool-aside"
        key={effect.kind === 'unknown' ? `unknown-${effect.key}` : effect.kind}
      >
        {text}
      </div>
    ) : null
  })
}
