import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { applyAccent } from './design/accent'

// Preload has normally put it there already; this covers a page whose
// document wasn't ready for it, before React paints anything.
applyAccent(window.spettro?.accent)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
