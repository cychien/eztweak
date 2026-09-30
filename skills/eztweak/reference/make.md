# Make something

> Only for a turn whose prompt says 增強設計 (the design harness) is on for it, or a request that
> asks for it by name. In any other turn, handle the request as if you had never read this file.

The request in front of you is job A: something to change or build. It arrives as an eztweak
feedback batch, as a plain request in chat, or as an explore round asking for variants of one
element. Whichever it is, `PRODUCT.md` at the project root is the brief and `DESIGN.md` the visual
direction - read them first if you have not - and `.eztweak/config.json` says what the project is built on, which
browser tool to look at it with, and where its design system and components are. When the config
is missing or names no browser tool, run [stack.md](stack.md) first; when it records no
`components.primitives`, run [components.md](components.md) first.

What each form of the request adds:

- **A batch**: `items`, each annotation with an `anchor` to source (`file:line`), a selector and
  the viewport it was made at; `references`; `attachments`; and the running page's `url`.
- **An explore**: one element's capture - its markup, computed styles, the slot it sits in and the
  page's tokens - and a tool each variant goes back through. Nothing is edited in an explore; the
  variants are proposals the user picks from, and the one they pick comes back later as a batch.
- **A plain request**: none of that. Find the source yourself and use the dev server.

## The request is the scope

Change what the request asks for, and nothing else. When you notice something else that is wrong -
a contrast failure, a missing state, text that overflows, a stale token - **say so
in one line in your reply and leave the code alone**. You are not being asked to be thorough; you
are being asked for this change. A fix nobody requested is one the user has to notice, understand
and possibly undo, in a diff they did not expect - and it buries the change they did ask for.

Three exceptions. What you just built must itself be right: correcting your own work is finishing
the job, not extending it. The project's documents may learn from the request, in Learn, because a
correction the user has had to make twice is a gap in the documents, not in the code. And a pattern
your change makes appear a third time is extracted, as Build says, which touches its other copies
without changing how they look.

## How closely to keep to the design system

`DESIGN.md` is the direction; the design system is the material, and how closely you keep to it
depends on how complete it is.

- **A complete system** - a real scale of colours, type, spacing, radii and shadows, used across
  the page - is the product's language. Build from its tokens, and reach outside them only when
  none of them can do what the piece needs.
- **A sparse one** - a handful of tokens, most values written inline - is only a hint. Go in the
  direction it and `DESIGN.md` point, and choose the values yourself.

Either way, a value that keeps coming up becomes part of the system - see **Patterns that keep
coming up**, under Build.

What stays fixed is `PRODUCT.md`: what the product is for, and its Brand Commitments. Beyond
that, `DESIGN.md` is where you start, not a limit: a precedent that shows a better arrangement, a
stronger emphasis or a contrast it does not describe can take the piece past it, built from the
system's own material.

## Tweak, or a piece of design?

A **tweak** adjusts what exists: the size, colour or spacing of a thing already on the page. A
**piece of design** makes something new, or replaces how something looks. Most requests are
tweaks. A tweak goes straight to Build, and gets your own look in Review rather than a reviewer's;
everything else applies to both. An explore is always a piece of design, made fast: nothing in it
is built yet, so it decides like one but takes no screenshots beyond its capture, looks at no
states, and has no review of any kind.

## Effort

The prompt may set this turn's design effort, which the user picks. Without one, it is high.

- **High**: everything in this file.
- **Medium**: everything but Review. No reviewer, for a piece of design either: look at the
  result yourself once, at the request's viewport, and fix what is plainly off.
- **Low**: read `PRODUCT.md`, `DESIGN.md` and [baseline.md](baseline.md), and go straight to
  building the change in the project's components and tokens. No Purpose, Look or Decide, no screenshots, no search for 靈感,
  no `principles.md`, no Review. Learn and Deliver still run.

The level changes how much work goes into a change, never what the request asks for.

## Purpose

Before looking for anything, decide what this piece is for. An adjective - clean, modern, polished -
decides nothing. Work out, from the request, `PRODUCT.md` and the page:

- what the person looking at it comes here to do or find;
- what is therefore the main body, and what is secondary;
- what makes that easy to do: what they must see or understand before they act, the fewest steps
  to get it done, what tells them it worked, and how they get back from a mistake.

That is what you search with and what you judge every input against. How to lay it out is not
decided yet: Look may show you a better arrangement than the first one you would reach for.

