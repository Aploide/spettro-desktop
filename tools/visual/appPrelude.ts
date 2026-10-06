// Runs before anything else on the app harness page — it is AppHarness's
// first import, and ES modules evaluate in import order — because the
// renderer reads its window layout (sidebar width and collapse, terminal
// drawer) from localStorage the moment state/shell.ts loads.
//
// The capture runs every scene in the same Electron profile, so storage
// persists between scenes: a scene that collapsed the sidebar would collapse
// it in every scene after. Each page load therefore starts from the defaults
// and applies only what its own mode asks for.

const mode = new URLSearchParams(location.search).get('mode') ?? 'welcome'

localStorage.setItem('spettro.sidebarCollapsed', mode === 'collapsed' ? '1' : '0')
localStorage.removeItem('spettro.sidebarWidth')
localStorage.setItem('spettro.terminalDrawerVisible', '0')
// Unsent drafts are kept per chat (state/drafts.ts); one scene's typing must not
// show up in the next scene's composer.
for (const key of Object.keys(localStorage)) {
  if (key.startsWith('spettro.draft.')) localStorage.removeItem(key)
}

export {}
