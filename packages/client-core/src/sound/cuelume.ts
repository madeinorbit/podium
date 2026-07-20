/**
 * Vendored from cuelume 0.1.2 (https://www.npmjs.com/package/cuelume, MIT,
 * (c) Daniel White) — the audio engine + the recipe palette, minus the DOM
 * `bind()` layer we don't use. Sounds are synthesized live on one shared
 * `AudioContext`; there are no audio files.
 *
 * Local changes from upstream:
 *  - dropped the `navigator.userActivation` bail-out: notification cues fire
 *    while the window is unfocused, where that check is falsely conservative.
 *    Gesture policy is handled by `prewarmAudio()` instead (see below).
 *  - added `prewarmAudio()`: WKWebView (the Tauri macOS shell) creates
 *    AudioContexts suspended until a user gesture, so the engine calls this
 *    from a real pointerdown/keydown to unlock playback for the whole page
 *    lifetime.
 */

interface ToneLayer {
  kind: 'tone'
  waveform: OscillatorType
  frequency: number
  detune?: number
  glideTo?: number
  glideTime?: number
  offset?: number
  attack: number
  decay: number
  peak: number
}

interface NoiseLayer {
  kind: 'noise'
  filterType: BiquadFilterType
  filterFrequency: number
  filterQ?: number
  offset?: number
  attack: number
  decay: number
  peak: number
}

type Layer = ToneLayer | NoiseLayer

interface Shimmer {
  delay: number
  feedback: number
  wet: number
  lowpass: number
}

interface Recipe {
  masterGain: number
  layers: Layer[]
  shimmer?: Shimmer
}

const SOURCE_STOP_PADDING = 0.05
const CLEANUP_MARGIN = 0.05
const INAUDIBLE_GAIN = 0.001

/** The cues Podium actually uses. Upstream ships fourteen; the interaction
 *  clicks/ticks are out of scope for notification sounds, so only the four
 *  notification-shaped recipes are vendored. */
export const RECIPES = {
  /** A soft two-note ascending bell — the agent asked you a question. */
  chime: {
    masterGain: 0.5,
    layers: [
      { kind: 'tone', waveform: 'sine', frequency: 1046.5, attack: 0.006, decay: 0.22, peak: 0.09 },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 1568,
        offset: 0.09,
        attack: 0.006,
        decay: 0.26,
        peak: 0.08,
      },
    ],
    shimmer: { delay: 0.12, feedback: 0.25, wet: 0.18, lowpass: 4000 },
  },
  /** A single note gliding downward like a water drop — approval wanted. */
  droplet: {
    masterGain: 0.55,
    layers: [
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 1200,
        glideTo: 550,
        glideTime: 0.14,
        attack: 0.004,
        decay: 0.2,
        peak: 0.075,
      },
    ],
    shimmer: { delay: 0.09, feedback: 0.2, wet: 0.15, lowpass: 3000 },
  },
  /** A short, warm three-note ascending confirmation — "done", not a fanfare. */
  success: {
    masterGain: 0.5,
    layers: [
      { kind: 'tone', waveform: 'sine', frequency: 880, attack: 0.004, decay: 0.09, peak: 0.06 },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 1108.73,
        offset: 0.06,
        attack: 0.004,
        decay: 0.1,
        peak: 0.06,
      },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 1318.51,
        offset: 0.12,
        attack: 0.004,
        decay: 0.18,
        peak: 0.07,
      },
    ],
    shimmer: { delay: 0.1, feedback: 0.22, wet: 0.16, lowpass: 4500 },
  },
  /** A muted knock followed by two descending tones — a calm, recoverable refusal. */
  error: {
    masterGain: 0.42,
    layers: [
      {
        kind: 'noise',
        filterType: 'bandpass',
        filterFrequency: 850,
        filterQ: 1.1,
        attack: 0.001,
        decay: 0.035,
        peak: 0.13,
      },
      {
        kind: 'tone',
        waveform: 'triangle',
        frequency: 440,
        offset: 0.025,
        attack: 0.004,
        decay: 0.09,
        peak: 0.045,
      },
      {
        kind: 'tone',
        waveform: 'triangle',
        frequency: 349.23,
        offset: 0.1,
        attack: 0.004,
        decay: 0.14,
        peak: 0.04,
      },
    ],
  },
} as const satisfies Record<string, Recipe>

export type SoundName = keyof typeof RECIPES

function renderTone(
  context: AudioContext,
  destination: AudioNode,
  layer: ToneLayer,
  startTime: number,
): void {
  const oscillator = context.createOscillator()
  oscillator.type = layer.waveform
  oscillator.frequency.setValueAtTime(layer.frequency, startTime)
  if (layer.detune) oscillator.detune.value = layer.detune
  if (layer.glideTo !== undefined) {
    const glideTime = layer.glideTime ?? layer.attack + layer.decay
    oscillator.frequency.exponentialRampToValueAtTime(layer.glideTo, startTime + glideTime)
  }
  const gain = context.createGain()
  gain.gain.setValueAtTime(0.0001, startTime)
  gain.gain.exponentialRampToValueAtTime(layer.peak, startTime + layer.attack)
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + layer.attack + layer.decay)
  oscillator.connect(gain).connect(destination)
  oscillator.start(startTime)
  oscillator.stop(startTime + layer.attack + layer.decay + SOURCE_STOP_PADDING)
}

