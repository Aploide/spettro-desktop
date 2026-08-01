// The seam between the remote server and whatever actually holds the
// conversations — port of RemoteHostBridge.swift.
//
// RemoteHost deals in sockets, pairing, and JSON; it knows nothing about the
// AppModel or the agent. Everything it needs from the app is behind this
// interface, which the model layer implements. This is what keeps a phone's
// prompt on the same code path as one typed locally: the bridge hands work to
// the model, so the transcript, persistence, and busy state update exactly
// once for every attached screen.
//
// Shape notes for the implementor:
//  * `openChat`'s `configOptions` / `commands` / `plan` / `usage` ride to the
//    phone inside the chats/open result. They are normalized on the way out
//    (see normalize* in src/shared/remote.ts), so either the shared parsed
//    shapes or the Swift wire shapes are acceptable here.
//  * Event timestamps are ms epoch; the host converts to RFC3339 on the wire.
//  * Chat ids must be UUID strings (the iOS client decodes them as UUID).

import type { EventEmitter } from 'events'
import type { ACPContentBlock, JSONValue } from '../../shared/acp'
import type { ChatSummary, StoredSession } from '../../shared/model'

export interface RemoteBridge {
  listChats(): ChatSummary[]
  openChat(chatId: string): { chat: StoredSession; configOptions: JSONValue; commands: JSONValue; plan: JSONValue; usage: JSONValue | null; isBusy: boolean } | null
  closeChat(chatId: string): void
  newChat(projectPath: string): ChatSummary
  deleteChat(chatId: string): void
  flagChat(chatId: string, flags: { isPinned?: boolean; isArchived?: boolean }): void
  listProjects(): { path: string; name: string }[]
  prompt(chatId: string, blocks: ACPContentBlock[], sourceDeviceId: string): Promise<void>
  cancelChat(chatId: string): void
  setConfig(chatId: string, configId: string, value: { stringValue?: string; boolValue?: boolean }): Promise<void>
  agentCall(method: string, params: JSONValue): Promise<JSONValue>
  resolvePermission(promptId: string, selectedOptionId: string | null, deviceId: string): void
  answerQuestion(promptId: string, answers: JSONValue | null, deviceId: string): void
  agentReady(): boolean
  events: EventEmitter // 'chat-update'(chatId, rawUpdate) 'chat-user'(chatId, text, attachments, timestamp, sourceDeviceId|null) 'chat-state'(summary, extra?) 'chat-removed'(chatId) 'host-state'({agentReady,shuttingDown,message?}) 'permission-ask'(promptId, chatId|null, raw) 'permission-resolved'(promptId, resolvedBy|null) 'question-ask'(promptId, chatId|null, raw) 'question-resolved'(promptId, resolvedBy|null) 'agent-notification'(method, params)
}
