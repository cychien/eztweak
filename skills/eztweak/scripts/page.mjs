#!/usr/bin/env node
// Measures a rendered page, screenshots it, and compares two sets of screenshots, so the design,
// components and making steps run the same commands every time instead of improvising them.
//
//   node page.mjs measure <url>                   what the page renders, tallied, as JSON
//   node page.mjs shot <url> <file> [--viewport WxH[,WxH...]] [--around <css>] [--page]
//                  [--hover [css]] [--focus [css]] [--active [css]] [--states]
//                                                 the element at 2x, its states, and the page
//   node page.mjs shots <url> <dir> [path ...]    full-page PNGs at desktop and mobile per path
//   node page.mjs compare <before-dir> <after-dir> which screenshots changed; exit 1 when any did
//
// It drives a headless Chrome of its own over the DevTools protocol, one browser per command. In an
// eztweak session that browser is signed in the way the user's is: the daemon hands over the page's
// cookies and storage, in Playwright's storageState shape, through EZTWEAK_PAGE_STATE.

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

export const DESKTOP = { width: 1440, height: 900 }
export const MOBILE = { width: 390, height: 844 }
const SETTLE_MS = 400
const LOAD_TIMEOUT_MS = 30_000
const STATE_TIMEOUT_MS = 2000
const MARGIN = 48
// Twice the pixels, so a detail is judged on what it is rather than guessed at.
const PIECE_SCALE = 2
export const STATES = ['hover', 'focus', 'active']

// ---------------------------------------------------------------------------- the browser

