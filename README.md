# eztweak

> Point at your live app. Your agent fixes it.

eztweak turns any locally running dev server into an annotatable review surface for human ↔
agent iteration. The user marks up the **real page** - click an element, select some text, leave a
comment - and the feedback flows to a local coding agent (Claude Code, Codex, anything that can
run a CLI) as structured items that resolve to **exact source locations**. The agent edits the
code, HMR updates the page in place, the user reviews the next round.

```
$ npx -y eztweak@latest http://localhost:5173/pricing   # opens the review shell
$ npx -y eztweak@latest poll http://localhost:5173/     # agent blocks here until you hit send
```

- **Zero config.** A local daemon reverse-proxies your dev server and injects the annotation
  overlay. No code changes, no build plugins required, works with any framework.
- **Anchored feedback.** Annotations carry a layered anchor: `file:line` (with the optional Vite
  plugin), React component chain, `data-section`, CSS selector, text, viewport. Agents stop
  guessing which part of the page you meant. Paste or drop a screenshot into any comment and the
  agent gets a path to it.
- **Built for the loop.** Batch annotations, send once; the agent's `poll` is a blocking CLI call
  that prints structured JSON - the same portable contract as an AXI. HMR keeps iterations
  in place; the review chrome lives outside the app frame, so it survives your agent's syntax errors.
- **Local-first.** Everything binds to 127.0.0.1. Nothing leaves your machine.

## Install

Nothing to install - `npx -y eztweak@latest` is enough. For agents, add the bundled skill:

```
npx skills add cychien/eztweak --skill eztweak
```

Optional, for exact `file:line` anchors in Vite + React projects:

```ts
// vite.config.ts
import { eztweakSource } from 'eztweak/vite'

export default defineConfig({
  plugins: [eztweakSource(), react()],
})
```

Dev-only (`apply: 'serve'`) - it never touches production builds.

## Updating

- **CLI** - always invoke it as `npx -y eztweak@latest`. A bare `npx eztweak` reuses whatever
  version npx cached and never checks for a newer one.
- **Skill** - `npx skills update eztweak`.
- **Daemon** - takes care of itself. All session and shell logic lives in a background daemon, so
  opening a session with a different CLI version replaces the running daemon with that version.
  Your sessions come back with it, under the same restore guarantee any daemon restart gets (see
  Configuration). A CLI that reaches a daemon on another version is refused with a `409` that says
  how to update, instead of speaking a mismatched protocol.

## Configuration

| Variable | Default | What it moves |
| --- | --- | --- |
| `EZTWEAK_DATA_DIR` | `~/.eztweak` | Session state, the daemon registry, and the daemon log |
| `EZTWEAK_CONTROL_PORT` | `4400` | First port of the ten-port range the daemon searches for its control server |

Set both together to run a second, fully isolated instance: a starting daemon adopts any live
daemon it finds inside its own control range, so moving the data dir alone still lands you on the
shared daemon. `npm run dev` sets both.

Sessions outlive the daemon that served them. On start, the daemon picks each session back up
from disk and re-binds it to the port it last held, so a review shell tab you already have open
only needs a reload, and feedback you queued before the restart is still waiting. If that port has
since been taken, the session moves to a free one and the CLI re-resolves it.

Typing `/` in either comment box opens a command menu - arrow keys and Enter, or click. A slash
mid-word stays a slash, so urls and paths are left alone. Two commands:

- **`/file`** opens the system file picker and drops what you choose in as an attachment, where the
  slash was.
- **`/element`** points the comment at a *second* element - "make this match that one". The page
  stays live while you choose, so a plain click still follows links and opens menus and only
  ⌘/Ctrl+click picks; the comment box steps aside and comes back when you are done. You can cross to
  another page to find what you meant, and eztweak brings you back to finish the comment. The
  element arrives as a chip carrying the same layered anchor an annotation gets, so the agent is
  handed a `file:line` instead of a description, and `[ref 1]` in the comment text says exactly where
  in the sentence you meant it.

Either comment box also takes an image or file, pasted or dropped in. Attachments become inline chips
in the text itself, so a comment can point at a file mid sentence, and backspace deletes one the
way it deletes a character. They are names, not previews - the box is for the comment, and a
thumbnail takes the room it needs. The bytes go straight to the session directory, capped at 8 MB
per file, and the batch hands the agent an absolute path per attachment so it opens the screenshot
instead of being handed base64. Deleting a queued annotation deletes its files with it; anything
attached and then abandoned is collected a day later.

A session belongs to one project on one origin, not to the origin alone. Dev servers all default
to the same port, so reviewing a second project on `localhost:5173` would otherwise inherit the
first one's conversation and hand its undelivered feedback to the wrong agent. The project is the
nearest `.git` or `package.json` ancestor of the directory you run `eztweak` from, so switching
projects on a port starts a clean review and switching back finds the old one intact.

## Development

Working on eztweak itself takes one command:

```
npm run dev                 # watch src/, serve the playground fixture, start an isolated daemon,
                            # open the review shell
npm run dev -- --no-plugin  # the same page without eztweakSource(), to see fallback-only anchors
npm run dev:agent           # second terminal: a stand-in agent that polls, prints anchors, replies
npm run dev:cli status      # the eztweak CLI, pointed at the dev daemon instead of the real one
```

A client rebuild (`src/client/**`) only needs a browser reload; a rebuild the daemon loads
restarts it, and in-flight polls reconnect on their own. Dev mode keeps its daemon registry and
sessions in `.dev/`, so your own `~/.eztweak` is never touched. The review target is
[`fixtures/playground`](fixtures/playground/README.md).

## Status

Early. On the roadmap: diff-derived Keep/Undo, screenshots, layout-issue detection, ACP mode.

## License

MIT
