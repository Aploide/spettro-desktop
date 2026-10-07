// Drafts: what the user has typed but not sent, per chat. Kept out of the composer's
// own state so switching chats, a reconnect, or a relaunch can never throw it
// away: the composer reads its chat's draft when it mounts and writes every
// change back. Text only — images are too big for localStorage and cheap to
// re-attach. `NEW_SESSION_DRAFT` is the new-session view's field.

export const NEW_SESSION_DRAFT = 'new'
const DRAFT_PREFIX = 'spettro.draft.'

export function loadDraft(chatId: string): string {
  try {
    return localStorage.getItem(DRAFT_PREFIX + (chatId || NEW_SESSION_DRAFT)) ?? ''
  } catch {
    return ''
  }
}

export function saveDraft(chatId: string, text: string): void {
  const key = DRAFT_PREFIX + (chatId || NEW_SESSION_DRAFT)
  try {
    if (text === '') localStorage.removeItem(key)
    else localStorage.setItem(key, text)
  } catch {
    // Storage full or unavailable: the draft lives as long as the window.
  }
}
