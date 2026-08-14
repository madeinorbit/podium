/**
 * THE FEED'S OWN `hello` MEMBERS — declared here, and here is the point (POD-2061).
 *
 * A resuming client presents its position in `hello`, and the thing that HOLDS a
 * position is the replica's sink, not the transport. `boundary.test.ts` states
 * that as a property of `socket-hub.ts`'s source text: the transport may not
 * contain feed-position vocabulary at all, because every time it has, it became
 * the second place ADR 2 D7's ladder lives and the two copies disagreed.
 *
 * So the field is named ONCE, by the side that owns the value, and the hub
 * spreads what it is handed without reading it. This module is that name. It is
 * deliberately a type and nothing else — a helper here that BUILT the fragment
 * would put the decision back on this side of the seam.
 */

import type { HelloMessage } from '@podium/protocol'
import type { z } from 'zod'

/** The `hello` members the feed sink fills in. Narrowed off the parsed message
 *  rather than restated, so this cannot describe a field the wire does not
 *  declare. */
export type FeedHelloFields = Required<Pick<z.infer<typeof HelloMessage>, 'feedCursor'>>
