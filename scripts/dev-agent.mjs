import { devTargetUrl, runCli } from './dev-env.mjs'

/** Stands in for a real coding agent: polls, prints every anchor field the agent
 *  would have to work from, then replies and polls again. Lets one person walk
 *  the whole loop without a second party. */

const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`

function describe(item, index) {
  console.log(`\n${bold(`#${index + 1}`)} ${dim(`[${item.kind}]`)} ${item.label}`)
  if (item.comment) console.log(`   ${item.comment}`)
  const a = item.anchor ?? {}
  const rows = [
    ['source', a.source ?? dim('(none - fallbacks only)')],
    ['components', a.components?.join(' ← ')],
    ['section', a.section],
    ['selector', a.selector],
    ['text', a.text && JSON.stringify(a.text)],
    ['viewport', a.viewport && `${a.viewport.preset ?? '?'} (${a.viewport.width}×${a.viewport.height})`],
    ['point.rel', a.point?.rel && `${a.point.rel.x?.toFixed(2)}, ${a.point.rel.y?.toFixed(2)}`],
  ]
  for (const [key, value] of rows) {
    if (value) console.log(`   ${dim(key.padEnd(11))}${value}`)
  }
  printExtras(item, '   ')
}

/** What the user handed over alongside the anchor. Both are what a real agent
 *  would act on - a path it has to open, and an element the comment points at -
 *  so a loop that does not show them cannot be used to check they arrived. */
function printExtras(carrier, indent) {
  for (const file of carrier.attachments ?? []) {
    console.log(`${indent}${dim('file'.padEnd(11))}${file.path} ${dim(`(${file.mime}, ${file.size}B)`)}`)
  }
  for (const r of carrier.references ?? []) {
    const a = r.anchor ?? {}
    const where = [a.source, a.components?.length && `<${a.components.join(' ← ')}>`, a.page]
      .filter(Boolean)
      .join(' · ')
    console.log(`${indent}${dim(`ref ${r.n}`.padEnd(11))}${r.label} ${dim(`→ ${where}`)}`)
  }
}

const url = process.argv[2] ?? devTargetUrl()
console.log(dim(`fake agent polling ${url} - annotate in the browser and hit send`))

let reply = '假 agent 已連線，開始 review 吧'
for (;;) {
  const raw = await runCli(['poll', url, '--agent-reply', reply], { capture: true })
  const result = JSON.parse(raw)

  if (result.type === 'session-ended') {
    console.log(dim('\nsession ended by the user - stopping'))
    break
  }

  console.log(`\n${bold(`── batch ${result.batchId ?? ''}`)} (${result.items.length} items)`)
  if (result.note) console.log(dim(`note: ${result.note}`))
  printExtras(result, '')
  result.items.forEach(describe)

  reply = result.items.map((item, i) => `#${i + 1} ${item.label} → 假裝改好了`).join('\n')
}