const CHROMES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
  win32: [
    `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
}

export function findChrome(env = process.env, platform = process.platform) {
  if (env.CHROME_PATH) return env.CHROME_PATH
  const found = (CHROMES[platform] ?? []).find((path) => existsSync(path))
  if (!found) throw new Error('no Chrome found; set CHROME_PATH to its executable')
  return found
}

/** The DevTools protocol over the pipe Chrome opens on fds 3 and 4: JSON messages ended by NUL. */
async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'eztweak-page-'))
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--mute-audio',
      '--disable-extensions',
      '--use-mock-keychain',
      '--password-store=basic',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  )
  const toChrome = chrome.stdio[3]
  const fromChrome = chrome.stdio[4]
  let id = 0
  const pending = new Map()
  const listeners = new Set()
  let buffered = ''
  fromChrome.setEncoding('utf8')
  fromChrome.on('data', (chunk) => {
    buffered += chunk
    let end
    while ((end = buffered.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffered.slice(0, end))
      buffered = buffered.slice(end + 1)
      if (message.id !== undefined && pending.has(message.id)) {
        const { ok, fail } = pending.get(message.id)
        pending.delete(message.id)
        if (message.error)
          fail(
            new Error(
              `${message.error.message}${message.error.data ? `: ${message.error.data}` : ''}`,
            ),
          )
        else ok(message.result)
      } else for (const listen of listeners) listen(message)
    }
  })
  const died = new Promise((_, fail) => {
    chrome.on('exit', (code) => fail(new Error(`Chrome exited (${code}) before the page was done`)))
    chrome.on('error', fail)
  })
  died.catch(() => {})
  const send = (method, params = {}, sessionId) =>
    Promise.race([
      new Promise((ok, fail) => {
        const message = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) }
        pending.set(message.id, { ok, fail })
        toChrome.write(`${JSON.stringify(message)}\0`)
      }),
      died,
    ])
  const next = (sessionId, method, timeout) =>
    new Promise((ok) => {
      const timer = setTimeout(() => {
        listeners.delete(listen)
        ok(null)
      }, timeout)
      const listen = (m) => {
        if (m.sessionId !== sessionId || m.method !== method) return
        clearTimeout(timer)
        listeners.delete(listen)
        ok(m.params)
      }
      listeners.add(listen)
    })

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const page = (method, params) => send(method, params, sessionId)
  await page('Page.enable')

  return {
    async viewport({ width, height }, scale = 1) {
      const mobile = isPhone({ width })
      await page('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: scale,
        mobile,
      })
      await page('Emulation.setTouchEmulationEnabled', { enabled: mobile })
    },
    async navigate(url) {
      const loaded = next(sessionId, 'Page.loadEventFired', LOAD_TIMEOUT_MS)
      const { errorText } = await page('Page.navigate', { url })
      if (errorText) throw new Error(`could not open ${url}: ${errorText}`)
      await loaded
    },
    /** Where the page ended up: a sign-in it bounced to is somewhere else. */
    async open(url) {
      await this.navigate(url)
      return this.evaluate(
        `async () => { await document.fonts.ready; await new Promise((r) => setTimeout(r, ${SETTLE_MS})); return location.href }`,
      )
    },
    /** Cookies go in directly; storage is written from a blank page of the origin, served here so
     *  none of the app runs before it is in place. */
    async signIn(origin, { cookies, storage }) {
      if (cookies.length) {
        await page('Network.setCookies', {
          cookies: cookies.map(({ name, value, path }) => ({ name, value, path, url: origin })),
        })
      }
      if (!storage) return
      const serve = (m) => {
        if (m.sessionId !== sessionId || m.method !== 'Fetch.requestPaused') return
        page('Fetch.fulfillRequest', {
          requestId: m.params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'text/html' }],
          body: Buffer.from('<!doctype html><title></title>').toString('base64'),
        }).catch(() => {})
      }
      listeners.add(serve)
      try {
        await page('Fetch.enable', { patterns: [{ urlPattern: `${origin}/*` }] })
        await this.navigate(`${origin}/`)
        await this.evaluate(`() => (${seedStorage})(${JSON.stringify(storage)})`)
      } finally {
        listeners.delete(serve)
        await page('Fetch.disable').catch(() => {})
      }
    },
    async evaluate(fn) {
      const { result, exceptionDetails } = await page('Runtime.evaluate', {
        expression: `(${fn})()`,
        awaitPromise: true,
        returnByValue: true,
      })
      if (exceptionDetails) {
        throw new Error(
          exceptionDetails.exception?.description?.split('\n')[0] ?? exceptionDetails.text,
        )
      }
      return result.value
    },
    /** The whole page when `clip` is left out, or that rect of it, past the viewport either way.
     *  `zoom` scales the image against the viewport's own pixel ratio. */
    async screenshot(clip, zoom = 1) {
      const { cssContentSize } = await page('Page.getLayoutMetrics')
      const area = clip ?? {
        x: 0,
        y: 0,
        width: cssContentSize.width,
        height: cssContentSize.height,
      }
      const { data } = await page('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { ...area, scale: zoom },
      })
      return Buffer.from(data, 'base64')
    },
    async mouse(type, x, y, buttons = 0) {
      await page('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: type === 'mouseMoved' ? 'none' : 'left',
        buttons,
        clickCount: type === 'mouseMoved' ? 0 : 1,
      })
    },
    async key(key) {
      for (const type of ['keyDown', 'keyUp']) await page('Input.dispatchKeyEvent', { type, key })
    },
    // Chrome writes to its profile until it has exited, so the folder goes only after that.
    async close() {
      const exited = new Promise((ok) => chrome.once('exit', ok))
      await send('Browser.close').catch(() => {})
      let timer
      await Promise.race([exited, new Promise((ok) => (timer = setTimeout(ok, 2000)))])
      clearTimeout(timer)
      if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill()
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}

async function withBrowser(url, run) {
  const browser = await launch()
  try {
    const origin = new URL(url).origin
    const state = signInFor(origin, await fetchPageState())
    if (state) await browser.signIn(origin, state)
    return await run(browser)
  } finally {
    await browser.close()
  }
}

// ---------------------------------------------------------------------------- signing in

