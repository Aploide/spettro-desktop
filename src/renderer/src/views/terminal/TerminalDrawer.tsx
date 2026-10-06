// Port of TerminalDrawerView.swift + TerminalView.swift (doc 17): a
// resizable-height bottom drawer of per-project terminal tabs. Each tab
// hosts an @xterm/xterm Terminal wired over IPC to a node-pty shell in the
// main process. Terminals are deliberately independent of the chat/ACP
// lifecycle: switching tabs or hiding the drawer only hides DOM (the xterm
// instances and their scrollback stay mounted); the shells themselves live
// in main and keep running regardless.
//
// Drawer height persists across relaunches via localStorage
// ("spettro.terminalDrawerHeight" — the @AppStorage analog). Tabs persist
// only while the app runs, restored from main via terminalList.
//
// Opening the drawer for the first time starts a shell straight away — an
// empty drawer with a "New Terminal" button is one click nobody wanted. A
// shell that exits keeps its tab and its output, with "press Enter to
// restart" (a new shell in the same tab, scrollback intact), instead of
// vanishing two seconds later. Closing a tab that is still running a command
// asks first, and a terminal that can't be opened says why.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { humanizeError } from '@shared/humanize'
import { quietCall } from '@renderer/state/store'
import { confirmDialog } from '@renderer/views/common/ConfirmDialog'
import { showToast } from '@renderer/views/common/Toast'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'

const HEIGHT_KEY = 'spettro.terminalDrawerHeight'
const MIN_HEIGHT = 120
const MAX_HEIGHT = 700
const DEFAULT_HEIGHT = 280

/** Written into a tab whose shell has exited. */
const EXITED_LINE = '\r\n\x1b[2m[Process exited — press Enter to restart]\x1b[0m\r\n'

interface Tab {
  /** The tab's own identity: its first shell's id, kept across restarts so
   *  the xterm (and its scrollback) stays attached. */
  id: string
  /** The shell running in it now (a restart replaces it). */
  termId: string
  projectPath: string
  title: string
  running: boolean
}

interface TermSession {
  term: Terminal
  fit: FitAddon
  observer: ResizeObserver
}

interface TerminalDrawerProps {
  projectPath: string
  visible: boolean
  onClose: () => void
}

function clampHeight(height: number): number {
  if (!Number.isFinite(height)) return DEFAULT_HEIGHT
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height))
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** Appends an alpha byte to #rrggbb colors; returns other formats as-is. */
function withAlpha(color: string, alphaHex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color + alphaHex : color
}

/** The 16 ANSI colours for the light scheme. xterm's built-in set is drawn for
 *  a dark background: its white, bright white and bright yellow all but vanish
 *  on --canvas, and `ls`, git and test runners print in exactly those. These
 *  are the same hues deepened until each reads on the warm white, the way
 *  light terminal themes remap them ("white" becomes a mid grey). The dark
 *  scheme keeps xterm's defaults, which were made for it. */
const LIGHT_ANSI: ITheme = {
  black: '#1f1e1d',
  red: '#c4453a',
  green: '#2b7d55',
  yellow: '#8a6a10',
  blue: '#2f6dbf',
  magenta: '#a3449c',
  cyan: '#1f7a8c',
  white: '#6b6a63',
  brightBlack: '#8a887f',
  brightRed: '#b03a30',
  brightGreen: '#237049',
  brightYellow: '#7a5d0c',
  brightBlue: '#2659a6',
  brightMagenta: '#8a3584',
  brightCyan: '#186a79',
  brightWhite: '#4a4945'
}

/** xterm theme from the computed theme.css palette. Read at mount and again
 *  whenever the colour scheme flips (see the effect below): xterm paints with
 *  concrete colours, so it can't follow the CSS variables on its own. A theme
 *  without ANSI entries puts xterm's dark-background defaults back, which is
 *  what flipping to dark wants. */
function readXtermTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const canvas = style.getPropertyValue('--canvas').trim() || '#262624'
  const foreground = style.getPropertyValue('--text-primary').trim() || '#f5f4ef'
  const accent = style.getPropertyValue('--accent').trim() || '#d97757'
  const light = window.matchMedia('(prefers-color-scheme: light)').matches
  return {
    ...(light ? LIGHT_ANSI : {}),
    background: canvas,
    foreground,
    cursor: accent,
    cursorAccent: canvas,
    selectionBackground: withAlpha(accent, '4d')
  }
}

/** theme.css's --font-mono, resolved: xterm measures glyphs on a canvas and
 *  needs the literal stack, not a var() reference. */
