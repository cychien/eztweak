import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { type CliRun, FakeInspire, LINEAR_ENTRY, STRIPE_ENTRY, runCli } from './helpers/inspire.js'

const service = new FakeInspire()

before(async () => {
  await service.start()
})
after(async () => {
  await service.stop()
})

/** Its own data dir, so nothing leaks between tests or into the real `~/.eztweak`. */
function world(): { dataDir: string; env: NodeJS.ProcessEnv } {
  const dataDir = mkdtempSync(join(tmpdir(), 'eztweak-inspire-cli-'))
  return {
    dataDir,
    env: {
      EZTWEAK_DATA_DIR: dataDir,
      EZTWEAK_INSPIRE_URL: service.url,
      HOME: dataDir,
      USERPROFILE: dataDir,
    },
  }
}

const search = ['inspire', '--tag', 'command-menu,calm']

/** Node's warnings share stderr, so "one line" is about the error lines only. */
const errorLines = (run: CliRun) =>
  run.stderr.split('\n').filter((line) => line.startsWith('error:'))

test('without a token the search does not run, and says which command fixes that', async () => {
  const { env } = world()
  const run = await runCli(search, env)
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.deepEqual(errorLines(run).length, 1, 'one line')
  assert.match(run.stderr, /run `eztweak login`/)
})

test('login stores the token owner-only, and the search then works', async () => {
  const { dataDir, env } = world()
  service.mode = 'ok'
  const login = await runCli(['login', '--token', 'tok_abc'], env)
  assert.equal(login.code, 0)
  const file = join(dataDir, 'credentials.json')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { inspire: { token: 'tok_abc' } })

  const sentBefore = service.searches.length
  const run = await runCli(search, env)
  assert.equal(run.code, 0, run.stderr)
  const sent = service.searches[sentBefore]!
  assert.equal(sent.token, 'tok_abc')
  assert.deepEqual(sent.body, { tags: ['command-menu', 'calm'] })

  const out = await runCli(['logout'], env)
  assert.equal(out.code, 0)
  assert.equal(existsSync(file), false)
  assert.equal((await runCli(search, env)).code, 2, 'and the token is really gone')
})

test('a result prints as its block, and its images land in the cache exactly once', async () => {
  const { dataDir, env } = world()
  service.mode = 'ok'
  await runCli(['login', '--token', 'tok_abc'], env)

  const first = await runCli([...search, '--limit', '2'], env)
  assert.equal(first.code, 0, first.stderr)
  const entryDir = join(dataDir, 'cache', 'inspiration', LINEAR_ENTRY.id)
  const screenshot = join(entryDir, 'screenshot-desktop-0.png')
  const mockup = join(entryDir, 'mockup-0.png')
  assert.ok(existsSync(screenshot) && existsSync(mockup))
  assert.ok(first.stdout.includes('## Linear: command menu  (slug linear-command-menu)'))
  assert.ok(first.stdout.includes('tags: command-menu, dialog, dense'))
  assert.ok(!first.stdout.includes('https://linear.app'), 'the source url is not printed')
  assert.ok(first.stdout.includes(screenshot) && first.stdout.includes(mockup))
  const code = join(entryDir, 'source.html')
  assert.equal(readFileSync(code, 'utf8'), LINEAR_ENTRY.sources!.html)
  assert.ok(first.stdout.includes(`code: ${code}`), 'the markup is handed over as a path')
  assert.ok(first.stdout.includes(`Why it works: ${LINEAR_ENTRY.why}`))
  assert.ok(first.stdout.includes(`Wrong when: ${LINEAR_ENTRY.wrong_when}`))
  assert.equal(service.searches.at(-1)!.body.limit, 2)

  const downloaded = service.imageRequests.length
  const fetchedCode = service.sourceRequests.length
  const second = await runCli([...search, '--limit', '2'], env)
  assert.equal(second.code, 0)
  assert.equal(service.imageRequests.length, downloaded, 'a cached image is not fetched again')
  assert.equal(
    service.sourceRequests.length,
    fetchedCode + 1,
    'the markup is fetched each time, since it is edited',
  )
  assert.equal(second.stdout, first.stdout)
})

test('--json prints the response with the local paths in place of the expiring urls', async () => {
  const { dataDir, env } = world()
  service.mode = 'ok'
  await runCli(['login', '--token', 'tok_abc'], env)
  const run = await runCli([...search, '--json'], env)
  assert.equal(run.code, 0, run.stderr)
  const body = JSON.parse(run.stdout) as {
    results: { images: { url: string }[]; sources: { url: string }[] }[]
  }
  assert.equal(
    body.results[0]!.images[0]!.url,
    join(dataDir, 'cache', 'inspiration', LINEAR_ENTRY.id, 'screenshot-desktop-0.png'),
  )
  assert.ok(!run.stdout.includes('/v1/images/'))
  assert.equal(
    body.results[0]!.sources[0]!.url,
    join(dataDir, 'cache', 'inspiration', LINEAR_ENTRY.id, 'source.html'),
  )
})

test('nothing matched is not a failure: one line, and the step goes on', async () => {
  const { env } = world()
  service.mode = 'empty'
  await runCli(['login', '--token', 'tok_abc'], env)
  const run = await runCli(search, env)
  service.mode = 'ok'
  assert.equal(run.code, 0)
  assert.equal(run.stdout.trim(), 'no matches for tags command-menu, calm')
})