async function fetchPageState(env = process.env) {
  if (!env.EZTWEAK_PAGE_STATE || !env.EZTWEAK_PAGE_STATE_TOKEN) return null
  try {
    const res = await fetch(env.EZTWEAK_PAGE_STATE, {
      headers: { authorization: `Bearer ${env.EZTWEAK_PAGE_STATE_TOKEN}` },
      signal: AbortSignal.timeout(STATE_TIMEOUT_MS),
    })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** A dev server answers on every loopback name, and the user's browser may know it by another. */
export function sameOrigin(a, b) {
  const x = new URL(a)
  const y = new URL(b)
  if (x.protocol !== y.protocol || x.port !== y.port) return false
  return x.hostname === y.hostname || (LOOPBACK.has(x.hostname) && LOOPBACK.has(y.hostname))
}

/** Whether a cookie for `domain` is sent to `host`, loopback names counting as one. */
function cookieReaches(domain, host) {
  const bare = domain.replace(/^\./, '')
  return bare === host || host.endsWith(`.${bare}`) || (LOOPBACK.has(bare) && LOOPBACK.has(host))
}

/** What of a storageState applies to the page at `origin`, or null when none of it does. */
export function signInFor(origin, state) {
  if (!state) return null
  const host = new URL(origin).hostname
  const cookies = (state.cookies ?? []).filter((c) => cookieReaches(c.domain, host))
  const entry = state.origins?.find((o) => sameOrigin(o.origin, origin)) ?? null
  const storage = entry && {
    localStorage: entry.localStorage ?? [],
    sessionStorage: entry.sessionStorage ?? [],
    indexedDB: entry.indexedDB ?? [],
  }
  return cookies.length || storage ? { cookies, storage } : null
}

/** Runs in the page. Writes the user's storage into this browser's copy of the origin. */
async function seedStorage({ localStorage: local, sessionStorage: session, indexedDB: dbs }) {
  for (const { name, value } of local) localStorage.setItem(name, value)
  for (const { name, value } of session) sessionStorage.setItem(name, value)
  const path = (o) => o.keyPathArray ?? o.keyPath
  for (const db of dbs) {
    await new Promise((ok) => {
      const request = indexedDB.open(db.name, db.version)
      request.onupgradeneeded = () => {
        for (const s of db.stores) {
          const store = request.result.createObjectStore(s.name, {
            ...(path(s) !== undefined ? { keyPath: path(s) } : {}),
            autoIncrement: s.autoIncrement,
          })
          for (const i of s.indexes)
            store.createIndex(i.name, path(i), { multiEntry: i.multiEntry, unique: i.unique })
          for (const r of s.records) {
            if ('key' in r) store.put(r.value, r.key)
            else store.put(r.value)
          }
        }
      }
      request.onsuccess = () => {
        request.result.close()
        ok()
      }
      request.onerror = () => ok()
    })
  }
}

/** The page went somewhere other than where it was sent: a sign-in, most of the time. */
export function landedElsewhere(requested, landed) {
  const trim = (p) => p.replace(/\/+$/, '') || '/'
  const a = new URL(requested)
  const b = new URL(landed)
  return !sameOrigin(a.href, b.href) || trim(a.pathname) !== trim(b.pathname)
}

const redirectLine = (requested, landed) => `redirected: ${requested} ended at ${landed}`

// Phones get touch and a mobile viewport, so a layout that keys on either renders as it would there.
const isPhone = ({ width }) => width < 600

// ---------------------------------------------------------------------------- measure

/** Runs in the page. Counts what the visible elements render, so frequency says what dominates. */
function tally() {
  const TOP = 12
  const rows = (map) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP)
      .map(([value, count]) => ({ value, count }))
  const add = (map, key, by = 1) => {
    if (key) map.set(key, (map.get(key) ?? 0) + by)
  }
  const transparent = (c) => !c || c === 'transparent' || /rgba?\([^)]*,\s*0\)$/.test(c)
  const px = (v) => (v && v !== '0px' && v !== 'normal' && v !== 'none' ? v : null)

  const m = {
    text: new Map(),
    background: new Map(),
    border: new Map(),
    family: new Map(),
    size: new Map(),
    weight: new Map(),
    lineHeight: new Map(),
    letterSpacing: new Map(),
    radius: new Map(),
    shadow: new Map(),
    padding: new Map(),
    gap: new Map(),
  }
  const area = new Map()
  const screen = innerWidth * Math.max(innerHeight, document.documentElement.scrollHeight)
  let elements = 0
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) continue
    elements += 1
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
    if (ownText) {
      add(m.text, s.color)
      add(m.family, s.fontFamily.split(',')[0].replace(/["']/g, '').trim())
      add(m.size, s.fontSize)
      add(m.weight, s.fontWeight)
      add(m.lineHeight, s.lineHeight)
      add(m.letterSpacing, px(s.letterSpacing))
    }
    if (!transparent(s.backgroundColor)) {
      add(m.background, s.backgroundColor)
      add(area, s.backgroundColor, r.width * r.height)
    }
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== 'none') {
        add(m.border, `${s[`border${side}Width`]} ${s[`border${side}Color`]}`)
        break
      }
    }
    add(m.radius, px(s.borderRadius))
    add(m.shadow, px(s.boxShadow))
    for (const v of [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft])
      add(m.padding, px(v))
    add(m.gap, px(s.rowGap))
    add(m.gap, s.columnGap !== s.rowGap ? px(s.columnGap) : null)
  }

  // A stock palette defines hundreds of tokens no page uses; the project's own are what matter.
  const STOCK =
    /^--(tw-|color-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d)/
  const tokens = {}
  const root = getComputedStyle(document.documentElement)
  let tokenCount = 0
  for (const sheet of document.styleSheets) {
    let rules
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    const walk = (list) => {
      for (const rule of list) {
        if (rule.cssRules && !rule.selectorText) walk(rule.cssRules)
        if (!rule.selectorText || !/(^|,)\s*(:root|html)\s*(,|$)/.test(rule.selectorText)) continue
        for (const name of rule.style) {
          if (!name.startsWith('--') || name in tokens) continue
          tokenCount += 1
          if (!STOCK.test(name)) tokens[name] = root.getPropertyValue(name).trim()
        }
      }
    }
    walk(rules)
  }

  const widths = new Map()
  for (const el of document.querySelectorAll(
    'main, section, header, footer, [class*="container"], [class*="shell"]',
  )) {
    const w = Math.round(el.getBoundingClientRect().width)
    if (w > 0 && w < innerWidth) add(widths, `${w}px`)
  }

  return {
    viewport: {
      width: innerWidth,
      height: innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
    },
    overflowsSideways: document.documentElement.scrollWidth > innerWidth,
    elements,
    colors: { text: rows(m.text), background: rows(m.background), border: rows(m.border) },
    backgroundShare: rows(area).map(({ value, count }) => ({
      value,
      percent: Math.round((count / screen) * 1000) / 10,
    })),
    type: {
      family: rows(m.family),
      size: rows(m.size),
      weight: rows(m.weight),
      lineHeight: rows(m.lineHeight),
      letterSpacing: rows(m.letterSpacing),
    },
    radius: rows(m.radius),
    shadow: rows(m.shadow),
    spacing: { padding: rows(m.padding), gap: rows(m.gap) },
    containerWidths: rows(widths),
    tokens: { declared: tokenCount, project: tokens },
  }
}

