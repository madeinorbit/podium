# Mission count vocabulary

The screenshot of POD-789 showed four numbers that looked like they should agree:

| Surface | Said | Actually counted |
| --- | --- | --- |
| Sidebar | `2 agents working` | Present sessions on this issue, including parked |
| Gauge | `3 TO GO` | Member issues not started, including proposed |
| Chip | `3 live` | Present sessions in the subtree, including parked |
| Spine | `13:03` | One session actually computing |

Same mission, three units, one word (`live` / `working` / `to go`) wearing the others' clothes.

## After

One story, three nouns that cannot be confused:

- **Tasks** (the bar): accepted work only. Proposed discoveries stay in the Proposed section. A parent that is itself being worked, with only proposed children, reads `1 running` — not `3 to go`.
- **Agents computing** (the chip, while someone is): `1 working`. Never `live`. Parked sessions are present; they are not live.
- **Agents present** (the chip, when nobody is computing; the fleet stack): `N agents`. Same word the stack already uses.

On that screenshot the four callouts become:

| Surface | Reads |
| --- | --- |
| Sidebar | `working · 13:04` |
| Gauge | `1 running` |
| Chip | `1 working` |
| Spine | `13:03` |

The fleet stack still shows `2` for presence (one working, one parked). That number no longer also claims they are both working.
