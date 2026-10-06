// What to ask before stopping work the user started.
//
// Quitting, installing an update and restarting the engine all kill every
// running turn (and a terminal's running command). None of them used to ask.
// busyGuard() decides whether to, and in what words: nothing running means no
// question at all; running chats can be waited for ("Quit when finished"); a
// terminal command can't — `npm run dev` never finishes — so it only earns a
// mention. Pure, and shared: the quit dialog in main and the renderer's update
// and restart alerts read the same sentences.

export type GuardedAction = 'quit' | 'update' | 'restart'

export interface BusyGuard {
  title: string
  message: string
  /** "Quit when finished" — null when there is nothing to wait for that
   *  will ever finish (only terminals), or the action can't wait. */
  whenFinishedLabel: string | null
  nowLabel: string
}

const VERB: Record<GuardedAction, { now: string; later: string | null; stops: string }> = {
  quit: { now: 'Quit now', later: 'Quit when finished', stops: 'Quitting now stops' },
  update: { now: 'Update now', later: 'Update when finished', stops: 'Updating now restarts Spettro, which stops' },
  restart: { now: 'Restart now', later: null, stops: 'Restarting the engine stops' }
}

export function busyGuard(action: GuardedAction, busyTasks: number, runningTerminals = 0): BusyGuard | null {
  const tasks = Math.max(0, Math.floor(busyTasks))
  const terms = action === 'quit' ? Math.max(0, Math.floor(runningTerminals)) : 0
  if (tasks === 0 && terms === 0) return null
  const verb = VERB[action]
  const termNote =
    terms === 0 ? '' : terms === 1 ? 'a command running in the terminal' : `commands running in ${terms} terminals`
  if (tasks === 0) {
    return {
      title: terms === 1 ? 'A terminal is still running a command' : `${terms} terminals are still running commands`,
      message: `${verb.stops} ${terms === 1 ? 'it' : 'them'}.`,
      whenFinishedLabel: null,
      nowLabel: verb.now
    }
  }
  const them = tasks === 1 && terms === 0 ? 'it' : 'them'
  return {
    title: `Spettro is working on ${tasks} ${tasks === 1 ? 'task' : 'tasks'}`,
    message:
      `${verb.stops} ${them}.` +
      (termNote !== '' ? ` There ${terms === 1 ? 'is also' : 'are also'} ${termNote}.` : ''),
    whenFinishedLabel: verb.later,
    nowLabel: verb.now
  }
}