function measure(url) {
  return withBrowser(url, async (browser) => {
    await browser.viewport(DESKTOP)
    const landed = await browser.open(url)
    const desktop = await browser.evaluate(tally)
    await browser.viewport(MOBILE)
    await browser.open(url)
    const { tokens, ...mobile } = await browser.evaluate(tally)
    return {
      url,
      ...(landedElsewhere(url, landed) ? { redirected: landed } : {}),
      desktop,
      mobile,
    }
  })
}

// ---------------------------------------------------------------------------- shot

/** Runs in the page. Where the element sits on the whole page, and what of it no screenshot shows. */
function locate(selector) {
  const all = document.querySelectorAll(selector)
  if (!all.length) return { found: 0 }
  const el = all[0]
  const r = el.getBoundingClientRect()
  const name = (e) => {
    const cls = typeof e.className === 'string' ? e.className.trim().split(/\s+/).slice(0, 2) : []
    return (
      e.tagName.toLowerCase() +
      (e.id ? `#${e.id}` : '') +
      cls.map((c) => (c ? `.${c}` : '')).join('')
    )
  }
  const clipped = []
  for (const e of [el, ...el.querySelectorAll('*')]) {
    const st = getComputedStyle(e)
    const below = st.overflowY !== 'visible' ? e.scrollHeight - e.clientHeight : 0
    const side = st.overflowX !== 'visible' ? e.scrollWidth - e.clientWidth : 0
    if (below > 1) clipped.push(`${name(e)} scrolls ${below}px more below`)
    if (side > 1) clipped.push(`${name(e)} scrolls ${side}px more to the side`)
    if (clipped.length >= 5) break
  }
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const st = getComputedStyle(a)
    if (st.overflowX === 'visible' && st.overflowY === 'visible') continue
    const ar = a.getBoundingClientRect()
    if (
      r.top < ar.top - 1 ||
      r.bottom > ar.bottom + 1 ||
      r.left < ar.left - 1 ||
      r.right > ar.right + 1
    ) {
      clipped.push(`${name(a)} cuts part of it off`)
      break
    }
  }
  return {
    found: all.length,
    rect: { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height },
    clipped,
  }
}

