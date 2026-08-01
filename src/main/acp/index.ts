// Public surface of the ACP layer (main process): subprocess + JSON-RPC
// transport (AcpConnection), typed facade (AcpAgent), and the wire parsers.

export { AcpConnection, AcpError } from './connection'
export { AcpAgent } from './agent'
export {
  parseConfigOption,
  parseConfigOptions,
  parseCommand,
  parseCommands,
  parsePlanEntry,
  parsePlan,
  parseUsage,
  parseToolCallEvent,
  parseSessionUpdate,
  parsePermissionRequest,
  parseQuestionRequest,
  parseQuestionFromPermission
} from './parse'