## Look

Gather the inputs before deciding anything:

- **The current page.** Look at where the piece will sit, and at the page as a whole: what it
  leads with, and the rhythm of its sections. A piece is right or
  wrong only in the page it lands in, so choose the direction that keeps the whole page looking
  good, not the one that looks best on its own. Look with screenshots, taken by the skill's own
  script - `<skill>` is the folder above this file's `reference/`:

  ```
  node <skill>/scripts/page.mjs shot <url><page> <file> --viewport <W>x<H> --around "<selector>" --page
  ```

  It writes the piece with some of the page around it at twice the page's pixels, whole even when
  it runs past the viewport, and with `--page` the whole page beside it at its own size. Judge the
  details - spacing, alignment, type, edges, colour - only on the piece; the whole page is for the
  rhythm of its sections and their proportions, and is too small to judge a detail on. Several
  viewports - `--viewport 1168x861,390x844` - come out of the same run, one file each.
  `--hover`, `--focus` and `--active` shoot the piece again with one element in that state - the
  pointer on it, focus reached from the keyboard, or pressed - a file each; give each the selector
  of the element to put in the state, or nothing to use `--around`'s, and `--states` is all three on
  the piece. A phone has no hover, so that one is skipped there. In a batch, `page`, `viewport` and `selector` are the
  item's anchor's. A `clipped:` line means part of the piece is scrolled out of sight inside it,
  and what it hides is not in the picture. A `redirected:` line means the page sent the script
  somewhere else, a sign-in most of the time, so the picture is not the user's page: judge from the
  source and the user's own screenshots instead, and say so in one line in your reply. Only when
  the script cannot run - there is no Chrome - take them with the browser tool. Read the DOM only around the piece, never as a snapshot of the
  whole page: the source is found through the anchor or the code, and a whole-page dump fills the
  context with a page the screenshot has already shown you.
- **The project's own kin.** What the request asks for usually exists somewhere already. A flow
  that needs a dialog uses the dialog this project has; go and look at it - the primitive in the
  component set (`components.path` in the config), and how the pages that use it use it. Do not
  invent a second version of a thing the project already has a version of.
- **The system.** `DESIGN.md`'s direction, the design system, and the component set.
- **This user's taste.** `.eztweak/taste.md`, when it exists: how this user has judged earlier
  work. Build the first version to it; the review judges by it too.

Search [inspiration.md](inspiration.md) for precedent only when the database is available: the
prompt says so, or, outside an eztweak session, `~/.eztweak/credentials.json` holds an `inspire`
token. Otherwise skip the search and say nothing about it. When you do search, describe what the thing
is and has to show, and read what comes back in the order inspiration.md gives: the text and the
first image of each result, then the code of only the ones you learn from. A precedent is the
work of an outstanding designer, so study why each part of it is the way it is - the intent behind
its elements and patterns, and what its motion is for - before you judge it. What it can give you
is a move you would not have reached yourself - an arrangement, what leads and what recedes, an
emphasis, a contrast - and the reasoning that makes it work. Bring what it teaches into a design of
your own, in this project's tokens; start from its pattern only when that pattern is right for this
case, and adapt it even then. The design is still yours.

**An explore is not a search for inspiration.** The user wants to see how the element could be
arranged to read more easily and look cleaner. Its variants differ in a decision - what leads, what
recedes, how it is grouped, how much it shows - not in decoration, and each is a direction of its
own. When the prompt lists what earlier rounds on this element already offered, offer something
else.

## Decide

Now turn the purpose into layout decisions, with what Look showed you: take a precedent's move where
it beats your first idea. Decide:

- how dense it should be, and what has to be visible first;
- what colour and emphasis are for here, and what they are not for.

Not "a clean, modern, good-looking dashboard", but:

```
The user comes here to find orders that went wrong.
The list of those orders is the body of the screen; revenue figures are secondary.
A compact data layout, so the first screen on desktop shows as many orders as it can.
Red marks a problem and nothing else.
```

Write these four or five lines, the purpose with them, for yourself before building; they are what
Build builds and what you check the result against. Then hold the direction up against the
request's own content before you build any of it: can everything the request says must be seen,
done or noticed still be seen, done and noticed this way? A direction that would hide something
the request needs is cheaper to adjust here than after it is built, polished and reviewed - and the
adjustment is usually small: order, a count, the one item that must not be missed brought forward. A tweak needs one of them, a piece of design all
of them. In an explore the purpose is shared, and each variant answers the decisions differently.