export function parseViewport(raw) {
  const match = /^(\d+)x(\d+)$/.exec(raw ?? '')
  if (!match) throw new Error(`--viewport takes WIDTHxHEIGHT, like 1168x861, not ${raw}`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

/** `card.png` at one viewport, `card-1168x861.png` and the rest when there are several; a state
 *  or the page adds its name, as in `card-hover.png`. */
export function shotFiles(file, sizes, page, states = []) {
  const stem = join(dirname(file), basename(file, extname(file)))
  const name = (tag, size) =>
    sizes.length === 1 && !tag
      ? file
      : `${stem}${tag}${sizes.length > 1 ? `-${size.width}x${size.height}` : ''}.png`
  return sizes.flatMap((size) => [
    { size, file: name('', size), kind: 'piece' },
    ...(page ? [{ size, file: name('-page', size), kind: 'page' }] : []),
    ...states.map(({ state, target }) => ({
      size,
      file: name(`-${state}`, size),
      kind: state,
      target,
    })),
  ])
}

/** The states asked for, each on its own element or on the piece. */
export function statesFrom(named, around) {
  const wanted = named.states === true ? STATES : STATES.filter((s) => named[s] !== undefined)
  return wanted.map((state) => {
    const target = typeof named[state] === 'string' ? named[state] : around
    if (!target) throw new Error(`--${state} needs a selector, or --around to take it from`)
    return { state, target }
  })
}

/** Runs in the page. Brings the element into view and says where its middle is on screen. */
function reach(selector) {
  const el = document.querySelector(selector)
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

/** Runs in the page. Waits out the transitions a state started, never one that loops. */
async function settle() {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const finite = document
    .getAnimations()
    .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
  await Promise.race([
    Promise.all(finite.map((a) => a.finished.catch(() => {}))),
    new Promise((r) => setTimeout(r, 1000)),
  ])
}

/** Puts the element in a state the way a person would: the pointer on it, pressed on it, or
 *  focus reached from the keyboard, so `:focus-visible` holds too. */
async function enterState(browser, state, target) {
  const at = await browser.evaluate(`() => (${reach})(${JSON.stringify(target)})`)
  if (!at) throw new Error(`nothing matches ${target} to ${state}`)
  if (state === 'focus') {
    await browser.key('Shift')
    const focused = await browser.evaluate(
      `() => { const el = document.querySelector(${JSON.stringify(target)}); el.focus(); return document.activeElement === el }`,
    )
    if (!focused) throw new Error(`${target} cannot take focus`)
  } else {
    await browser.mouse('mouseMoved', at.x, at.y)
    if (state === 'active') await browser.mouse('mousePressed', at.x, at.y, 1)
  }
  await browser.evaluate(settle)
}

/** Lets go without a click: the press is released away from the element. */
async function leaveState(browser, state) {
  if (state === 'active') {
    await browser.mouse('mouseMoved', 0, 0, 1)
    await browser.mouse('mouseReleased', 0, 0)
  }
  await browser.mouse('mouseMoved', 0, 0)
  await browser.evaluate('() => { document.activeElement?.blur(); window.scrollTo(0, 0) }')
  await browser.evaluate(settle)
}

async function shot(
  url,
  file,
  {
    sizes = [DESKTOP],
    around = null,
    page = false,
    margin = MARGIN,
    scale = PIECE_SCALE,
    states = [],
  } = {},
) {
  mkdirSync(dirname(file), { recursive: true })
  return withBrowser(url, async (browser) => {
    const lines = []
    let loaded = null
    let landed = url
    for (const { size, file: out, kind, target } of shotFiles(file, sizes, page, states)) {
      // The piece, the page and the states at one viewport come out of one load.
      if (loaded !== size) {
        await browser.viewport(size, scale)
        landed = await browser.open(url)
        if (loaded === null && landedElsewhere(url, landed)) lines.push(redirectLine(url, landed))
        loaded = size
      }
      const crop = kind === 'piece' || kind === 'page' ? around : (around ?? target)
      // The page is for rhythm and proportion, which read at 1x; the detail is in the crop.
      if (!crop || kind === 'page') {
        writeFileSync(out, await browser.screenshot(undefined, 1 / scale))
        lines.push(out)
        continue
      }
      if (kind === 'hover' && isPhone(size)) {
        lines.push(`${kind}: none at ${size.width}x${size.height}, a phone has no hover`)
        continue
      }
      if (kind !== 'piece') await enterState(browser, kind, target)
      const found = await browser.evaluate(`() => (${locate})(${JSON.stringify(crop)})`)
      if (!found.found) {
        const where = landedElsewhere(url, landed) ? `; it was ${redirectLine(url, landed)}` : ''
        throw new Error(`nothing on ${url} matches ${crop} at ${size.width}x${size.height}${where}`)
      }
      const doc = await browser.evaluate(
        '() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })',
      )
      const left = Math.max(0, Math.floor(found.rect.x - margin))
      const top = Math.max(0, Math.floor(found.rect.y - margin))
      const right = Math.min(doc.width, Math.ceil(found.rect.x + found.rect.width + margin))
      const bottom = Math.min(doc.height, Math.ceil(found.rect.y + found.rect.height + margin))
      writeFileSync(
        out,
        await browser.screenshot({ x: left, y: top, width: right - left, height: bottom - top }),
      )
      lines.push(out)
      if (kind !== 'piece') {
        await leaveState(browser, kind)
        continue
      }
      if (found.found > 1) lines.push(`${found.found} elements match ${crop}; this is the first`)
      for (const line of found.clipped) lines.push(`clipped: ${line}`)
    }
    return lines
  })
}

// ---------------------------------------------------------------------------- shots

export function shotName(path) {
  const slug = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.html?$/i, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .toLowerCase()
  return slug || 'index'
}

function shots(url, dir, paths) {
  mkdirSync(dir, { recursive: true })
  return withBrowser(url, async (browser) => {
    const written = []
    for (const [name, size] of [
      ['desktop', DESKTOP],
      ['mobile', MOBILE],
    ]) {
      await browser.viewport(size)
      for (const path of paths) {
        const target = new URL(path, url).href
        const landed = await browser.open(target)
        const file = join(dir, `${shotName(path)}-${name}.png`)
        writeFileSync(file, await browser.screenshot())
        written.push(file)
        if (name === 'desktop' && landedElsewhere(target, landed))
          written.push(redirectLine(target, landed))
      }
    }
    return written
  })
}

// ---------------------------------------------------------------------------- compare

/** 8-bit truecolour PNGs, with or without alpha: what a browser screenshot is. */
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let at = 8
  let width = 0
  let height = 0
  let channels = 0
  const data = []
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at)
    const type = buffer.toString('ascii', at + 4, at + 8)
    const body = buffer.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body[8]
      const colour = body[9]
      if (depth !== 8 || (colour !== 2 && colour !== 6) || body[12] !== 0) {
        throw new Error(
          `unsupported PNG: bit depth ${depth}, colour type ${colour}, interlace ${body[12]}`,
        )
      }
      channels = colour === 6 ? 4 : 3
    } else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') break
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0
      const b = up ? up[x] : 0
      const c = up && x >= channels ? up[x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[x] = v & 0xff
    }
  }
  return { width, height, channels, pixels }
}

