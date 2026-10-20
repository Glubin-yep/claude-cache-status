export type CacheInfo = { hit: number; read: number; written: number; at: number }
export type CtxInfo = { tokens: number; window: number; percent: number; compactAt: number | null }
export type LimitInfo = { kind: string; percent: number; resetsAt: number | null }
export type Totals = { read: number; written: number; cost: number | null }

declare module 'claude-code' {
  interface PluginState {
    'cache-status': {
      info: CacheInfo | null
      now: number
      ctx: CtxInfo | null
      hist: number[]
      limits: LimitInfo[]
      totals: Totals
      isCompact: boolean
      isAlert: boolean
    }
  }
}