Decide the direction yourself. A request that is open-ended - "make it more appealing", "be
bolder", "改好看一點" - is asking you to decide, so do not hand the choice back as options: pick the
strongest direction, build it, and say in your reply, in a few words, which one you took. The
review is what catches a wrong one. When the batch builds a variant the user picked in an explore,
the direction is already theirs: do not look for another. Ask the user only when the answer turns on something only they
know - which content, which audience, a fact about the business. An explore puts its choices to
the user as variants, so it never asks in words.

## Build

Read [baseline.md](baseline.md) and then [principles.md](principles.md) before you build. The
baseline is the standard every piece is held to; the principles put it into practice, with the
defaults against AI slop and the craft floor. The defaults are defaults rather than bans, so `DESIGN.md`, the user's own
request or a precedent's move can earn any of them back; going against one without any of these is
the reflex they exist to stop.

Build with the project's components and design system, from the inputs above and the inspiration
you found, into UI that does what the user asked and reaches the goal behind it. A component the
work needs and the set lacks is written the way `components.library` says, as the components step
would write it, and its values come from the design system as the section on keeping to it says.
In an explore, build each variant within the round's own rules - one
root, its own styles, no files touched.

**Look at it in every state.** Whenever you look at what you built - a tweak's own look, the
check before a review, the look after a refine - shoot each interactive element you changed or
added, a button, a link, a field or a card that responds, with `--hover`, `--focus` and `--active`,
and look at every file. A state that looks wrong - a box that appears on hover, a focus ring that is
missing or cut off, a press that shifts the layout - is part of the change, and is fixed before you
deliver; the user should never be the one to find it.

**Patterns that keep coming up.** A design grows in use, and the system grows with it. When your
change makes a value or a piece of UI appear for the third time - the same shadow written out a
third time, a third card with the same header - extract it. A value becomes a token in the design
system, under a name that says what it is; a piece of UI becomes a component in the project's
library, written the way `components.library` says, and its name goes into `components.primitives`
in `.eztweak/config.json` so later work finds it among the project's own kin and uses it. Switch
the existing copies to it without changing how they look, and name the extraction in your reply.
Twice is not yet a pattern; leave it. An explore extracts nothing, since nothing in it is settled.

Build to the bar the reviewer holds it to, the baseline: outstanding rather than the safe
average, designed for the whole screen rather than the component alone, the point of the page first
and plain, hierarchy visible at a glance, greys carrying the page and colour kept for the point,
spacing fit for what the page is for, and every state finished. Before you write it, picture that
version, not the first competent one, and build that. A clever idea is not the goal; a useful move
done cleanly is.

## Review

A maker judging their own work praises it. So a piece of design in a batch or a plain request is
judged by an independent reviewer: a subagent with a fresh context, started with your agent tool,
that did not watch you make it.

First screenshot the piece in place with `shot`, as in Look and in one run: `--around` it at the
request's viewport - and at `390x844` too when the piece reflows - with its interactive elements in
their states, plus one of the whole page at desktop, into files outside the project. Those are what
the reviewer judges, and your own check that nothing is broken. Then give it this brief, with the three paths
written out in full - a file a reviewer is only pointed to from inside another is one it does not
open. Add only what it needs to run, and never your intent or your opinion of the result:

```
Review a UI change you did not make. Read <the paths of critique.md, baseline.md and principles.md,
all beside this file>, then judge by critique.md.
The user asked: "<the request, in their words>"
Page: <url>, at <viewport - an item's anchor.viewport, else desktop>.
The change is in: <the selector, or file:line, of what you changed>.
Screenshots: <the files>.
```

One review covers the whole batch: when it holds more than one piece of design, list each one in
the brief - its request, where it is, its screenshots - and get one answer. When a piece builds a
variant the user picked in an explore, add `The direction was chosen by the user; judge execution
and fit.` to the brief, and read a pivot on that piece as refine. When a piece takes a precedent's
move past what `DESIGN.md` describes, add `It departs from DESIGN.md on purpose: <the move, in a few
words>. Judge whether the move serves the page.`

It answers with scores, a verdict and at most three fixes. **One review**, acted on by its verdict:

