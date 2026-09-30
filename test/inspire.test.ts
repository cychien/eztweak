import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_INSPIRE_URL,
  type InspireEntry,
  apiUrl,
  cacheFiles,
  entryTitle,
  imageCachePath,
  inspirationCacheDir,
  inspireBaseUrl,
  noMatchesLine,
  parseSearchArgs,
  renderEntry,
  renderSearch,
  sourceCachePath,
  withLocalPaths,
} from '../src/inspire.js'

const entry: InspireEntry = {
  id: 'ent_7f3a',
  slug: 'linear-command-menu',
  source_name: 'Linear',
  source_url: 'https://linear.app',
  why: 'Every action is one keystroke away.',
  wrong_when: 'Nobody here learns a shortcut.',
  tags: ['command-menu', 'dialog', 'dense'],
  images: [{ kind: 'screenshot', viewport: 'desktop', position: 0, url: 'https://x/1' }],
}

test('the base url comes from the environment, and falls back to the service', () => {
  assert.equal(inspireBaseUrl({}), DEFAULT_INSPIRE_URL)
  assert.equal(inspireBaseUrl({ EZTWEAK_INSPIRE_URL: '' }), DEFAULT_INSPIRE_URL)
  assert.equal(inspireBaseUrl({ EZTWEAK_INSPIRE_URL: 'http://127.0.0.1:9/' }), 'http://127.0.0.1:9')
  assert.equal(apiUrl('/v1/search', 'http://127.0.0.1:9'), 'http://127.0.0.1:9/v1/search')
  assert.equal(apiUrl('v1/search', 'http://127.0.0.1:9'), 'http://127.0.0.1:9/v1/search')
})

test('an image caches under its entry, named by kind, viewport and position', () => {
  const dir = '/data'
  assert.equal(
    imageCachePath('ent_7f3a', entry.images![0]!, 0, dir),
    join(inspirationCacheDir(dir), 'ent_7f3a', 'screenshot-desktop-0.png'),
  )
  assert.equal(
    imageCachePath(
      'ent_7f3a',
      { kind: 'screenshot', viewport: 'mobile', position: 2, url: '' },
      0,
      dir,
    ),
    join(inspirationCacheDir(dir), 'ent_7f3a', 'screenshot-mobile-2.png'),
  )
  assert.equal(
    imageCachePath('ent_7f3a', { kind: 'mockup', viewport: null, url: '' }, 1, dir),
    join(inspirationCacheDir(dir), 'ent_7f3a', 'mockup-1.png'),
    'a mockup has no viewport, so it takes no segment for one',
  )
})

test('the title is the slug without the source name it is already headed by', () => {
  assert.equal(entryTitle(entry), 'command menu')
  assert.equal(
    entryTitle({ ...entry, source_name: 'GitHub', slug: 'github-pr-review' }),
    'pr review',
  )
  assert.equal(entryTitle({ ...entry, source_name: 'Linear', slug: 'linear' }), 'linear')
  assert.equal(entryTitle({ ...entry, source_name: 'Stripe', slug: 'checkout' }), 'checkout')
})

test('a result renders as the block the agent reads, and drops what the entry lacks', () => {
  assert.equal(
    renderEntry(entry, { images: ['/cache/ent_7f3a/screenshot-desktop-0.png'], sources: [] }),
    [
      '## Linear: command menu  (slug linear-command-menu)',
      'tags: command-menu, dialog, dense',
      'Why it works: Every action is one keystroke away.',
      'Wrong when: Nobody here learns a shortcut.',
      'images: /cache/ent_7f3a/screenshot-desktop-0.png',
    ].join('\n'),
  )
  const bare = renderEntry({ ...entry, tags: [], wrong_when: null })
  assert.ok(!bare.includes('tags:'))
  assert.ok(!bare.includes('linear.app'), 'the source url is not worth a line')
  assert.ok(!bare.includes('images:'))
  assert.ok(!bare.includes('Wrong when:'))
  assert.ok(bare.includes('Why it works:'))
})

test('the block says what the entry shows, and marks an inventory read off an image', () => {
  const full: InspireEntry = {
    ...entry,
    description: 'A command menu over the whole product.',
    elements: ['search_input', 'result_list'],
    wording: ['Type a command or search'],
    actions: ['run a command', 'jump to an issue'],
    layout: 'The input sits above the results.',
    layout_metrics: { columns: 1 },
    fidelity: 'dom',
    score: 0.82,
  }
  const rendered = renderEntry(full)
  assert.equal(
    rendered,
    [
      '## Linear: command menu  (slug linear-command-menu)',
      'tags: command-menu, dialog, dense',
      'Shows: A command menu over the whole product.',
      'Components: search input, result list',
      'Actions: run a command, jump to an issue',
      'Why it works: Every action is one keystroke away.',
      'Wrong when: Nobody here learns a shortcut.',
    ].join('\n'),
  )
  assert.ok(!rendered.includes('Type a command or search'))
  assert.ok(!rendered.includes('The input sits above the results.'))
  assert.ok(!rendered.includes('0.82'))

  const approximate = renderEntry({ ...full, fidelity: 'image', wording: undefined })
  assert.ok(
    approximate.startsWith('## Linear: command menu  (slug linear-command-menu)  (approximate)'),
  )
  assert.equal(approximate.match(/approximate/g)?.length, 1, 'one word, in the heading line')
})

test('why it works prints as written, beneath its label when it has several lines', () => {
  const why = '- The popover is dark.\n- Its image is a mockup.'
  assert.ok(renderEntry({ ...entry, why }).includes(`Why it works:\n${why}`))
  assert.ok(renderEntry(entry).includes('Why it works: Every action is one keystroke away.'))
})

