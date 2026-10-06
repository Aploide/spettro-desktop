// Port of Spettro/Views/Providers/AddLocalEndpointView.swift — attaches a
// local OpenAI-compatible server (LM Studio, Ollama, llama.cpp), mirroring the
// TUI's local-endpoint branch of /connect.
//
// Nobody should have to know which port their model server listens on. The
// sheet opens by asking all three usual ones at once and offers whichever
// answers: "Ollama · 3 models — Add". A server that answers with no models
// says so ("Ollama is running but has no models. Download one first.") rather
// than letting an empty server be added. Only when nothing answers — or the
// server is somewhere unusual — does the address field come into play, and it
// still probes before it saves, so a typo is found here instead of on the
// first message.

import { useCallback, useEffect, useState } from 'react'
import type { LocalProbeResult } from '@shared/extensions'
import { shortHost } from '@shared/extensions'
import { humanizeError } from '@shared/humanize'
import { getState, quietCall } from '@renderer/state/store'
import Disclosure from '@renderer/views/common/Disclosure'
import Spinner from '@renderer/views/shell/Spinner'
import { CheckSealIcon, DesktopIcon, WarningTriangleIcon } from './icons'
import '@renderer/design/form.css'
import './providers.css'

/** The defaults the common local servers listen on. */
export const LOCAL_PRESETS: { name: string; url: string }[] = [
  { name: 'LM Studio', url: 'http://localhost:1234' },
  { name: 'Ollama', url: 'http://localhost:11434' },
  { name: 'llama.cpp', url: 'http://localhost:8080' }
]

type PresetState = 'checking' | 'absent' | LocalProbeResult

