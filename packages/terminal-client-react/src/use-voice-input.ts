import { useEffect, useRef, useState } from 'react'

/**
 * Browser speech-to-text via the Web Speech API (webkitSpeechRecognition).
 * Free, no key, works in Chrome/Edge/Safari; silently unsupported in Firefox —
 * callers hide the mic button when `supported` is false. Bridging the client
 * mic into the harness's own native voice input is not realistically possible
 * from a web page (see spec addon §8), so transcribed text lands in the input
 * field instead.
 */
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  onresult: ((event: SpeechResultEventLike) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}
interface SpeechResultEventLike {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

function recognitionCtor(): (new () => SpeechRecognitionLike) | undefined {
  const w = globalThis as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
    | (new () => SpeechRecognitionLike)
    | undefined
}

export interface VoiceInput {
  supported: boolean
  listening: boolean
  toggle: () => void
}

export function useVoiceInput(onText: (text: string) => void): VoiceInput {
  const [listening, setListening] = useState(false)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const onTextRef = useRef(onText)
  onTextRef.current = onText
  const supported = recognitionCtor() !== undefined

  useEffect(() => {
    return () => {
      recRef.current?.stop()
      recRef.current = null
    }
  }, [])

  const toggle = () => {
    if (listening) {
      recRef.current?.stop()
      return
    }
    const Ctor = recognitionCtor()
    if (!Ctor) return
    const rec = new Ctor()
    rec.lang = navigator.language || 'en-US'
    rec.continuous = true
    rec.interimResults = false
    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result?.isFinal) onTextRef.current(result[0].transcript.trim())
      }
    }
    rec.onend = () => {
      setListening(false)
      recRef.current = null
    }
    rec.onerror = () => {
      setListening(false)
      recRef.current = null
    }
    recRef.current = rec
    rec.start()
    setListening(true)
  }

  return { supported, listening, toggle }
}
