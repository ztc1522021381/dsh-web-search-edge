/**
 * dsh-web-search-edge — a keyless, zero-cost `web_search` backend for DeepSeek Harness.
 *
 * Why this exists: the shipped `deepseek-official` search provider implements search as a
 * full auxiliary Messages call carrying the server-side `web_search_20250305` tool, because
 * DeepSeek publishes no dedicated search endpoint. Every search therefore bills one model
 * turn (the input side being the fetched page text). This provider reads ordinary result
 * pages instead and normalizes them into the `WebSearchResult` shape the `ctx.web` seam
 * expects — no API key, no model call, no bill.
 *
 * It registers into the same `ctx.web` seam, so `dsh-tool-web` still owns the model-facing
 * `web_search` contract and nothing else in the composition changes.
 *
 * ## Transports
 *
 *   browser — the locally installed Edge is driven headless:
 *             `msedge --headless=new --dump-dom <url>`. This is the default lane, because the
 *             engines worth using are client-rendered: their result cards do not exist in the
 *             bytes the server sends, so no amount of HTTP scraping can see them. Runs in a
 *             throwaway profile directory, never the user's real Edge profile.
 *   http    — plain `fetch`, ~0.2–1.5 s. Kept for engines that answer completely in HTML,
 *             and as the fallback when no browser is installed.
 *
 * ## Engines
 *
 *   shenma (m.sm.cn)  — Shenma/UC. Best Chinese quality here; renders into `qk-*` cards.
 *   bing   (bing.com) — Always reachable. Strong on technical/English, but it geolocates by
 *                       source IP, so local Chinese queries can drift to another city.
 *
 * @module dsh-web-search-edge
 */

import z from '@deepseek-ai/schemastery'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
const name = 'web-search-edge'

/** The web seam this provider registers into. */
const inject = ['web']

/** Stable provider id; select it with `searchProvider: free-scrape`. */
const FREE_SEARCH_PROVIDER_ID = 'free-scrape'

/* Headless Edge appends `HeadlessEdg/...` to its own UA and several engines refuse that, so a
 * current desktop Edge UA is supplied explicitly. */
const EDGE_VERSION = '140.0.0.0'
const DESKTOP_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${EDGE_VERSION} Safari/537.36 Edg/${EDGE_VERSION}`

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const DEFAULT_MAX_RESULTS = 8
const DEFAULT_MAX_PER_SITE = 3
const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_BROWSER_TIMEOUT_MS = 30000

/** Refuse to buffer more than this from one headless DOM dump. */
const BROWSER_MAX_DOM_BYTES = 12 * 1024 * 1024

/**
 * How long a blocked engine is skipped. These engines flag a source IP for several minutes
 * after a burst, so asking again sooner only burns latency and keeps the address flagged.
 */
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000

const DEFAULT_MIN_ANCHOR_COVERAGE = 0.75

/** Interstitials served instead of results. Each of these means "this lane is blocked". */
const BLOCK_MARKERS = [
  /antispider/i,
  /wappass\.baidu\.com/i,
  /访问异常/,
  /访问受限/,
  /百度安全验证/,
  /安全验证/,
  /请输入验证码/,
  /slidetounlock/i,
  /nc_iconfont/i,
  /verify-bar-area/i,
  /verify-img-panel/i,
  /访问过于频繁/,
  /unusual traffic/i,
  /are you a robot/i,
  /id="captcha"/i,
]

const Config = z.object({
  /** Engines queried concurrently. Known ids: shenma, bing. */
  engines: z.array(z.string()).default(['shenma', 'bing']),
  maxResults: z.number().step(1).min(1).max(20).default(DEFAULT_MAX_RESULTS),
  /** Cap on how many sources one site may contribute, so one site cannot fill the result set. */
  maxPerSite: z.number().step(1).min(1).max(20).default(DEFAULT_MAX_PER_SITE),
  /** Per-request HTTP budget. */
  timeoutMs: z.number().step(1).min(1000).default(DEFAULT_TIMEOUT_MS),
  /** How long an engine is skipped after it answers with an anti-bot page. */
  cooldownMs: z.number().step(1).min(0).default(DEFAULT_COOLDOWN_MS),
  /**
   * Minimum share (0–1) of the query's distinctive terms the returned sources must cover.
   * Guards against a geolocated engine answering a different city or product with confident
   * links. `0` disables the check.
   */
  minAnchorCoverage: z.number().min(0).max(1).default(DEFAULT_MIN_ANCHOR_COVERAGE),
  /**
   * Which lane to use per engine:
   *   `auto`    — each engine takes the lane that works for it: Shenma is client-rendered, so it
   *               is rendered by Edge (~4–5 s); Bing answers fully in HTML, so it is fetched
   *               over HTTP (~0.3 s). This is the default because it is both correct and fast.
   *   `browser` — force every engine through Edge. Slowest, but immune to HTTP-level blocking.
   *   `http`    — force plain fetch. Fastest; an engine that renders its results will report
   *               "no parseable results" instead of silently returning nothing.
   */
  transport: z.union([z.const('auto'), z.const('browser'), z.const('http')]).default('auto'),
  /** Explicit Edge/Chromium executable; empty means auto-detect. */
  browserPath: z.string().default(''),
  browserTimeoutMs: z.number().step(1).min(2000).default(DEFAULT_BROWSER_TIMEOUT_MS),
  /** Keep each rendered page's DOM under this path for debugging. Empty disables. */
  debugDomDir: z.string().default(''),
})

/* ------------------------------------------------------------------ */
/* text helpers                                                        */
/* ------------------------------------------------------------------ */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  thinsp: ' ', hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘',
  rsquo: '’', middot: '·', copy: '©', reg: '®', trade: '™',
}

function decodeEntities(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&([a-z]+);/gi, (whole, key) => NAMED_ENTITIES[key.toLowerCase()] ?? whole)
}

/**
 * Strip markup and entities, and collapse the spacing that highlighting leaves behind.
 *
 * Engines wrap matched words in `<em>`/`<b>`: `GX<em>Works2</em>` is one word on screen, so the
 * inline tag itself is dropped rather than turned into a space — otherwise "GX Works2" stops
 * matching the query term `gxworks2`. Chinese text carries no word spaces, so spaces left
 * between two CJK characters are removed too.
 */
function stripTags(value) {
  return decodeEntities(String(value))
    .replace(/<\/?(?:em|b|strong|i|u|font|mark|span)\b[^>]*>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .replace(
      /([\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef])\s+(?=[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef])/g,
      '$1',
    )
    .replace(/\s+([，。、；：！？）》」』】·,.;:!?)\]])/g, '$1')
    .replace(/([（《「『【])\s+/g, '$1')
    .trim()
}

function clampText(value, max) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (text.length === 0) return undefined
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** First non-empty capture among several candidate patterns. */
function firstMatch(block, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(block)
    if (match !== null && match[1] !== undefined) return match[1]
  }
  return undefined
}

/** Read a JSON attribute such as `data-reco="{&quot;norm_url&quot;:...}"`. */
function readJsonAttribute(block, attribute) {
  const raw = new RegExp(`${attribute}="([^"]*)"`).exec(block)?.[1]
  if (raw === undefined) return undefined
  try {
    return JSON.parse(decodeEntities(raw))
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* URLs                                                                */
/* ------------------------------------------------------------------ */

const TRACKING_PARAMS = new Set([
  'spm', 'from', 'src', 'ref', 'refer', 'referrer', 'fr', 'pos', 'idx', 'query', 'si',
  's_from', 'entryid', 'clicktime', 'sessionid', 'wfr', 'forbs', 'msclkid', 'gclid', 'fbclid',
  'vd_source', 'share_source', 'share_medium', 'sc', 'ps', 'qt', 'l', 'cid', 'hid', 'sps', 'kt',
])

/**
 * Search-engine properties whose URLs are never answers: the SERP itself, its onebox panels
 * and its redirector. Matched by domain suffix, because the engines answer with their own
 * subdomains (`wenku.csdn.net` is content, but `image.sm.cn` is a panel).
 */
const SEARCH_DOMAINS = [
  'sm.cn', 'bing.com', 'bing.net', 'google.com', 'google.com.hk', 'gstatic.com',
  'yandex.com', 'yandex.ru', 'duckduckgo.com', 'search.yahoo.com', 'so.toutiao.com',
  'toutiao.com', 'sogou.com', 'quark.sm.cn', 'uc.cn', 'baidu.com',
]

/** Hosts inside a dropped domain that do serve real content. */
const CONTENT_HOSTS = new Set([
  'baike.baidu.com', 'zhidao.baidu.com', 'tieba.baidu.com', 'jingyan.baidu.com',
  'wenku.baidu.com', 'pan.baidu.com', 'developer.baidu.com', 'ai.baidu.com', 'cloud.baidu.com',
])

function isSearchHost(url) {
  try {
    const host = new URL(url).host.toLowerCase()
    if (host === 'baidu.com' || host === 'www.baidu.com' || host === 'm.baidu.com') return true
    if (CONTENT_HOSTS.has(host)) return false
    return SEARCH_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
  } catch {
    return false
  }
}

/** Redirect wrappers that must be unwrapped before the URL means anything. */
function isRedirector(url) {
  try {
    const { host, pathname } = new URL(url)
    if (host.endsWith('bing.com')) return pathname.startsWith('/ck/')
    if (host.endsWith('baidu.com')) return pathname.startsWith('/link')
    if (host.endsWith('sm.cn')) return pathname.startsWith('/jump') || pathname.startsWith('/link')
    if (host.endsWith('sogou.com')) return pathname.startsWith('/link')
    return false
  } catch {
    return false
  }
}

/** Canonical dedupe key: no hash, no tracking params, lowercase host, no trailing slash. */
function normalizeUrl(url) {
  try {
    const parsed = new URL(url)
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
        parsed.searchParams.delete(key)
      }
    }
    const path = parsed.pathname.replace(/\/+$/, '')
    const search = parsed.searchParams.toString()
    return `${parsed.host.toLowerCase()}${path}${search.length === 0 ? '' : `?${search}`}`.toLowerCase()
  } catch {
    return String(url).toLowerCase()
  }
}

