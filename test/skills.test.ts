import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { listSkills } from '../src/skills.js'

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
