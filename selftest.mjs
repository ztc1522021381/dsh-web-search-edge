#!/usr/bin/env node
/**
 * dsh-web-search-edge self-test.
 *
 * Run `node selftest.mjs` from the package directory to check every layer this plugin
 * depends on, in the order a real search touches them. Each step prints PASS or FAIL with
 * the measurement that decided it, so a broken installation names its own problem.
 *
 *   node selftest.mjs            full check, including live network searches
 *   node selftest.mjs --offline  skip the network, check wiring only
 *
 * Exit code 0 means every step passed.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const offline = process.argv.includes('--offline')

let failed = 0

function step(name, ok, detail) {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`  ${mark}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}

async function main() {
  console.log('\ndsh-web-search-edge self-test\n')

  // ── package ──────────────────────────────────────────────────────────────
  console.log('package')

  const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
  step('package.json parses', true, `${pkg.name}@${pkg.version}`)
  step('main entry exists', existsSync(join(here, pkg.main ?? 'index.js')))
  step('bundle patch exists', existsSync(join(here, pkg.dsh?.bundle?.patch ?? 'cordis.patch.yml')))
  step('type declarations exist', existsSync(join(here, 'types/index.d.ts')))
  step('icon exists', existsSync(join(here, 'icon.png')))
  step('LICENSE exists', existsSync(join(here, 'LICENSE')))

  // ── module ───────────────────────────────────────────────────────────────
  console.log('\nmodule')

  const mod = await import(pathToFileURL(join(here, pkg.main ?? 'index.js')).href)
  step('index.js imports', typeof mod.apply === 'function', `provider id: ${mod.FREE_SEARCH_PROVIDER_ID}`)
  step('declares the web inject', Array.isArray(mod.inject) && mod.inject.includes('web'))
  step('exports the provider class', typeof mod.FreeSearchProvider === 'function')
  step('exports the browser pool', typeof mod.EdgeBrowserPool === 'function')

  const defaults = mod.Config({})
  step('config defaults are sane',
    Array.isArray(defaults.engines) && defaults.engines.length > 0
      && defaults.maxResults >= 1 && defaults.maxResults <= 20,
    `engines=${defaults.engines.join(',')} maxResults=${defaults.maxResults} transport=${defaults.transport}`)

  for (const engine of defaults.engines) {
    step(`engine "${engine}" is registered`, mod.ENGINES.has(engine) || mod.ENGINE_ALIASES.has(engine))
  }

  // ── browser ──────────────────────────────────────────────────────────────
  console.log('\nbrowser')

  const browserPath = mod.resolveBrowser('')
  step('local browser found', typeof browserPath === 'string', browserPath ?? 'none')

  if (offline) {
    console.log('\n(offline mode: skipping live checks)\n')
    finish()
    return
  }

  // ── engines ──────────────────────────────────────────────────────────────
  console.log('\nengines (live)')

  const started = Date.now()
  const pool = new mod.EdgeBrowserPool({ browserPath: browserPath ?? undefined })
  try {
    const html = await pool.render('https://example.com', { timeoutMs: 15000, settleMs: 500 })
    step('Edge renders a page', html.length > 500, `${html.length} bytes in ${Date.now() - started} ms`)
  } catch (error) {
    step('Edge renders a page', false, error.message)
  }

  for (const [engineId, spec] of mod.ENGINES) {
    const url = spec.url('三菱 PLC')
    // Client-rendered engines occasionally race their own JavaScript on the first try;
    // one retry separates a timing miss from a real problem.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const t0 = Date.now()
        if (spec.prefer === 'browser' && browserPath !== undefined) {
          const html = await pool.render(url, { timeoutMs: 20000, settleMs: 2000 })
          const rows = spec.parse(html)
          if (rows.length > 0 || attempt === 2) {
            step(`${engineId} returns results`, rows.length > 0,
              `${rows.length} rows in ${Date.now() - t0} ms${attempt === 2 ? ' (after retry)' : ''}`)
            break
          }
        } else {
          const { status, text } = await mod.fetchText(url, { timeoutMs: 15000 })
          const rows = spec.parse(text)
          step(`${engineId} returns results`, status === 200 && rows.length > 0,
            `HTTP ${status}, ${rows.length} rows in ${Date.now() - t0} ms`)
          break
        }
      } catch (error) {
        if (attempt === 2) step(`${engineId} returns results`, false, error.message)
      }
    }
  }
  await pool.stop()

  // ── end to end ───────────────────────────────────────────────────────────
  console.log('\nend to end (live)')

  const config = mod.Config({})
  const provider = new mod.FreeSearchProvider(() => ({
    engines: config.engines,
    maxResults: config.maxResults,
    maxPerSite: config.maxPerSite,
    timeoutMs: config.timeoutMs,
    cooldownMs: config.cooldownMs,
    minAnchorCoverage: config.minAnchorCoverage,
    transport: config.transport,
    browserPath: config.browserPath,
    browserTimeoutMs: config.browserTimeoutMs,
    debugDomDir: '',
  }))

  for (const query of ['三菱 GX Works2', '上海 天气']) {
    const t0 = Date.now()
    try {
      const result = await provider.search({ query, maxResults: config.maxResults })
      const ms = Date.now() - t0
      step(`"${query}"`, result.sources.length > 0,
        `${result.sources.length} sources, ${ms} ms, first: ${result.sources[0]?.url?.slice(0, 60) ?? '—'}`)
    } catch (error) {
      step(`"${query}"`, false, error.message.slice(0, 120))
    }
  }
  await mod.stopBrowserPools()

  finish()
}

function finish() {
  if (failed === 0) {
    console.log('\nall checks passed\n')
    process.exit(0)
  }
  console.log(`\n${failed} check${failed === 1 ? '' : 's'} failed\n`)
  process.exit(1)
}

main().catch((error) => {
  console.error(`\nself-test crashed: ${error?.stack ?? error}\n`)
  process.exit(1)
})
