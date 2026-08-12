# Task detail visual audit

## Verdict

The information architecture is good, especially the document/rail split and the separation of agent activity, task prose, and operational properties. The remaining gap to Linear is mainly visual hierarchy: Podium renders too much of the page in small type, gives ordinary metadata too many repeated homes, and uses hairlines, tinted surfaces, and evenly spaced blocks where Linear uses typography and whitespace.

The result is legible but still reads as an operations console. The target should be a calm document with operational controls available around it.

## Highest-impact changes

### 1. Raise the reading scale

Current source values put the title at 18px, narrative prose at 13px, the dossier at 9.5px, rail labels at 11px, rail values at 12px, and section labels at 8.5px. At the captured desktop size, the page consequently has no comfortably readable middle tier.

Recommended desktop scale:

| Role | Current | Target |
| --- | ---: | ---: |
| Task title | 18px / 1.3 | 22px / 1.25 |
| Narrative body | 13px / relaxed | 14.5px / 1.55–1.6 |
| Authored section heading | mostly 8.5px mono or absent | 14–15px / 600 sans |
| Utility section label | 8.5px mono | 10–10.5px mono |
| Dossier metadata | 9.5px mono | 10.5–11px mono |
| Property value | 12px | 13px |
| Property label | 11px | 11.5–12px |

Use the larger sans heading only for human-authored narrative sections such as Design, Acceptance, and Notes. Keep mono uppercase labels for machine-owned sections such as Sessions, Branch, Artifacts, and Activity. That distinction will create hierarchy without adding decoration.

### 2. Give the document a slower opening rhythm

The main column currently begins with 24px vertical padding. Linear leaves a much larger pause between navigation and the title, which makes the title feel like the start of a document instead of the next row in the shell.

- Increase desktop top padding to 44–48px.
- Increase the text measure from `max-w-3xl` (768px) to roughly 840–880px, while preserving a readable paragraph width inside rich content.
- Use 8–12px inside a section and 32–40px between major sections. The current repeated `mb-7` gives unlike things the same cadence.
- Keep the title, its exception metadata, and the description as one opening group before the first operational block.

### 3. Remove repeated ordinary metadata

Status, priority, and assignee appear beneath the title and again in the properties rail. Live state and git state also appear in both the sticky task header and operational blocks. Repetition makes every region feel busier while adding little scan value.

- Let the rail own ordinary, editable properties: status, priority, assignee, labels.
- Under the title, retain only provenance and recency plus true exceptions: agent-created, internal, stale, pinned, or needs-human.
- Let the sticky header own only transient urgency: needs you and active-agent count. Keep branch name, ahead/behind, and actions in the Branch rail section.
- Do not repeat stage in the title dossier when it is already the first property in the adjacent rail.

This is the closest structural analogue to Linear's calmness: one fact, one home.

### 4. Make the properties rail quieter

The rail has the right content and ordering, but full-width dividers between every band make it read as stacked control panels. Linear groups rail properties primarily with whitespace.

- Increase the rail from 272px to 288–304px when viewport width allows.
- Increase horizontal padding from 14px to 18–20px and property rows from 26px to 30–32px.
- Replace most horizontal separators with 20–24px vertical gaps and a quiet section label. Keep only the rail's left boundary and separators around genuinely actionable regions if needed.
- Bring the rail background closer to the document background; use no more than a subtle 1–2% tonal shift.
- Keep values at normal weight. Use color only for state glyphs and exceptional action states.

## Secondary changes

### 5. Visually demote the Now block without moving it

The Now block is valuable Podium-specific content, but it is currently the strongest object on the page: an inset surface, several bordered rows, multiple colors, a header, and a branch footer. It delays the human-authored task description.

- Keep its placement, but show at most two agent rows before a quiet “N more” disclosure.
- Reduce row height and border contrast; remove per-row tinted backgrounds at rest.
- Reserve amber for a row that actually needs the operator and blue for the active row. Render inactive rows neutrally.
- Remove the branch footer when the same branch is present in the rail.

### 6. Use fewer visual voices

The screenshot simultaneously presents issue tint, blue live state, amber attention, green progress, orange agent marks, blue hairlines, tinted rows, and a yellow merge action. Linear is calmer because most of its page is neutral and color is sparse.

- Limit the document to neutral text plus the issue accent.
- Reserve semantic colors for needs-you, destructive, blocking, and a single primary action.
- Lower non-interactive hairline contrast by roughly one step. Prefer spacing to lines between prose sections.
- Avoid tinted fills for ordinary state. A glyph or 1px accent is enough.

### 7. Make the pinned composer recede until used

The pinned composer is functionally correct, but its full-width border and persistent frame create another horizontal band.

- Use a quieter top boundary and a flatter input at rest.
- Increase contrast and enclosure on focus, not permanently.
- Keep the current pinned behavior.

## What to preserve

- The document plus right-rail layout.
- Inline editing.
- The ordered rail content: properties, sessions, branch, relations, long tail, provenance.
- Collapsed agent brief and long-tail fields.
- Pinned comment composer.
- Issue-specific operational content; the goal is to lower its visual volume, not remove it.

## Recommended implementation sequence

1. Change typography and document spacing only; compare at the same 1976×1232 viewport.
2. Remove duplicated metadata and the duplicate branch footer.
3. Restyle the rail grouping and Now block.
4. Tune border and semantic-color usage across the page.

The first pass should avoid broader shell changes. Most of the perceived improvement can come from `IssuePage.tsx`, `IssueBody.tsx`, the issue-page chrome, and property chrome.

## Runtime review set

Capture these at the same viewport before accepting the change:

- A short ordinary task with no sessions, to verify the page does not feel empty or oversized.
- A busy multi-agent task like the current POD-516 evidence, to verify density and color restraint.
- A long task scrolled into artifacts/activity, to verify section rhythm.
- One narrow desktop width just above the rail breakpoint, to ensure the wider type and rail do not squeeze the document.