test('an entry from before the inventory renders without its lines', () => {
  const rendered = renderEntry(entry)
  assert.ok(!rendered.includes('undefined'))
  for (const line of ['Shows:', 'Components:', 'Actions:', 'approximate']) {
    assert.ok(!rendered.includes(line), line)
  }
  assert.ok(rendered.includes('Why it works:'))
})

test('an entry s working implementation prints as a code path', () => {
  const rendered = renderEntry(entry, { images: [], sources: ['/cache/ent_7f3a/source.html'] })
  assert.ok(
    rendered.endsWith('\ncode: /cache/ent_7f3a/source.html'),
    'the paths come after the text',
  )
  assert.ok(!renderEntry(entry).includes('code:'), 'no line when there is no code')
})

test('no results is one line naming what was asked', () => {
  const query = { tags: ['hero', 'dark popover'] }
  assert.equal(noMatchesLine(query), 'no matches for tags hero, dark popover')
  assert.equal(renderSearch({ results: [] }, new Map(), query), noMatchesLine(query))
  const rendered = renderSearch(
    { results: [entry] },
    new Map([['ent_7f3a', { images: ['/cache/a.png'], sources: [] }]]),
    query,
  )
  assert.ok(rendered.startsWith('## Linear:'))
  assert.equal(
    noMatchesLine({ query: 'a settings dialog', tags: ['calm'] }),
    'no matches for "a settings dialog" · tags calm',
  )
})

test('--json carries the local paths, because the service urls expire', () => {
  const dir = '/data'
  const source = { kind: 'html', url: 'https://x/source' }
  const withSource = { ...entry, sources: [source] }
  const image = entry.images![0]!
  const substituted = withLocalPaths(
    { results: [withSource] },
    new Map([
      [
        'ent_7f3a',
        {
          images: [imageCachePath('ent_7f3a', image, 0, dir)],
          sources: [sourceCachePath('ent_7f3a', source, dir)],
        },
      ],
    ]),
    dir,
  )
  assert.equal(substituted.results[0]!.images![0]!.url, imageCachePath('ent_7f3a', image, 0, dir))
  assert.equal(substituted.results[0]!.sources![0]!.url, sourceCachePath('ent_7f3a', source, dir))
  const untouched = withLocalPaths({ results: [entry] }, new Map(), dir)
  assert.equal(untouched.results[0]!.images![0]!.url, 'https://x/1')
})

test('an image that could not be cached keeps its url, and does not shift the others', () => {
  const dir = '/data'
  const mobile = { kind: 'screenshot', viewport: 'mobile', position: 0, url: 'https://x/2' }
  const both = { ...entry, images: [...entry.images!, mobile] }
  const substituted = withLocalPaths(
    { results: [both] },
    new Map([['ent_7f3a', { images: [imageCachePath('ent_7f3a', mobile, 1, dir)], sources: [] }]]),
    dir,
  )
  const [desktopUrl, mobileUrl] = substituted.results[0]!.images!.map((i) => i.url)
  assert.equal(desktopUrl, 'https://x/1')
  assert.equal(mobileUrl, imageCachePath('ent_7f3a', mobile, 1, dir))
})

test('the desktop screenshot is listed first, whatever order the service sent', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'eztweak-inspire-'))
  const shot = (viewport: string, url: string) => ({
    kind: 'screenshot',
    viewport,
    position: 0,
    url,
  })
  const images = [
    shot('detail', 'https://x/d'),
    shot('mobile', 'https://x/m'),
    shot('desktop', 'https://x/w'),
  ]
  const fetchImpl = (async () => new Response(new Uint8Array([1]))) as typeof fetch
  const files = await cacheFiles([{ ...entry, images }], { dataDir, fetchImpl })
  assert.deepEqual(files.get('ent_7f3a')!.images, [
    imageCachePath('ent_7f3a', images[2]!, 2, dataDir),
    imageCachePath('ent_7f3a', images[1]!, 1, dataDir),
    imageCachePath('ent_7f3a', images[0]!, 0, dataDir),
  ])
})

test('the search arguments take a description, comma-separated tags, or both', () => {
  assert.deepEqual(parseSearchArgs(['--tag', 'hero, dark popover']), {
    query: undefined,
    tags: ['hero', 'dark popover'],
    limit: undefined,
    json: false,
  })
  assert.deepEqual(parseSearchArgs(['--tag', 'calm', '--limit', '5', '--json']), {
    query: undefined,
    tags: ['calm'],
    limit: 5,
    json: true,
  })
  assert.deepEqual(parseSearchArgs(['--query', '  a settings dialog  ']), {
    query: 'a settings dialog',
    tags: [],
    limit: undefined,
    json: false,
  })
  assert.deepEqual(parseSearchArgs(['--query', 'a settings dialog', '--tag', 'calm']), {
    query: 'a settings dialog',
    tags: ['calm'],
    limit: undefined,
    json: false,
  })
  const nothing = { error: 'give --query, --tag, or both' }
  assert.deepEqual(parseSearchArgs([]), nothing)
  assert.deepEqual(parseSearchArgs(['--tag', ' , ']), nothing)
  assert.deepEqual(parseSearchArgs(['--query', '   ']), nothing)
  assert.deepEqual(parseSearchArgs(['--query']), { error: 'missing value for --query' })
  assert.deepEqual(parseSearchArgs(['--tag']), { error: 'missing value for --tag' })
  assert.deepEqual(parseSearchArgs(['--tag', 'hero', '--limit', 'x']), {
    error: 'invalid --limit: x',
  })
  assert.deepEqual(parseSearchArgs(['--tag', 'hero', '--limit', '0']), {
    error: 'invalid --limit: 0',
  })
})
