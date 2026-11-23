import { asSessionId } from '@podium/model'
import { observable, runInAction } from 'mobx'
import type { UiState } from '../../../packages/client-core/src/replica/contract'
import {
  createNotificationSounds,
  type SessionPhaseChange,
} from '../../../packages/client-core/src/sound/notification-sounds'

const data = {
  constructors: [] as Array<Record<string, unknown>>,
  resumes: [] as Array<Record<string, unknown>>,
  inputs: [] as Array<Record<string, unknown>>,
  paints: [] as Array<Record<string, unknown>>,
  oscillatorStarts: 0,
  started: false,
}
let activeEvent: string | null = null
const contexts: AudioContext[] = []
const probeId = new URL(location.href).searchParams.get('probe') ?? ''
export interface AudioSnapshot {
  data: typeof data
  states: Array<{ state: string; time: number }>
  activation?: boolean
  visibility: string
}
// Driver evaluate() can grant user activation. Send observations from the page
// itself so the first gesture and later notification really exercise autoplay.
function publish(stage: string) {
  const snapshot: AudioSnapshot = {
    data,
    states: contexts.map((context) => ({ state: context.state, time: context.currentTime })),
    activation: navigator.userActivation?.hasBeenActive,
    visibility: document.visibilityState,
  }
  void fetch(`/telemetry?probe=${encodeURIComponent(probeId)}`, {
    method: 'POST',
    body: JSON.stringify({ stage, snapshot }),
  }).catch(() => {})
}
const NativeContext = window.AudioContext ?? Reflect.get(window, 'webkitAudioContext')
const InstrumentedContext = new Proxy(NativeContext, {
  construct(target, args) {
    const start = performance.now()
    const context = Reflect.construct(target, args) as AudioContext
    data.constructors.push({
      start,
      duration: performance.now() - start,
      event: activeEvent,
      state: context.state,
    })
    contexts.push(context)
    const resume = context.resume.bind(context)
    context.resume = () => {
      const record = {
        start: performance.now(),
        duration: 0,
        event: activeEvent,
        before: context.state,
        after: '',
        rejected: false,
      }
      data.resumes.push(record)
      const promise = resume()
      record.duration = performance.now() - record.start
      void promise.then(
        () => {
          record.after = context.state
        },
        () => {
          record.rejected = true
        },
      )
      return promise
    }
    const createOscillator = context.createOscillator.bind(context)
    context.createOscillator = () => {
      const oscillator = createOscillator()
      const start = oscillator.start.bind(oscillator)
      oscillator.start = (...params) => {
        data.oscillatorStarts++
        return start(...params)
      }
      return oscillator
    }
    return context
  },
})
window.AudioContext = InstrumentedContext
if (Reflect.get(window, 'webkitAudioContext'))
  Reflect.set(window, 'webkitAudioContext', InstrumentedContext)

const button = document.querySelector('button')
if (!button) throw new Error('Missing probe button')
button.focus()
let clicks = 0
for (const name of ['pointerdown', 'keydown', 'click']) {
  window.addEventListener(
    name,
    () => {
      activeEvent = name
      data.inputs.push({ event: name, start: performance.now(), duration: 0 })
    },
    { capture: true },
  )
}
button.addEventListener('click', () => {
  button.textContent = `Changed ${++clicks}`
  button.style.backgroundColor = clicks % 2 ? '#f7ce64' : '#b8def8'
  const input = data.inputs.find((item) => item.event === 'pointerdown' || item.event === 'keydown')
  if (!input) throw new Error('Click did not follow pointer or keyboard input')
  const committed = performance.now()
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      data.paints.push({ click: clicks, committed, input: input.start, time: performance.now() })
      publish('first')
    }),
  )
})

const phases = observable.box<readonly SessionPhaseChange[]>([], { deep: false })
const settings = new Map<string, string>()
const sounder = createNotificationSounds({
  phases: () => phases.get(),
  ui: {
    get: (key: string) => settings.get(key) ?? null,
    set: (key: string, value: string | null) => {
      if (value === null) settings.delete(key)
      else settings.set(key, value)
    },
  } as UiState,
  visibleSessionIds: () => [],
  windowFocused: () => false,
})
sounder.start()
for (const name of ['pointerdown', 'keydown', 'click']) {
  window.addEventListener(name, () => {
    const input = data.inputs.at(-1)
    if (!input) throw new Error('Input capture listener did not run')
    input.duration = performance.now() - (input.start as number)
    activeEvent = null
  })
}
Reflect.set(window, '__audioProbe', data)
Reflect.set(window, '__audioStates', () =>
  contexts.map((context) => ({ state: context.state, time: context.currentTime })),
)
Reflect.set(window, '__emitNotification', () => {
  const base = { agentKind: 'codex' as const, headless: false, archived: false }
  const state = { since: '2026-11-23T00:00:00.000Z', nativeSubagentCount: 0 }
  runInAction(() =>
    phases.set([
      {
        sessionId: asSessionId('probe-session'),
        previous: { ...base, agentState: { ...state, phase: 'working' } },
        current: { ...base, agentState: { ...state, phase: 'idle', idle: { kind: 'done' } } },
      },
    ]),
  )
})
data.started = true
setTimeout(() => publish('before'), 400)
const commands = setInterval(async () => {
  const response = await fetch(`/command?probe=${encodeURIComponent(probeId)}`)
  if ((await response.text()) !== 'notify') return
  clearInterval(commands)
  Reflect.get(window, '__emitNotification')()
  setTimeout(() => publish('later'), 200)
}, 50)
