# eztweak

> Point at your live app. Your agent fixes it.

eztweak turns any locally running dev server into an annotatable review surface for human ↔
agent iteration. The user marks up the **real page** - click an element, frame a region, select
some text, leave a comment - and the feedback flows to a local coding agent (Claude Code, Codex,
anything that can run a CLI) as structured items that resolve to **exact source locations**. The
agent edits the code, HMR updates the page in place, the user reviews the next round.

```
$ npx -y eztweak@latest http://localhost:5173/pricing --agent claude  # managed ACP agent
$ npx -y eztweak@latest http://localhost:5173/pricing                 # portable poll mode
$ npx -y eztweak@latest poll http://localhost:5173/                   # agent waits for feedback
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
- **Built for the loop.** In ACP mode, eztweak owns the agent and keeps its live work, questions,
  and permission prompts in the review shell. Poll mode keeps the blocking structured-JSON contract
  for any external agent or automation. HMR keeps iterations in place; the review chrome lives
  outside the app frame, so it survives your agent's syntax errors.
- **Local-first.** Everything binds to 127.0.0.1. Nothing leaves your machine, except one
  request to the npm registry every few hours to learn whether a newer version exists (opt out
  with `EZTWEAK_NO_UPDATE_CHECK=1`).

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

When a newer eztweak is on npm, a card appears at the top of the review shell and one button takes
it. The new version is installed under `~/.eztweak/versions/` and started as this daemon's
successor: the successor binds and registers first, and only once it is up does the old daemon let
go - so a version that fails to start leaves you on the one you had, with the error in the card.
Your sessions come back on the ports they held and the shell reloads itself.

An ACP agent is restarted along with the daemon and comes back in a fresh session, so the review's
conversation does not carry across - the same as `/new`. The card says so before you click, and the
thread says so afterwards.

The close button in the card's corner puts the offer away; the version beside the name in the
header turns into a pill you can click to bring it back. Nothing is installed or restarted without
that click.

Without the shell:

- **CLI** - always invoke it as `npx -y eztweak@latest`. A bare `npx eztweak` reuses whatever
  version npx cached and never checks for a newer one.
- **Daemon** - opening a session with a different CLI version replaces the running daemon with that
  version, under the same restore guarantee any daemon restart gets (see Configuration). A CLI
  that reaches a daemon on another version is refused with a `409` that says how to update,
  instead of speaking a mismatched protocol.
- **Skill** - `npx skills update eztweak`, whenever you feel like it. Deliberately not part of the
  update button: the skill's own instructions launch the CLI as `npx -y eztweak@latest`, so an old
  copy still starts a current review, and everything that governs a review once it is running
  ships with the daemon. Its reader is also an agent session eztweak did not spawn and cannot
  restart, so a sync would not take effect until that agent's next session either way. The bundled
  copy carries the release it came from in its frontmatter (`metadata.version`).

The daemon asks the npm registry for the latest version at most once every four hours. Set
`EZTWEAK_NO_UPDATE_CHECK=1` to never ask.

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
mid-word stays a slash, so urls and paths are left alone. The commands:

- **`/file`** opens the system file picker and drops what you choose in as an attachment, where the
  slash was.
- **`/new`** starts a new chat: the agent's context is thrown away and the review carries on in a
  fresh session, which is how a long review stops paying to replay its own history on every turn.
  Only offered in [ACP mode](#acp-mode-experimental), and only in the note box below the queue. The
  thread empties with it, back to the state it opened in - a notice explaining that the history above
  no longer counts is still history above. The log on disk is untouched: `/new` records where the
  visible thread starts, so the record of the review stays whole while the shell shows the fresh
  start that was actually asked for. Every batch the agent had not finished with goes too, not just
  the turn it was on - a question queued behind that turn was asked of a context you have just said
  to start over from, and a fresh session answering it would be answering something else. The 待送
  清單 is left alone: those you have not sent yet, so they were never the old context's to begin
  with. A note you were part-way through typing survives, so `/new` and then send is one move.
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

## The queue

Queued annotations stay editable until the batch goes out. The pencil on a row turns that row's
comment into a field in place - nothing appears elsewhere, and there is no second place to look.
Editing borrows the two buttons the row already has rather than adding any: the pencil becomes the
tick that commits, and the cross, which dismisses either way, becomes the one that backs out. The row
keeps its number and its source label throughout, so what is being changed never stops being obvious.

The field is seeded with exactly what the row was showing, chips where the sentence had them, so a
`[ref 1]` or an attached screenshot survives a wording change instead of having to be picked again.
⌘/Ctrl+Enter saves, Escape cancels, and both outrank the shell's own bindings while the field is
open, so ⌘+Enter is this save rather than the batch send. `/file` works inside it; `/element` does
not - pointing a comment at a new element needs the page's own pointer routed back into a row, which
is a different thing from adjusting what you already wrote, so delete the chip and re-annotate
instead.

A cancel takes any file attached during the edit with it; the files the row already had are left
alone either way, and one dropped by a save is collected by the same sweep that collects an
attachment nothing references.

## Asking while the agent is still working

Sending mid-turn is allowed and queues - you should not have to wait for a turn to finish before
writing down what you just noticed. The batch goes out on its own the moment the agent comes back,
and your bubble appears in the thread the moment it leaves the composer, which is what says it went.
To make it go *now*, stop the current turn: the queued batch is delivered as soon as that turn ends.
`/new` does the opposite - it drops the queue along with the context.

The thread draws each answer under the question it answers, which is not always where the log put it.
The log itself stays append-only and stamped in real time - it is the record of the review - but a
batch sent mid-turn lands *between* an earlier question and its reply, so rendering the log verbatim
would put the agent's answer under a question it is not answering, and put the new question above
output that started before it was typed. Instead every entry carries the batch it belongs to, and the
in-flight turn is drawn in the same place its finished reply will be, so nothing moves when the reply
lands. Entries that answer no batch - the session notices - stay exactly where the log put them,
because for those the timeline *is* the meaning.

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
| `EZTWEAK_DATA_DIR` | `~/.eztweak` | Session state, the daemon registry and log, versions installed by the in-shell update, and the update-check cache |
| `EZTWEAK_CONTROL_PORT` | `4400` | First port of the ten-port range the daemon searches for its control server |
| `EZTWEAK_NO_UPDATE_CHECK` | unset | Set to `1` and the daemon never asks the npm registry for the latest version, so the shell never offers an update |

Set both together to run a second, fully isolated instance: a starting daemon adopts any live
daemon it finds inside its own control range, so moving the data dir alone still lands you on the
shared daemon. `npm run dev` sets both.

Sessions outlive the daemon that served them. On start, the daemon picks each session back up
from disk and re-binds it to the port it last held, so a review shell tab you already have open
only needs a reload, and feedback you queued before the restart is still waiting. If that port has
since been taken, the session moves to a free one and the CLI re-resolves it. A session that was
driving an ACP agent starts that agent again, in a fresh context; the thread says so.

A session belongs to one project on one origin, not to the origin alone. Dev servers all default
to the same port, so reviewing a second project on `localhost:5173` would otherwise inherit the
first one's conversation and hand its undelivered feedback to the wrong agent. The project is the
nearest `.git` or `package.json` ancestor of the directory you run `eztweak` from, so switching
projects on a port starts a clean review and switching back finds the old one intact.

## Agent modes

eztweak can either manage an ACP agent inside the review session or expose feedback through its
portable polling contract. Both modes receive the same structured feedback and exact anchors.

### ACP mode (experimental)

Pass `--agent` when opening the session:

```
npx -y eztweak@latest http://localhost:5173/ --agent claude
```

The daemon starts the agent as a child process, sends each feedback batch as one turn, and shows
the agent's streaming reply, plan, tool activity, questions, and permission prompts in the review
shell. The completed reply is saved in the conversation, and the next queued batch is delivered
automatically. No second terminal or `poll` loop is needed. This is also the mode used by the
bundled eztweak skill.

Two controls come with owning the agent:

- **⌘/Ctrl+.** stops the turn in flight, from anywhere including mid-sentence in the composer -
  which is when you usually want it, since watching the agent head the wrong way is what prompts it.
  No button: a control that is live for the few seconds a turn lasts costs the composer a permanent
  slot to say so. The status badge reads `正在中止` until the agent answers, so the keypress is not
  silent. Whatever it had already said stays in the thread, and the batch is not handed back: you
  stopped it on purpose.
- **`/new`** in the note box clears the agent's context. See [The comment box](#the-comment-box).

Three built-in profiles map short names to ACP server commands:

| Profile | Command |
| --- | --- |
| `claude` | `npx -y @agentclientprotocol/claude-agent-acp` |
| `codex` | `npx -y @agentclientprotocol/codex-acp` |
| `gemini` | `gemini --experimental-acp` |

Any other value is used as an ACP command line, so a custom server can be started with
`--agent 'my-acp-agent --flag'`. Only one live ACP agent can own a session. End the session or stop
the daemon before switching it to a different agent.

### Poll mode

Without `--agent`, the review uses the existing CLI contract:

```
npx -y eztweak@latest http://localhost:5173/
npx -y eztweak@latest poll http://localhost:5173/
```

`poll` blocks until the user sends feedback, prints the structured batch as JSON, and exits. This
mode remains available for scripts and integrations that consume the CLI contract directly.

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

Early. On the roadmap: diff-derived Keep/Undo and layout-issue detection. ACP mode is an
experimental spike.

## License

MIT