test('a refused token exits 2 and says it was the token', async () => {
  const { env } = world()
  service.mode = '401'
  await runCli(['login', '--token', 'tok_stale'], env)
  const run = await runCli(search, env)
  service.mode = 'ok'
  assert.equal(run.code, 2)
  assert.equal(errorLines(run).length, 1)
  assert.match(run.stderr, /token was refused/)
})

test('a service that cannot be reached exits 2 in one line', async () => {
  const { env } = world()
  await runCli(['login', '--token', 'tok_abc'], env)
  service.mode = 'down'
  const run = await runCli(search, env)
  service.mode = 'ok'
  assert.equal(run.code, 2)
  assert.equal(errorLines(run).length, 1)
  assert.match(run.stderr, /cannot reach the inspiration service/)
})

test('a malformed invocation is a usage error, not a step that failed', async () => {
  const { env } = world()
  const noAxis = await runCli(['inspire'], env)
  assert.equal(noAxis.code, 1)
  assert.match(noAxis.stderr, /give --query, --tag, or both/)
  const noTty = await runCli(['login'], env)
  assert.equal(noTty.code, 1)
  assert.match(noTty.stderr, /login --token/)
})

test('a description alone is a search, and reaches the service as the query', async () => {
  const { env } = world()
  service.mode = 'ok'
  await runCli(['login', '--token', 'tok_abc'], env)

  const alone = await runCli(
    ['inspire', '--query', 'a settings dialog with a destructive delete'],
    env,
  )
  assert.equal(alone.code, 0, alone.stderr)
  assert.deepEqual(service.searches.at(-1)!.body, {
    query: 'a settings dialog with a destructive delete',
  })

  const withTags = await runCli(['inspire', '--query', 'a settings dialog', '--tag', 'dialog'], env)
  assert.equal(withTags.code, 0, withTags.stderr)
  assert.deepEqual(service.searches.at(-1)!.body, {
    query: 'a settings dialog',
    tags: ['dialog'],
  })
})

test('the block shows the inventory, marks the approximate entry, and never the score', async () => {
  const { env } = world()
  service.mode = 'ok'
  await runCli(['login', '--token', 'tok_abc'], env)
  const run = await runCli(['inspire', '--query', 'a checkout that shows the order'], env)
  assert.equal(run.code, 0, run.stderr)

  assert.ok(run.stdout.includes(`Shows: ${LINEAR_ENTRY.description}`))
  assert.ok(run.stdout.includes('Components: search input, result list, shortcut hint'))
  assert.ok(run.stdout.includes('Actions: run a command, jump to an issue, dismiss with escape'))
  assert.ok(!run.stdout.includes(LINEAR_ENTRY.wording![0]!), 'the wording is --json only')
  assert.ok(!run.stdout.includes(LINEAR_ENTRY.layout!), 'and so is the layout')
  assert.ok(!run.stdout.includes('score'))
  assert.ok(!run.stdout.includes('0.9'))

  assert.ok(run.stdout.includes(`## Stripe: checkout  (slug ${STRIPE_ENTRY.slug})  (approximate)`))
  assert.equal(run.stdout.match(/\(approximate\)/g)?.length, 1, 'only the entry read off an image')

  const json = await runCli(['inspire', '--query', 'a checkout', '--json'], env)
  const body = JSON.parse(json.stdout) as {
    results: { score: number; wording?: string[]; layout: string; layout_metrics?: unknown }[]
  }
  assert.equal(body.results[0]!.score, 0.9)
  assert.deepEqual(body.results[0]!.wording, LINEAR_ENTRY.wording)
  assert.equal(body.results[0]!.layout, LINEAR_ENTRY.layout)
  assert.deepEqual(body.results[0]!.layout_metrics, LINEAR_ENTRY.layout_metrics)
  assert.equal(body.results[1]!.wording, undefined)
})

test('an entry from before the inventory still renders as a block', async () => {
  const { env } = world()
  service.mode = 'ok'
  await runCli(['login', '--token', 'tok_abc'], env)
  const { description, elements, wording, actions, layout, layout_metrics, fidelity, ...old } =
    LINEAR_ENTRY
  service.entries = [old]
  const run = await runCli(['inspire', '--tag', 'command-menu'], env)
  service.entries = [LINEAR_ENTRY, STRIPE_ENTRY]
  assert.equal(run.code, 0, run.stderr)
  assert.ok(!run.stdout.includes('undefined'))
  for (const line of ['Shows:', 'Components:', 'Actions:', 'approximate']) {
    assert.ok(!run.stdout.includes(line), line)
  }
  assert.ok(run.stdout.includes(`Why it works: ${LINEAR_ENTRY.why}`))
})

test('the help lists the inspiration commands with the rest', async () => {
  const { env } = world()
  const run = await runCli(['--help'], env)
  assert.equal(run.code, 0)
  for (const line of [
    'login [--token <t>] | logout',
    'inspire [--query "<text>"] [--tag a,b]',
    'by tags, or both',
  ]) {
    assert.ok(run.stdout.includes(line), line)
  }
  assert.ok(run.stdout.includes('EZTWEAK_INSPIRE_URL'))
  assert.ok(!run.stdout.includes('vocabulary') && !run.stdout.includes('--feeling'))
})
