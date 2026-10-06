// A few plain-language ways to start, shown where a session has no messages
// yet (the new-session view and an empty chat). A chip only fills the
// composer — the user still reads, edits and sends — so it can't start work
// nobody meant to start.

export const STARTER_PROMPTS: { label: string; prompt: string }[] = [
  { label: 'Explain this project', prompt: 'Explain this project in simple terms' },
  { label: 'Fix a bug', prompt: 'Help me find and fix a bug: ' },
  { label: 'Add a feature', prompt: 'Help me add a new feature: ' },
  { label: 'Write tests', prompt: 'Write tests for the most important code that has none' }
]

/** For a start with no project yet (working in the home folder): the
 *  prompts above all assume there is code to explain, fix or test. */
export const FRESH_START_PROMPTS: { label: string; prompt: string }[] = [
  { label: 'Build a simple website', prompt: 'Build me a simple website for ' },
  { label: 'Make a small app', prompt: 'Make a small app that ' },
  { label: 'Automate a chore', prompt: 'Write a script that ' },
  { label: 'Explain a file', prompt: 'Explain this file in simple terms: ' }
]

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