function renderNoise(
  context: AudioContext,
  destination: AudioNode,
  layer: NoiseLayer,
  startTime: number,
): void {
  const duration = layer.attack + layer.decay + SOURCE_STOP_PADDING
  const length = Math.max(1, Math.floor(duration * context.sampleRate))
  const buffer = context.createBuffer(1, length, context.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i++) data[i] = 2 * Math.random() - 1
  const source = context.createBufferSource()
  source.buffer = buffer
  const filter = context.createBiquadFilter()
  filter.type = layer.filterType
  filter.frequency.value = layer.filterFrequency
  if (layer.filterQ !== undefined) filter.Q.value = layer.filterQ
  const gain = context.createGain()
  gain.gain.setValueAtTime(0.0001, startTime)
  gain.gain.exponentialRampToValueAtTime(layer.peak, startTime + layer.attack)
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + layer.attack + layer.decay)
  source.connect(filter).connect(gain).connect(destination)
  source.start(startTime)
  source.stop(startTime + duration)
}

function attachShimmer(
  context: AudioContext,
  source: AudioNode,
  destination: AudioNode,
  shimmer: Shimmer,
): AudioNode[] {
  const delay = context.createDelay(1)
  delay.delayTime.value = shimmer.delay
  const feedbackFilter = context.createBiquadFilter()
  feedbackFilter.type = 'lowpass'
  feedbackFilter.frequency.value = shimmer.lowpass
  const feedbackGain = context.createGain()
  feedbackGain.gain.value = shimmer.feedback
  const wetGain = context.createGain()
  wetGain.gain.value = shimmer.wet
  source.connect(delay)
  delay.connect(feedbackFilter)
  feedbackFilter.connect(feedbackGain)
  feedbackGain.connect(delay)
  feedbackFilter.connect(wetGain)
  wetGain.connect(destination)
  return [delay, feedbackFilter, feedbackGain, wetGain]
}

function sourceEnd(recipe: Recipe): number {
  return Math.max(
    ...recipe.layers.map(
      (layer) => (layer.offset ?? 0) + layer.attack + layer.decay + SOURCE_STOP_PADDING,
    ),
  )
}

function shimmerTail(shimmer: Shimmer | undefined): number {
  if (!shimmer || shimmer.feedback <= 0) return 0
  if (shimmer.feedback >= 1) return shimmer.delay
  return shimmer.delay * (1 + Math.ceil(Math.log(INAUDIBLE_GAIN) / Math.log(shimmer.feedback)))
}

function renderRecipe(context: AudioContext, recipe: Recipe): void {
  const now = context.currentTime
  const master = context.createGain()
  master.gain.value = recipe.masterGain
  master.connect(context.destination)
  const shimmerNodes = recipe.shimmer
    ? attachShimmer(context, master, context.destination, recipe.shimmer)
    : []
  for (const layer of recipe.layers) {
    const startTime = now + (layer.offset ?? 0)
    if (layer.kind === 'tone') renderTone(context, master, layer, startTime)
    else renderNoise(context, master, layer, startTime)
  }
  const cleanupAfterMs = (sourceEnd(recipe) + shimmerTail(recipe.shimmer) + CLEANUP_MARGIN) * 1000
  setTimeout(() => {
    master.disconnect()
    for (const node of shimmerNodes) node.disconnect()
  }, cleanupAfterMs)
}

let sharedContext: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (sharedContext) return sharedContext
  if (typeof window === 'undefined') return null
  const Ctor =
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try {
    sharedContext = new Ctor()
  } catch {
    return null
  }
  return sharedContext
}

/**
 * Unlock audio from inside a real user gesture. WKWebView (and Safari) create
 * AudioContexts suspended until a gesture resumes one; once running it stays
 * running, so a single early call makes later background notification cues
 * audible for the rest of the page's life. Safe to call repeatedly.
 */
export function prewarmAudio(): void {
  const context = getAudioContext()
  if (context && context.state !== 'running') {
    context.resume().catch(() => {})
  }
}

/**
 * Plays a cue immediately. Lazily creates the shared `AudioContext`, resumes
 * it if suspended, and is a no-op when Web Audio is unavailable (SSR, tests,
 * old browsers) or the context stays locked (no gesture has happened yet).
 */
export function play(sound: SoundName): void {
  const context = getAudioContext()
  if (!context) return
  const recipe = RECIPES[sound]
  if (context.state === 'running') {
    renderRecipe(context, recipe)
  } else {
    try {
      void context.resume().then(
        () => {
          if (context.state === 'running') renderRecipe(context, recipe)
        },
        () => {},
      )
    } catch {
      // Some browsers throw synchronously when audio is blocked.
    }
  }
}
