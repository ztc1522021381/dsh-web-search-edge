/**
 * Type declarations for dsh-web-search-edge.
 *
 * The plugin registers one search provider (`free-scrape`) into the `ctx.web` seam. Host
 * code never imports these types directly — they exist so tooling and consumers can see
 * what this package exports without reading the implementation.
 *
 * Kernel compatibility: dsh >= 0.2.1-rc.1. From that release every field of this plugin's
 * `Config` is declared `.volatile()`, so the kernel passes `apply` a resolved Config whose
 * fields are live accessors (`config.maxResults.get()`) instead of plain values, and a
 * volatile-only config change is committed into the running fiber without a remount.
 */

/** One search result source, in the shape the `ctx.web` seam expects. */
export interface WebSearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
}

/** The result of one search through the provider. */
export interface WebSearchResult {
  readonly content?: string
  readonly sources: readonly WebSearchSource[]
  readonly truncated: boolean
}

/** A request the provider accepts. */
export interface WebSearchRequest {
  readonly query: string
  readonly maxResults?: number
}

/** The provider contract the `ctx.web` seam calls. */
export interface WebSearchProvider {
  readonly id: string
  available(): boolean
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}

/** A long-lived headless Edge driven over the DevTools protocol. */
export class EdgeBrowserPool {
  constructor(options?: { browserPath?: string; idleMs?: number; launchTimeoutMs?: number })
  stop(): Promise<void>
  render(url: string, options?: { timeoutMs?: number; settleMs?: number; signal?: AbortSignal }): Promise<string>
}

/** The keyless search provider. */
export class FreeSearchProvider implements WebSearchProvider {
  readonly id: 'free-scrape'
  constructor(readOptions: () => Record<string, unknown>)
  available(): boolean
  engineStatus(): string[]
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}

/**
 * A live accessor a `.volatile()` schema field resolves to. `apply` must read it with `get()`;
 * reading the field itself yields this object, not the configured value.
 */
export interface Volatile<T> {
  get(): T
}

/**
 * The resolved configuration `apply` receives. Every field is volatile, so each one is a live
 * accessor rather than a plain value — use {@link readField} or {@link readOptions} to unwrap.
 */
export interface PluginConfig {
  readonly engines: Volatile<readonly string[]>
  readonly maxResults: Volatile<number>
  readonly maxPerSite: Volatile<number>
  readonly timeoutMs: Volatile<number>
  readonly cooldownMs: Volatile<number>
  readonly minAnchorCoverage: Volatile<number>
  readonly transport: Volatile<'auto' | 'browser' | 'http'>
  readonly browserPath: Volatile<string>
  readonly browserTimeoutMs: Volatile<number>
  readonly debugDomDir: Volatile<string>
}

/** Plugin configuration after the volatile accessors have been unwrapped. */
export interface ResolvedOptions {
  readonly engines: readonly string[]
  readonly maxResults: number
  readonly maxPerSite: number
  readonly timeoutMs: number
  readonly cooldownMs: number
  readonly minAnchorCoverage: number
  readonly transport: 'auto' | 'browser' | 'http'
  readonly browserPath: string
  readonly browserTimeoutMs: number
  readonly debugDomDir: string
}

/** Unwrap one resolved config field: a volatile accessor is read through `get()`, a plain value as-is. */
export function readField<T>(config: unknown, key: string): T

/** Unwrap every field and apply the plugin's defaults and clamping rules. */
export function readOptions(config: unknown): ResolvedOptions

/** The Cordis plugin entry: `apply(ctx, config)` registers the provider. */
export const apply: (ctx: unknown, config: PluginConfig) => unknown

/** Engines queried when the config names none. */
export const DEFAULT_ENGINES: readonly string[]

export const DEFAULT_MAX_RESULTS: number
export const DEFAULT_MAX_PER_SITE: number
export const DEFAULT_TIMEOUT_MS: number
export const DEFAULT_COOLDOWN_MS: number
export const DEFAULT_MIN_ANCHOR_COVERAGE: number
export const DEFAULT_BROWSER_TIMEOUT_MS: number

/** The provider id this plugin registers into `ctx.web`. */
export const FREE_SEARCH_PROVIDER_ID: 'free-scrape'

/** The Cordis plugin name and the services it injects. */
export const name: 'web-search-edge'
export const inject: readonly ['web']