/**
 * The registrable site a URL belongs to, used only to spread results across publishers.
 *
 * `blog.csdn.net` and `bbs.csdn.net` are different hosts but one publisher; counting them
 * separately would let one site occupy every slot while looking diverse. Two-label public
 * suffixes are enough here and avoid shipping a full PSL snapshot.
 */
const MULTI_PART_SUFFIXES = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'com.hk', 'com.tw', 'com.au', 'co.uk',
  'co.jp', 'co.kr', 'co.in', 'com.br', 'ne.jp', 'or.jp',
])

function siteOf(url) {
  let host
  try {
    host = new URL(url).host.toLowerCase()
  } catch {
    return String(url).toLowerCase()
  }
  const labels = host.split('.')
  if (labels.length <= 2) return host
  const lastTwo = labels.slice(-2).join('.')
  return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo
}

/** Bing wraps answered links as `/ck/a?...&u=a1<base64url>`; recover the target. */
function unwrapBingUrl(href) {
  try {
    const parsed = new URL(href, 'https://www.bing.com')
    if (!parsed.pathname.startsWith('/ck/')) return href
    const encoded = parsed.searchParams.get('u')
    if (encoded === null || !encoded.startsWith('a1')) return href
    const base64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    return /^https?:\/\//i.test(decoded) ? decoded : href
  } catch {
    return href
  }
}

/** Shenma wraps links as `/jump?u=<percent-encoded target>`; recover the target. */
function unwrapShenmaUrl(href) {
  try {
    const parsed = new URL(href, 'https://m.sm.cn')
    if (!parsed.pathname.startsWith('/jump') && !parsed.pathname.startsWith('/link')) return href
    const target = parsed.searchParams.get('u') ?? parsed.searchParams.get('url')
    if (target === null) return href
    return /^https?:\/\//i.test(target) ? target : href
  } catch {
    return href
  }
}

function sanitizeHref(href) {
  if (href === undefined) return undefined
  const url = decodeEntities(href).trim()
  if (!/^https?:\/\//i.test(url)) return undefined
  return unwrapBingUrl(unwrapShenmaUrl(url))
}

/**
 * A readable title for a hit whose engine gave none: the host plus the last meaningful path
 * segment, so the model can tell a forum thread from a product page without fetching it.
 */
function readableFallbackTitle(url) {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname
      .split('/')
      .filter((part) => part.length > 0)
      .map((part) => decodeURIComponent(part).replace(/\.[a-z0-9]{2,5}$/i, ''))
      .filter((part) => !/^\d{1,4}$/.test(part))
    const tail = segments.at(-1)
    const host = parsed.host.replace(/^www\./i, '')
    return clampText(tail === undefined ? host : `${host} — ${tail.replace(/[-_+]+/g, ' ')}`, 160) ?? host
  } catch {
    return String(url)
  }
}

/* ------------------------------------------------------------------ */
/* relevance: terms, distinctiveness, ranking                          */
/* ------------------------------------------------------------------ */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
const CJK_ONLY = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u

/**
 * Split a query into matchable terms. Latin words of 2+ characters stay whole; a run of CJK
 * is expanded into overlapping bigrams so a Chinese phrase still matches a page that
 * reorders or pads it. A single-character CJK run stays as-is.
 */