function terminalFont(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
    'ui-monospace, Menlo, Consolas, monospace'
  )
}

export default function TerminalDrawer({
  projectPath,
  visible,
  onClose
}: TerminalDrawerProps): React.JSX.Element {
  // ---- tab state (flat store grouped by project, like TerminalPanelStore) --
  const [tabsByProject, setTabsByProject] = useState<Record<string, Tab[]>>({})
  // Selection is remembered per project, so each chat's drawer keeps its own
  // active tab instead of sharing one global selection (doc 17).
  const [selectedByProject, setSelectedByProject] = useState<Record<string, string>>({})

  const sessions = useRef(new Map<string, TermSession>())
  /** Output that arrived before the tab's xterm attached, by termId; flushed
   *  on attach. */
  const pendingData = useRef(new Map<string, string[]>())
  const tabsRef = useRef<Tab[]>([])
  /** Projects whose drawer has already started its first shell this run. */
  const autoStarted = useRef(new Set<string>())
  /** Tabs whose shell is being restarted right now. */
  const restarting = useRef(new Set<string>())

  const allTabs = Object.values(tabsByProject).flat()
  useEffect(() => {
    tabsRef.current = allTabs
  })

  const currentTabs = tabsByProject[projectPath] ?? []
  // Fall back to the project's last tab if the remembered id is gone —
  // this is also how selection "repairs" after a close.
  const selectedId =
    currentTabs.find((t) => t.id === selectedByProject[projectPath])?.id ??
    currentTabs[currentTabs.length - 1]?.id ??
    null

  // ---- drawer height (persisted, drag-resizable) --------------------------
  const [height, setHeight] = useState(() =>
    clampHeight(Number(localStorage.getItem(HEIGHT_KEY)) || DEFAULT_HEIGHT)
  )
  useEffect(() => {
    localStorage.setItem(HEIGHT_KEY, String(height))
  }, [height])

  // Height at the start of the current drag, so the gesture composes with
  // the persisted value instead of accumulating per-tick deltas (doc 17).
  const dragBase = useRef<{ startY: number; baseHeight: number } | null>(null)

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragBase.current = { startY: e.clientY, baseHeight: height }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [height]
  )
  const onHandlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const base = dragBase.current
    if (!base) return
    // Dragging up (negative delta) grows the drawer.
    setHeight(clampHeight(base.baseHeight + (base.startY - e.clientY)))
  }, [])
  const onHandlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragBase.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }, [])

  // ---- restore this project's tabs from main (tabs outlive the drawer) ----
  useEffect(() => {
    if (tabsByProject[projectPath]) return
    let cancelled = false
    void window.spettro.call('terminalList', projectPath).then((ids) => {
      if (cancelled) return
      setTabsByProject((prev) =>
        prev[projectPath]
          ? prev
          : {
              ...prev,
              [projectPath]: ids.map((id) => ({
                id,
                termId: id,
                projectPath,
                title: basename(projectPath),
                running: true
              }))
            }
      )
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath])

  // ---- tab lifecycle ------------------------------------------------------
  /** A new shell in `projectPath`, or null (with a toast saying why). */
  const spawnShell = useCallback(async (path: string): Promise<string | null> => {
    try {
      return await quietCall('terminalCreate', path)
    } catch (err) {
      const human = humanizeError(err)
      showToast({
        tone: 'error',
        key: 'terminal-create',
        title: 'Couldn’t open a terminal',
        detail: human.known ? `${human.title}. ${human.detail}` : human.detail
      })
      return null
    }
  }, [])

  const newTerminal = useCallback(async () => {
    const id = await spawnShell(projectPath)
    if (!id) return
    setTabsByProject((prev) => ({
      ...prev,
      [projectPath]: [
        ...(prev[projectPath] ?? []),
        { id, termId: id, projectPath, title: basename(projectPath), running: true }
      ]
    }))
    setSelectedByProject((prev) => ({ ...prev, [projectPath]: id }))
  }, [projectPath, spawnShell])

  // The first time the drawer is shown for a project, a shell is already
  // there. Only once: after the last tab is closed on purpose, the empty
  // state (and its button) is the answer.
  const listed = tabsByProject[projectPath] !== undefined
  useEffect(() => {
    if (!visible || !listed || autoStarted.current.has(projectPath)) return
    autoStarted.current.add(projectPath)
    if ((tabsByProject[projectPath] ?? []).length === 0) void newTerminal()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, listed, projectPath])

  /** Enter in an exited tab: a fresh shell, same tab, same scrollback. */
  const restartTab = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId)
      // One restart at a time: a second Enter mustn't start a second shell.
      if (!tab || tab.running || restarting.current.has(tabId)) return
      restarting.current.add(tabId)
      const termId = await spawnShell(tab.projectPath).finally(() => restarting.current.delete(tabId))
      if (!termId) return
      updateTab(setTabsByProject, tabId, { termId, running: true })
      const session = sessions.current.get(tabId)
      if (session) {
        session.term.write('\r\n')
        void quietCall('terminalResize', termId, session.term.cols, session.term.rows)
      }
    },
    [spawnShell]
  )

  const closeTabById = useCallback((id: string) => {
    const session = sessions.current.get(id)
    if (session) {
      session.observer.disconnect()
      session.term.dispose()
      sessions.current.delete(id)
    }
    const termId = tabsRef.current.find((t) => t.id === id)?.termId ?? id
    pendingData.current.delete(termId)
    void quietCall('terminalDispose', termId)
    setTabsByProject((prev) => {
      const next: Record<string, Tab[]> = {}
      let changed = false
      for (const [project, tabs] of Object.entries(prev)) {
        const filtered = tabs.filter((t) => t.id !== id)
        if (filtered.length !== tabs.length) changed = true
        next[project] = filtered
      }
      return changed ? next : prev
    })
  }, [])

  const selectTab = useCallback(
    (id: string) => {
      setSelectedByProject((prev) => ({ ...prev, [projectPath]: id }))
    },
    [projectPath]
  )

  const setTitle = useCallback((id: string, title: string) => {
    setTabsByProject((prev) => {
      const next: Record<string, Tab[]> = {}
      for (const [project, tabs] of Object.entries(prev)) {
        next[project] = tabs.map((t) =>
          // Shell-set titles (OSC escapes) become the tab label, falling back
          // to the project folder's name when empty (doc 17).
          t.id === id ? { ...t, title: title.trim() || basename(t.projectPath) } : t
        )
      }
      return next
    })
  }, [])

  // ---- live re-theme ------------------------------------------------------
  // The appearance setting flips nativeTheme in main, which flips this media
  // query; every open terminal (not just the visible one) is repainted so a
  // hidden tab doesn't come back in the old scheme.
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => {
      const theme = readXtermTheme()
      for (const session of sessions.current.values()) session.term.options.theme = theme
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  // Closing a tab with a command still running in it asks first; an idle
  // shell (or an exited one) just closes.
  const requestCloseTab = useCallback(
    async (id: string) => {
      const tab = tabsRef.current.find((t) => t.id === id)
      if (tab?.running && (await quietCall('terminalHasProcess', tab.termId).catch(() => false))) {
        const answer = await confirmDialog({
          title: 'Close this terminal?',
          message: 'A command is still running in it. Closing the terminal stops it.',
          confirmLabel: 'Close',
          destructive: true
        })
        if (answer !== 'confirm') return
      }
      closeTabById(id)
    },
    [closeTabById]
  )

  // ---- terminal-data / terminal-exit events (not routed via the store) ----
  useEffect(() => {
    const tabFor = (termId: string): Tab | undefined => tabsRef.current.find((t) => t.termId === termId)
    return window.spettro.onEvent((event) => {
      if (event.type === 'terminal-data') {
        const tab = tabFor(event.termId)
        const session = tab ? sessions.current.get(tab.id) : undefined
        if (session) {
          session.term.write(event.data)
        } else if (tab || pendingData.current.has(event.termId)) {
          const queue = pendingData.current.get(event.termId) ?? []
          queue.push(event.data)
          pendingData.current.set(event.termId, queue)
        }
      } else if (event.type === 'terminal-exit') {
        const tab = tabFor(event.termId)
        if (!tab) return
        // The tab stays, with its output, until the user restarts or closes it.
        sessions.current.get(tab.id)?.term.write(EXITED_LINE)
        updateTab(setTabsByProject, tab.id, { running: false })
      }
    })
  }, [])

  // ---- xterm attach (once per tab; DOM persists across tab switches) ------
  const attachTerminal = useCallback(
    (tab: Tab, el: HTMLDivElement | null) => {
      if (!el || sessions.current.has(tab.id)) return
      const term = new Terminal({
        theme: readXtermTheme(),
        fontFamily: terminalFont(),
        fontSize: 12,
        cursorBlink: true,
        scrollback: 5000,
        allowTransparency: false
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(el)

      // Always the tab's current shell: a restart swaps it underneath.
      const current = (): Tab | undefined => tabsRef.current.find((t) => t.id === tab.id)
      term.onData((data) => {
        const now = current()
        if (!now) return
        if (now.running) void quietCall('terminalWrite', now.termId, data)
        else if (data.includes('\r')) void restartTab(now.id)
      })
      term.onTitleChange((title) => setTitle(tab.id, title))
      // fit.fit() resizes the xterm grid; propagate the new grid to the pty.
      term.onResize(({ cols, rows }) => {
        const now = current()
        if (now?.running) void quietCall('terminalResize', now.termId, cols, rows)
      })

      const observer = new ResizeObserver(() => {
        // Skip while hidden (zero-sized) — refit happens on reveal.
        if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit()
      })
      observer.observe(el)
      sessions.current.set(tab.id, { term, fit, observer })

      // Flush output that raced ahead of the first render.
      const queued = pendingData.current.get(tab.termId)
      if (queued) {
        pendingData.current.delete(tab.termId)
        for (const chunk of queued) term.write(chunk)
      }

      requestAnimationFrame(() => {
        if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit()
        term.focus()
      })
    },
    [setTitle, restartTab]
  )

  // Refit + focus the active terminal when it becomes visible or the drawer
  // resizes (the terminal takes keyboard focus when it appears, per doc 17).
  useEffect(() => {
    if (!visible || !selectedId) return
    const session = sessions.current.get(selectedId)
    if (!session) return
    const raf = requestAnimationFrame(() => {
      session.fit.fit()
      session.term.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [visible, selectedId, height])

  // Dispose all xterm instances on unmount (the ptys in main keep running).
  useEffect(() => {
    const map = sessions.current
    return () => {
      for (const session of map.values()) {
        session.observer.disconnect()
        session.term.dispose()
      }
      map.clear()
    }
  }, [])

  // ---- render -------------------------------------------------------------
  return (
    <div
      className={'terminal-drawer' + (visible ? '' : ' terminal-drawer--hidden')}
      style={{ height }}
    >
      <div
        className="terminal-drawer__handle"
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal drawer"
      />
      <div className="terminal-drawer__tabbar">
        <div className="terminal-drawer__tabs">
          {currentTabs.map((tab) => (
            <div
              key={tab.id}
              className={
                'terminal-tab' + (tab.id === selectedId ? ' terminal-tab--selected' : '')
              }
              onClick={() => selectTab(tab.id)}
            >
              <span className="terminal-tab__glyph mono" aria-hidden="true">
                &gt;_
              </span>
              <span className="terminal-tab__title">{tab.title}</span>
              {!tab.running && <span className="terminal-tab__ended">(ended)</span>}
              <button
                className="terminal-tab__close"
                title="Close terminal"
                aria-label="Close terminal"
                onClick={(e) => {
                  e.stopPropagation()
                  void requestCloseTab(tab.id)
                }}
              >
                &#215;
              </button>
            </div>
          ))}
        </div>
        <button
          className="terminal-drawer__iconbtn"
          title="New terminal"
          aria-label="New terminal"
          onClick={() => void newTerminal()}
        >
          +
        </button>
        <button
          className="terminal-drawer__iconbtn"
          title="Hide terminal"
          aria-label="Hide terminal"
          onClick={onClose}
        >
          &#215;
        </button>
      </div>
      <div className="terminal-drawer__body">
        {/* Every tab (across projects) stays mounted so scrollback survives
            tab switches and project switches; only the active one is shown. */}
        {allTabs.map((tab) => (
          <div
            key={tab.id}
            className={
              'terminal-slot' +
              (tab.projectPath === projectPath && tab.id === selectedId
                ? ' terminal-slot--active'
                : '')
            }
          >
            <div className="terminal-slot__host" ref={(el) => attachTerminal(tab, el)} />
          </div>
        ))}
        {currentTabs.length === 0 && (
          <div className="terminal-drawer__empty">
            <div className="terminal-drawer__empty-label">No terminal open</div>
            <button className="terminal-drawer__newbtn" onClick={() => void newTerminal()}>
              New Terminal
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** Patches one tab, wherever it is filed. */
function updateTab(
  set: React.Dispatch<React.SetStateAction<Record<string, Tab[]>>>,
  tabId: string,
  patch: Partial<Tab>
): void {
  set((prev) => {
    const next: Record<string, Tab[]> = {}
    for (const [project, tabs] of Object.entries(prev)) {
      next[project] = tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t))
    }
    return next
  })
}
