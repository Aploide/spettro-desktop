import type { SpettroBridge } from '../shared/ipc'

declare global {
  interface Window {
    spettro: SpettroBridge
  }
}

export {}
