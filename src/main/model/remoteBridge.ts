// AppModel as seen by an attached phone — the port of
// AppModel+RemoteHost.swift, packaged as the RemoteBridge interface the
// remote host is built against (src/main/remote/bridge.ts).
//
// Every method routes into the same call the local UI makes: a phone's
// prompt goes through AppModel.send, not straight to the agent, so the local
// transcript, persistence, and busy state update exactly once — and the
// streamed answer is broadcast to every screen from one place.

import { EventEmitter } from 'events'
import { statSync } from 'fs'
import { basename } from 'path'
import type { ACPContentBlock, ACPQuestionAnswer, JSONValue } from '../../shared/acp'
import { ExtensionMethod } from '../../shared/extensions'
import type { ChatSummary } from '../../shared/model'
import type { RemoteBridge } from '../remote/bridge'
import type { AppModel, PromptAttachment } from './appModel'
import type { ChatSession } from './chatSession'
import { listProjectFiles } from './projectFiles'

/** The `_spettro/*` calls a phone can make that change state this process
 *  mirrors. After one lands, the local stores are re-read so both screens
 *  agree — a key connected on the phone must not leave this window still
 *  showing an empty provider list (or parked on the setup gate). */
const MUTATING_EXTENSION_METHODS = new Set<string>([
  ExtensionMethod.accountLoginStart,
  ExtensionMethod.accountLoginCancel,
  ExtensionMethod.accountLogout,
  ExtensionMethod.providersConnect,
  ExtensionMethod.providersDisconnect,
  ExtensionMethod.localAdd,
  ExtensionMethod.localRemove,
  ExtensionMethod.modelsFavorite
])

export function buildRemoteBridge(model: AppModel): RemoteBridge {
  const events = new EventEmitter()
  events.setMaxListeners(100)

  // Chats the phones have been told are gone. A turn still running when its
  // chat goes (deleted, or a studio run discarded as the editor closes) is
  // cancelled on the way out, and its last chat-state lands after the
  // chat/removed — the phone would put the row straight back.
  const removed = new Set<string>()
  model.on('chat-removed-remote', (chatId: string) => removed.add(chatId))

  // Workflow Studio's scratch chats are the studio's alone: kept out of the
  // sidebar and off disk, and so never shown to a phone either, which would
  // otherwise list a "Workflow · name" chat it could never get rid of. A
  // discarded one is no longer in the model to ask, so `removed` answers.
  const hidden = (chatId: string | null | undefined): boolean =>
    typeof chatId === 'string' && (removed.has(chatId) || model.sessionById(chatId)?.isScratch === true)
  /** The chats a phone may see and act on. */
  const visible = (chatId: string): ChatSession | null => {
    const session = model.sessionById(chatId)
    return session && !session.isScratch ? session : null
  }

  // Re-emit the model's remote-facing events under the bridge's names,
  // dropping any about a scratch chat or one already removed (`chatOf` says
  // which chat that is).
  const forward = (from: string, to: string, chatOf?: (args: unknown[]) => string | null | undefined): void => {
    model.on(from, (...args: unknown[]) => {
      if (chatOf && hidden(chatOf(args))) return
      events.emit(to, ...args)
    })
  }
  const chatArg = (args: unknown[]): string => args[0] as string
  const summaryArg = (args: unknown[]): string => (args[0] as ChatSummary).id
  const promptChatArg = (args: unknown[]): string | null => args[1] as string | null
  forward('chat-update-raw', 'chat-update', chatArg)
  forward('chat-user', 'chat-user', chatArg)
  forward('chat-state', 'chat-state', summaryArg)
  // A notice alone: a chat/state with a notice and no stopReason, which
  // ends nothing on the phone.
  forward('chat-notice', 'chat-state', summaryArg)
  // Also sent for a discarded scratch chat, which is gone by then: a phone
  // that somehow had it drops it.
  forward('chat-removed-remote', 'chat-removed')
  forward('host-state', 'host-state')
  forward('permission-ask', 'permission-ask', promptChatArg)
  forward('permission-resolved', 'permission-resolved')
  forward('question-ask', 'question-ask', promptChatArg)
  forward('question-resolved', 'question-resolved')
  forward('agent-notification', 'agent-notification')

  const listProjects = (): { path: string; name: string }[] => {
    const counts = new Map<string, number>()
    for (const session of model.sessions) {
      if (session.isScratch) continue
      counts.set(session.projectPath, (counts.get(session.projectPath) ?? 0) + 1)
    }
    // The default folder is always offered, even with no chats in it yet —
    // otherwise a phone attached to an empty sidebar would have nowhere at
    // all to start a conversation.
    const fallback = model.defaultProjectPath
    if (!counts.has(fallback)) counts.set(fallback, 0)
    return [...counts.entries()]
      .map(([path, chatCount]) => ({ path, name: basename(path), chatCount }))
      .sort((a, b) => b.chatCount - a.chatCount || a.name.localeCompare(b.name))
      .map(({ path, name }) => ({ path, name }))
  }

  return {
    listChats: () => model.sessions.filter((s) => !s.isScratch).map((s) => s.summary()),

    openChat: (chatId) => {
      const session = visible(chatId)
      if (!session) return null
      return {
        chat: session.snapshot(),
        configOptions: session.configOptions as unknown as JSONValue,
        commands: session.commands as unknown as JSONValue,
        plan: session.plan as unknown as JSONValue,
        usage: session.usage ? (session.usage as unknown as JSONValue) : null,
        isBusy: session.isBusy
      }
    },

    // A phone stopping to view a chat needs nothing host-side; the chat and
    // its ACP session stay live for every other screen.
    closeChat: () => {},

    newChat: (projectPath) => {
      if (!isDirectory(projectPath)) {
        throw new Error(`No such project folder: ${projectPath}`)
      }
      // Use the session newChat actually created rather than looking one up
      // by folder afterwards — several chats commonly share a project.
      return model.newChat(projectPath).summary()
    },

    deleteChat: (chatId) => {
      if (visible(chatId)) model.closeChat(chatId)
    },

    flagChat: (chatId, flags) => {
      if (visible(chatId)) model.flagChat(chatId, flags)
    },

    renameChat: (chatId, title) => {
      if (!visible(chatId)) return false
      model.renameChat(chatId, title)
      return true
    },

    listProjects,

    // Only the folders a phone is offered: projects/list is the whole of
    // what it can browse, not the disk.
    projectFiles: async (projectPath) => {
      if (!listProjects().some((p) => p.path === projectPath)) return null
      return listProjectFiles(projectPath)
    },

    // Mentions go the same way as the composer's: each still in the text is
    // sent as the file it names (send keeps only real project files).
    prompt: async (chatId, blocks, sourceDeviceId, mentions) => {
      if (!visible(chatId)) return
      const { text, attachments } = decomposeBlocks(blocks)
      model.send(chatId, text, attachments, sourceDeviceId, mentions)
    },

    cancelChat: (chatId) => {
      if (visible(chatId)) model.cancel(chatId)
    },

    setConfig: async (chatId, configId, value) => {
      if (!visible(chatId)) return null
      const next = typeof value.stringValue === 'string' ? value.stringValue : value.boolValue
      if (next === undefined) return null
      const options = await model.setConfigValueForDevice(chatId, configId, next)
      return options === null ? null : (options as unknown as JSONValue)
    },

    // The phone drives its own account, subscription, and provider screens
    // through this one passthrough — it speaks the same `_spettro/*` methods
    // this process does, so nothing about that surface had to be restated for
    // it. Errors propagate as-is: the host turns them into JSON-RPC faults.
    agentCall: async (method, params) => {
      const result = await model.agentRaw(method, params)
      if (MUTATING_EXTENSION_METHODS.has(method)) {
        void model.refreshExtensions().catch(() => {
          // Best-effort mirror; the phone already has the authoritative answer.
        })
      }
      return result
    },

    resolvePermission: (promptId, selectedOptionId, deviceId) => {
      if (selectedOptionId !== null) {
        model.resolvePermission(promptId, selectedOptionId, deviceId)
      } else {
        model.dismissPermission(promptId, deviceId)
      }
    },

    answerQuestion: (promptId, answers, deviceId) => {
      model.answerQuestion(promptId, toQuestionAnswers(answers), deviceId)
    },

    agentReady: () => model.agentReady(),

    pendingPrompts: () => model.pendingPrompts().filter((p) => !hidden(p.chatId)),

    events
  }
}

