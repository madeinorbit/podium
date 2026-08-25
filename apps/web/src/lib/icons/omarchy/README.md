# Omarchy marks

The seven SVG sources the `Podium on Omarchy` design supplies, verbatim from the
Claude Design project (`2d7a6747-67a5-490a-b7ad-4605095ba985`).

They are the same outlines the Podium appearance draws from
`../AgentIcons.tsx` and `../podium-logo.svg`, recoloured to the profile's Tokyo
Night ink. That is the point of shipping them as assets rather than re-tinting
the inline marks: the design names six mark STATES, each with one fill, and the
files carry those fills. Rendering them as images is what makes an Omarchy
screenshot match the artboard without a colour being chosen anywhere in code.

| file | fill | means |
| --- | --- | --- |
| `om-claude.svg` | `#d97757` | Claude Code — brand clay, the one mark that keeps its own colour |
| `om-openai-mid.svg` | `#a9b1d6` | Codex, named in a header |
| `om-openai-dim.svg` | `#737aa2` | Codex, in a list row |
| `om-openai-amber.svg` | `#e0af68` | Codex, on a row that is asking something of you |
| `om-grok-dim.svg` | `#737aa2` | Grok, in a list row |
| `om-grok-amber.svg` | `#e0af68` | Grok, on a row that is asking something of you |
| `om-wordmark.svg` | `#c0caf5` | the Podium wordmark in the command bar |

Harnesses the design does not draw (Cursor, OpenCode, shell) keep the inline
marks and take their tone from the profile's tokens — inventing a recolour for a
mark the design never supplied would be the substitution this folder exists to
avoid.
