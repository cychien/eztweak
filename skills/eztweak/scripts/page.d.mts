export interface Png {
  width: number
  height: number
  channels: 3 | 4
  pixels: Buffer
}

export type Diff =
  | { same: true }
  | {
      same: false
      changed: number
      box: { left: number; top: number; right: number; bottom: number }
    }
  | { same: false; size: { before: string; after: string } }

export type Comparison = { name: string } & (Diff | { same: false; missing: 'before' | 'after' })

export const DESKTOP: { width: number; height: number }
export const MOBILE: { width: number; height: number }
export function shotName(path: string): string
export function decodePng(buffer: Buffer): Png
export function diffPngs(before: Buffer, after: Buffer): Diff
export function compare(beforeDir: string, afterDir: string): Comparison[]
export function describe(result: Comparison): string
export function findChrome(env?: Record<string, string | undefined>, platform?: string): string
export type ShotState = 'hover' | 'focus' | 'active'
export const STATES: ShotState[]
export function shotFiles(
  file: string,
  sizes: { width: number; height: number }[],
  page: boolean,
  states?: { state: ShotState; target: string }[],
): {
  size: { width: number; height: number }
  file: string
  kind: 'piece' | 'page' | ShotState
  target?: string
}[]
export function statesFrom(
  named: Record<string, string | true>,
  around: string | null,
): { state: ShotState; target: string }[]
export function parseViewport(raw: string | undefined): { width: number; height: number }
export function flags(args: string[]): { named: Record<string, string | true>; rest: string[] }

export interface StorageEntry {
  name: string
  value: string
}
export interface SignIn {
  cookies: { name: string; value: string; domain: string; path: string }[]
  storage: {
    localStorage: StorageEntry[]
    sessionStorage: StorageEntry[]
    indexedDB: unknown[]
  } | null
}
export function sameOrigin(a: string, b: string): boolean
export function signInFor(origin: string, state: unknown): SignIn | null
export function landedElsewhere(requested: string, landed: string): boolean