function queryTerms(query) {
  const terms = new Set()
  for (const raw of String(query).toLowerCase().split(/[\s,，、.。:：;；!！?？()（）[\]"'“”‘’/\\|+~-]+/)) {
    const token = raw.trim()
    if (token.length === 0) continue
    if (CJK_ONLY.test(token)) {
      if (token.length === 1) terms.add(token)
      else for (let i = 0; i < token.length - 1; i++) terms.add(token.slice(i, i + 2))
      continue
    }
    if (token.length >= 2) terms.add(token)
  }
  return [...terms]
}

/**
 * How distinctive a term is before any candidate is seen: longer tokens, tokens carrying
 * digits (model numbers, error codes, versions) and tokens mixing letters and digits are the
 * ones a relevant page usually repeats. Generic English words score lowest.
 */
function intrinsicWeight(term) {
  let weight = 1
  weight += Math.min(term.length, 10) / 10
  if (/\d/.test(term)) weight += 0.8
  if (/[a-z]/.test(term) && /\d/.test(term)) weight += 0.4
  if (CJK.test(term)) weight += 0.3
  return weight
}

function haystackOf(source) {
  return `${source.title ?? ''} ${source.url ?? ''} ${source.snippet ?? ''}`.toLowerCase()
}

/**
 * Does `term` occur in `haystack` as itself?
 *
 * A plain `includes` is wrong for short Latin tokens: `st` would match `stm32`, `install` and
 * `most`, so "梯形图转 ST 语言" would happily accept an STM32 page. When the term starts or
 * ends with a Latin letter or digit, that boundary must be real; CJK on either side counts as
 * a boundary because Chinese is written without spaces.
 */
function mentions(haystack, term) {
  if (term.length === 0) return false
  if (CJK.test(term)) return haystack.includes(term)
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(haystack)
}

/** How many query terms a source mentions. */
function relevanceScore(source, terms) {
  const haystack = haystackOf(source)
  let score = 0
  for (const term of terms) if (mentions(haystack, term)) score++
  return score
}

/** Coverage-and-length gate retained for callers that want a boolean. */
function isRelevant(source, terms) {
  if (terms.length === 0) return true
  const haystack = haystackOf(source)
  const matched = terms.filter((term) => mentions(haystack, term))
  if (matched.length === 0) return false
  if (matched.length < Math.ceil(terms.length / 2)) return false
  if (terms.some((term) => CJK.test(term))) return true
  const longest = Math.max(...terms.map((term) => term.length))
  return matched.some((term) => term.length === longest)
}

/**
 * Score every candidate against the query, then keep the on-topic ones in descending order.
 *
 * The distinguishing idea: a term that appears in *every* candidate ("下载", "server") says
 * nothing, while a term that appears in a few ("works2", "stm32f103", "梯形图") is what makes
 * an answer relevant. So each term is weighted by `1 / (0.5 + documentFrequency / candidates)`
 * — inverse document frequency over the merged result set — and a source must match at least
 * one such distinctive term, or it is dropped no matter how many filler words it shares.
 *
 * Title matches count double and URL matches half again, because a page whose *title* names
 * the query is far more likely to be the answer than one that merely mentions it in a snippet.
 */
function rankSources(candidates, terms, { limit }) {
  if (candidates.length === 0) return []
  if (terms.length === 0) return candidates.slice(0, limit)

  const haystacks = candidates.map((source) => ({
    all: haystackOf(source),
    title: `${source.title ?? ''}`.toLowerCase(),
    url: `${source.url ?? ''}`.toLowerCase(),
  }))

  const df = new Map()
  for (const term of terms) {
    let count = 0
    for (const probe of haystacks) if (mentions(probe.all, term)) count++
    df.set(term, count)
  }

  const total = candidates.length
  const distinctive = new Set()
  for (const term of terms) {
    const count = df.get(term) ?? 0
    if (count === 0) continue
    if (total <= 2 ? true : count <= Math.max(1, Math.ceil(total * 0.4))) distinctive.add(term)
  }
  if (distinctive.size === 0) for (const term of terms) distinctive.add(term)

  const scored = []
  for (let index = 0; index < candidates.length; index++) {
    const probe = haystacks[index]
    let score = 0
    let anchors = 0
    let matched = 0
    for (const term of terms) {
      const count = df.get(term) ?? 0
      if (count === 0) continue
      if (!mentions(probe.all, term)) continue
      matched++
      const weight = intrinsicWeight(term) / (0.5 + count / total)
      let hit = 1
      if (mentions(probe.title, term)) hit += 1
      if (mentions(probe.url, term)) hit += 0.5
      score += weight * hit
      if (distinctive.has(term)) anchors++
    }
    if (anchors === 0) continue
    // With one or two candidates there is no population to judge rarity against, so every
    // matched term looks distinctive. Fall back to plain coverage there: a page matching one
    // word of a four-word query is a filler hit, not an answer.
    if (total <= 2 && matched * 2 < terms.length) continue
    const phrase = terms.length > 1 && terms.every((term) => mentions(probe.title, term))
    if (phrase) score *= 1.15
    scored.push({ source: candidates[index], score, index })
  }

  scored.sort((a, b) => b.score - a.score || a.index - b.index)

  const best = scored[0]?.score ?? 0
  const cutoff = best * 0.45
  const kept = scored.filter((entry) => entry.score >= cutoff).map((entry) => entry.source)
  if (kept.length > 0) return kept.slice(0, limit)
  return scored.slice(0, limit).map((entry) => entry.source)
}

/**
 * Which query terms actually distinguish an answer, judged against a candidate pool.
 *
 * A term the pool barely mentions — or never mentions, which is the same signal at its
 * strongest — is the one that decides whether a page answers the question; a term the pool
 * always mentions ("天气") says nothing. A term with zero document frequency stays an anchor on
 * purpose: if the engine answered about another city, that city's name is absent from every
 * candidate, and discarding it as unmatched would let the wrong answer pass.
 */
function anchorTerms(terms, reference) {
  if (terms.length === 0) return []
  if (reference.length === 0) return [...terms]
  const haystacks = reference.map((source) => haystackOf(source))
  const total = reference.length
  const threshold = Math.max(1, Math.ceil(total * 0.4))
  const anchors = []
  for (const term of terms) {
    let count = 0
    for (const haystack of haystacks) if (mentions(haystack, term)) count++
    if (count <= threshold) anchors.push(term)
  }
  return anchors
}

/**
 * Share of the query's anchor terms the returned sources cover.
 *
 * An engine that geolocates answers "天气 上海 明天" with pages about whichever city its IP
 * sits in; those share every word except the distinguishing one. Returning them silently is
 * worse than returning few results, because the model would report the wrong city and cite it.
 * `reference` is the pool the anchors were judged against — pass the candidate pool, not the
 * final list: on a short list every surviving term looks common, and the absent ones — the
 * distinguishing ones — would drop out of consideration entirely.
 */
function anchorCoverage(sources, terms, reference = sources) {
  if (terms.length === 0 || sources.length === 0) return 1
  const anchors = anchorTerms(terms, reference)
  if (anchors.length === 0) return 1
  const haystacks = sources.map((source) => haystackOf(source))
  const covered = anchors.filter((term) => haystacks.some((haystack) => mentions(haystack, term)))
  return covered.length / anchors.length
}

/**
 * Take the best `limit` sources while keeping any single *site* from crowding out the rest.
 *
 * One publisher can supply most relevant hits for a technical query, and handing the model one
 * site's pages is worse than a mixed set, because an answer built from one source cannot be
 * cross-checked. Surplus slots refill from the sources held back, so the cap never shortens
 * the result unless there is genuinely nothing else.
 */
function takeDiverse(ranked, limit, maxPerSite) {
  if (ranked.length <= limit) return ranked.slice(0, limit)
  const cap = Number.isInteger(maxPerSite) && maxPerSite > 0 ? maxPerSite : limit
  if (cap >= limit) return ranked.slice(0, limit)

  const perSite = new Map()
  const picked = []
  const held = []
  for (const source of ranked) {
    if (picked.length >= limit) break
    const site = siteOf(source.url)
    const used = perSite.get(site) ?? 0
    if (used >= cap) {
      held.push(source)
      continue
    }
    perSite.set(site, used + 1)
    picked.push(source)
  }
  for (const source of held) {
    if (picked.length >= limit) break
    picked.push(source)
  }
  return picked
}

/* ------------------------------------------------------------------ */
/* transport: http                                                     */
/* ------------------------------------------------------------------ */

class BlockedError extends Error {
  constructor(message, { body = '' } = {}) {
    super(message)
    this.name = 'BlockedError'
    this.blocked = true
    this.bodySample = body.slice(0, 400)
  }
}

function detectsBlock(body) {
  if (typeof body !== 'string' || body.length === 0) return false
  const head = body.slice(0, 4000)
  return BLOCK_MARKERS.some((marker) => marker.test(head))
}

function linkSignals(signal) {
  const controller = new AbortController()
  const forward = () => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) forward()
    else signal.addEventListener('abort', forward, { once: true })
  }
  return {
    controller,
    dispose: () => {
      if (signal !== undefined) signal.removeEventListener('abort', forward)
    },
  }
}