export function diffPngs(before, after) {
  if (before.equals(after)) return { same: true }
  const a = decodePng(before)
  const b = decodePng(after)
  if (a.width !== b.width || a.height !== b.height) {
    return {
      same: false,
      size: { before: `${a.width}x${a.height}`, after: `${b.width}x${b.height}` },
    }
  }
  let changed = 0
  let box = null
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * a.channels
      const j = (y * b.width + x) * b.channels
      if (
        a.pixels[i] === b.pixels[j] &&
        a.pixels[i + 1] === b.pixels[j + 1] &&
        a.pixels[i + 2] === b.pixels[j + 2]
      )
        continue
      changed += 1
      box = box
        ? {
            left: Math.min(box.left, x),
            top: Math.min(box.top, y),
            right: Math.max(box.right, x),
            bottom: Math.max(box.bottom, y),
          }
        : { left: x, top: y, right: x, bottom: y }
    }
  }
  return changed ? { same: false, changed, box } : { same: true }
}

export function compare(beforeDir, afterDir) {
  const names = new Set(
    [...readdirSync(beforeDir), ...readdirSync(afterDir)].filter((n) => n.endsWith('.png')),
  )
  return [...names].sort().map((name) => {
    const a = join(beforeDir, name)
    const b = join(afterDir, name)
    if (!existsSync(a) || !existsSync(b))
      return { name, same: false, missing: existsSync(a) ? 'after' : 'before' }
    return { name, ...diffPngs(readFileSync(a), readFileSync(b)) }
  })
}

