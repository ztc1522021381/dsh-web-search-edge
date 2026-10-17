/**
 * Type declarations for dsh-web-search-free.
 *
 * The plugin registers one search provider (`free-scrape`) into the `ctx.web` seam. Host
 * code never imports these types directly — they exist so tooling and consumers can see
 * what this package exports without reading the implementation.
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

/** Resolved plugin configuration. */
export interface PluginConfig {
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

/** The Cordis plugin entry: `apply(ctx, config)` registers the provider. */
export const apply: (ctx: unknown, config: Partial<PluginConfig>) => unknown

/** The Cordis plugin name and the services it injects. */
export const name: 'web-search-free'
export const inject: readonly ['web']
