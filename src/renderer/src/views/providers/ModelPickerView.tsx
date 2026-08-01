// The model catalog behind `_spettro/models/*`, which the macOS app surfaces
// only as counts ("8 models") inside ConnectProvidersView. The same data, laid
// out the way the TUI's /models dialog reads it: grouped by provider,
// favorites first inside each group (`groupedModels`), the context window in
// the TUI's compact form, and the capability flags the catalog carries.
//
// Favorites are the list the CLI's model cycle steps through (F2 / Shift+F2 in
// the TUI), so starring here changes which models are a keystroke away. The
// active model itself is a per-session ACP config option — it is switched from
// a chat's toolbar, not here, and this only marks which one it is.

import { useMemo, useState } from 'react'
import type { ModelEntry } from '@shared/extensions'
import { EMPTY_EXTENSIONS, contextLabel, groupedModels } from '@shared/extensions'
import { call, useApp } from '@renderer/state/store'
import { CheckIcon, StarIcon } from './icons'
import '@renderer/design/form.css'
import './providers.css'

export default function ModelPickerView({ onClose }: { onClose: () => void }): JSX.Element {
  const app = useApp()
  const models = app?.extensions?.models ?? EMPTY_EXTENSIONS.models
  const [search, setSearch] = useState('')

  const groups = useMemo(() => {
    const query = search.trim().toLowerCase()
    const filtered =
      query === ''
        ? models
        : {
            ...models,
            models: models.models.filter(
              (m) =>
                m.displayName.toLowerCase().includes(query) ||
                m.name.toLowerCase().includes(query) ||
                m.providerName.toLowerCase().includes(query)
            )
          }
    return groupedModels(filtered)
  }, [models, search])

  const total = models.models.length

  return (
    <div className="modal-backdrop modal-backdrop--stacked" role="presentation">
      <div className="modal-panel modal-panel--models" role="dialog" aria-modal="true" aria-label="Models">
        <div className="modal-head">
          <div className="modal-head-texts">
            <span className="modal-title">Models</span>
            <span className="modal-subtitle">
              {total} model{total === 1 ? '' : 's'} from your connected providers.
            </span>
          </div>
          <div className="modal-actions">
            <button className="btn btn--prominent" onClick={onClose}>
              Done
            </button>
          </div>
        </div>

        <div className="divider" />

        <div className="form-scroll">
          <div className="model-search">
            <input
              className="input"
              type="search"
              placeholder="Search models"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {groups.length === 0 ? (
            <div className="form-card">
              <div className="prov-row">
                <span className="form-text">
                  {total === 0
                    ? 'No models yet — connect a provider, sign in, or attach a local server.'
                    : `No model matches “${search}”.`}
                </span>
              </div>
            </div>
          ) : (
            groups.map((group) => (
              <section className="form-section" key={group.provider}>
                <div className="form-section-title">{group.provider}</div>
                <div className="form-card">
                  {group.models.map((model) => (
                    <ModelRow key={`${model.provider}:${model.name}`} model={model} />
                  ))}
                </div>
              </section>
            ))
          )}

          <div className="form-footer">
            Starred models are the ones the CLI&rsquo;s model cycle steps through. The active model
            is chosen per chat from the toolbar.
          </div>
        </div>
      </div>
    </div>
  )
}

function ModelRow({ model }: { model: ModelEntry }): JSX.Element {
  const context = contextLabel(model)
  return (
    <div className="model-row">
      <button
        className={`model-star ${model.favorite ? 'model-star--on' : ''}`}
        title={model.favorite ? 'Remove from favorites' : 'Add to favorites'}
        aria-pressed={model.favorite}
        onClick={() => void call('modelSetFavorite', model.provider, model.name, !model.favorite)}
      >
        <StarIcon size={14} filled={model.favorite} />
      </button>

      <div className="prov-texts">
        <span className="prov-title-line">
          <span className="prov-name">{model.displayName}</span>
          {model.active && (
            <span className="model-active">
              <CheckIcon size={11} />
              Active
            </span>
          )}
        </span>
        {/* The catalog id, when it isn't just the display name again. */}
        {model.name !== model.displayName && (
          <span className="prov-sub mono model-id">{model.name}</span>
        )}
      </div>

      <div className="model-chips">
        {model.local && <span className="model-chip">local</span>}
        {model.vision && <span className="model-chip">vision</span>}
        {model.reasoning && <span className="model-chip">reasoning</span>}
        {model.toolCall && <span className="model-chip">tools</span>}
        {context !== null && <span className="model-chip model-chip--ctx">{context}</span>}
      </div>
    </div>
  )
}