export default function AddLocalEndpointView({
  onClose,
  onAdded
}: {
  onClose: () => void
  onAdded?: () => void
}): JSX.Element {
  const [presets, setPresets] = useState<Record<string, PresetState>>({})
  const [endpoint, setEndpoint] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [probe, setProbe] = useState<LocalProbeResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isWorking, setIsWorking] = useState(false)

  const scan = useCallback(() => {
    setPresets(Object.fromEntries(LOCAL_PRESETS.map((p) => [p.url, 'checking' as const])))
    for (const preset of LOCAL_PRESETS) {
      void quietCall('localEndpointProbe', preset.url, null)
        .then((result) => setPresets((prev) => ({ ...prev, [preset.url]: result })))
        .catch(() => setPresets((prev) => ({ ...prev, [preset.url]: 'absent' })))
    }
  }, [])

  useEffect(() => scan(), [scan])

  // Escape is this sheet's Cancel, and only this sheet's (not Settings').
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const checking = LOCAL_PRESETS.some((p) => presets[p.url] === 'checking')
  const found = LOCAL_PRESETS.flatMap((p) => {
    const state = presets[p.url]
    return state && typeof state === 'object' ? [{ preset: p, result: state }] : []
  })

  // `localEndpointAdd` swallows its failure into `extensions.error` rather
  // than rejecting, so success is confirmed against the endpoint actually
  // appearing in the pushed list — closing on a silent failure would leave the
  // user believing the server was attached.
  const add = async (url: string, key: string | null, name: string): Promise<void> => {
    setError(null)
    setIsWorking(true)
    try {
      await quietCall('localEndpointAdd', url, key)
      const local = getState().app?.extensions?.providers.local ?? []
      if (local.some((l) => shortHost(l.endpoint) === shortHost(url))) {
        onAdded?.()
        onClose()
      } else {
        setError(failureText(lastError(), url, name))
      }
    } catch (err) {
      setError(failureText(err, url, name))
    } finally {
      setIsWorking(false)
    }
  }

  const trimmed = endpoint.trim()
  const testCustom = async (): Promise<void> => {
    setError(null)
    setProbe(null)
    setIsWorking(true)
    try {
      setProbe(await quietCall('localEndpointProbe', trimmed, apiKey === '' ? null : apiKey))
    } catch (err) {
      setError(failureText(err, trimmed, null))
    } finally {
      setIsWorking(false)
    }
  }

  return (
    <div className="modal-backdrop modal-backdrop--stacked" role="presentation">
      <div className="modal-panel modal-panel--local" role="dialog" aria-modal="true" aria-label="Use a model on this computer">
        <div className="local">
          <header className="local-header">
            <span className="modal-title">Use a model on this computer</span>
            <span className="modal-subtitle">
              Spettro works with LM Studio, Ollama and llama.cpp. Your messages stay on this computer.
            </span>
          </header>

          <div className="local-found" aria-live="polite">
            {checking && found.length === 0 ? (
              <div className="local-status">
                <Spinner size={14} />
                <span>Looking for a model server…</span>
              </div>
            ) : found.length === 0 ? (
              <div className="local-status local-status--empty">
                <span className="local-status-icon">
                  <DesktopIcon size={16} />
                </span>
                <span>
                  No model server is running. Open LM Studio, Ollama or llama.cpp, then check again.
                </span>
                <button className="btn btn--small" onClick={scan}>
                  Check Again
                </button>
              </div>
            ) : (
              found.map(({ preset, result }) => (
                <div className="local-server" key={preset.url}>
                  <span className={`local-server-icon${result.models.length > 0 ? ' local-server-icon--ok' : ''}`}>
                    {result.models.length > 0 ? <CheckSealIcon size={16} /> : <WarningTriangleIcon size={15} />}
                  </span>
                  <span className="local-server-texts">
                    <span className="local-server-name">
                      {preset.name}
                      {result.models.length > 0 && (
                        <span className="local-server-count">
                          {' '}
                          · {result.models.length} {result.models.length === 1 ? 'model' : 'models'}
                        </span>
                      )}
                    </span>
                    <span className="local-server-sub">
                      {result.models.length > 0
                        ? modelPreview(result)
                        : `${preset.name} is running but has no models. Download one first, then check again.`}
                    </span>
                  </span>
                  {result.models.length > 0 ? (
                    <button
                      className="btn btn--small btn--prominent"
                      disabled={isWorking}
                      onClick={() => void add(preset.url, null, preset.name)}
                    >
                      Add
                    </button>
                  ) : (
                    <button className="btn btn--small" onClick={scan}>
                      Check Again
                    </button>
                  )}
                </div>
              ))
            )}
          </div>

          <Disclosure label="Use a different address" openLabel="Use a different address" defaultOpen={false}>
            <div className="local-fields">
              <input
                className="input input--mono"
                type="text"
                placeholder="http://localhost:1234"
                aria-label="Server address"
                value={endpoint}
                spellCheck={false}
                onChange={(e) => {
                  setEndpoint(e.target.value)
                  setProbe(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && trimmed !== '') {
                    e.stopPropagation()
                    void testCustom()
                  }
                }}
              />
              <input
                className="input"
                type="password"
                placeholder="API key (only if your server asks for one)"
                aria-label="Server API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              {probe && (
                <div className="probe-card">
                  <span className="probe-head">
                    <span className="probe-ok">
                      <CheckSealIcon size={14} />
                    </span>
                    {probe.name} — {probe.models.length} {probe.models.length === 1 ? 'model' : 'models'}
                  </span>
                  {probe.models.length > 0 ? (
                    <span className="probe-models">{modelPreview(probe)}</span>
                  ) : (
                    <span className="probe-models">It&rsquo;s running but has no models. Download one first.</span>
                  )}
                </div>
              )}
              <div className="local-custom-actions">
                <button
                  className="btn btn--small"
                  disabled={isWorking || trimmed === ''}
                  onClick={() =>
                    void (probe === null
                      ? testCustom()
                      : add(trimmed, apiKey === '' ? null : apiKey, probe.name))
                  }
                >
                  {probe === null ? 'Check Address' : 'Add This Server'}
                </button>
              </div>
            </div>
          </Disclosure>

          {error !== null && <span className="form-error">{error}</span>}

          <footer className="local-footer">
            {isWorking && <Spinner size={16} />}
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          </footer>
        </div>
      </div>
    </div>
  )
}

function modelPreview(result: LocalProbeResult): string {
  return (
    result.models
      .slice(0, 4)
      .map((m) => m.displayName)
      .join(', ') + (result.models.length > 4 ? ', …' : '')
  )
}

/** A probe or add that failed, said for this server ("Nothing is running at
 *  localhost:1234. Is LM Studio open?"). */
function failureText(err: unknown, url: string, name: string | null): string {
  if (err === null || err === undefined) return 'That server couldn’t be added.'
  const preset = LOCAL_PRESETS.find((p) => shortHost(p.url) === shortHost(url))
  const human = humanizeError(err, { endpoint: url, serverName: name ?? preset?.name })
  return human.known ? `${human.title}. ${human.detail}` : human.detail
}

function lastError(): string | null {
  const error = getState().app?.extensions?.error ?? null
  return error === null || error === '' ? null : error
}
