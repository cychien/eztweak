/** The skills on this machine that a review can ask the agent to run.
 *
 *  Read off disk rather than off the wire. The protocol does carry a list -
 *  `available_commands_update` - but it is a list of *slash commands*, and a
 *  skill is indistinguishable in it from `/doctor` or `/usage`: the field that
 *  separates them (`type === 'prompt'`) exists in the CLI and is dropped by the
 *  adapter on the way out. Disk gives up the bundled skills, which live inside
 *  the CLI binary with no file to find, and buys exact classification for
 *  everything else - which is the trade this picker wants, because a menu of
 *  "skills" that offers `/heapdump` is a menu that lied.
 *
 *  The layouts are the ones the agent itself probes when it resolves a skill by
 *  name, so anything listed here can actually be invoked. */

import { readFileSync, readdirSync } from 'node:fs'
import { agentBrandFor } from './agents.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Skill {
  /** What the agent is asked to run, and what the menu filters on. A plugin's
   *  skill carries its `<plugin>:<name>` spelling, because that is the name the
   *  agent resolves. */
  name: string
  description: string
  /** Where it came from, for the menu's grouping. */
  source: 'project' | 'user' | 'plugin'
}

/** Directories that hold one directory per skill. Probed at both the project and
 *  the user level, which is what the agent does. */
const SKILL_DIRS = ['.claude/skills', '.agents/skills']

/** Frontmatter's `name`, `description` and `user-invocable`, and nothing else.
 *
 *  Deliberately not a YAML parser: the fields this needs are plain scalars on one
 *  line, and a dependency that can parse anchors and flow mappings would buy
 *  nothing except the chance to throw on a skill file it disliked. A file whose
 *  frontmatter this cannot read is skipped, not guessed at. */
function readFrontmatter(
  path: string,
): { name?: string; description?: string; 'user-invocable'?: string } | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  const fields: { name?: string; description?: string; 'user-invocable'?: string } = {}
  for (const line of text.slice(3, end).split('\n')) {
    const match = /^(name|description|user-invocable):\s*(.*)$/.exec(line)
    if (!match) continue
    const value = match[2]!.trim().replace(/^['"]|['"]$/g, '')
    if (value) fields[match[1] as keyof typeof fields] = value
  }
  return fields
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** One skill directory, or null when it holds no readable `SKILL.md`.
 *
 *  The directory name wins over the frontmatter's `name` when they disagree,
 *  because the directory is what the agent resolves by - a skill whose
 *  frontmatter names something else would be listed under a name that cannot be
 *  invoked. */
function readSkill(dir: string, name: string, source: Skill['source']): Skill | null {
  const fields = readFrontmatter(join(dir, name, 'SKILL.md'))
  if (!fields) return null
  // A skill can declare that only the agent may reach for it. Offering one of
  // those is worse than leaving it out: the CLI refuses the command with "this
  // skill can only be invoked by Claude, not directly by users", and refusing it
  // *is* the turn - the prompt never reaches the model, so the batch comes back
  // with no reply, no error and nothing to explain the silence.
  //
  // Absent means invocable. The field is the exception, and a skill that says
  // nothing about it is the ordinary kind.
  if (fields['user-invocable']?.toLowerCase() === 'false') return null
  return { name, description: fields.description ?? '', source }
}

/**
 * Every skill reachable from `project`, by name.
 *
 * Not included, and both deliberate: skills bundled inside the CLI binary, which
 * have no file to read; and directory-scoped skills under some nested
 * `<subdir>/.claude/skills`, which would cost a walk of the whole project to
 * find and are rare enough not to earn one.
 */
export function listSkills(project: string, home: string = homedir()): Skill[] {
  const found = new Map<string, Skill>()
  // Project last so it wins: the nearer definition is the one in force, and it
  // is also the one the reviewer is most likely to have written.
  const roots: [string, Skill['source']][] = [
    [home, 'user'],
    [project, 'project'],
  ]
  for (const [root, source] of roots) {
    for (const dir of SKILL_DIRS) {
      const container = join(root, dir)
      for (const name of entries(container)) {
        const skill = readSkill(container, name, source)
        if (skill) found.set(skill.name, skill)
      }
    }
  }
  const plugins = join(project, '.claude/plugins')
  for (const plugin of entries(plugins)) {
    const container = join(plugins, plugin, 'skills')
    for (const name of entries(container)) {
      const skill = readSkill(container, name, 'plugin')
      // `<plugin>:<name>` is how the agent resolves it, so it is the name here.
      if (skill) found.set(`${plugin}:${name}`, { ...skill, name: `${plugin}:${name}` })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** How this agent expects a skill to be named in a prompt.
 *
 *  Claude reads `/name`. Codex builds its own command list as `` `$${name}` ``,
 *  so it reads `$name` - which is also what eztweak's composer writes, so for
 *  codex the user's own text already speaks the right language and only Claude's
 *  has to be translated.
 *
 *  Anything else keeps `$`: it is what the user typed, and inventing a prefix for
 *  an agent nobody here has a profile for would be a guess dressed up as a
 *  translation. */
export function skillPrefix(agent: string): string {
  return agentBrandFor(agent) === 'claude' ? '/' : '$'
}

/** Spend the `[skill n]` markers a comment carries, now that the agent is known.
 *
 *  The stored text keeps markers rather than prefixed names because the prefix
 *  belongs to whoever is listening: the same conversation resumed on the other
 *  agent has to read correctly there too, and a record written in Claude's
 *  language would be a record of who happened to be running that afternoon.
 *
 *  A marker naming nothing is left exactly as it was written - the same rule the
 *  shell draws it by, and the same reason: it is something the user put there. */
export function spendSkillMarkers(text: string, skills: string[], agent: string): string {
  return text.replace(/\[skill (\d+)\]/g, (whole, n: string) => {
    const name = skills[Number(n) - 1]
    return name === undefined ? whole : `${skillPrefix(agent)}${name}`
  })
}
