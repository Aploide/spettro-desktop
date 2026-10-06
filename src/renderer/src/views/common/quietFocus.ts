// Focus that doesn't draw the keyboard ring.
//
// React's `autoFocus` (and a plain `el.focus()`) from script matches
// :focus-visible in Chromium, so a screen that opens with its main button
// focused showed a second accent ring around a button whose fill already
// says "this is the default" — a doubled border, not a default button. The
// focus itself stays (Enter and Space still press it, Tab moves on from it);
// only the ring waits until the user actually reaches for the keyboard.

// `focusVisible` is in Chromium's FocusOptions (and the spec) but not yet in
// TypeScript's DOM lib.
type QuietFocusOptions = FocusOptions & { focusVisible?: boolean }

export function quietFocus(el: HTMLElement | null | undefined): void {
  el?.focus({ focusVisible: false } as QuietFocusOptions)
}

/** A ref callback standing in for `autoFocus` on a button. */
export function autoFocusQuietly(el: HTMLElement | null): void {
  quietFocus(el)
}
