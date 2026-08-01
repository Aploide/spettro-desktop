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
import type { RemoteBridge } from '../remote/bridge'
import type { AppModel, PromptAttachment } from './appModel'

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

  // Re-emit the model's remote-facing events under the bridge's names.
  const forward = (from: string, to: string): void => {
    model.on(from, (...args: unknown[]) => {
      events.emit(to, ...args)
    })
  }
  forward('chat-update-raw', 'chat-update')
  forward('chat-user', 'chat-user')
  forward('chat-state', 'chat-state')
  forward('chat-removed-remote', 'chat-removed')
  forward('host-state', 'host-state')
  forward('permission-ask', 'permission-ask')
  forward('permission-resolved', 'permission-resolved')
  forward('question-ask', 'question-ask')
  forward('question-resolved', 'question-resolved')
  forward('agent-notification', 'agent-notification')

  return {
    listChats: () => model.sessions.map((s) => s.summary()),

    openChat: (chatId) => {
      const session = model.sessionById(chatId)
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
      model.closeChat(chatId)
    },

    flagChat: (chatId, flags) => {
      model.flagChat(chatId, flags)
    },

    listProjects: () => {
      const counts = new Map<string, number>()
      for (const session of model.sessions) {
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
    },

    prompt: async (chatId, blocks, sourceDeviceId) => {
      const { text, attachments } = decomposeBlocks(blocks)
      model.send(chatId, text, attachments, sourceDeviceId)
    },

    cancelChat: (chatId) => {
      model.cancel(chatId)
    },

    setConfig: async (chatId, configId, value) => {
      if (typeof value.stringValue === 'string') {
        await model.setConfigValue(chatId, configId, value.stringValue)
      } else if (typeof value.boolValue === 'boolean') {
        await model.setConfigValue(chatId, configId, value.boolValue)
      }
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
