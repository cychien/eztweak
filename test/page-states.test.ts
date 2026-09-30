import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { decodePng, findChrome } from '../skills/eztweak/scripts/page.mjs'

const run = promisify(execFile)
const PAGE_SCRIPT = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  'skills/eztweak/scripts/page.mjs',
)

/** Each state paints the button one colour, and a click leaves a mark a later load shows. */
const PAGE = `<!doctype html><style>
  body { margin: 0; } main { padding: 1200px 60px 60px; }
  button { width: 120px; height: 40px; border: 0; background: rgb(255, 255, 255); outline: none; }
  button:hover { background: rgb(255, 0, 0); }
  button:focus-visible { background: rgb(0, 0, 255); }
  button:active { background: rgb(0, 255, 0); }
</style><main><div class="row"><button>Save</button></div></main><script>
  const b = document.querySelector('button')
  b.onclick = () => sessionStorage.setItem('clicked', '1')
  if (sessionStorage.getItem('clicked')) b.style.background = 'rgb(0, 0, 0)'
</script>`

let server: Server
const dir = mkdtempSync(join(tmpdir(), 'eztweak-states-'))
after(() => {
  server?.close()
  rmSync(dir, { recursive: true, force: true })
})

/** The colour inside the button, clear of its label; it sits `margin` in from the crop's corner. */
function buttonColour(file: string): string {
  const png = decodePng(readFileSync(file))
  const x = (48 + 8) * 2
  const y = (48 + 20) * 2
  const i = (y * png.width + x) * png.channels
  return `${png.pixels[i]},${png.pixels[i + 1]},${png.pixels[i + 2]}`
}

test('each state is shot as a person would cause it, at twice the pixels, without a click', async (t) => {
  try {
    findChrome()
  } catch {
    return t.skip('no Chrome to open the page in')
  }
  server = createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE),
  )
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const out = join(dir, 'row.png')
  const { stdout } = await run('node', [
    PAGE_SCRIPT,
    'shot',
    url,
    out,
    '--around',
    'button',
    '--states',
    '--viewport',
    '800x600,700x600',
  ])
  assert.ok(stdout.includes('row-hover-800x600.png'))
  const at = (name: string) => buttonColour(join(dir, `${name}.png`))
  assert.equal(decodePng(readFileSync(join(dir, 'row-800x600.png'))).width, (120 + 96) * 2)
  assert.equal(at('row-800x600'), '255,255,255', 'at rest, and nothing left over from a state')
  assert.equal(at('row-hover-800x600'), '255,0,0')
  assert.equal(at('row-focus-800x600'), '0,0,255', 'focus from the keyboard, so :focus-visible')
  assert.equal(at('row-active-800x600'), '0,255,0')
  assert.equal(at('row-700x600'), '255,255,255', 'the press was let go without a click')
})
