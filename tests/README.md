# Tests

```sh
npm test          # once
npm run test:watch
npm run typecheck # includes the tests themselves (tsconfig.test.json)
```

Vitest, because the app is already a Vite build: the suite reuses the same
`@shared` / `@renderer` aliases the app resolves with, so a test imports a
module exactly the way the app does. `@main` is a test-only alias — the main
process uses relative imports, but tests cross the process boundary often
enough that spelling `../../src/main/...` obscured what was under test.

Most tests run in Node. Pure code has no business paying for a DOM, and the
majority of what is worth testing here is pure. The few that assert on
behaviour a user can perform opt in with `// @vitest-environment jsdom` at the
top of the file.

## What is tested, and why that and not other things

This codebase has an unusually good visual regression story — `tools/visual`
renders the orchestration views offscreen and screenshots them, in both colour
schemes — so the tests deliberately do **not** re-check appearance. They cover
the things a screenshot renders perfectly while being wrong:

| File | What it protects |
| --- | --- |
| `orchestration.test.ts` | `groupTranscript`, the most intricate pure function in the app. A member attached to the wrong run still draws beautifully. |
| `toolPresentation.test.ts` | String surgery against title/args formats defined in another language in another repo, which rots quietly. |
| `extensions.test.ts` | The `_spettro/*` decoders — specifically where their deliberate leniency stops. |
| `chatSession.test.ts` | Transcript upsert semantics, including the `argsJSON` overwrite that the whole text-recovery path exists to survive. |
| `setConfigValue.test.ts` | Telling an agent's refusal from a dead pipe. Getting it wrong is invisible until you look closely. |
| `configBar.test.tsx` | That the Ultra chip *does nothing* when locked — a screenshot only shows that it looks locked. |
| `workflowStudio.test.tsx` | That Run saves first, refuses to run a broken script, and that an old CLI says so instead of showing an empty project. |

## `wire.ts`

The fixture builders are not conveniences — they are the specification the
tests are written against, so each one records which Go file its shape comes
from. A wrong builder makes every test using it agree with the wrong thing.
That is not hypothetical: the hand-written visual fixtures encoded a misreading
of the CLI twice before a recording caught it, which is why
`tools/visual/capture-live.cjs` records real sessions and
`tools/probe-workflow-ext.cjs` drives a real binary. Those are the check on
these; these are not a substitute for them.

## Adding one

Assert on the promise, not the implementation. The Ultra chip is the worked
example: it uses `aria-disabled` rather than `disabled` because a disabled
button in Chromium swallows the pointer events its own tooltip needs — so the
test asserts the click does not fire and the reason is readable, not that a
particular attribute is set. A test that pins the mechanism blocks the fix.
