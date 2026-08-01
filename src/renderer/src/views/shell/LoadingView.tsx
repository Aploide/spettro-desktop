// Port of the private LoadingView in ContentView.swift: a large centered
// spinner over a secondary-styled, phase-specific message.

import Spinner from './Spinner'

export default function LoadingView({ message }: { message: string }): JSX.Element {
  return (
    <div className="loading-view">
      <Spinner size={28} />
      <div className="loading-message">{message}</div>
    </div>
  )
}