- **ship**: go on to Learn.
- **refine**: make the listed fixes, look at the result yourself, and go on to Learn.
- **pivot**: the direction was wrong. Build a different one, not a variant of the same idea, and
  have that reviewed once more - with the same brief and one more line, since two reviewers score
  the same piece differently and a comparison is steadier than a second score:

  ```
  An earlier version, for comparison: <a screenshot of the first direction, taken before you replaced it>.
  ```

  Deliver the direction that review calls better, putting the first one back when that is its
  answer. There is no third review.

A **tweak** gets no reviewer: look at it yourself, rendered at the request's viewport, fix what is
plainly off, and stop. **An explore** gets no review at all, not even your own: it is there to
put directions in front of the user quickly, and the one they pick is reviewed when a batch builds
it. Send each variant the moment it is made. When your agent has no way to start a subagent, review the piece yourself
by critique.md, strictly, as if someone else had made it.

## Learn

An ordinary change edits code only. `PRODUCT.md`, `DESIGN.md` and `.eztweak/taste.md` change only
on what the user has actually said, never on what you read into it. Two signals count:

- **The user states a rule.** "Never", "always", "from now on", in so many words, is a rule the
  first time.
- **The same correction, asked for again.** The same kind of adjustment the user has already asked
  for once before - the spacing tighter again, the accent used less again - means the documents
  let you make the same mistake twice.

Nothing else counts: not a batch that sends back what you made, not a tone, not a guess at what
they meant. Fix the work for those, and leave the documents alone. When a signal holds, write it
into the document it belongs to, in the form that document already uses:

- A visual lesson goes to `DESIGN.md`, at the level the file is written at: a Do or Don't that
  names a tendency - "the accent stays rare, one filled button per band" - not a value. A value
  stays in the code.
- A visual rule the user states as binding - "never", "always", in so many words - goes to
  `PRODUCT.md`'s Brand Commitments, because `DESIGN.md` is a direction and the user's own rule is
  not optional.
- A product rule goes to `PRODUCT.md`: Product Principles when it is a principle, Capabilities and
  Constraints when it is a fact.
- How the user judges quality - what they have called good or bad in general terms, or corrected
  twice - goes to `.eztweak/taste.md`, creating it if it is not there: the judgment ("a single
  emphasised figure beats a row of equal badges"), not the element it came from. Newest first.
- One line, in the user's own terms, not an essay. If it contradicts an entry already there, change
  that entry rather than adding a second one that disagrees, and say so.

When none of these holds but your change leaves a line in either file stale - it still describes
what you just removed - name the line in 順帶一提 and leave the file as it is.

The skill's own `baseline.md`, `principles.md` and `critique.md` are shared by every project this
skill is installed in, so they are never edited here. What you learn from this request is about
this product and this user, and it lives with the project.

An explore edits no file, so this step does not run in one; the pick that comes back later as a
batch is where the learning happens.

## Deliver

For a batch or a plain request: a reply the user can read in a few seconds. One short line per
item: what changed, as they will see it on the page, and the files it touched, since it is their
code - no sub-bullets, no pixel values or breakpoints, no account of what you checked or could not
run. When Learn wrote to a document, one more line naming the file and the entry, so they can
strike it if the reading was wrong. When you searched for 靈感, one more line for each result you
took from: what you took - its arrangement and its details, the spacing, sizes and weights - and
where yours differs from it and why, so the user can judge the reason. A reason that names 設計規範 is
one `DESIGN.md` or `PRODUCT.md` actually says; a reason you inferred is given as your own judgment. Then, only
when there is something they would act on and do not already know, a short **順帶一提** list: one
line each, what and where, no fixes applied. That list is the whole of what you do about it.

Leave out everything they did not ask about: the review, its scores and its verdict; which steps
you followed; a tour of every detail you made; facts they already have, such as what
`PRODUCT.md` says. When the review raised something you left and it matters to them, it goes in
順帶一提 as your own observation.

For an explore: each variant through the tool, with a note that says the idea in one line.

Everything the user reads - replies, progress lines, questions, variant names and notes - is in the
language they write in, and in their words: 增強設計, 設計規範, 靈感, not harness, make.md, precedent
or inspire. A progress line says what you are doing to their page ("正在調整間距"), never which step
of this file you are on, and never anything about the review: while it runs, "正在檢查細節" is all
the line needs. This holds for every line, including the ones you write between tool calls.
