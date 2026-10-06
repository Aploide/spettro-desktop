// The slash commands in words a non-developer can choose between.
//
// The CLI describes its commands for a terminal (internal/acp/commands.go):
// lowercase, in its own vocabulary ("set token budget per request"), with a
// usage hint beside each ("provider:model [api_key]"). The palette shows the
// sentence below instead and no usage hint — the /models one asked people to
// type an API key into the chat, where it would sit in the transcript and the
// session history. A command this file doesn't know keeps the CLI's text.

import type { ACPCommand } from '@shared/acp'

const COMMAND_COPY: Record<string, string> = {
  help: 'What you can type after /',
  mode: 'Switch between Plan, Coding and Ask',
  plan: 'Think it through and propose a plan first',
  models: 'See the models you can use — or pick one in the model menu',
  permission: 'How much Spettro may do without asking',
  thinking: 'How hard the model thinks before answering',
  ultra: 'Turn Ultra on or off — big tasks get a team of helpers',
  goal: 'Keep working on its own toward a goal you describe',
  memory: 'See or change what Spettro remembers',
  compact: 'Shorten the conversation so it can keep going',
  clear: 'Forget this conversation so far',
  diff: 'Show what Spettro changed in your files',
  workflows: 'Saved workflows: list, show or run one',
  'workflow-size': 'How big Ultra’s team of helpers can get',
  budget: 'Limit how much each request may spend',
  loop: 'Repeat a request on a schedule',
  tasks: 'This session’s task list',
  stats: 'How much this session has used',
  jobs: 'Commands still running in the background',
  hooks: 'Scripts set to run around Spettro’s actions',
  skills: 'The skills Spettro can use, and where each comes from',
  permissions: 'Permission level, with troubleshooting'
}

/** For developers: listed after everything else when "/" opens the menu,
 *  and still found by name. */
const ADVANCED = new Set(['budget', 'loop', 'tasks', 'stats', 'jobs', 'hooks', 'skills', 'permissions', 'workflow-size'])

/** Commands that run as they are from the palette rather than waiting for
 *  arguments: /models' argument form takes an API key. */
const RUN_BARE = new Set(['models'])

export function commandDescription(command: ACPCommand): string | undefined {
  return COMMAND_COPY[command.name] ?? command.description
}

/** Whether accepting the command in the palette leaves room for arguments
 *  ("/mode ") or runs it as it is. */
export function takesArguments(command: ACPCommand): boolean {
  return !!command.inputHint && !RUN_BARE.has(command.name)
}

/** The everyday commands first, the developer ones after; otherwise the
 *  CLI's order (the sort is stable). */
export function orderCommands(commands: ACPCommand[]): ACPCommand[] {
  const rank = (c: ACPCommand): number => (ADVANCED.has(c.name) ? 1 : 0)
  return [...commands].sort((a, b) => rank(a) - rank(b))
}
