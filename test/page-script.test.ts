import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'
import {
  compare,
  decodePng,
  describe,
  diffPngs,
  findChrome,
  flags,
  landedElsewhere,
  parseViewport,
  sameOrigin,
  shotFiles,
  shotName,
  signInFor,
  statesFrom,
} from '../skills/eztweak/scripts/page.mjs'

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (bytes: Buffer) => {
  let c = 0xffffffff
  for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const sum = Buffer.alloc(4)
  sum.writeUInt32BE(crc(body))
  return Buffer.concat([length, body, sum])
}

/** A PNG whose rows use `filter`, so the decoder's unfiltering is what the comparison tests. */
function png(
  width: number,
  height: number,
  channels: 3 | 4,
  pixel: (x: number, y: number) => number[],
  filter = 0,
) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = channels === 4 ? 6 : 2
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  const prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const row = Buffer.from(Array.from({ length: width }, (_, x) => pixel(x, y)).flat())
    raw[y * (stride + 1)] = filter
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels]! : 0
      raw[y * (stride + 1) + 1 + i] =
        (row[i]! - (filter === 1 ? left : filter === 2 ? prev[i]! : 0)) & 0xff
    }
    row.copy(prev)
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const white = () => [255, 255, 255]

test('a screenshot is named by its path', () => {
  assert.equal(shotName('/'), 'index')
  assert.equal(shotName('/changelog.html'), 'changelog')
  assert.equal(shotName('/settings/billing/'), 'settings-billing')
})

test('the same pixels compare as the same, whatever the encoding', () => {
  const plain = png(4, 3, 3, (x, y) => [x * 60, y * 80, 7])
  assert.deepEqual(diffPngs(plain, plain), { same: true })
  assert.deepEqual(
    diffPngs(
      plain,
      png(4, 3, 3, (x, y) => [x * 60, y * 80, 7], 1),
    ),
    { same: true },
  )
  assert.deepEqual(
    diffPngs(
      plain,
      png(4, 3, 3, (x, y) => [x * 60, y * 80, 7], 2),
    ),
    { same: true },
  )
  const rgba = png(4, 3, 4, (x) => [x, 0, 0, 255])
  assert.equal(decodePng(rgba).channels, 4)
  assert.deepEqual(
    diffPngs(
      rgba,
      png(4, 3, 4, (x) => [x, 0, 0, 255], 1),
    ),
    { same: true },
  )
})

test('a change is reported by how many pixels and where', () => {
  const before = png(6, 5, 3, white)
  const after = png(6, 5, 3, (x, y) => (x >= 2 && x <= 3 && y === 4 ? [0, 0, 0] : [255, 255, 255]))
  assert.deepEqual(diffPngs(before, after), {
    same: false,
    changed: 2,
    box: { left: 2, top: 4, right: 3, bottom: 4 },
  })
  assert.deepEqual(diffPngs(before, png(6, 4, 3, white)), {
    same: false,
    size: { before: '6x5', after: '6x4' },
  })
})

test('comparing two directories names every screenshot, and the ones missing on a side', () => {
  const before = mkdtempSync(join(tmpdir(), 'eztweak-shots-'))
  const after = mkdtempSync(join(tmpdir(), 'eztweak-shots-'))
  writeFileSync(join(before, 'index-desktop.png'), png(2, 2, 3, white))
  writeFileSync(join(after, 'index-desktop.png'), png(2, 2, 3, white))
  writeFileSync(join(before, 'index-mobile.png'), png(2, 2, 3, white))
  writeFileSync(
    join(after, 'index-mobile.png'),
    png(2, 2, 3, (x) => (x ? [0, 0, 0] : [255, 255, 255])),
  )
  writeFileSync(join(after, 'pricing-desktop.png'), png(2, 2, 3, white))
  const lines = compare(before, after).map(describe)
  assert.deepEqual(lines, [
    'same     index-desktop.png',
    'differs  index-mobile.png: 2 pixels, x 1-1, y 0-1',
    'missing  pricing-desktop.png (no before)',
  ])
})

