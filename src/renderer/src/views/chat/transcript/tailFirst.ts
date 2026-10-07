// A long chat, opened, is drawn from its end.
//
// Opening a chat of hundreds of rows built every one of them — elements,
// parsed markdown, diffs — in the task that answered the click, though the
// reader sees only the last screenful (rows out of sight are not even laid
// out: chat.css). That was a 75–100 ms task before the chat could appear.
// Now the last rows are drawn at once, and the rows above them after that
// first frame, a batch a task, each landing above the ones before; the
// column keeps the tail pinned meanwhile. (Not a transition: a chat that is
// streaming re-renders every frame, and each of those would restart it.)

import { useEffect, useState } from 'react'

/** Rows drawn in the frame that opens a chat: more than a tall window shows. */
export const TAIL_FIRST = 40
/** Rows added above per task after that: each a frame or two of work. */
export const BATCH = 160
/** Below this, the whole chat is drawn at once: holding back a handful of
 *  rows saves nothing worth a second pass. */
const DEFER_ABOVE = 60

/** Under React's act() (the tests) everything is drawn at once, as act
 *  renders what it was given before it returns (store.ts does the same). */
function inAct(): boolean {
  return (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT === true
}

/**
 * How many of `count` rows, from the top, to leave out for now: on the first
 * render that has rows, all but the last TAIL_FIRST of a long chat; zero from
 * the frame after. Call it from a component mounted per chat (ChatView is
 * keyed by chat), so a chat is drawn tail-first once, when it opens.
 */
export function useTailFirst(count: number): number {
  const [cut, setCut] = useState<number | null>(null)
  let held = cut ?? 0
  if (cut === null && count > 0) {
    held = count > DEFER_ABOVE && !inAct() && typeof requestAnimationFrame === 'function' ? count - TAIL_FIRST : 0
    // Decided once, while rendering: React renders again at once with it.
    setCut(held)
  }
  useEffect(() => {
    if (!cut) return
    // Once the frame that shows what is drawn so far has been painted: a
    // task queued from its animation frame runs after the paint.
    let timer: ReturnType<typeof setTimeout> | undefined
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => setCut((c) => Math.max(0, (c ?? 0) - BATCH)))
    })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [cut])
  return held
}