async function fetchText(url, { timeoutMs, signal, referer, accept, userAgent, cookie }) {
  const { controller, dispose } = linkSignals(signal)
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  try {
    const headers = {
      'user-agent': userAgent ?? DESKTOP_UA,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      accept:
        accept ??
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      'upgrade-insecure-requests': '1',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': referer === undefined ? 'none' : 'same-origin',
    }
    if (referer !== undefined) {
      headers.referer = referer
      headers['sec-fetch-user'] = '?1'
    }
    if (cookie !== undefined) headers.cookie = cookie
    const response = await fetch(url, { headers, redirect: 'follow', signal: controller.signal })
    const text = await response.text()
    return { status: response.status, text, finalUrl: response.url }
  } finally {
    clearTimeout(timer)
    dispose()
  }
}

/* ------------------------------------------------------------------ */
/* transport: the local Edge browser, kept warm over CDP               */
/* ------------------------------------------------------------------ */

function browserCandidates() {
  const fromEnv = [process.env.DSH_SEARCH_BROWSER, process.env.DSH_EDGE_PATH].filter(
    (value) => typeof value === 'string' && value.length > 0,
  )
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
      .filter((value) => typeof value === 'string' && value.length > 0)
    return [
      ...fromEnv,
      ...roots.map((root) => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
      ...roots.map((root) => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ]
  }
  if (process.platform === 'darwin') {
    return [
      ...fromEnv,
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  }
  return [
    ...fromEnv,
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/opt/microsoft/msedge/msedge',
  ]
}

/** Resolve the browser executable; `undefined` means the browser lane is unavailable. */
function resolveBrowser(explicitPath) {
  if (typeof explicitPath === 'string' && explicitPath.length > 0) {
    return existsSync(explicitPath) ? explicitPath : undefined
  }
  for (const candidate of browserCandidates()) {
    if (candidate.length > 0 && existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Kill a process and everything it spawned.
 *
 * `child.kill()` terminates only the direct child. A headless browser is a process *tree* —
 * one browser process, several renderer and service processes — and on Windows those children
 * survive their parent's death, which is how an idle-looking machine accumulates dozens of
 * stray Edge processes and a temp profile directory that can no longer be deleted. `taskkill
 * /T /F` is the reliable way to take the tree down.
 */
function killProcessTree(child) {
  return new Promise((resolve) => {
    if (child.pid === undefined || process.platform !== 'win32') {
      try {
        child.kill('SIGKILL')
      } catch {}
      resolve()
      return
    }
    const killer = spawn(
      'taskkill',
      ['/PID', String(child.pid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    )
    const done = () => resolve()
    killer.on('error', () => {
      // taskkill missing or denied: fall back to the direct kill and hope for the best.
      try {
        child.kill('SIGKILL')
      } catch {}
      done()
    })
    killer.on('close', done)
    // Never let a stuck taskkill hold the caller.
    setTimeout(done, 3000).unref?.()
  })
}

function sweepDirectory(directory) {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 })
  } catch {
    // Edge may still hold a file lock; retry off the event loop and never fail the search.
    setTimeout(() => {
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {}
    }, 2000).unref?.()
  }
}

/**
 * A one-connection WebSocket client for the DevTools protocol.
 *
 * The global `WebSocket` never releases its underlying socket after `close()` — the socket
 * keeps the host's event loop alive after the browser is gone, which turns an unloaded plugin
 * into a process the host has to force down. This client owns a plain `net`/`http` upgrade
 * socket it can destroy on demand, speaks the handful of frames CDP uses (text in, text out,
 * plus close), and holds nothing once `destroy()` runs.
 */
class CdpSocket {
  #socket

  #messages = []

  #waiters = []

  #closed = false

  #frames = []

  #buffer = Buffer.alloc(0)

  #onMessage = () => {}

  #onClose = () => {}

  constructor(url) {
    this.#onMessage = () => {}
  }

  /** Open the socket to `ws://127.0.0.1:<port><path>`. */
  connect(port, path) {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString('base64')
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        path,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
        agent: false,
      })
      request.on('upgrade', (response, socket) => {
        this.#socket = socket
        socket.on('data', (chunk) => this.#onData(chunk))
        socket.on('close', () => this.#handleClose())
        socket.on('error', () => this.#handleClose())
        resolve()
      })
      request.on('error', reject)
      request.setTimeout(5000, () => request.destroy(new Error('debugger upgrade timed out')))
      request.end()
    })
  }

  onMessage(listener) {
    this.#onMessage = listener
    // deliver anything already buffered
    while (this.#messages.length > 0) {
      const message = this.#messages.shift()
      listener(message)
    }
  }

  onClose(listener) {
    this.#onClose = listener
  }

  send(text) {
    if (this.#closed || this.#socket === undefined) return
    const payload = Buffer.from(text, 'utf8')
    const length = payload.length
    // RFC 6455: every client-to-server frame is masked with a 4-byte key. The DevTools
    // endpoint silently drops unmasked client frames, which looks like a dead connection.
    const mask = randomBytes(4)
    const masked = Buffer.allocUnsafe(length)
    for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i & 3]

    let header
    if (length < 126) {
      header = Buffer.from([0x81, 0x80 | length])
    } else if (length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x81
      header[1] = 0x80 | 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x81
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    this.#socket.write(Buffer.concat([header, mask, masked]))
  }

  /** Destroy the connection and release everything the socket holds. */
  destroy() {
    if (this.#closed) return
    this.#closed = true
    this.#messages.length = 0
    this.#waiters.length = 0
    if (this.#socket !== undefined) {
      this.#socket.removeAllListeners()
      this.#socket.destroy()
      this.#socket = undefined
    }
  }

  get closed() {
    return this.#closed
  }

  #handleClose() {
    if (this.#closed) return
    this.#closed = true
    this.#socket = undefined
    this.#onClose()
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    // decode every complete frame in the buffer
    for (;;) {
      const frame = this.#decodeFrame()
      if (frame === undefined) break
      if (frame.opcode === 0x1 || frame.opcode === 0x2 || frame.opcode === 0x0) {
        if (frame.opcode !== 0x0) this.#frames = []
        this.#frames.push(frame.payload)
        if (frame.fin) {
          const message = Buffer.concat(this.#frames).toString('utf8')
          this.#frames = []
          const listener = this.#onMessage
          if (listener !== undefined) listener(message)
        }
      } else if (frame.opcode === 0x8) {
        // server close: acknowledge nothing, just tear down
        this.#handleClose()
        return
      }
      // ping (0x9) / pong (0xA): CDP does not use them; ignore
    }
  }

  #decodeFrame() {
    const buffer = this.#buffer
    if (buffer.length < 2) return undefined
    const first = buffer[0]
    const second = buffer[1]
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let offset = 2
    let length = second & 0x7f
    if (length === 126) {
      if (buffer.length < 4) return undefined
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return undefined
      const big = buffer.readBigUInt64BE(2)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.#handleClose()
        return undefined
      }
      length = Number(big)
      offset = 10
    }
    // DevTools never masks frames it sends; if it ever did, we would need the 4-byte key.
    const maskLength = masked ? 4 : 0
    if (buffer.length < offset + maskLength + length) return undefined
    let payload = buffer.subarray(offset + maskLength, offset + maskLength + length)
    if (masked) {
      const key = buffer.subarray(offset, offset + 4)
      const unmasked = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i++) unmasked[i] = payload[i] ^ key[i & 3]
      payload = unmasked
    }
    this.#buffer = buffer.subarray(offset + maskLength + length)
    return { fin, opcode, payload }
  }
}

/**
 * One long-lived headless Edge, driven over the DevTools protocol.
 *
 * Spawn-per-search costs ~4 s of process start-up on every query, and `--dump-dom`'s
 * `--virtual-time-budget` never advances on a page that keeps a connection open — the render
 * then hangs until a hard kill, which is the long tail an interactive search cannot afford.
 * Keeping the process alive removes both: start-up is paid once, later renders run at full
 * speed, and navigation is bounded by an ordinary timeout instead of by virtual time.
 *
 * The browser lives in a throwaway profile directory — never the user's real profile,
 * history, cookies or extensions — and exits by itself once it has been idle past `idleMs`,
 * so no orphaned process is left behind after the last search.
 */
class EdgeBrowserPool {
  #browserPath

  #idleMs

  #launchTimeoutMs

  #child

  #profileDir

  #port

  #starting = null

  #idleTimer

  constructor({ browserPath, idleMs = 5 * 60 * 1000, launchTimeoutMs = 15000 } = {}) {
    this.#browserPath = browserPath
    this.#idleMs = idleMs
    this.#launchTimeoutMs = launchTimeoutMs
  }

  /** Kill the browser and delete its profile. Safe to call repeatedly. */
  async stop() {
    clearTimeout(this.#idleTimer)
    const child = this.#child
    this.#child = undefined
    this.#port = undefined
    if (child === undefined) return
    await killProcessTree(child)
    if (this.#profileDir !== undefined) {
      sweepDirectory(this.#profileDir)
      this.#profileDir = undefined
    }
  }

  #touchIdle() {
    clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => {
      this.stop().catch(() => {})
    }, this.#idleMs)
    this.#idleTimer.unref?.()
  }

  /** Port of the running browser, launching it first when needed. */
  async #ensure() {
    if (this.#port !== undefined) return this.#port
    if (this.#starting === null) {
      this.#starting = this.#launch().finally(() => {
        this.#starting = null
      })
    }
    return this.#starting
  }

  async #launch() {
    this.#profileDir = mkdtempSync(join(tmpdir(), 'dsh-search-'))
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--mute-audio',
      '--lang=zh-CN',
      // Shenma serves a captcha page to a renderer it can tell is automated. This flag and
      // the navigator cleanup below are what keep the DevTools-driven browser looking like
      // an ordinary one; without them the engine answers every query with a block.
      '--disable-blink-features=AutomationControlled',
      `--user-agent=${DESKTOP_UA}`,
      `--user-data-dir=${this.#profileDir}`,
      // 0 makes the browser pick a free port and write it to DevToolsActivePort.
      '--remote-debugging-port=0',
      'about:blank',
    ]
    const child = spawn(this.#browserPath, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    })
    child.on('exit', () => {
      // Whatever the reason, the next render must launch a fresh browser instead of writing
      // into a port that no longer answers.
      this.#port = undefined
      this.#starting = null
      if (this.#profileDir !== undefined) {
        sweepDirectory(this.#profileDir)
        this.#profileDir = undefined
      }
    })

    const portFile = join(this.#profileDir, 'DevToolsActivePort')
    const deadline = Date.now() + this.#launchTimeoutMs
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(`browser exited during start-up (code ${child.exitCode})`)
      }
      if (existsSync(portFile)) {
        const first = readFileSync(portFile, 'utf8').trim().split('\n')[0]
        const port = Number.parseInt(first, 10)
        if (Number.isInteger(port) && port > 0) {
          this.#child = child
          this.#port = port
          return port
        }
      }
      if (Date.now() > deadline) {
        await killProcessTree(child)
        sweepDirectory(this.#profileDir)
        this.#profileDir = undefined
        throw new Error('browser did not open a debugging port in time')
      }
      await new Promise((resolve) => setTimeout(resolve, 200).unref?.())
    }
  }

  /**
   * Render one URL and return its HTML.
   *
   * A target is created per call and closed afterwards, so each render starts from a clean
   * page (no cookies leaking between queries) while the browser process, and its cost, is
   * paid once. `settleMs` lets a client-rendered results list finish filling in; the load
   * event alone fires before the results exist on engines like Shenma.
   */
  async render(url, { timeoutMs = 20000, settleMs = 1200, signal } = {}) {
    const port = await this.#ensure()
    this.#touchIdle()

    const target = await this.#cdpJson('PUT', '/json/new?about:blank')
    const targetPath = new URL(target.webSocketDebuggerUrl).pathname + new URL(target.webSocketDebuggerUrl).search
    const socket = new CdpSocket()
    try {
      await socket.connect(port, targetPath)

      let seq = 0
      const pending = new Map()
      const listeners = new Set()
      socket.onMessage((text) => {
        let message
        try {
          message = JSON.parse(text)
        } catch {
          return
        }
        if (message.id !== undefined) {
          const waiter = pending.get(message.id)
          if (waiter !== undefined) {
            pending.delete(message.id)
            if (message.error !== undefined) waiter.reject(new Error(message.error.message))
            else waiter.resolve(message.result)
          }
        } else if (message.method !== undefined) {
          for (const listener of [...listeners]) listener(message)
        }
      })
      const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++seq
          pending.set(id, { resolve, reject })
          socket.send(JSON.stringify({ id, method, params }))
        })

      await send('Page.enable')
      // A DevTools-attached renderer sets navigator.webdriver, which several engines read as
      // "automated traffic" and answer with a captcha. Clear it before any page script runs.
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source:
          'Object.defineProperty(navigator, "webdriver", { get: () => undefined });' +
          'Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });' +
          'Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });' +
          'window.chrome = { runtime: {} };',
      })
      const loaded = new Promise((resolve) => {
        const listener = (message) => {
          if (message.method === 'Page.loadEventFired') {
            listeners.delete(listener)
            resolve()
          }
        }
        listeners.add(listener)
      })
      await send('Page.navigate', { url })
      // A page that keeps a connection open never fires load; the timeout keeps the render
      // bounded instead of hanging the way --virtual-time-budget could.
      await Promise.race([
        loaded,
        new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
      ])
      if (signal?.aborted) throw new Error('browser render aborted')
      await new Promise((resolve) => setTimeout(resolve, settleMs).unref?.())

      const { result } = await send('Runtime.evaluate', {
        expression: 'document.documentElement.outerHTML',
        returnByValue: true,
      })
      if (typeof result?.value !== 'string' || result.value.length === 0) {
        throw new Error('browser produced no DOM')
      }
      return result.value
    } finally {
      socket.destroy()
      this.#cdpJson('GET', `/json/close/${target.id}`).catch(() => {})
    }
  }

  /**
   * One request to the DevTools HTTP endpoint, on a socket that closes with the response.
   *
   * `fetch` keeps its connections alive in a global pool, and those sockets keep a stopped
   * process's event loop from draining — the difference between a plugin that unloads cleanly
   * and one the host has to tear down. `node:http` with a one-shot agent never lingers.
   */
  #cdpJson(method, path) {
    const port = this.#port
    if (port === undefined) return Promise.reject(new Error('browser is not running'))
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port, path, method, agent: false },
        (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8')
            if (response.statusCode < 200 || response.statusCode >= 300) {
              reject(new Error(`browser answered HTTP ${response.statusCode} for ${path}`))
              return
            }
            try {
              resolve(JSON.parse(body))
            } catch {
              reject(new Error(`browser returned non-JSON for ${path}`))
            }
          })
        },
      )
      request.on('error', reject)
      request.setTimeout(5000, () => {
        request.destroy(new Error(`browser endpoint timed out for ${path}`))
      })
      request.end()
    })
  }
}

