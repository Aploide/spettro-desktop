// Port of the private LoadingView in ContentView.swift: a large centered
// spinner over one plain line ("Starting Spettro…"). Should starting take
// longer than it ever should (a hung binary, a slow disk), a hint appears
// after ten seconds with the way out — Settings › Advanced, where the engine
// can be pointed elsewhere or restarted — instead of a spinner forever.

import { useEffect, useState } from 'react'
import Spinner from './Spinner'

/** How long before "this is taking a while" is worth saying. */
export const SLOW_START_MS = 10_000

export default function LoadingView({
  message,
  onOpenSettings
}: {
  message: string
  onOpenSettings?: () => void
}): JSX.Element {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_START_MS)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="loading-view">
      <Spinner size={28} />
      <div className="loading-message">{message}</div>
      {slow && (
        <div className="loading-hint" role="status">
          <span>This is taking longer than usual.</span>
          {onOpenSettings && (
            <button type="button" className="link" onClick={onOpenSettings}>
              Open Settings
            </button>
          )}
        </div>
      )}
    </div>
  )
}
