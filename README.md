# eztweak

> Point at your live app. Your agent fixes it.

eztweak turns any locally running dev server into an annotatable review surface for human ↔
agent iteration. The user marks up the **real page** - click an element, frame a region, select
some text, leave a comment - and the feedback flows to a local coding agent (Claude Code, Codex,
anything that can run a CLI) as structured items that resolve to **exact source locations**. The
agent edits the code, HMR updates the page in place, the user reviews the next round.

```
$ npx -y eztweak@latest http://localhost:5173/pricing   # opens the review shell
$ npx -y eztweak@latest poll http://localhost:5173/     # agent blocks here until you hit send
```

- **Zero config.** A local daemon reverse-proxies your dev server and injects the annotation
  overlay. No code changes, no build plugins required, works with any framework.
- **Anchored feedback.** Annotations carry a layered anchor: `file:line` (with the optional Vite
  plugin), React component chain, `data-section`, CSS selector, text, viewport. Agents stop
  guessing which part of the page you meant. Paste or drop a screenshot into any comment and the
  agent gets a path to it; `/element` points a comment at a second element, so "make this match
  that one" arrives as a `file:line` too.
- **Every screen at once.** Review on one device or lay all three out on a canvas - desktop,
  iPad and iPhone side by side at their real viewports, scrolling together. An annotation stays on
  the screen it was made on, and reaches the agent tagged with the width it was made at.
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

## Annotating

Two modes, and the toolbar shows which one is armed. Both leave the page live underneath, and
`Esc` steps back out - first the open comment box, then the mode.

- **元素** (`E`) - point at one thing. Hover frames the element under the cursor, a click opens the
  comment box on it, and selecting text instead annotates that run. This is the mode for "this
  button", "this heading", "this sentence".
- **範圍** (`R`) - drag a box over an area. What the box encloses *whole* is what it means: the
  elements it merely cuts through are looked past, down to the ones that fit - so framing a card is
  the card, and framing a row of them is the row. The box you drew stays on screen as the comment's
  subject, and the agent is handed the enclosing element's `file:line` plus `anchor.contains`, a
  line per element the box held: component, `file:line`, and a snippet of that element's own text,
  which is what tells two instances of the same component apart. This is the mode for "this whole
  block", "these four cards", "the spacing through here".

One comment is composed at a time - across every preview on the canvas, not just the one you are
in - so a box drawn in one screen cannot open a second comment box behind the one you are writing.

## The comment box

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

  The same command also takes a plain **drag**, the way a screenshot tool does: frame a box and the
  chip points at everything inside it (no modifier needed - a press only becomes a box once it has
  moved, so a plain click is still the page's). What the box encloses whole is what it means - the
  elements it merely cuts through are looked past, down to the ones that fit - so framing a card is
  the card, and framing a row of them is the row. A region resolves to their common ancestor for the
  `file:line`, and carries `anchor.contains`, a line per element it enclosed - component, `file:line`
  and a snippet of that element's own text, which is what tells two instances of the same component
  apart. A frame around exactly one element is simply that element, the same as clicking it.


Either comment box also takes an image or file, pasted or dropped in. Attachments become inline chips
in the text itself, so a comment can point at a file mid sentence, and backspace deletes one the
way it deletes a character. They are names, not previews - the box is for the comment, and a
thumbnail takes the room it needs. The bytes go straight to the session directory, capped at 8 MB
per file, and the batch hands the agent an absolute path per attachment so it opens the screenshot
instead of being handed base64. Deleting a queued annotation deletes its files with it; anything
attached and then abandoned is collected a day later.

## Devices

The header carries one toggle group with two sides: a menu picking the size to preview at, and
all of them at once (`4`). The raised side is the one showing. The sizes are real device viewports, not bare widths - where the fold lands is
half of what a responsive review is looking at:

| Key | Device | Viewport |
| --- | --- | --- |
| `1` | 手機 | 375×629 - a 375×812 screen, less the browser's bars |
| `2` | 平板 | 1112×740 - a 10.5" tablet on its side, past the breakpoint most layouts switch on |
| `3` | 電腦 | 1440×788 - a 1440×900 laptop screen, less the menu bar and the browser's own |

The sizes are the **page area** a browser leaves on that device, not the screen it leaves it on -
so a card on the canvas stops showing the page exactly where the real thing stops showing it. On
its own a size takes only its width from the table and the height from your screen: one preview
gets the whole stage to show the page in, and the canvas is where the fold is what you are
checking.

The names are shelves, not machines - a 手機 row naming a handset would claim a precision the
row does not have, when phone widths run from 360 up past 430. The sizes are still taken from
real machines; the comments in `devices.ts` say which.

**`4` lays them out on one canvas** - phone and tablet side by side, the desktop on the row below.
The control in the stage's top corner picks which sizes are on it: the three above, plus a portrait
tablet (834×1018) that is off by default.

The canvas is drawn at **true size**, always. A 375 card is 375 pixels whether it is standing alone
or with three others beside it - a scaled 375 is not 375 to a media query, and a page measured at a
size nobody browses at is not a measurement. Turning a size off does not resize or rearrange the
ones that are left. What does not fit is what the dragging is for.

Every card is the device it names, at its own height. What keeps the canvas short enough to work
on is the two-row layout, not a cap on the cards - a card cut to a shared height would be lying
about where the fold falls, which is half of what the preview is for.

**Drag a card by its label to rearrange the canvas.** A card cannot stop just anywhere: it lands
top-aligned in an existing row, or on a row of its own, and a line marks where it would go -
upright between two cards, flat between two rows. The arrangement is remembered, and a size turned
on later joins as its own row at the bottom rather than reshuffling what you laid out.

**Drag the background to move the canvas.** The frames are the app: a press inside one belongs to
the page, so the backdrop and the gaps are what the canvas is panned by. That is also why the
canvas does not have to fit - what is off the edge is a drag away.

Scrolling inside any one preview scrolls the others to the same point in the page, and navigating
one - a link, back, forward - takes all of them: annotations are filtered by path, and three
previews on three pages is three separate reviews.

An annotation belongs to the screen it was made on: mark up the iPhone card and the pin lives
there, not on all three. The agent gets `@mobile 390x844` in the anchor either way. Everything the
overlay draws - the comment box, the element label, the pins - is drawn back up to full size, so a
canvas scaled to 60% is still one you can read and type into.

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

Early. On the roadmap: diff-derived Keep/Undo, layout-issue detection, ACP mode.

## License

MIT