/**
 * One pool per browser executable, so a session reuses its warm Edge across searches. Keyed
 * by path so an explicit `browserPath` never shares state with the auto-detected one.
 */
const sharedPools = new Map()

function poolFor(browserPath) {
  let pool = sharedPools.get(browserPath)
  if (pool === undefined) {
    pool = new EdgeBrowserPool({ browserPath })
    sharedPools.set(browserPath, pool)
  }
  return pool
}

/** Stop every pooled browser. Exported so a shutting-down host can call it. */
async function stopBrowserPools() {
  await Promise.all([...sharedPools.values()].map((pool) => pool.stop().catch(() => {})))
  sharedPools.clear()
}

/**
 * Delete profile directories left behind by a previous run.
 *
 * A hard kill — crash, power loss, a taskkill that reached the browser before its locks
 * released — leaves `dsh-search-*` directories behind, and they add up run after run.
 * Called once when the plugin loads, before any browser is launched.
 */
function sweepAbandonedProfiles() {
  const root = tmpdir()
  let entries
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  for (const entry of entries) {
    if (!entry.startsWith('dsh-search-')) continue
    const directory = join(root, entry)
    try {
      const stat = statSync(directory)
      if (stat.mtimeMs < cutoff) sweepDirectory(directory)
    } catch {
      // already gone, or unreadable: nothing to do
    }
  }
}

