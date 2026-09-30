import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  HARNESS_OFF,
  HARNESS_ON,
  HARNESS_WORDS,
  type Truth,
  harnessReady,
  missingTruth,
  setupBrief,
  skillDir,
  skillReference,
  truthBrief,
  truthExploreRule,
  truthFilesZh,
  truthState,
} from '../src/truth.js'

const SRC = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src')
const SKILL = skillDir(SRC)

const project = () => mkdtempSync(join(tmpdir(), 'eztweak-truth-'))
const truth = (product: boolean, design: boolean, enabled = true, seen = false): Truth => ({
  product,
  design,
  enabled,
  seen,
})

test('a turn is in the harness only when its prompt says so, and told when it no longer is', () => {
  const on = truthBrief(truth(true, true), SKILL)
  assert.equal(on[0], HARNESS_ON)
  assert.equal(truthBrief(truth(false, false), SKILL)[0], HARNESS_ON, 'building first says it too')
  assert.equal(setupBrief(truth(false, false), SKILL)[0], HARNESS_ON)
  assert.deepEqual(truthBrief(truth(true, true, false, false), SKILL), [], 'never seen: nothing')
  assert.deepEqual(
    truthBrief(truth(true, true, false, true), SKILL),
    [HARNESS_OFF],
    'seen: retracted',
  )
  assert.ok(HARNESS_OFF.includes('no edits to `PRODUCT.md`, `DESIGN.md` or `.eztweak/config.json`'))
  const explore = (t: Truth) => truthExploreRule(t, SKILL).join('\n')
  assert.ok(explore(truth(true, true)).includes(HARNESS_ON))
  assert.ok(explore(truth(true, true, false, true)).includes(HARNESS_OFF))
  assert.ok(!explore(truth(true, true, false, false)).includes('design harness'))
})