/** Splits a remote prompt's content blocks back into the text + attachments
 *  shape the shared send path takes (port of remotePrompt). */
function decomposeBlocks(blocks: ACPContentBlock[]): {
  text: string
  attachments: PromptAttachment[]
} {
  let text = ''
  const attachments: PromptAttachment[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      text += text === '' ? block.text : `\n${block.text}`
    } else if (block.type === 'image') {
      attachments.push({ data: block.data, mimeType: block.mimeType })
    }
  }
  return { text, attachments }
}

/** Lenient conversion of wire-shaped answers into ACPQuestionAnswer[].
 *  null (or anything that isn't an array) declines the form. */
function toQuestionAnswers(raw: JSONValue | null): ACPQuestionAnswer[] | null {
  if (raw === null || !Array.isArray(raw)) return null
  const answers: ACPQuestionAnswer[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const obj = entry as { [key: string]: JSONValue }
    const questionId =
      typeof obj.questionId === 'string'
        ? obj.questionId
        : typeof obj.id === 'string'
          ? obj.id
          : null
    if (questionId === null) continue
    const notes = typeof obj.notes === 'string' ? obj.notes : undefined
    const text = typeof obj.text === 'string' ? obj.text : undefined
    const kind = typeof obj.kind === 'string' ? obj.kind : undefined
    if (kind === 'custom' || (kind === undefined && text !== undefined)) {
      const answer: ACPQuestionAnswer = { questionId, kind: 'custom', text: text ?? '' }
      if (notes !== undefined) answer.notes = notes
      answers.push(answer)
    } else {
      const optionIds = Array.isArray(obj.optionIds)
        ? obj.optionIds.filter((v): v is string => typeof v === 'string')
        : []
      const optionId = typeof obj.optionId === 'string' ? obj.optionId : undefined
      const ids = optionIds.length > 0 ? optionIds : optionId !== undefined ? [optionId] : []
      const answer: ACPQuestionAnswer = { questionId, kind: 'option', optionIds: ids }
      if (optionId !== undefined) answer.optionId = optionId
      if (notes !== undefined) answer.notes = notes
      answers.push(answer)
    }
  }
  return answers
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
