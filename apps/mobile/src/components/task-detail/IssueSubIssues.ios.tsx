import { HStack, Image, RNHostView, Text, VStack } from '@expo/ui/swift-ui'
import {
  accessibilityElement,
  accessibilityIdentifier,
  accessibilityLabel,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  listRowInsets,
  opacity,
  padding,
} from '@expo/ui/swift-ui/modifiers'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { PageIssue } from '@podium/client-graph/issue-page'
import { issueStatusOf } from '@podium/model'
import { isFinished } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { type ComponentProps, useState } from 'react'
import { useWindowDimensions } from 'react-native'
import { issueObserver as observer } from '../../client/issue-observer'
import { useIssueOpening } from '../../client/issue-opening'
import { color } from '../../theme/theme'
import { listRowPress } from '../list-row-press.ios'
import { StageGlyph } from '../StageGlyph'
import { DetailActionRow, DetailGroup } from './DetailList'
import type { IssueSubIssues as WebSubIssues } from './IssueSubIssues'

type Props = ComponentProps<typeof WebSubIssues>

export const IssueSubIssuesSection = observer(function IssueSubIssuesSection({
  issue,
  subIssues,
  onOpen,
  onAdd,
}: Props) {
  const views = useIssueOpening()
  const [all, setAll] = useState(false)
  const rows = subIssues ?? views?.row(issue.id).children ?? []
  if (typeof rows === 'symbol') throw rows
  if (rows.length === 0) return null
  return (
    <DetailGroup label="Sub-tasks" count={String(rows.length)} testID="issue-subtasks-section">
      {(all ? rows : rows.slice(0, 4)).map((child) => (
        <SubTaskRow key={child.id} child={child} onOpen={onOpen} />
      ))}
      {!all && rows.length > 4 ? (
        <DetailActionRow label={`See all ${rows.length} sub-tasks`} onPress={() => setAll(true)} />
      ) : null}
      {onAdd ? <DetailActionRow label="Add sub-task" onPress={onAdd} /> : null}
    </DetailGroup>
  )
})

/** Native rows have no hosted text or fixed heights. AX5 keeps the whole title. */
const SubTaskRow = observer(function SubTaskRow({
  child,
  onOpen,
}: {
  child: IssueViewModel
  onOpen: (id: string) => void
}) {
  const { fontScale } = useWindowDimensions()
  const title = 'authoredTitle' in child ? (child as PageIssue).authoredTitle : child.title
  return (
    <HStack
      alignment="top"
      spacing={12}
      modifiers={[
        listRowInsets({ leading: 16, trailing: 16, top: 0, bottom: 0 }),
        padding({ vertical: 12 }),
        frame({ minHeight: 44, maxWidth: Infinity, alignment: 'leading' }),
        accessibilityElement('ignore'),
        accessibilityLabel(`${issueDisplayRef(child)} ${title}`),
        accessibilityIdentifier('issue-sub-task'),
        listRowPress(() => onOpen(child.id)),
        opacity(isFinished(child) || child.archived ? 0.7 : 1),
      ]}
    >
      <HStack modifiers={[frame({ width: 20, height: Math.round(20 * Math.max(1, fontScale)) })]}>
        <RNHostView matchContents>
          <StageGlyph stage={issueStatusOf(child)} size={16} ground={color.groupedCard} />
        </RNHostView>
      </HStack>
      <VStack
        alignment="leading"
        spacing={4}
        modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}
      >
        <Text
          modifiers={[
            font({ textStyle: 'body' }),
            foregroundStyle(color.text),
            fixedSize({ horizontal: false, vertical: true }),
            frame({ maxWidth: Infinity, alignment: 'leading' }),
          ]}
        >
          {title}
        </Text>
        <Text
          modifiers={[
            font({ textStyle: 'footnote' }),
            foregroundStyle(color.textDim),
            fixedSize({ horizontal: false, vertical: true }),
          ]}
        >
          {issueDisplayRef(child)}
          {child.archived ? ' · Archived' : ''}
        </Text>
      </VStack>
      {fontScale <= 1.35 ? (
        <Image systemName="chevron.right" size={12} color={color.textFaint} />
      ) : null}
    </HStack>
  )
})

export { IssueSubIssuesSection as IssueSubIssues }