/**
 * Render one URL through the pool for `browserPath`. Kept as a plain function so callers and
 * tests that only want a page rendered never touch the pool's lifecycle.
 */
function renderHtmlWithBrowser(url, { timeoutMs, signal, browserPath, settleMs, debugDir } = {}) {
  return poolFor(browserPath)
    .render(url, { timeoutMs, signal, settleMs })
    .then((text) => {
      if (typeof debugDir === 'string' && debugDir.length > 0) {
        try {
          const stamp = Buffer.from(url).toString('base64url').slice(0, 40)
          writeFileSync(join(debugDir, `${stamp}.html`), text, 'utf8')
        } catch {}
      }
      return text
    })
}

/* ------------------------------------------------------------------ */
/* engine: Shenma (m.sm.cn) — rendered cards                           */
/* ------------------------------------------------------------------ */

/**
 * Shenma answers in `div.sc` blocks that carry a `data-reco` JSON blob holding the destination
 * (`norm_url`), the publisher (`host_name`) and the article title. Those blocks only exist after
 * the page's own JavaScript has run, which is why this engine reads the *rendered* DOM.
 *
 * The visible anchors are a second, independent source of the same links (`qk-link-wrapper`),
 * used for the card title and the summary paragraph, and as the URL when `data-reco` is absent.
 */
function parseShenma(html) {
  const rows = []
  const blocks = [...html.matchAll(/<div class="sc[^"]*"[\s\S]*?(?=<div class="sc[^"]*"|<\/body>|$)/g)]
  for (const match of blocks) {
    const block = match[0].slice(0, 12000)
    const reco = readJsonAttribute(block, 'data-reco') ?? {}
    const anchorUrl = firstMatch(block, [
      /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*qk-link-wrapper[^"]*"/i,
      /<a[^>]*class="[^"]*qk-link-wrapper[^"]*"[^>]+href="(https?:\/\/[^"]+)"/i,
      /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*data-log="/i,
    ])
    const url = sanitizeHref(typeof reco.norm_url === 'string' ? reco.norm_url : anchorUrl)
    if (url === undefined) continue

    const title =
      clampText(
        typeof reco.article_title === 'string' ? stripTags(reco.article_title) : undefined,
        300,
      ) ??
      clampText(stripTags(firstMatch(block, [/<div[^>]*class="[^"]*qk-title-text[^"]*"[^>]*>([\s\S]*?)<\/div>/i]) ?? ''), 300)
    if (title === undefined || title.length < 2) continue

    const snippet = firstMatch(block, [
      /<div[^>]*class="[^"]*qk-paragraph-text[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<div[^>]*class="[^"]*qk-paragraph-value[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<div[^>]*class="[^"]*qk-summary[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    ])
    const date = firstMatch(block, [/<span[^>]*class="[^"]*qk-source-item[^"]*"[^>]*>([\s\S]*?)<\/span>/i])
    const published = date === undefined ? undefined : /(\d{4}-\d{2}-\d{2})/.exec(stripTags(date))?.[1]

    rows.push({
      url,
      title,
      snippet: clampText(snippet === undefined ? undefined : stripTags(snippet), 400),
      publishedAt:
        published === undefined ? undefined : new Date(`${published}T00:00:00Z`).toISOString(),
      site: typeof reco.host_name === 'string' ? clampText(stripTags(reco.host_name), 60) : undefined,
    })
  }
  return rows
}

/* ------------------------------------------------------------------ */
/* engine: Bing (rendered or plain HTML)                               */
/* ------------------------------------------------------------------ */

