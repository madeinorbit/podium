/**
 * COMPOSER HARNESS (POD-1659). Not shipped, not part of the app.
 *
 * Draws the pre-change composer beside the stacked one at real phone widths,
 * in the states that made the old layout look wrong: the long resume
 * placeholder, a typed line, and a grown multi-line prompt. Run it with
 * `npx vite --config vite.harness.config.ts` from apps/mobile, then
 * `node harness/composer-shoot.mjs`.
 */
import { createRoot } from 'react-dom/client'
import { StyleSheet, Text, View } from 'react-native'
import { Composer } from '../src/components/Composer'
import { color, font, sans, space } from '../src/theme/theme'
import { OldComposer } from './OldComposer'

/** The placeholder the screenshot was taken with, plus the two shorter ones. */
const CASES = [
  { label: 'session — resume', placeholder: 'Message — resumes the agent…' },
  { label: 'session — live', placeholder: 'Message the agent…' },
  { label: 'superagent', placeholder: 'Delegate a task…' },
]

/** A phone the app actually ships to: iPhone 13/14/15 logical width. */
const PHONE = 390

const noop = () => {}

/** A prompt long enough to push the field several lines up off the rail. */
const LONG =
  'Rebase onto main first — the composer height commit landed after this branch ' +
  'point, so the spring is gone and the wrapper takes a plain height now.'

/** Enough of the attachments API to draw the paperclip. */
const attachments = {
  attachments: [],
  uploading: false,
  accept: noop,
  pick: noop,
  paste: undefined,
  remove: noop,
  ready: () => [],
  clear: noop,
} as never

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.frame}>
      <Text style={styles.frameLabel}>{title}</Text>
      <View style={styles.phone}>{children}</View>
    </View>
  )
}

function Harness() {
  return (
    <View style={styles.page}>
      <Text style={styles.heading}>Composer — flanked (before) vs stacked (after)</Text>
      {CASES.map((one) => (
        <View key={one.label} style={styles.pair}>
          <Text style={styles.caseLabel}>{one.label}</Text>
          <View style={styles.row}>
            <Frame title="before">
              <OldComposer placeholder={one.placeholder} onSend={noop} attachments={attachments} />
            </Frame>
            <Frame title="after">
              <Composer placeholder={one.placeholder} onSend={noop} attachments={attachments} />
            </Frame>
          </View>
        </View>
      ))}
      <View style={styles.pair}>
        <Text style={styles.caseLabel}>with an activity caption</Text>
        <View style={styles.row}>
          <Frame title="before">
            <OldComposer
              placeholder="Message — resumes the agent…"
              onSend={noop}
              caption="Editing Composer.tsx"
              attachments={attachments}
            />
          </Frame>
          <Frame title="after">
            <Composer
              placeholder="Message — resumes the agent…"
              onSend={noop}
              caption="Editing Composer.tsx"
              attachments={attachments}
            />
          </Frame>
        </View>
      </View>
      <View style={styles.pair}>
        <Text style={styles.caseLabel}>
          typed — the send disc fills, and the row does not move
        </Text>
        <View style={styles.row}>
          <Frame title="before">
            <OldComposer
              placeholder="Message the agent…"
              onSend={noop}
              draftInsertion={{ id: 1, text: 'Rebase onto main and re-run the lane' }}
              attachments={attachments}
            />
          </Frame>
          <Frame title="after">
            <Composer
              placeholder="Message the agent…"
              onSend={noop}
              draftInsertion={{ id: 1, text: 'Rebase onto main and re-run the lane' }}
              attachments={attachments}
            />
          </Frame>
        </View>
      </View>
      <View style={styles.pair}>
        <Text style={styles.caseLabel}>grown — a prompt of a few lines</Text>
        <View style={styles.row}>
          <Frame title="before">
            <OldComposer
              placeholder="Message the agent…"
              onSend={noop}
              draftInsertion={{ id: 2, text: LONG }}
              attachments={attachments}
            />
          </Frame>
          <Frame title="after">
            <Composer
              placeholder="Message the agent…"
              onSend={noop}
              draftInsertion={{ id: 2, text: LONG }}
              attachments={attachments}
            />
          </Frame>
        </View>
      </View>
      <View style={styles.pair}>
        <Text style={styles.caseLabel}>words only — no attach control</Text>
        <View style={styles.row}>
          <Frame title="before">
            <OldComposer placeholder="Comment on this task…" onSend={noop} />
          </Frame>
          <Frame title="after">
            <Composer placeholder="Comment on this task…" onSend={noop} />
          </Frame>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  page: {
    backgroundColor: color.bg,
    padding: space.xl,
    gap: space.xl,
    minHeight: '100%',
  },
  heading: {
    ...sans(700),
    color: color.text,
    fontSize: font.heading,
  },
  pair: { gap: space.sm },
  caseLabel: {
    ...sans(600),
    color: color.textDim,
    fontSize: font.tiny,
  },
  row: { flexDirection: 'row', gap: space.xl },
  frame: { gap: space.xs },
  frameLabel: {
    ...sans(500),
    color: color.textMicro,
    fontSize: font.micro,
  },
  phone: {
    width: PHONE,
    backgroundColor: color.engraved,
    borderRadius: 12,
    paddingVertical: space.md,
  },
})

const host = document.getElementById('root')
if (!host) throw new Error('no #root')
createRoot(host).render(<Harness />)