test('one viewport writes the file named, several write one each, and --page adds the page', () => {
  const desktop = { width: 1168, height: 861 }
  const phone = { width: 390, height: 844 }
  assert.deepEqual(
    shotFiles('/s/card.png', [desktop], false).map((f) => f.file),
    ['/s/card.png'],
  )
  assert.deepEqual(
    shotFiles('/s/card.png', [desktop, phone], true).map((f) => [f.file, f.kind]),
    [
      ['/s/card-1168x861.png', 'piece'],
      ['/s/card-page-1168x861.png', 'page'],
      ['/s/card-390x844.png', 'piece'],
      ['/s/card-page-390x844.png', 'page'],
    ],
  )
  assert.deepEqual(
    shotFiles('/s/card.png', [desktop], false, [
      { state: 'hover', target: '.cta' },
      { state: 'focus', target: '.card' },
    ]).map((f) => [f.file, f.kind, f.target]),
    [
      ['/s/card.png', 'piece', undefined],
      ['/s/card-hover.png', 'hover', '.cta'],
      ['/s/card-focus.png', 'focus', '.card'],
    ],
  )
  assert.deepEqual(
    shotFiles('/s/card.png', [desktop], true).map((f) => f.file),
    ['/s/card.png', '/s/card-page.png'],
  )
})

test('a viewport is WIDTHxHEIGHT, and flags come out of the arguments in any order', () => {
  assert.deepEqual(parseViewport('1168x861'), { width: 1168, height: 861 })
  assert.throws(() => parseViewport('desktop'), /WIDTHxHEIGHT/)
  assert.deepEqual(
    flags(['http://x/', '--viewport', '390x844', 'out.png', '--page', '--around', '.card']),
    { named: { viewport: '390x844', page: true, around: '.card' }, rest: ['http://x/', 'out.png'] },
  )
  assert.deepEqual(flags(['u', 'f', '--page']).named, { page: true }, 'a last flag is true too')
})

test('Chrome is CHROME_PATH when set, and a clear error when there is none to find', () => {
  assert.equal(findChrome({ CHROME_PATH: '/opt/chrome' }, 'linux'), '/opt/chrome')
  assert.throws(() => findChrome({}, 'plan9'), /set CHROME_PATH/)
})

test('loopback names are one origin, and the port and scheme still tell origins apart', () => {
  assert.ok(sameOrigin('http://localhost:5173', 'http://127.0.0.1:5173/pricing'))
  assert.ok(sameOrigin('http://[::1]:5173', 'http://localhost:5173'))
  assert.ok(!sameOrigin('http://localhost:5173', 'http://localhost:5174'))
  assert.ok(!sameOrigin('http://localhost:5173', 'https://localhost:5173'))
  assert.ok(!sameOrigin('http://app.test', 'http://localhost'))
})

test("a storageState signs in the page it belongs to, and nothing of another origin's", () => {
  const state = {
    cookies: [
      { name: 'sid', value: 's1', domain: 'localhost', path: '/' },
      { name: 'other', value: 'o', domain: 'api.example.com', path: '/' },
    ],
    origins: [
      {
        origin: 'http://localhost:5173',
        localStorage: [{ name: 'token', value: 't' }],
        sessionStorage: [],
        indexedDB: [],
      },
    ],
  }
  const signIn = signInFor('http://127.0.0.1:5173', state)
  assert.deepEqual(
    signIn?.cookies.map((c) => c.name),
    ['sid'],
  )
  assert.deepEqual(signIn?.storage?.localStorage, [{ name: 'token', value: 't' }])
  assert.equal(signInFor('http://localhost:5173', { cookies: [], origins: [] }), null)
  assert.equal(signInFor('http://localhost:5173', null), null)
  const elsewhere = signInFor('http://app.test:3000', state)
  assert.equal(elsewhere, null, 'a loopback cookie and storage do not reach another host')
})

test('a page that ends on another path or origin landed elsewhere; a trailing slash does not', () => {
  assert.ok(!landedElsewhere('http://localhost:5173/', 'http://localhost:5173'))
  assert.ok(!landedElsewhere('http://localhost:5173/app/', 'http://127.0.0.1:5173/app?x=1#top'))
  assert.ok(landedElsewhere('http://localhost:5173/app', 'http://localhost:5173/login?next=/app'))
  assert.ok(landedElsewhere('http://localhost:5173/app', 'https://accounts.example.com/signin'))
})

test('a state is put on the element it names, or on the piece, and --states is all three', () => {
  assert.deepEqual(statesFrom({ hover: '.cta', focus: true }, '.card'), [
    { state: 'hover', target: '.cta' },
    { state: 'focus', target: '.card' },
  ])
  assert.deepEqual(
    statesFrom({ states: true }, '.card').map((s) => s.state),
    ['hover', 'focus', 'active'],
  )
  assert.deepEqual(statesFrom({ page: true }, '.card'), [], 'none unless asked')
  assert.throws(() => statesFrom({ active: true }, null), /--active needs a selector/)
})
