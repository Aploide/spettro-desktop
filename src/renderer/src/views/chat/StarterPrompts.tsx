// A few plain-language ways to start, shown where a session has no messages
// yet (the new-session view and an empty chat). A chip only fills the
// composer — the user still reads, edits and sends — so it can't start work
// nobody meant to start.

import { useEffect, useState } from 'react'
import { call } from '@renderer/state/store'

export const STARTER_PROMPTS: { label: string; prompt: string }[] = [
  { label: 'Explain this project', prompt: 'Explain this project in simple terms' },
  { label: 'Fix a bug', prompt: 'Help me find and fix a bug: ' },
  { label: 'Add a feature', prompt: 'Help me add a new feature: ' },
  { label: 'Write tests', prompt: 'Write tests for the most important code that has none' }
]

/** For a start with no project yet (working in the home folder, or in a
 *  folder with nothing in it, like one "New project…" just made): the
 *  prompts above all assume there is code to explain, fix or test. */
export const FRESH_START_PROMPTS: { label: string; prompt: string }[] = [
  { label: 'Build a simple website', prompt: 'Build me a simple website for ' },
  { label: 'Make a small app', prompt: 'Make a small app that ' },
  { label: 'Automate a chore', prompt: 'Write a script that ' },
  { label: 'Explain a file', prompt: 'Explain this file in simple terms: ' }
]

/** Whether `path` holds no files yet. False until the answer comes (and
 *  when there is none), and never asked for a folder `skip` says is no
 *  project anyway: listing a home folder walks it. */
export function useEmptyFolder(path: string, skip = false): boolean {
  const [empty, setEmpty] = useState<{ path: string; empty: boolean } | null>(null)
  useEffect(() => {
    if (skip || path === '') return
    let live = true
    void call('listProjectFiles', path).then((files) => {
      if (live && files) setEmpty({ path, empty: files.length === 0 })
    })
    return () => {
      live = false
    }
  }, [path, skip])
  return !skip && empty?.path === path && empty.empty
}

export default function StarterPrompts({
  onPrompt,
  fresh = false
}: {
  onPrompt: (prompt: string) => void
  /** No project yet: ways to start something new. */
  fresh?: boolean
}): JSX.Element {
  return (
    <div className="starter-prompts" role="group" aria-label="Ways to start">
      {(fresh ? FRESH_START_PROMPTS : STARTER_PROMPTS).map((p) => (
        <button key={p.label} type="button" className="starter-prompt" onClick={() => onPrompt(p.prompt)}>
          {p.label}
        </button>
      ))}
    </div>
  )
}
