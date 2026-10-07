// `?accent=lilac|mono` on any harness page: puts the accent on <html> before
// anything renders, the way preload does in the app. Imported first by every
// harness entry. Without the parameter the page is in the default (Lilac),
// which is also what a page that never sets data-accent shows.

import { applyAccent } from '@renderer/design/accent'
import { DEFAULT_ACCENT, isAccent, type Accent } from '@shared/model'

const asked = new URLSearchParams(location.search).get('accent')

/** The accent this page was asked for. The app harness also reports it in its
 *  app-state, which the store applies on every update. */
export const HARNESS_ACCENT: Accent = isAccent(asked) ? asked : DEFAULT_ACCENT

applyAccent(HARNESS_ACCENT)
