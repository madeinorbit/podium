/**
 * BACKEND RAIL HARNESS (POD-1677). Not shipped, not part of the app.
 *
 * The Superagent composer, before and after the model/effort chips move off
 * their own band under the capsule and into the control row. Drawn at the
 * phone width the chips have to survive, across the labels that are actually
 * wide — "Codex · GPT-5.6-Terra" plus an effort word is the case the brief
 * flagged. Run it with `npx vite --config vite.harness.config.ts` from
 * apps/mobile, then `node harness/backend-rail-shoot.mjs`.
 */
import { createRoot } from 'react-dom/client'
import { StyleSheet, Text, View } from 'react-native'
import { Composer } from '../src/components/Composer'
import { SuperagentBackendRail } from '../src/components/SuperagentBackendRail'
import type { SuperagentBackend } from '../src/lib/superagent-backend'
import { color, font, sans, space } from '../src/theme/theme'
import { BelowComposer } from './BelowComposer'
import { BelowRail } from './BelowRail'

/** A phone the app actually ships to: iPhone 13/14/15 logical width. */
const PHONE = 390
/** The narrow end of the range — iPhone SE / mini. */
const SMALL = 320

const noop = () => {}

/**
 * The rail's states in order of how much width they ask for: quiet Auto, a
 * short Claude pick, and the two Codex labels the brief called out. Cursor is
 * the longest label in the catalog but draws no effort chip, so it stresses
 * the model chip alone.
 */
const CASES: { label: string; backend: SuperagentBackend }[] = [
  {
    label: 'Auto — nothing picked',
    backend: { agentKind: undefined, model: 'auto', effort: 'auto' },
  },
  {
    label: 'Claude Code · Opus · High',
    backend: { agentKind: 'claude-code', model: 'opus', effort: 'high' },
  },
  {
    label: 'Codex · GPT-5.6-Luna · Max — the case the brief flagged',
    backend: { agentKind: 'codex', model: 'gpt-5.6-luna', effort: 'max' },
  },
  {
    label: 'Codex · GPT-5.6-Terra · Ultra — the widest pair in the catalog',
    backend: { agentKind: 'codex', model: 'gpt-5.6-terra', effort: 'ultra' },
  },
  {
    label: 'Cursor · Claude Opus 4.8 Thinking — longest label, no effort chip',
    backend: { agentKind: 'cursor', model: 'claude-opus-4-8-thinking-high', effort: 'auto' },
  },
]

function Frame({
  title,
  width,
  children,
}: {
  title: string
  width: number
  children: React.ReactNode
}) {
  return (
    <View style={styles.frame}>
      <Text style={styles.frameLabel}>{title}</Text>
      <View style={[styles.phone, { width }]}>{children}</View>
    </View>
  )
}

function Pair({
  label,
  backend,
  width,
}: {
  label: string
  backend: SuperagentBackend
  width: number
}) {
  return (
    <View style={styles.pair}>
      <Text style={styles.caseLabel}>{label}</Text>
      <View style={styles.row}>
        <Frame title="before — rail under the capsule" width={width}>
          <BelowComposer
            placeholder="Delegate a task…"
            onSend={noop}
            below={<BelowRail backend={backend} onModelChange={noop} onEffortChange={noop} />}
          />
        </Frame>
        <Frame title="after — rail in the control row" width={width}>
          <Composer
            placeholder="Delegate a task…"
            onSend={noop}
            leading={
              <SuperagentBackendRail backend={backend} onModelChange={noop} onEffortChange={noop} />
            }
          />
        </Frame>
      </View>
    </View>
  )
}

function Harness() {
  return (
    <View style={styles.page}>
      <Text style={styles.heading}>Superagent composer — model rail below vs in the row</Text>
      <Text style={styles.sub}>iPhone 13/14/15 width (390)</Text>
      {CASES.map((one) => (
        <Pair key={one.label} label={one.label} backend={one.backend} width={PHONE} />
      ))}
      <Text style={styles.sub}>iPhone SE / mini width (320)</Text>
      {CASES.slice(2).map((one) => (
        <Pair key={`sm-${one.label}`} label={one.label} backend={one.backend} width={SMALL} />
      ))}
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
  sub: {
    ...sans(600),
    color: color.label,
    fontSize: font.micro,
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
    backgroundColor: color.engraved,
    borderRadius: 12,
    paddingVertical: space.md,
  },
})

const host = document.getElementById('root')
if (!host) throw new Error('no #root')
createRoot(host).render(<Harness />)