test('an ordinary change edits code only; the two files change on a request or a learning signal', () => {
  const rule = truthBrief(truth(true, true), SKILL).join(' ')
  assert.ok(rule.includes('An ordinary change edits code only'))
  assert.ok(!/extend|as well as the code/.test(rule), 'no standing licence to edit the files')
  const make = readFileSync(skillReference(SKILL, 'make'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(
    make.includes(
      'A value becomes a token in the design system, under a name that says what it is',
    ),
    'a recurring value goes to the design system, not the document',
  )
  assert.ok(make.includes('appear for the third time'), 'three times makes a pattern')
  assert.ok(make.includes('a piece of UI becomes a component in the project'))
  assert.ok(make.includes('its name goes into `components.primitives`'), 'so later work reuses it')
  assert.ok(make.includes('Twice is not yet a pattern'))
  assert.ok(make.includes('An explore extracts nothing'))
  assert.ok(make.includes('change only on what the user has actually said'))
  assert.ok(
    make.includes('name the line in 順帶一提 and leave the file as it is'),
    'stale is reported',
  )
  const principles = readFileSync(skillReference(SKILL, 'principles'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(principles.includes('A value that keeps coming up becomes a token in the system'))
  assert.ok(!principles.includes('extend the document'))
  const skill = readFileSync(join(SKILL, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(skill.includes('An ordinary change edits code only'))
})

test('every harness reference says it applies only when a prompt turns it on', () => {
  for (const name of [
    'product',
    'stack',
    'design',
    'components',
    'make',
    'baseline',
    'principles',
    'inspiration',
    'critique',
  ]) {
    const doc = readFileSync(skillReference(SKILL, name), 'utf8').replace(/\s*>\s*/g, ' ')
    assert.ok(
      doc.includes('Only for a turn whose prompt says 增強設計 (the design harness) is on'),
      name,
    )
    assert.ok(doc.includes('as if you had never read this file'), name)
  }
  const skill = readFileSync(join(SKILL, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(
    skill.includes('only when the user explicitly asks for 增強設計'),
    'the description never auto-triggers it',
  )
  assert.ok(skill.includes('never for an ordinary UI request'))
  assert.ok(
    skill.includes('handled as if this skill had never been read, even later in a conversation'),
  )
  assert.ok(skill.includes(HARNESS_ON))
})

test('the state reads both files, and carries the switch as given', () => {
  const dir = project()
  assert.deepEqual(truthState(dir, false), truth(false, false, false))
  assert.deepEqual(truthState(dir, true), truth(false, false, true))
  writeFileSync(join(dir, 'DESIGN.md'), '---\nname: Fixture\n---\n')
  assert.deepEqual(truthState(dir, true), truth(false, true))
  writeFileSync(join(dir, 'PRODUCT.md'), '# Product\n')
  assert.deepEqual(truthState(dir, true), truth(true, true))
})

test('what is missing is what is missing, product first, whatever the switch says', () => {
  assert.deepEqual(missingTruth(truth(false, false)), ['product', 'design'])
  assert.deepEqual(missingTruth(truth(true, false)), ['design'])
  assert.deepEqual(missingTruth(truth(false, true)), ['product'])
  assert.deepEqual(missingTruth(truth(true, true)), [])
  assert.deepEqual(missingTruth(truth(false, false, false)), ['product', 'design'])
  assert.equal(truthFilesZh(['product', 'design']), 'PRODUCT.md 與 DESIGN.md')
  assert.equal(truthFilesZh(['design']), 'DESIGN.md')
})

test('the harness is ready only when switched on with both files in place', () => {
  assert.equal(harnessReady(truth(true, true)), true)
  assert.equal(harnessReady(truth(true, true, false)), false, "the switch is the user's call")
  assert.equal(harnessReady(truth(true, false)), false)
  assert.equal(harnessReady(truth(false, false)), false)
})

test('switched off: the brief is nothing at all, whatever the project has', () => {
  assert.deepEqual(truthBrief(truth(true, true, false), SKILL), [])
  assert.deepEqual(truthBrief(truth(false, false, false), SKILL), [])
  assert.deepEqual(truthBrief(truth(false, true, false), SKILL), [])
})

test('switched on with both files: the standing rule, and no question', () => {
  const rule = truthBrief(truth(true, true), SKILL).join(' ')
  assert.ok(rule.includes('Read `PRODUCT.md` and `DESIGN.md` at the project root'))
  assert.ok(rule.includes('Keep to `PRODUCT.md`;'))
  assert.ok(rule.includes('a direction to start from, not a rule to obey'), 'DESIGN.md guides')
  assert.ok(!rule.includes('the prose as much as the tokens'))
  assert.ok(!rule.includes('這個專案') && !rule.includes('ask the user'))
})

test('switched on with a file missing: the steps that build it, then make, and no question', () => {
  const both = truthBrief(truth(false, false), SKILL).join('\n')
  assert.ok(both.includes(HARNESS_ON))
  assert.ok(!both.includes('這個專案') && !both.includes('ask the user'), 'the switch was the ask')
  const at = (name: string) => both.indexOf(skillReference(SKILL, name))
  assert.ok(at('product') > 0 && at('stack') > at('product') && at('design') > at('stack'))
  assert.ok(at('components') > at('design'), 'then the design system and components')
  assert.ok(at('make') > at('components'), 'and the batch is handled by the making step')
  assert.ok(!both.includes('direction to start from'), 'nothing exists to guide yet')

  const noDesign = truthBrief(truth(true, false), SKILL).join('\n')
  assert.ok(
    noDesign.includes('`DESIGN.md`') && !noDesign.includes(skillReference(SKILL, 'product')),
  )
  assert.ok(noDesign.includes(skillReference(SKILL, 'design')))
})

test('the setup brief walks the steps for what is missing, and has no batch to handle', () => {
  const setup = setupBrief(truth(false, false), SKILL).join('\n')
  assert.ok(
    setup.includes('switched on the design harness - 增強設計'),
    'named as the user sees it',
  )
  const at = (name: string) => setup.indexOf(skillReference(SKILL, name))
  assert.ok(at('product') > 0 && at('stack') > at('product') && at('design') > at('stack'))
  assert.ok(at('components') > at('design'))
  assert.ok(at('make') < 0, 'there is no batch to make anything for')
  assert.ok(setup.includes('No feedback batch comes with this turn and no UI is to change'))
  const done = setupBrief(truth(true, true), SKILL).join('\n')
  assert.ok(done.includes('nothing to set up'))
  assert.ok(!done.includes(skillReference(SKILL, 'product')))
})

const CLI = '/usr/local/bin/node /Users/me/.npm/_npx/abc/node_modules/eztweak/dist/cli.mjs'
const INSPIRE = { cli: CLI }

test('the briefs stay short enough to be read', () => {
  // The prose, not the paths: how long a path is depends on where the skill is installed.
  const len = (lines: string[]) => lines.join('\n').replaceAll(SKILL, '').replaceAll(CLI, '').length
  assert.ok(len(truthBrief(truth(false, false), SKILL, INSPIRE)) < 1000, 'building first')
  assert.ok(len(truthBrief(truth(true, true), SKILL, INSPIRE)) < 800, 'the rule')
  assert.ok(len(setupBrief(truth(false, false), SKILL, INSPIRE)) < 1150, 'the setup')
})

// The published package may predate a command, so the agent runs the daemon's own CLI, and it
// hears the feature in the user's words - both only in a turn the harness is on for.
test('a harness-on turn names the CLI to run and the words to use; any other turn neither', () => {
  const on = truthBrief(truth(true, true), SKILL, INSPIRE).join('\n')
  assert.ok(on.includes(HARNESS_WORDS))
  assert.ok(on.includes(`\`${CLI} inspire ...\``) && on.includes('never another copy of eztweak'))
  assert.ok(truthBrief(truth(false, false), SKILL, INSPIRE).join('\n').includes(`${CLI} inspire`))
  assert.ok(setupBrief(truth(false, false), SKILL, INSPIRE).join('\n').includes(`${CLI} inspire`))
  assert.ok(
    truthExploreRule(truth(true, true), SKILL, INSPIRE).join('\n').includes(`${CLI} inspire`),
  )
  for (const lines of [
    truthBrief(truth(true, true, false, true), SKILL, INSPIRE),
    truthBrief(truth(true, true, false, false), SKILL, INSPIRE),
    truthExploreRule(truth(true, true, false, false), SKILL, INSPIRE),
  ]) {
    const text = lines.join('\n')
    assert.ok(!text.includes(' inspire ...') && !text.includes(HARNESS_WORDS))
  }
  const inspiration = readFileSync(skillReference(SKILL, 'inspiration'), 'utf8').replace(
    /\s+/g,
    ' ',
  )
  assert.ok(inspiration.includes('Never look for another copy or version of eztweak to run'))
  assert.ok(inspiration.includes('never another way to run the command'))
  const make = readFileSync(skillReference(SKILL, 'make'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(
    make.includes('in the language they write in, and in their words: 增強設計, 設計規範, 靈感'),
  )
  const skill = readFileSync(join(SKILL, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(skill.includes('talk to the user in the language they write in and in their words'))
})

test('the skill directory resolves from the source tree, and every reference is there', () => {
  assert.ok(existsSync(join(SKILL, 'SKILL.md')), SKILL)
  for (const name of [
    'start',
    'product',
    'stack',
    'design',
    'components',
    'make',
    'baseline',
    'principles',
    'inspiration',
    'critique',
  ]) {
    assert.ok(existsSync(skillReference(SKILL, name)), name)
  }
})

test('the design reference follows the spec, measures the running page, and holds no components', () => {
  const doc = readFileSync(skillReference(SKILL, 'design'), 'utf8')
  assert.ok(doc.includes('designmd spec'), 'it defers to the spec')
  assert.ok(doc.includes('**the tokens are anchors, not a full set**'))
  assert.ok(doc.includes('The rendered page'))
  assert.ok(doc.includes('**Frequency**'), 'and counts, which separates system from exception')
  assert.ok(doc.includes('designmd lint DESIGN.md'))
  assert.ok(doc.includes('PRODUCT.md'), "the Overview's voice comes from the product file")
  assert.ok(doc.includes('do not silently overwrite it'), 'an existing document is not clobbered')
  assert.ok(doc.includes('**Components are not defined here.**'))
  assert.ok(doc.includes('no `components:` group'))
  assert.ok(!doc.includes('\n## Components\n'), 'the body template has no Components section')
  for (const heading of [
    '`Overview`',
    '`Colors`',
    '`Typography`',
    '`Layout`',
    '`Elevation & Depth`',
    '`Shapes`',
    "`Do's and Don'ts`",
  ]) {
    assert.ok(doc.includes(heading), heading)
  }
  assert.ok(doc.includes('Do not rename or paraphrase the canonical headings'))
})

test('the design reference asks the client for what measurement cannot give, in two modes', () => {
  const doc = readFileSync(skillReference(SKILL, 'design'), 'utf8')
  assert.ok(doc.includes('### Step 4: Ask for what cannot be extracted'))
  assert.ok(doc.includes('two rounds of at most three questions'))
  assert.ok(!doc.includes('North Star'), 'no metaphor for later designs to reach for')
  assert.ok(doc.includes('anti-reference'))
  assert.ok(
    !doc.includes('**Colour character**'),
    "naming the colours is the agent's job, not a question",
  )
  assert.ok(doc.includes('add one of\nyour own when the project needs it'))
  assert.ok(doc.includes('## Scan mode') && doc.includes('## Seed mode'))
  assert.ok(doc.includes('do not switch silently'))
  assert.ok(
    doc.includes('12px and 14px'),
    'density is derived from the product when there are no tokens',
  )
})

test('the design reference keeps the language broad: character and anchors, no scales', () => {
  const doc = readFileSync(skillReference(SKILL, 'design'), 'utf8')
  const flat = doc.replace(/\s+/g, ' ')
  assert.ok(flat.includes('a direction agents start from when they design, not a specification'))
  assert.ok(doc.includes('**Keep it\nbroad.**'))
  assert.ok(flat.includes('everything made from it comes out looking alike'))
  assert.ok(doc.includes('**Anchors only.**') && doc.includes('No scale'))
  assert.ok(doc.includes('Do not write out scales'))
  assert.ok(!doc.includes('Named Rules') && !doc.includes('Shadow Vocabulary'), 'no doctrine')
  assert.ok(doc.includes('**Tendencies, not requirements**'))
  assert.ok(doc.includes('`gray-100`'))
  assert.ok(doc.includes('Key Characteristics'))
  assert.ok(doc.includes('would read the same pasted onto another product'))
  assert.ok(doc.includes('`omitted`'), 'a left-out group is declared, so the linter reads it')
  assert.ok(
    doc.includes(
      'Do not add frontmatter groups outside `colors`, `typography`, `rounded`, `spacing` and `omitted`',
    ),
  )
})

test('the design system carries the scales DESIGN.md leaves out', () => {
  const doc = readFileSync(skillReference(SKILL, 'components'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(doc.includes("the scales it does not write out are this step's"))
  assert.ok(doc.includes('`DESIGN.md` is not edited for them'))
  assert.ok(!doc.includes('Do not add a scale step the document does not have'))
})

test('the principles reference states its defaults, and states that they are defaults', () => {
  const doc = readFileSync(skillReference(SKILL, 'principles'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(doc.includes('**default, not a ban**'))
  assert.ok(doc.includes('the user asking for it in so many words can earn any of them back'))
  assert.ok(doc.includes("a precedent's move, or the user"), 'a precedent can earn a default back')
  assert.ok(doc.includes('One dark surface on a light page'), 'contrast is not a theme')
  assert.ok(!doc.includes('say which one and why'), 'no ledger of departures')
  assert.ok(doc.includes('after [baseline.md](baseline.md)'), 'the baseline is read first')
  const floor = doc.slice(doc.indexOf('## The craft floor'))
  assert.ok(
    floor.includes('**No card inside a card.**'),
    'a floor, not a default DESIGN.md can lift',
  )
  assert.ok(floor.includes('This holds whatever `DESIGN.md` or a precedent suggests'))
  assert.equal(doc.match(/card inside a card/gi)?.length, 1, 'stated once')
  assert.ok(doc.includes('## Against AI slop'))
  assert.ok(doc.includes('## The craft floor'), 'a floor that holds whatever the direction is')
  assert.ok(doc.includes("## The project's design system"))
  assert.ok(doc.includes('as closely as the system is complete'), 'adherence follows completeness')
  for (const tell of [
    'Do not number sections',
    'Do not put a task in a modal',
    'Do not reach for gradient text',
    'Do not use hard offset shadows',
    'Do not use glowing shadows',
    'Do not approximate an organic contour',
    'Monospace is for code',
    'Do not use emoji or Unicode glyphs',
    'Default to a light page',
    'Content lines up with content',
    "A secondary card's description stops at three lines",
    'No thick coloured border on one side of a card',
    'No thick accent border on a rounded element',
    'Do not pair a hairline border with a wide diffuse shadow',
    'need an explicit reason',
    'Do not crush letter spacing',
    'Do not use one spacing value everywhere',
    'Do not use bounce or elastic easing',
    'Do not use a pulsing status dot',
    'Do not assemble an illustration out of primitive shapes',
    'Do not lean on em dashes',
    'No SaaS buzzwords',
    'No aphoristic cadence',
    'Text reads without effort',
    'Never grey text on a coloured background',
    'Text does not touch its container or the edge of the viewport',
    'Nothing overflows its container',
    'A clipping container does not swallow a popover',
    'Cards in a horizontal scroller keep the same inset on both sides',
    'Animate transform and opacity, not layout',
  ]) {
    assert.ok(doc.includes(tell), tell)
  }
})

test("the baseline is the author's taste, stated as rules a build can be held to", () => {
  const doc = readFileSync(skillReference(SKILL, 'baseline'), 'utf8').replace(/\s+/g, ' ')
  const sections = [
    '## Usability comes first',
    '## Aim for outstanding, never average',
    '## Know what the point of the page is',
    '## Design for the whole screen',
    '## Hierarchy is always visible',
    '## Grey first, colour sparingly',
    '## Quality comes from proportion and detail',
    '## Decoration serves, never competes',
  ].map((h) => doc.indexOf(h))
  assert.ok(
    sections.every((i, n) => i > 0 && (n === 0 || i > sections[n - 1]!)),
    'usability leads, and the point of the page comes before what leans on it',
  )
  assert.ok(doc.includes('**Never hide what matters to look minimal.**'))
  assert.ok(doc.includes('**Do not settle for the safe average.**'))
  assert.ok(doc.includes('**Outstanding comes from judgment and precision, not novelty.**'))
  assert.ok(doc.includes('**A component is designed in its screen, never on its own.**'))
  assert.ok(doc.includes('**Better alone and worse on the screen is worse.**'))
  assert.ok(doc.includes('**Start from the least the screen can do its job with.**'))
  assert.ok(
    doc.includes("On a list of posts, each post's title is the point, and its excerpt is not"),
  )
  assert.ok(doc.includes('a page with many points has none'))
  assert.ok(doc.includes('**Nearness and likeness mean relation.**'))
  assert.ok(doc.includes('**Distance and difference mean separation.**'))
  assert.ok(doc.includes('**The darkest greys are for the point.**'))
  assert.ok(doc.includes('**Lines and borders are light grey.**'))
  assert.ok(doc.includes('Do not reach for a dark-grey token to draw a line'))
  assert.ok(doc.includes('**Weight and colour balance each other.**'))
  assert.ok(doc.includes('spacing only has to feel comfortable'), 'a page that presents')
  assert.ok(doc.includes('spacing is compact but easy to scan'), 'a page people work in')
  assert.ok(doc.includes('**Few elements, each finished with care.**'))
  assert.ok(doc.includes('**Type runs small.**'))
  assert.ok(doc.includes('Large, heavy type needs a real reason'))
  assert.ok(doc.includes('refined beats plain'))
  assert.ok(doc.includes('Nothing decorative is louder than the point of the page'))
  assert.ok(!doc.includes('super clean'), 'the bar is the rules, not a reaction to aim for')
})

test('the components reference makes the tokens real in the stack without changing a pixel', () => {
  const doc = readFileSync(skillReference(SKILL, 'components'), 'utf8')
  assert.ok(doc.includes('## The invariant: nothing visible changes'))
  assert.ok(doc.includes('**The existing system wins.**'))
  assert.ok(doc.includes('**New tokens take new keys.**'))
  assert.ok(doc.includes('**New components do not replace used ones.**'))
  assert.ok(doc.includes('"primitives"'), 'the one field this step adds')
  assert.ok(doc.includes('**Write them the way the project already writes components.**'))
  assert.ok(doc.includes('`components.library` says how'))
  assert.ok(doc.includes('**`custom`**') && doc.includes('**`none`**'))
  assert.ok(doc.includes('never pass `--overwrite`'), 'the shadcn CLI never replaces a used file')
  assert.ok(!doc.includes('the way shadcn/ui is built on Tailwind'), 'no shadcn by analogy')
  assert.ok(doc.includes("A library's default look stays where it already fits"))
  assert.ok(doc.includes('inspiration.md'), 'a component looks for precedent before it is drawn')
  assert.ok(doc.includes('screenshot'), 'the invariant is verified, not assumed')
})

test('the stack reference records the design system and component library, and assumes neither', () => {
  const doc = readFileSync(skillReference(SKILL, 'stack'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(doc.includes('"design_system"') && doc.includes('"library"'))
  assert.ok(doc.includes('**The design system.**') && doc.includes('**The component library.**'))
  assert.ok(doc.includes('`components.json` at the root'), 'shadcn is detected from its files')
  assert.ok(doc.includes('a React project is not a shadcn project until the files say so'))
  assert.ok(doc.includes('A new React project uses `shadcn`'))
  assert.ok(doc.includes('Any other new project records `custom`'))
})

test('the inspiration reference gives the commands, the payload, and the two rules', () => {
  const doc = readFileSync(skillReference(SKILL, 'inspiration'), 'utf8')
  const flat = doc.replace(/\s+/g, ' ')
  assert.ok(doc.includes('npx -y eztweak@latest inspire --query'), 'the description is the way in')
  assert.ok(doc.includes('[--tag onboarding]'), 'tags are free words that nudge a search')
  assert.ok(!doc.includes('vocabulary') && !doc.includes('--feeling') && !doc.includes('--pattern'))
  assert.ok(flat.includes('the elements on it, the register its wording is in, the actions'))
  assert.ok(
    flat.includes('works without a review session, a daemon or a dev server'),
    'it stands alone',
  )
  assert.ok(doc.includes('`Why it works:`') && doc.includes('`Wrong when:`'), 'the payload')
  assert.ok(flat.includes('Read a result in two steps'), 'read progressively')
  assert.ok(
    flat.includes('**The text and the first image**, of every result'),
    'judged by the text and the image together',
  )
  assert.ok(
    flat.includes('**The code**, of each result you learn from - one or several'),
    'code last',
  )
  assert.ok(flat.includes('**Learn why it works, and how it is made.**'), 'intent and surface')
  assert.ok(flat.includes('The surface, just as closely'), 'presentation is learned too')
  assert.ok(flat.includes('not to paste it'), 'the code explains, it is not copied')
  assert.ok(flat.includes('**Mind the motion.**'))
  assert.ok(flat.includes('Motion that is only there because the precedent had it is decoration'))
  assert.ok(flat.includes('**Make it yours.**'))
  assert.ok(flat.includes('not as the precedent in a new skin'))
  assert.ok(flat.includes('**Starting from a pattern.**'), 'a pattern that fits can be the base')
  assert.ok(flat.includes('it is a starting point, not a copy'))
  assert.ok(
    flat.includes('Take a result seriously before you judge it'),
    'a precedent is studied, not skimmed',
  )
  assert.ok(
    flat.includes("You are not obliged to use a precedent's pattern"),
    'a precedent is learned from, not a pattern to keep',
  )
  assert.ok(
    flat.includes('Read the whole file, not its first lines'),
    'the precedent code is read in full',
  )
  assert.ok(flat.includes('Carry relationships, not numbers'), 'fitted to the project scale')
  assert.ok(
    flat.includes('A move that `DESIGN.md` does not describe is not a reason to drop it'),
    'a precedent can take the design past DESIGN.md',
  )
  assert.ok(doc.includes('## Where a result may be named'))
  assert.ok(flat.includes('In your reply to the user, and nowhere else.'))
  assert.ok(flat.includes('Never write an entry, a slug, a source or an image path into'))
  assert.ok(flat.includes('exit code 2'), 'the failure the CLI actually gives')
  assert.ok(flat.includes('say nothing to the user about it'), 'a failed search is not news')
  assert.ok(flat.includes('carry on with `DESIGN.md`'))
  assert.ok(flat.includes('the round is about arrangement, not inspiration'))
  assert.ok(flat.includes('one that covers most of it, or one part of it well, is a result'))
  assert.ok(!doc.includes('—'), 'plain dashes, like the rest of the skill')
})

test('the setup brief names the running page, so no step goes looking for it', () => {
  const setup = setupBrief(truth(false, false), SKILL, undefined, 'http://localhost:5174').join(
    '\n',
  )
  assert.ok(setup.includes('The page is running at http://localhost:5174.'))
  assert.ok(!setupBrief(truth(false, false), SKILL).join('\n').includes('The page is running'))
})

test('the design and components steps measure and compare with the skill s own script', () => {
  assert.ok(existsSync(join(SKILL, 'scripts', 'page.mjs')))
  const design = readFileSync(skillReference(SKILL, 'design'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(design.includes('node <skill>/scripts/page.mjs measure <url>'))
  assert.ok(design.includes('Only when the script cannot run'), 'the browser tool is the fallback')
  const components = readFileSync(skillReference(SKILL, 'components'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(components.includes('page.mjs shots <url> <dir>/before'))
  assert.ok(components.includes('page.mjs compare <dir>/before <dir>/after'))
  assert.ok(components.includes('Every line must say `same`'))
})

test('a lower effort is named in every harness brief, and make.md says what it leaves out', () => {
  const low = truthBrief(truth(true, true), SKILL, undefined, 'low').join('\n')
  assert.ok(low.includes("Design effort for this turn: low. make.md's Effort section"))
  const building = truthBrief(truth(false, false), SKILL, undefined, 'medium').join('\n')
  assert.ok(
    building.includes('Design effort for this turn: medium.'),
    'a batch that builds first too',
  )
  assert.ok(
    !truthBrief(truth(true, true), SKILL).join('\n').includes('Design effort'),
    'high says nothing',
  )
  const make = readFileSync(skillReference(SKILL, 'make'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(make.includes('## Effort'))
  assert.ok(make.includes('**Medium**: everything but Review. No reviewer'))
  assert.ok(make.includes('No Purpose, Look or Decide, no screenshots, no search for 靈感'))
  assert.ok(make.includes('Learn and Deliver still run'))
  assert.ok(make.includes('never what the request asks for'), 'effort is not scope')
})

test('the making step looks at the page with screenshots, not a dump of its DOM', () => {
  const make = readFileSync(skillReference(SKILL, 'make'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(make.includes('--viewport <W>x<H> --around "<selector>"'), 'the piece, cut out')
  assert.ok(make.includes("`page`, `viewport` and `selector` are the item's anchor's"))
  assert.ok(make.includes('A `clipped:` line means part of the piece is scrolled out of sight'))
  assert.ok(
    make.includes('First screenshot the piece in place with `shot`'),
    'the review shots too',
  )
  assert.ok(make.includes('never as a snapshot of the whole page'))
})

test('the steps that configure a project never depend on the inspiration database', () => {
  for (const name of ['product', 'stack', 'design']) {
    const doc = readFileSync(skillReference(SKILL, name), 'utf8')
    assert.ok(!/inspire|inspiration/i.test(doc), name)
  }
  const inspiration = readFileSync(skillReference(SKILL, 'inspiration'), 'utf8').replace(
    /\s+/g,
    ' ',
  )
  assert.ok(inspiration.includes('nothing in `PRODUCT.md` or `DESIGN.md` is decided by it'))
})

test('the product reference explores first, interviews in rounds, and needs no session', () => {
  const doc = readFileSync(skillReference(SKILL, 'product'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(doc.includes('works with or without a review session'))
  assert.ok(doc.includes('not a requirement'), 'a running page is optional evidence')
  assert.ok(doc.includes('## Step 2: Explore the project'))
  assert.ok(doc.includes("a hypothesis about the user's intent, not as their answer"))
  assert.ok(doc.includes('at most three focused questions'))
  assert.ok(doc.includes('one real answer or approval round'))
  assert.ok(doc.includes('They are goals, not questions to read out'))
  assert.ok(doc.includes('questions you write for this project'))
  assert.ok(doc.includes('only what it left open is asked'))
  assert.ok(doc.includes('1. Who the primary user is'))
  assert.ok(doc.includes('2. What the product makes possible'))
  assert.ok(doc.includes('future work must preserve'))
  assert.ok(!doc.includes('1. Who is the primary user'), 'no question script left behind')
})

test('the product reference says what belongs in it and what does not', () => {
  const doc = readFileSync(skillReference(SKILL, 'product'), 'utf8')
  assert.ok(
    doc.includes('### What belongs in PRODUCT.md') && doc.includes('### What does not belong'),
  )
  assert.ok(doc.includes('does not invent a visual world and it does not write `DESIGN.md`'))
  assert.ok(doc.includes('Do not ask about aesthetic direction, emotional feel'))
  assert.ok(doc.includes('Write only confirmed facts and explicitly marked open decisions'))
  assert.ok(
    doc.includes('Never silently overwrite an existing file'),
    'an existing brief is not clobbered',
  )
  assert.ok(doc.includes('never offer `DESIGN.md` during this work'))
  assert.ok(doc.includes('finish `PRODUCT.md` first, then resume it'))
  for (const section of [
    '## Users',
    '## Product Purpose',
    '## Positioning',
    '## Operating Context',
    '## Capabilities and Constraints',
    '## Brand Commitments',
    '## Evidence on Hand',
    '## Product Principles',
    '## Accessibility & Inclusion',
  ]) {
    assert.ok(doc.includes(section), section)
  }
  assert.ok(!doc.includes('## Feel'), 'feel belongs to DESIGN.md')
})

test('an explore never builds a file, and is bound by the harness only when it is ready', () => {
  const bare = truthExploreRule(truth(false, false), SKILL).join('\n')
  assert.ok(!bare.includes('.md'), 'nothing about files that are not there')
  assert.ok(bare.includes("the element's anchor"))
  const lone = truthExploreRule(truth(false, true), SKILL).join('\n')
  assert.equal(lone, bare, 'one file is not the harness')
  const off = truthExploreRule(truth(true, true, false), SKILL).join('\n')
  assert.equal(off, bare, 'switched off, the files bind nothing')
  const both = truthExploreRule(truth(true, true), SKILL).join('\n')
  assert.ok(both.includes('`PRODUCT.md` and `DESIGN.md`'))
  assert.ok(both.includes('every variant'))
  assert.ok(both.includes('`DESIGN.md` is a direction, not a'), 'variants may range past it')
  assert.ok(!both.includes('within its tokens and prose'))
  assert.ok(both.includes(skillReference(SKILL, 'make')), 'a variant is made the way anything is')
  assert.ok(!both.includes('its own precedent'), 'an explore is about arrangement, not inspiration')
})

test('the make reference walks inspiration, build, review, deliver, for a batch and an explore', () => {
  const doc = readFileSync(skillReference(SKILL, 'make'), 'utf8')
  assert.ok(doc.includes('## Tweak, or a piece of design?'))
  assert.ok(doc.includes('## How closely to keep to the design system'))
  assert.ok(
    doc.replace(/\s+/g, ' ').includes('how closely you keep to it depends on how complete it is'),
  )
  assert.ok(doc.includes('**A complete system**') && doc.includes('**A sparse one**'))
  assert.ok(
    doc.replace(/\s+/g, ' ').includes('a value that keeps coming up'),
    'recurring values become tokens',
  )
  assert.ok(!doc.includes('departs from `DESIGN.md`'), 'no ledger of departures')
  const order = [
    '## Purpose',
    '## Look',
    '## Decide',
    '## Build',
    '## Review',
    '## Learn',
    '## Deliver',
  ]
  const at = order.map((h) => doc.indexOf(h))
  assert.ok(
    at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1]!)),
    'the steps, in order: purpose before anything is looked for, layout only after',
  )
  assert.ok(doc.includes('**The current page.**') && doc.includes("**The project's own kin.**"))
  assert.ok(
    doc.replace(/\s+/g, ' ').includes('Do not invent a second version'),
    "the project's own dialog, not a new one",
  )
  assert.ok(doc.includes('**An explore is not a search for inspiration.**'))
  assert.ok(
    doc.replace(/\s+/g, ' ').includes('An adjective - clean, modern, polished - decides nothing'),
  )
  assert.ok(
    doc.replace(/\s+/g, ' ').includes('How to lay it out is not decided yet'),
    'the layout waits for what Look finds',
  )
  assert.ok(
    doc.replace(/\s+/g, ' ').includes("take a precedent's move where it beats your first idea"),
  )
  assert.ok(
    doc.replace(/\s+/g, ' ').includes('It departs from DESIGN.md on purpose'),
    'the reviewer is told a departure was meant',
  )
  assert.ok(
    doc.includes('The list of those orders is the body of the screen'),
    'the example shows decisions',
  )
  assert.ok(
    doc
      .replace(/\s+/g, ' ')
      .includes(
        'In an explore the purpose is shared, and each variant answers the decisions differently',
      ),
  )
  assert.ok(
    doc.includes('When the prompt lists what earlier rounds on this element already offered'),
  )
  assert.ok(
    doc.replace(/\s+/g, ' ').includes('only when the database is available'),
    'no login, no search',
  )
  assert.ok(doc.includes('against AI slop'))
  assert.ok(doc.includes('## Review'))
  assert.ok(doc.replace(/\s+/g, ' ').includes('One review covers the whole batch'))
  assert.ok(
    doc.replace(/\s+/g, ' ').includes('where yours differs from it and why'),
    'the reply says what a precedent gave and what it did not',
  )
  assert.ok(
    doc
      .replace(/\s+/g, ' ')
      .includes("hold the direction up against the request's own content before you build"),
    'the direction is checked against the request before it is built',
  )
  assert.ok(
    !doc.replace(/\s+/g, ' ').includes('It builds on an established pattern'),
    'the reviewer is not told to keep a pattern',
  )
  assert.ok(
    doc.replace(/\s+/g, ' ').includes('a reason you inferred is given as your own judgment'),
    'an inference is not passed off as the design doc',
  )
  assert.ok(
    doc.includes('The direction was chosen by the user; judge execution'),
    'a pick is not re-litigated',
  )
  assert.ok(
    !/step \d/.test(doc),
    'make.md names its steps, so they never collide with the harness steps',
  )
  assert.ok(doc.includes('**The same correction, asked for again.**'))
  assert.ok(
    !doc.includes('**The user sounds unsatisfied.**'),
    'a send-back is fixed, not written down',
  )
  assert.ok(doc.includes('**The user states a rule.**'))
  assert.ok(doc.includes('A visual lesson goes to `DESIGN.md`'))
  assert.ok(
    doc
      .replace(/\s+/g, ' ')
      .includes(
        'A visual rule the user states as binding - "never", "always", in so many words - goes to `PRODUCT.md`\'s Brand Commitments',
      ),
    'a binding rule lives where binding things live',
  )
  assert.ok(doc.includes('A product rule goes to `PRODUCT.md`'))
  assert.ok(
    doc.includes('never edited here'),
    "the skill's principles are not the project's notebook",
  )
  assert.ok(!doc.includes('mark it as such in the entry'), 'nothing inferred is written')
  assert.ok(doc.includes('this step does not run in one'), 'an explore edits nothing')
  for (const slot of ['inspiration.md', 'principles.md', 'critique.md']) {
    assert.ok(doc.includes(slot), slot)
  }
  assert.ok(!doc.includes('Not yet written'), 'every slot is filled')
})

test('the request is the scope, and what is noticed is reported rather than fixed', () => {
  const make = readFileSync(skillReference(SKILL, 'make'), 'utf8')
  assert.ok(make.includes('## The request is the scope'))
  assert.ok(make.includes('leave the code alone'))
  assert.ok(make.includes('順帶一提'), 'and there is a place to put it instead')
  const critique = readFileSync(skillReference(SKILL, 'critique'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(critique.includes('Judge **what changed**, and what it does to the page'))
  assert.ok(critique.includes('A piece that is lovely alone and hurts the page scores low'))
  assert.ok(
    make
      .replace(/\s+/g, ' ')
      .includes('keeps the whole page looking good, not the one that looks best on its own'),
  )
  assert.ok(make.replace(/\s+/g, ' ').includes('plus one of the whole page at desktop'))
  assert.ok(!make.includes('Name anything you did beyond what was asked'), 'no longer blessed')

  const doc = readFileSync(skillReference(SKILL, 'design'), 'utf8')
  assert.ok(doc.includes('Writing this file changes no other file'))
})

test('a piece of design is judged once by an independent reviewer, twice only after a pivot', () => {
  const make = readFileSync(skillReference(SKILL, 'make'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(make.includes('a subagent with a fresh context'), 'not the maker judging itself')
  assert.ok(make.includes('**One review**'), 'a second costs the user minutes')
  assert.ok(make.includes('**refine**: make the listed fixes, look at the result yourself'))
  assert.ok(make.includes('a comparison is steadier than a second score'), 'only after a pivot')
  assert.ok(make.includes('An earlier version, for comparison:'))
  assert.ok(make.includes('Deliver the direction that review calls better'))
  assert.ok(make.includes('There is no third review'))
  assert.ok(make.includes('Screenshots: <the files>.'), 'the reviewer judges what the maker shot')
  assert.ok(
    make.includes('Read <the paths of critique.md, baseline.md and principles.md, all beside this'),
    'every file the reviewer judges by is named in its brief, not only pointed to from critique.md',
  )
  assert.ok(make.includes('never your intent or your opinion of the result'))
  assert.ok(
    make.includes('**pivot**: the direction was wrong. Build a different one, not a variant'),
  )
  assert.ok(make.includes('A **tweak** gets no reviewer'))
  assert.ok(make.includes('**An explore** gets no review at all, not even your own'))
  assert.ok(make.includes('made fast: nothing in it is built yet'), 'no shots, states or review')
  assert.ok(make.includes('When your agent has no way to start a subagent'), 'standalone fallback')
  assert.ok(!make.includes('last scores'), "the scores are the agent's business")
  assert.ok(make.includes('Leave out everything they did not ask about: the review, its scores'))
  assert.ok(
    make.includes('the files it touched, since it is their code'),
    'changed files are named',
  )
  assert.ok(
    make.includes('Build the first version to it'),
    'the maker reads taste.md, not only the reviewer',
  )
  assert.ok(
    make.includes('never which step of this file you are on, and never anything about the review'),
  )
  assert.ok(HARNESS_WORDS.includes('never mention the review or its scores'))
  assert.ok(make.includes('no sub-bullets, no pixel values or breakpoints'))
  assert.ok(
    make.includes('Build to the bar the reviewer holds it to, the baseline'),
    'the build aims at the same bar',
  )
  assert.ok(!make.includes('super clean'), 'a named rule set, not a reaction to aim for')
  assert.ok(make.includes('picture that version, not the first competent one'))
})

test("the reviewer looks before it scores, by the user's bar and not by novelty", () => {
  const doc = readFileSync(skillReference(SKILL, 'critique'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(doc.includes('You change nothing'))
  assert.ok(doc.includes('judge whether the piece belongs, not whether it complies'))
  assert.ok(doc.includes('`baseline.md` and `principles.md`, which the brief names'))
  assert.ok(doc.includes('Read both before you score'))
  assert.ok(doc.includes('Assume the piece is not good enough until what you see proves it is'))
  assert.ok(doc.includes('## Look first') && doc.includes('Study the screenshots before you score'))
  assert.ok(doc.includes('a review takes a minute'), 'no tour of widths or the DOM')
  assert.ok(doc.includes('The baseline, in `baseline.md`'), 'the bar is the baseline')
  assert.ok(!doc.toLowerCase().includes('super clean'))
  assert.ok(doc.includes('A clever idea earns nothing on its own'))
  const order = ['**Useful**', '**Refined**', '**Clear**', '**Fits**', '**Craft**'].map((c) =>
    doc.indexOf(c),
  )
  assert.ok(
    order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1]!)),
    'useful weighs most',
  )
  assert.ok(doc.includes('no card is nested in a card'))
  assert.ok(
    doc.replace(/\s+/g, ' ').includes('is a highlight, not a card'),
    'a row fill is not a card',
  )
  for (const question of [
    '*Hierarchy*',
    '*Proportion*',
    '*Density*',
    '*Consistency*',
    '*States*',
  ]) {
    assert.ok(doc.includes(question), question)
  }
  assert.ok(doc.includes('without building the states'), 'states are judged from the diff, cheaply')
  assert.ok(
    doc.includes('built from that component rather than by hand'),
    'the diff is checked for reuse',
  )
  assert.ok(doc.includes('a hand-made copy that only looks the same is a flaw'))
  assert.ok(doc.includes('`.eztweak/taste.md`') && doc.includes('it outranks the examples below'))
  for (const verdict of ['**ship**', '**refine**', '**pivot**']) assert.ok(doc.includes(verdict))
  assert.ok(doc.includes('useful 0/10 · refined 0/10 · clear 0/10 · fits 0/10 · craft 0/10'))
  assert.ok(doc.includes('A competent piece nobody would comment on scores 5'))
  assert.ok(doc.includes('never from a gimmick'))
  assert.ok(doc.includes('At most three numbered items'))
  assert.ok(doc.includes('better: current | earlier - <one reason>'), 'the second review compares')
  assert.ok(doc.includes('not which fixed more of a list'))
})

test('what the user says about quality recalibrates the reviewer, in the project', () => {
  const make = readFileSync(skillReference(SKILL, 'make'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(make.includes('goes to `.eztweak/taste.md`, creating it if it is not there'))
  assert.ok(make.includes('never on what you read into it'), 'inferences are not written down')
  assert.ok(
    make.includes('Nothing else counts: not a batch that sends back what you made, not a tone'),
  )
  assert.ok(!make.includes('inference'), 'no inferred entries, marked or not')
  assert.ok(
    make.includes('`baseline.md`, `principles.md` and `critique.md` are shared by every project'),
  )
})

test('without a login the brief says to skip the search, and names no command', () => {
  for (const lines of [
    truthBrief(truth(true, true), SKILL, 'unavailable'),
    truthBrief(truth(false, false), SKILL, 'unavailable'),
    setupBrief(truth(false, false), SKILL, 'unavailable'),
    truthExploreRule(truth(true, true), SKILL, 'unavailable'),
  ]) {
    const text = lines.join('\n')
    assert.ok(text.includes('cannot be searched on this machine (no `eztweak login`)'))
    assert.ok(!text.includes(' inspire ...'))
  }
  assert.deepEqual(
    truthBrief(truth(true, true, false), SKILL, 'unavailable'),
    [],
    'off says nothing',
  )
})

test('the harness sets a direction and guards against mistakes, and prescribes no numbers', () => {
  const principles = readFileSync(skillReference(SKILL, 'principles'), 'utf8')
  const floor = principles.slice(principles.indexOf('## The craft floor'))
  assert.ok(!/\d+(px|ch|em)\b/.test(floor), 'the floor is judged by eye, not by a number')
  assert.ok(floor.includes('**No card inside a card.**'), 'a line no model may cross')
  assert.ok(principles.includes('## Against AI slop'), 'kept: lines that are never crossed')
  assert.ok(!principles.includes('are not a page structure'), 'removed by the owner')
  assert.ok(!principles.includes('oversized italic serif'), 'removed by the owner')
  assert.ok(
    !principles.includes('Emphasis comes from weight or size'),
    'emphasis may be colour too',
  )
  const critique = readFileSync(skillReference(SKILL, 'critique'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(critique.includes('never as treatments to ask for'))
  assert.ok(!critique.includes('airport') && !critique.includes('Progress drawn as data'))
  const brief = truthBrief(truth(true, true), SKILL).join(' ')
  assert.ok(!brief.includes('say where'), 'going past DESIGN.md needs no report')
})
