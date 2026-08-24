# Visual harness

Renders the orchestration views (workflow card, ultra swarm card, live panel)
against fixtures shaped exactly like the Go CLI's ACP output, then screenshots
them offscreen. Reviewing these views by reading the code does not work — what
matters is what they look like when twenty rows land at once — and reaching
the interesting states in the real app needs a provider and a ten-minute run.

```sh
npm run visual          # build the harness and shoot dark + light
```

Screenshots land in `.visual-shots/`. Both are gitignored; neither is bundled
by electron-builder, which packages `out/` only.

Add a state you care about to `fixtures.ts` — especially an awkward one. The
fixtures already cover the case that actually bit us: a finished workflow whose
`argsJSON` the CLI overwrote with its finish payload, leaving the phase tree
recoverable only from the rendered text.
