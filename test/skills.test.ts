import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { listSkills, skillPrefix, spendSkillMarkers } from '../src/skills.js'

function root(): string {
  return mkdtempSync(join(tmpdir(), 'ez-skills-'))
}

function writeSkill(
  base: string,
  dir: string,
  name: string,
  body = `---\nname: ${name}\ndescription: ${name} does things.\n---\n\n# ${name}\n`,
): void {
  mkdirSync(join(base, dir, name), { recursive: true })
  writeFileSync(join(base, dir, name, 'SKILL.md'), body)
}

test('skills are found in every layout the agent itself resolves', () => {
  const project = root()
  const home = root()
  writeSkill(project, '.claude/skills', 'project-one')
  writeSkill(project, '.agents/skills', 'project-two')
  writeSkill(home, '.claude/skills', 'user-one')
  writeSkill(project, '.claude/plugins/acme/skills', 'bundled')

  assert.deepEqual(
    listSkills(project, home).map((s) => [s.name, s.source]),
    [
      ['acme:bundled', 'plugin'],
      ['project-one', 'project'],
      ['project-two', 'project'],
      ['user-one', 'user'],
    ],
  )
})

test('the description comes from the frontmatter', () => {
  const project = root()
  writeSkill(project, '.claude/skills', 'described')
  const skill = listSkills(project, root())[0]!
  assert.equal(skill.description, 'described does things.')
})

// The name is what gets invoked, so it has to be the directory - a frontmatter
// `name` that disagrees would put a name in the menu that resolves to nothing.
test('the directory name wins over a disagreeing frontmatter name', () => {
  const project = root()
  writeSkill(
    project,
    '.claude/skills',
    'on-disk',
    '---\nname: something-else\ndescription: d\n---\n',
  )
  assert.deepEqual(
    listSkills(project, root()).map((s) => s.name),
    ['on-disk'],
  )
})

// A project skill and a user skill of the same name are the same invocation, and
// the project's is the one in force.
test('a project skill shadows a user skill of the same name', () => {
  const project = root()
  const home = root()
  writeSkill(home, '.claude/skills', 'shared', '---\nname: shared\ndescription: from user\n---\n')
  writeSkill(
    project,
    '.claude/skills',
    'shared',
    '---\nname: shared\ndescription: from project\n---\n',
  )
  const skills = listSkills(project, home)
  assert.equal(skills.length, 1)
  assert.equal(skills[0]!.source, 'project')
  assert.equal(skills[0]!.description, 'from project')
})

// Anything unreadable is left out rather than guessed at: a directory with no
// SKILL.md is not a skill, and a file this cannot parse is not one either.
test('directories without readable frontmatter are skipped', () => {
  const project = root()
  mkdirSync(join(project, '.claude/skills/empty'), { recursive: true })
  writeSkill(project, '.claude/skills', 'no-frontmatter', '# just a heading\n')
  writeSkill(project, '.claude/skills', 'unterminated', '---\nname: x\n')
  writeSkill(project, '.claude/skills', 'good')
  assert.deepEqual(
    listSkills(project, root()).map((s) => s.name),
    ['good'],
  )
})

// A skill may legitimately carry no description; it is still invocable.
test('a skill with no description is still listed', () => {
  const project = root()
  writeSkill(project, '.claude/skills', 'bare', '---\nname: bare\n---\n')
  assert.deepEqual(
    listSkills(project, root()).map((s) => [s.name, s.description]),
    [['bare', '']],
  )
})

test('a project with nowhere to look yields nothing rather than throwing', () => {
  assert.deepEqual(listSkills(join(tmpdir(), 'ez-does-not-exist'), root()), [])
})

// A skill can declare that only the agent may reach for it. Offering one is worse
// than leaving it out: the CLI refuses the command - "this skill can only be
// invoked by Claude, not directly by users" - and refusing it *is* the turn. The
// prompt never reaches the model, so the batch comes back with no reply, no error
// and nothing to explain the silence.
test('a skill the user may not invoke is not offered', () => {
  const home = root()
  writeSkill(
    home,
    '.claude/skills',
    'browser-only',
    '---\nname: browser-only\ndescription: agent only\nuser-invocable: false\n---\n\nx\n',
  )
  writeSkill(home, '.claude/skills', 'normal-one')
  assert.deepEqual(
    listSkills(root(), home).map((s) => s.name),
    ['normal-one'],
  )
})

// Absent means invocable: the field is the exception, and most skills say nothing
// about it.
test('a skill that says nothing about invocation is offered', () => {
  const home = root()
  writeSkill(home, '.claude/skills', 'quiet')
  assert.deepEqual(
    listSkills(root(), home).map((s) => s.name),
    ['quiet'],
  )
})

test('only an explicit false shuts a skill out', () => {
  const home = root()
  for (const [name, value] of [
    ['yes', 'true'],
    ['also', 'TRUE'],
    ['no', 'FALSE'],
  ]) {
    writeSkill(
      home,
      '.claude/skills',
      name!,
      `---\nname: ${name}\ndescription: x\nuser-invocable: ${value}\n---\n\nx\n`,
    )
  }
  assert.deepEqual(
    listSkills(root(), home)
      .map((s) => s.name)
      .sort(),
    ['also', 'yes'],
  )
})


// ------------------------------------------------- naming a skill to an agent

const CLAUDE = 'npx -y @agentclientprotocol/claude-agent-acp'
const CODEX = 'npx -y @agentclientprotocol/codex-acp'

// Claude expands `/name`. Codex builds its command list as `$name` - which is
// what the composer writes - so only Claude's has to be translated.
test('each agent is handed the prefix it reads', () => {
  assert.equal(skillPrefix(CLAUDE), '/')
  assert.equal(skillPrefix(CODEX), '$')
})

// An agent nobody here has a profile for gets what the user typed. Inventing a
// prefix for it would be a guess dressed up as a translation.
test('an unknown agent is handed the user’s own text', () => {
  assert.equal(skillPrefix('node my-acp-server.mjs'), '$')
})

test('markers become names in the language the agent reads', () => {
  const text = '先 [skill 1] 然後 [skill 2] 收尾'
  assert.equal(spendSkillMarkers(text, ['dataviz', 'review'], CLAUDE), '先 /dataviz 然後 /review 收尾')
  assert.equal(spendSkillMarkers(text, ['dataviz', 'review'], CODEX), '先 $dataviz 然後 $review 收尾')
})

// The whole reason the record keeps markers instead of names: the same
// conversation resumed on the other agent has to read correctly there too.
test('the same stored comment reads correctly on either agent', () => {
  const stored = '跑 [skill 1]'
  assert.notEqual(
    spendSkillMarkers(stored, ['dataviz'], CLAUDE),
    spendSkillMarkers(stored, ['dataviz'], CODEX),
  )
})

// Same rule the shell draws it by: something the user put there does not vanish.
test('a marker naming nothing is left as it was written', () => {
  assert.equal(spendSkillMarkers('跑 [skill 3]', ['onlyone'], CLAUDE), '跑 [skill 3]')
  assert.equal(spendSkillMarkers('跑 [skill 0]', ['onlyone'], CLAUDE), '跑 [skill 0]')
})

test('text with no markers is untouched', () => {
  assert.equal(spendSkillMarkers('這裡的間距要再緊一點', ['dataviz'], CLAUDE), '這裡的間距要再緊一點')
})
