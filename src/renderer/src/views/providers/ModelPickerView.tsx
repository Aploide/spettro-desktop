// The model catalog behind `_spettro/models/*`, which the macOS app surfaces
// only as counts ("8 models") inside ConnectProvidersView. The same data, laid
// out the way the TUI's /models dialog reads it: grouped by provider,
// favorites first inside each group (`groupedModels`), the context window in
// the TUI's compact form, and the capability flags the catalog carries.
//
// Favorites are the list the CLI's model cycle steps through (F2 / Shift+F2 in
// the TUI) and the top of the composer's model menu, so starring here changes
// which models are a click away. Opened from a chat ("Manage models…"), a
// click on a row also chooses that model — a list of models whose rows do
// nothing when clicked is a list nobody trusts.

import { useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ModelEntry } from '@shared/extensions'
import { EMPTY_EXTENSIONS, contextLabel, groupedModels } from '@shared/extensions'
import { call, useApp } from '@renderer/state/store'
import { CheckIcon, StarIcon } from './icons'
import '@renderer/design/form.css'
import './providers.css'

export default function ModelPickerView({
  onClose,
  chatId = null
}: {
  onClose: () => void
  /** The chat a click on a row switches the model of; without one the rows
   *  only star. */
  chatId?: string | null
}): JSX.Element {
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
              {total} model{total === 1 ? '' : 's'} from your connected providers
              {chatId ? ' — click one to use it' : ''}.
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
                    <ModelRow
                      key={`${model.provider}:${model.name}`}
                      model={model}
                      onChoose={
                        chatId
                          ? () => {
                              void call('setSelectOption', chatId, 'model', `${model.provider}:${model.name}`)
                              onClose()
                            }
                          : undefined
                      }
                    />
                  ))}
                </div>
              </section>
            ))
          )}

          <div className="form-footer">
            Star the models you use most: they&rsquo;re listed first when you pick a model.
          </div>
        </div>
      </div>
    </div>
  )
}

function ModelRow({ model, onChoose }: { model: ModelEntry; onChoose?: () => void }): JSX.Element {
  const context = contextLabel(model)
  // The row is the button; the star inside it is its own control and must
  // not also choose the model.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!onChoose || e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onChoose()
    }
  }
  return (
    <div
      className={`model-row${onChoose ? ' model-row--choosable' : ''}`}
      role={onChoose ? 'button' : undefined}
      tabIndex={onChoose ? 0 : undefined}
      aria-label={onChoose ? `Use ${model.displayName}` : undefined}
      onClick={onChoose}
      onKeyDown={onKeyDown}
    >
      <button
        className={`model-star ${model.favorite ? 'model-star--on' : ''}`}
        title={model.favorite ? 'Remove from favourites' : 'Add to favourites'}
        aria-pressed={model.favorite}
        onClick={(e) => {
          e.stopPropagation()
          void call('modelSetFavorite', model.provider, model.name, !model.favorite)
        }}
      >
        <StarIcon size={14} filled={model.favorite} />
      </button>

      <div className="prov-texts">
        <span className="prov-title-line">
          <span className="prov-name">{model.displayName}</span>
          {model.active && (
            <span className="model-active">
              <CheckIcon size={11} />
              In use
            </span>
          )}
        </span>
        {/* The catalog id, when it isn't just the display name again. */}
        {model.name !== model.displayName && (
          <span className="prov-sub mono model-id">{model.name}</span>
        )}
      </div>

      <div className="model-chips">
        {model.local && <span className="model-chip">Runs locally</span>}
        {model.vision && <span className="model-chip">Sees images</span>}
        {model.reasoning && <span className="model-chip">Reasons</span>}
        {model.toolCall && <span className="model-chip">Uses tools</span>}
        {context !== null && (
          <span className="model-chip model-chip--ctx" title="How much of a conversation it can keep in mind">
            {context} context
          </span>
        )}
      </div>
    </div>
  )
}
