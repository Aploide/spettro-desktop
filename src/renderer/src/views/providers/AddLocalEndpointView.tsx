// Port of Spettro/Views/Providers/AddLocalEndpointView.swift — attaches a
// local OpenAI-compatible server (LM Studio, Ollama, llama.cpp), mirroring the
// TUI's local-endpoint branch of /connect.
//
// The endpoint is probed before it is saved, so the user sees the models it
// actually advertises rather than discovering a bad URL on their first prompt:
// the primary button is "Test Connection" until a probe succeeds, and only
// then becomes "Add Server".

import { useState } from 'react'
import type { LocalProbeResult } from '@shared/extensions'
import { shortHost } from '@shared/extensions'
import { call, getState } from '@renderer/state/store'
import Spinner from '@renderer/views/shell/Spinner'
import { CheckSealIcon } from './icons'
import '@renderer/design/form.css'
import './providers.css'

/** The defaults the common local servers listen on, offered as one-tap fills
 *  so nobody has to remember port numbers. */
const PRESETS: { name: string; url: string }[] = [
  { name: 'LM Studio', url: 'http://localhost:1234' },
  { name: 'Ollama', url: 'http://localhost:11434' },
  { name: 'llama.cpp', url: 'http://localhost:8080' }
]

export default function AddLocalEndpointView({
  onClose,
  onAdded
}: {
  onClose: () => void
  onAdded?: () => void
}): JSX.Element {
  const [endpoint, setEndpoint] = useState('http://localhost:1234')
  const [apiKey, setApiKey] = useState('')
  const [probe, setProbe] = useState<LocalProbeResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isWorking, setIsWorking] = useState(false)

  const trimmed = endpoint.trim()

  const runProbe = async (): Promise<void> => {
    setError(null)
    setProbe(null)
    setIsWorking(true)
    try {
      setProbe(await call('localEndpointProbe', trimmed, apiKey === '' ? null : apiKey))
    } catch (err) {
      setError(message(err))
    } finally {
      setIsWorking(false)
    }
  }

  // `localEndpointAdd` swallows its failure into `extensions.error` rather
  // than rejecting, so success is confirmed against the endpoint actually
  // appearing in the pushed list — closing on a silent failure would leave the
  // user believing the server was attached.
  const save = async (): Promise<void> => {
    setIsWorking(true)
    try {
      await call('localEndpointAdd', trimmed, apiKey === '' ? null : apiKey)
      const local = getState().app?.extensions?.providers.local ?? []
      const added = local.some((l) => shortHost(l.endpoint) === shortHost(trimmed))
      if (added) {
        onAdded?.()
        onClose()
      } else {
        setError(lastError() ?? 'That server couldn’t be added.')
      }
    } catch (err) {
      setError(message(err))
    } finally {
      setIsWorking(false)
    }
  }

  const preview = probe
    ? probe.models
        .slice(0, 6)
        .map((m) => m.displayName)
        .join(', ') + (probe.models.length > 6 ? ', …' : '')
    : ''

  return (
    <div className="modal-backdrop modal-backdrop--stacked" role="presentation">
      <div
        className="modal-panel modal-panel--local"
        role="dialog"
        aria-modal="true"
        aria-label="Add a local server"
      >
        <div className="local">
          <header className="local-header">
            <span className="modal-title">Add a local server</span>
            <span className="modal-subtitle">
              Any server exposing an OpenAI-compatible /v1/models endpoint.
            </span>
          </header>

          <div className="local-presets">
            {PRESETS.map((preset) => (
              <button
                key={preset.url}
                className="btn btn--small"
                onClick={() => {
                  setEndpoint(preset.url)
                  setProbe(null)
                  setError(null)
                }}
              >
                {preset.name}
              </button>
            ))}
          </div>

          <div className="local-fields">
            <input
              className="input input--mono"
              type="text"
              placeholder="http://localhost:1234"
              value={endpoint}
              spellCheck={false}
              onChange={(e) => {
                setEndpoint(e.target.value)
                setProbe(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation()
                  void runProbe()
                }
              }}
            />
            <input
              className="input"
              type="password"
              placeholder="API key (only if your server requires one)"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>

          {probe && (
            <div className="probe-card">
              <span className="probe-head">
                <span className="probe-ok">
                  <CheckSealIcon size={14} />
                </span>
                {probe.name} — {probe.models.length} models
              </span>
              {preview !== '' && <span className="probe-models">{preview}</span>}
            </div>
          )}

          {error !== null && <span className="form-error">{error}</span>}

          <div className="form-spacer" />

          <footer className="local-footer">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <span className="form-spacer" />
            {isWorking && <Spinner size={16} />}
            <button
              className="btn btn--prominent"
              disabled={isWorking || trimmed === ''}
              onClick={() => void (probe === null ? runProbe() : save())}
            >
              {probe === null ? 'Test Connection' : 'Add Server'}
            </button>
          </footer>
        </div>
      </div>
    </div>
  )
}

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+':\s*/, '')
}

/** The store's last error, read straight after a mutating call (main pushes
 *  the new state before the call resolves). */
function lastError(): string | null {
  const error = getState().app?.extensions?.error ?? null
  return error === null || error === '' ? null : error
}