export function describe(result) {
  if (result.same) return `same     ${result.name}`
  if (result.missing) return `missing  ${result.name} (no ${result.missing})`
  if (result.size)
    return `differs  ${result.name}: size ${result.size.before} -> ${result.size.after}`
  const { left, top, right, bottom } = result.box
  return `differs  ${result.name}: ${result.changed} pixels, x ${left}-${right}, y ${top}-${bottom}`
}

// ---------------------------------------------------------------------------- the CLI

const USAGE = `usage:
  node page.mjs measure <url>
  node page.mjs shot <url> <file> [--viewport WxH[,WxH...]] [--around <css>] [--page] [--margin px] [--scale n]
                  [--hover [css]] [--focus [css]] [--active [css]] [--states]
  node page.mjs shots <url> <dir> [path ...]
  node page.mjs compare <before-dir> <after-dir>`

/** `--name value` pairs out of the arguments, the rest kept in order; a flag with no value is true. */
export function flags(args) {
  const named = {}
  const rest = []
  for (let at = 0; at < args.length; at++) {
    if (!args[at].startsWith('--')) rest.push(args[at])
    else if (at + 1 < args.length && !args[at + 1].startsWith('--'))
      named[args[at].slice(2)] = args[++at]
    else named[args[at].slice(2)] = true
  }
  return { named, rest }
}

async function main([command, ...args]) {
  if (command === 'measure' && args.length === 1) {
    console.log(JSON.stringify(await measure(args[0]), null, 1))
  } else if (command === 'shot' && flags(args).rest.length === 2) {
    const { named, rest } = flags(args)
    const lines = await shot(rest[0], resolve(rest[1]), {
      sizes: named.viewport ? named.viewport.split(',').map(parseViewport) : [DESKTOP],
      around: named.around ?? null,
      page: named.page === true,
      margin: named.margin !== undefined ? Number(named.margin) : MARGIN,
      scale: named.scale !== undefined ? Number(named.scale) : PIECE_SCALE,
      states: statesFrom(named, named.around ?? null),
    })
    for (const line of lines) console.log(line)
  } else if (command === 'shots' && args.length >= 2) {
    const [url, dir, ...paths] = args
    for (const file of await shots(url, resolve(dir), paths.length ? paths : ['/']))
      console.log(file)
  } else if (command === 'compare' && args.length === 2) {
    const results = compare(resolve(args[0]), resolve(args[1]))
    for (const result of results) console.log(describe(result))
    if (results.some((r) => !r.same)) process.exitCode = 1
  } else {
    console.error(USAGE)
    process.exitCode = 2
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message.split('\n')[0] : String(error))
    process.exitCode = 1
  })
}