function parseBing(html) {
  const rows = []
  for (const match of html.matchAll(/<li class="b_algo[\s\S]*?<\/li>/g)) {
    const block = match[0]
    const anchor = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (anchor === null) continue
    const url = sanitizeHref(anchor[1])
    if (url === undefined) continue
    const title = stripTags(anchor[2])
    if (title.length === 0) continue
    const snippet = firstMatch(block, [
      /<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
      /<p[^>]*>([\s\S]*?)<\/p>/i,
      /class="b_caption"[^>]*>([\s\S]*?)<\/div>/i,
    ])
    rows.push({
      url,
      title,
      snippet: clampText(snippet === undefined ? undefined : stripTags(snippet), 400),
    })
  }
  return rows
}

/* ------------------------------------------------------------------ */
/* engine registry                                                     */
/* ------------------------------------------------------------------ */

/**
 * `url` builds the SERP; `parse` turns the document into rows. `prefer` names the transport that
 * actually works for that engine, so the provider does not waste a round trip discovering it.
 */
const ENGINES = new Map([
  [
    'shenma',
    {
      label: '神马搜索',
      prefer: 'browser',
      url: (query) => `https://m.sm.cn/s?q=${encodeURIComponent(query)}`,
      mobile: true,
      parse: parseShenma,
    },
  ],
  [
    'bing',
    {
      label: 'Bing',
      prefer: 'http',
      url: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=20&mkt=zh-CN&setlang=zh-Hans`,
      mobile: false,
      parse: parseBing,
    },
  ],
])

/**
 * Ids that people naturally type, or that earlier versions of this plugin shipped, mapped onto
 * an engine that still exists. `smcn` is Shenma's old id and the previous default; keeping the
 * alias means an old config keeps working instead of failing with "unknown engine".
 */
const ENGINE_ALIASES = new Map([
  ['smcn', 'shenma'],
  ['sm', 'shenma'],
  ['uc', 'shenma'],
  ['shenma-mobile', 'shenma'],
  ['bing-html', 'bing'],
  ['google', 'bing'],
  ['duckduckgo', 'bing'],
])

function resolveEngineId(raw) {
  const id = String(raw ?? '').trim()
  if (id.length === 0) return undefined
  if (ENGINES.has(id)) return id
  return ENGINE_ALIASES.get(id.toLowerCase())
}

function resolveEngines(configured) {
  const resolved = []
  const rejected = []
  for (const raw of configured) {
    const id = resolveEngineId(raw)
    if (id === undefined) rejected.push(String(raw))
    else if (!resolved.includes(id)) resolved.push(id)
  }
  return { resolved, rejected }
}

/* ------------------------------------------------------------------ */
/* provider                                                            */
/* ------------------------------------------------------------------ */

/**
 * Per-engine cooldown memory.
 *
 * An engine that answered with an anti-bot page is skipped for a while instead of being asked
 * again: hammering a captcha endpoint keeps the address flagged, and each retry adds its full
 * timeout to a search another engine has already answered. The memory lives as long as the
 * plugin instance (one per composition).
 */
class EngineCooldowns {
  #until = new Map()

  #strikes = new Map()

  penalize(engineId, ms, reason) {
    this.#until.set(engineId, Date.now() + ms)
    this.#strikes.set(engineId, { reason, at: new Date().toISOString() })
  }

  remaining(engineId) {
    const until = this.#until.get(engineId)
    if (until === undefined) return 0
    const left = until - Date.now()
    if (left <= 0) {
      this.#until.delete(engineId)
      return 0
    }
    return left
  }

  report() {
    const entries = []
    for (const [engineId, until] of this.#until) {
      const left = until - Date.now()
      if (left <= 0) continue
      entries.push(`${engineId} ${Math.ceil(left / 1000)}s (${this.#strikes.get(engineId)?.reason ?? 'blocked'})`)
    }
    return entries
  }
}

/**
 * Keyless multi-engine search backend.
 *
 * Every configured engine is queried concurrently; results merge, get deduplicated and are
 * ranked by query distinctiveness. A single engine failing is not fatal — the other still
 * contributes, and only an empty result set raises.
 */
class FreeSearchProvider {
  id = FREE_SEARCH_PROVIDER_ID

  #readOptions

  #cooldowns = new EngineCooldowns()

  constructor(readOptions) {
    this.#readOptions = readOptions
  }

  /** Cheap local usability check; never touches the network. */
  available() {
    return true
  }

  /** Engines currently parked, for diagnostics. */
  engineStatus() {
    return this.#cooldowns.report()
  }

  async search(request, signal) {
    const query = typeof request?.query === 'string' ? request.query.trim() : ''
    if (query.length === 0) throw new Error('free-scrape: query must be a non-empty string')

    const current = this.#readOptions()
    const limit =
      typeof request?.maxResults === 'number' && request.maxResults > 0
        ? Math.min(request.maxResults, current.maxResults)
        : current.maxResults

    const { resolved, rejected } = resolveEngines(current.engines)
    if (resolved.length === 0) {
      throw new Error(
        `free-scrape has no usable engine: ${JSON.stringify(current.engines)} contains none of ` +
          `${[...ENGINES.keys()].join(', ')} (aliases: ${[...ENGINE_ALIASES.keys()].join(', ')})`,
      )
    }

    const browserPath = resolveBrowser(current.browserPath)
    const render = async (url) => {
      if (browserPath === undefined) throw new Error('no local Edge/Chromium found')
      return renderHtmlWithBrowser(url, {
        timeoutMs: current.browserTimeoutMs,
        signal,
        browserPath,
        debugDir: current.debugDomDir,
      })
    }

    const runEngine = async (engineId) => {
      const spec = ENGINES.get(engineId)
      const url = spec.url(query)

      // `auto` lets each engine take the lane it actually works in. Forcing one lane is a
      // debugging aid, and when a forced lane cannot run (no browser installed, or a
      // client-rendered page fetched as HTML) the engine reports why rather than silently
      // contributing nothing.
      const wantsBrowser =
        current.transport === 'browser' ||
        (current.transport === 'auto' && spec.prefer === 'browser' && browserPath !== undefined)

      if (wantsBrowser) {
        const html = await render(url)
        if (detectsBlock(html)) throw new BlockedError(`${spec.label} served an anti-bot page`)
        const rows = spec.parse(html)
        if (rows.length === 0) {
          throw new Error(`${spec.label} rendered no parseable results (layout change)`)
        }
        return { engineId, rows, lane: 'browser' }
      }

      const { status, text } = await fetchText(url, {
        timeoutMs: current.timeoutMs,
        signal,
        userAgent: spec.mobile ? MOBILE_UA : DESKTOP_UA,
      })
      if (detectsBlock(text)) throw new BlockedError(`${spec.label} served an anti-bot page`)
      if (status !== 200) throw new Error(`${spec.label} answered HTTP ${status}`)
      const rows = spec.parse(text)
      if (rows.length === 0) {
        throw new Error(
          `${spec.label} returned no parseable results over http` +
            (spec.prefer === 'browser' ? ' (this engine renders its results; use transport: auto or browser)' : ' (layout change)'),
        )
      }
      return { engineId, rows, lane: 'http' }
    }

    const settled = await Promise.allSettled(
      resolved.map(async (engineId) => {
        const parked = this.#cooldowns.remaining(engineId)
        if (parked > 0) {
          throw new Error(`skipped for ${Math.ceil(parked / 1000)}s after being rate-limited`)
        }
        try {
          return await runEngine(engineId)
        } catch (error) {
          if (error instanceof BlockedError) {
            this.#cooldowns.penalize(engineId, current.cooldownMs, error.message)
          }
          throw error
        }
      }),
    )

    const failures = []
    const cooldownNotes = []
    if (rejected.length > 0) failures.push(`ignored unknown engine(s) ${rejected.join(', ')}`)

    const terms = queryTerms(query)
    const seen = new Set()
    const candidates = []
    let contributed = 0

    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        const message = String(outcome.reason?.message ?? outcome.reason)
        // A parked engine is the ordinary consequence of an earlier throttle, not a fault the
        // model needs to read about on every search.
        if (message.startsWith('skipped for ')) cooldownNotes.push(message)
        else failures.push(message)
        continue
      }
      const { engineId, rows, lane } = outcome.value
      let added = 0
      for (const row of rows) {
        if (typeof row.url !== 'string' || row.url.length === 0) continue
        // Drop engine infrastructure before ranking: its own onebox panels would otherwise both
        // satisfy and skew the document-frequency weighting.
        if (isRedirector(row.url) || isSearchHost(row.url)) continue
        const key = normalizeUrl(row.url)
        if (seen.has(key)) continue
        seen.add(key)
        candidates.push({
          url: row.url,
          title: clampText(row.title, 300) ?? readableFallbackTitle(row.url),
          snippet: clampText(row.snippet, 400),
          publishedAt: row.publishedAt,
        })
        added++
      }
      if (added > 0) contributed++
      else failures.push(`${engineId}: no usable rows via ${lane}`)
    }

    const trouble = [...failures, ...cooldownNotes]

    if (candidates.length === 0) {
      throw new Error(
        `free-scrape found nothing for ${JSON.stringify(query)}` +
          (trouble.length === 0 ? '' : ` (${trouble.join('; ')})`),
      )
    }

    // Rank the whole pool rather than just `limit`, so the diversity pass has spare sites to
    // refill from after it caps any single site.
    const ranked = rankSources(candidates, terms, { limit: candidates.length })
    const picked = takeDiverse(ranked, limit, current.maxPerSite)

    if (picked.length === 0) {
      throw new Error(
        `free-scrape found no on-topic result for ${JSON.stringify(query)} ` +
          `(${candidates.length} candidates considered; ${trouble.join('; ') || 'all off-query'})`,
      )
    }

    const sources = picked.map((source) => ({
      url: source.url,
      ...(source.title === undefined ? {} : { title: source.title }),
      ...(source.snippet === undefined ? {} : { snippet: source.snippet }),
      ...(source.publishedAt === undefined ? {} : { publishedAt: source.publishedAt }),
    }))

    // A short list of confident-looking links is the dangerous case, not an empty one: the model
    // will cite the wrong city's weather without noticing. So a result set that misses the
    // query's distinguishing terms is still returned — with a caveat in `content`, which
    // `dsh-tool-web` prints above the sources — instead of the seam failing outright.
    const coverage = anchorCoverage(picked, terms, candidates)
    const anchors = anchorTerms(terms, candidates)
    const missing = anchors.filter(
      (term) => !picked.some((source) => mentions(haystackOf(source), term)),
    )
    const notes = []
    const weak = anchors.length > 0 && coverage < current.minAnchorCoverage
    if (weak) {
      notes.push(
        `These sources do not cover ${missing.map((term) => JSON.stringify(term)).join(', ')} ` +
          `from the query (${(coverage * 100).toFixed(0)}% of its distinctive terms). ` +
          `They are the closest matches ${resolved.join('/')} returned, not confirmed answers — ` +
          `re-run the search with different wording if the topic looks wrong.`,
      )
    }
    if (trouble.length > 0 && (weak || contributed <= 1)) {
      notes.push(`Engine notes: ${trouble.join('; ')}.`)
    }

    return {
      sources,
      truncated: sources.length >= limit && candidates.length > sources.length,
      ...(notes.length === 0 ? {} : { content: notes.join(' ') }),
    }
  }
}

/* ------------------------------------------------------------------ */
/* cordis plugin                                                       */
/* ------------------------------------------------------------------ */

/** A coverage threshold is only meaningful inside [0, 1]; anything else means "use the default". */
function normalizeCoverage(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return DEFAULT_MIN_ANCHOR_COVERAGE
  }
  return value
}

function readOptions(config) {
  const engines =
    Array.isArray(config.engines) && config.engines.length > 0 ? config.engines : Config({}).engines
  return {
    engines,
    maxResults: typeof config.maxResults === 'number' ? config.maxResults : DEFAULT_MAX_RESULTS,
    maxPerSite: typeof config.maxPerSite === 'number' ? config.maxPerSite : DEFAULT_MAX_PER_SITE,
    timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
    cooldownMs: typeof config.cooldownMs === 'number' ? config.cooldownMs : DEFAULT_COOLDOWN_MS,
    minAnchorCoverage: normalizeCoverage(config.minAnchorCoverage),
    transport:
      config.transport === 'http' || config.transport === 'browser' ? config.transport : 'auto',
    browserPath: typeof config.browserPath === 'string' ? config.browserPath : '',
    browserTimeoutMs:
      typeof config.browserTimeoutMs === 'number' ? config.browserTimeoutMs : DEFAULT_BROWSER_TIMEOUT_MS,
    debugDomDir: typeof config.debugDomDir === 'string' ? config.debugDomDir : '',
  }
}

/** Register the keyless search provider with `ctx.web`. */
function apply(ctx, config) {
  sweepAbandonedProfiles()
  const provider = new FreeSearchProvider(() => readOptions(config))
  const dispose = ctx.web.registerSearchProvider(provider)
  // One composition owns one browser pool. Tearing it down on plugin disposal stops the
  // headless Edge instead of leaving an idle process alive for its full idle window.
  ctx.effect(() => {
    void stopBrowserPools()
    return dispose
  })
  return dispose
}

export {
  BLOCK_MARKERS,
  BlockedError,
  Config,
  DEFAULT_BROWSER_TIMEOUT_MS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_PER_SITE,
  DEFAULT_MAX_RESULTS,
  DEFAULT_MIN_ANCHOR_COVERAGE,
  DEFAULT_TIMEOUT_MS,
  EDGE_VERSION,
  EdgeBrowserPool,
  ENGINES,
  ENGINE_ALIASES,
  EngineCooldowns,
  FREE_SEARCH_PROVIDER_ID,
  FreeSearchProvider,
  SEARCH_DOMAINS,
  anchorCoverage,
  anchorTerms,
  apply,
  browserCandidates,
  decodeEntities,
  detectsBlock,
  fetchText,
  inject,
  intrinsicWeight,
  isRedirector,
  isRelevant,
  isSearchHost,
  mentions,
  name,
  normalizeCoverage,
  normalizeUrl,
  parseBing,
  parseShenma,
  poolFor,
  queryTerms,
  rankSources,
  readableFallbackTitle,
  relevanceScore,
  renderHtmlWithBrowser,
  resolveBrowser,
  resolveEngineId,
  sanitizeHref,
  siteOf,
  stopBrowserPools,
  stripTags,
  sweepAbandonedProfiles,
  takeDiverse,
  unwrapBingUrl,
  unwrapShenmaUrl,
}
export default { name, inject, Config, apply }
