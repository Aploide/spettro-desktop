// Port of ProjectPickerView.swift — the home screen shown in the detail pane
// when no chat is selected: icon, headline, two folder buttons, and the agent
// version caption. Desktop addition per the port spec: a list of recent
// projects (app.recentProjects) for one-click reopening.

import { call, useApp } from '@renderer/state/store'
import AppIcon from './AppIcon'
import { FolderIcon } from './icons'
import { basename } from './util'

export default function ProjectPickerView(): JSX.Element {
  const app = useApp()
  const version = app?.agentVersion ?? app?.cli?.version ?? null
  const recents = app?.recentProjects ?? []

  const pickFolder = async (): Promise<void> => {
    const path = await call('pickFolder')
    if (path) await call('chooseProject', path)
  }

  return (
    <div className="picker">
      <AppIcon size={104} />

      <div className="picker-copy">
        <h1 className="picker-headline">What should Spettro build?</h1>
        <div className="picker-sub">
          Pick the folder your project lives in — the Spettro agent
          <br />
          will start there and every chat will work inside it.
          <br />
          Or open one of your saved chats from the sidebar.
        </div>
      </div>

      <div className="picker-buttons">
        <button className="btn btn--prominent btn--large" onClick={() => void pickFolder()}>
          <FolderIcon size={15} />
          Choose a Project Folder…
        </button>
        <button className="btn" onClick={() => void pickFolder()}>
          Create a New Project Folder…
        </button>
      </div>

      {recents.length > 0 && (
        <div className="recent">
          <div className="recent-caption">Recent projects</div>
          {recents.map((path) => (
            <button key={path} className="recent-row" onClick={() => void call('chooseProject', path)}>
              <span className="recent-icon">
                <FolderIcon size={14} />
              </span>
              <span className="recent-name">{basename(path)}</span>
              <span className="recent-path path-value" title={path}>
                {path}
              </span>
            </button>
          ))}
        </div>
      )}

      {version && <div className="version-caption">spettro {version}</div>}
    </div>
  )
}
