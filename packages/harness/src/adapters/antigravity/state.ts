import { access } from 'node:fs/promises'
import type { AgentStateProvider } from '../../agent-state/types.js'
import { withStateChannel } from '../../agent-state/types.js'
import type { HarnessObserver } from '../../manifest.js'
import { isRecord, stringField } from '../shared/json-util.js'
import { antigravityHookEvents } from './instrumentation.js'
import { CONVERSATION_ID, transcriptPath } from './paths.js'

export const antigravityState: AgentStateProvider = {
  instrumentation: () => ({ args: [] }),
  translate: async (raw) => withStateChannel(antigravityHookEvents(raw), 'hook'),
  screen(lines) {
    const text = lines.join('\n')
    // Esc returns to the native composer without emitting a Stop hook in
    // the measured CLI. Require its idle footer so an older interruption
    // still visible above a new running turn cannot finish that turn.
    if (
      /Interrupted · What should Antigravity CLI do instead\?/u.test(text) &&
      /\? for shortcuts/u.test(text)
    )
      return {
        events: withStateChannel(
          [{ kind: 'turn_completed', verdict: { kind: 'interrupted' } }],
          'classifier',
        ),
        interactionVisible: false,
      }
    if (/^\s*Requesting permission for:\s*$/mu.test(text) && /^\s*>\s*1\. Yes,/mu.test(text))
      return {
        events: withStateChannel(
          [
            {
              kind: 'needs_user',
              need: 'permission',
              summary: /Requesting permission for:\s*\n\s*([^\n]+)/u.exec(text)?.[1]?.slice(0, 200),
            },
          ],
          'classifier',
        ),
        interactionVisible: true,
      }
    if (/trust (?:this|the) (?:folder|workspace|directory)|trust the files/iu.test(text))
      return {
        events: withStateChannel(
          [
            {
              kind: 'needs_user',
              need: 'permission',
              summary: 'Approve the workspace in Antigravity',
            },
          ],
          'classifier',
        ),
        interactionVisible: true,
      }
    if (
      /Choose your color scheme|Terms of Service & Data Use|No authentication methods available/u.test(
        text,
      )
    )
      return {
        events: withStateChannel(
          [
            {
              kind: 'needs_user',
              need: 'question',
              summary: 'Finish Antigravity setup in the terminal',
              subjectless: true,
            },
          ],
          'classifier',
        ),
        interactionVisible: true,
      }
    return { events: [] }
  },
}

/** Bind through the session's own hook, never by choosing the newest sibling
 * in the same working directory. Late bookkeeping after Stop stays inert. */
export const observeAntigravity: HarnessObserver = (input, host) => {
  let stopped = false
  let bound = input.resumeValue
  let completed = false
  async function bind(id: string) {
    const path = transcriptPath(input.account.roots.state, id)
    if (!path || stopped) return
    host.onResumeValue(id)
    for (const candidate of [path, path.replace('transcript_full.jsonl', 'transcript.jsonl')]) {
      try {
        await access(candidate)
        if (!stopped) host.tailFile(candidate)
        return
      } catch {
        /* Wait for the first native log or try the short log. */
      }
    }
  }
  if (bound) void bind(bound)
  return {
    stop() {
      stopped = true
    },
    onHookPayload(raw) {
      if (stopped || !isRecord(raw)) return true
      const id = stringField(raw, 'conversationId')
      if (!id || !CONVERSATION_ID.test(id) || (bound && id !== bound)) return true
      bound = id
      if (raw.hookEventName === 'PreInvocation') completed = false
      if (completed && raw.hookEventName !== 'Stop') return true
      if (raw.hookEventName === 'Stop' && raw.fullyIdle === true && raw.continuationActive !== true)
        completed = true
      void bind(id)
      const model = stringField(raw, 'modelName')
      if (model) host.onModel?.(model, /-(low|medium|high|xhigh|max)$/u.exec(model)?.[1])
      host.onStateEvents(withStateChannel(antigravityHookEvents(raw), 'hook'))
      return true
    },
  }
}
