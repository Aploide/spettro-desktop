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

export default function StarterPrompts({ onPrompt }: { onPrompt: (prompt: string) => void }): JSX.Element {
  return (
    <div className="starter-prompts" role="group" aria-label="Ways to start">
      {STARTER_PROMPTS.map((p) => (
        <button key={p.label} type="button" className="starter-prompt" onClick={() => onPrompt(p.prompt)}>
          {p.label}
        </button>
      ))}
    </div>
  )
}
