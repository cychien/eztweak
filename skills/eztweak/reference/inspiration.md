# Search the inspiration database

> Only for a turn whose prompt says 增強設計 (the design harness) is on for it, or a request that
> asks for it by name. In any other turn, handle the request as if you had never read this file.

## What it is

A curated collection of interfaces that work, each entry carrying the reason it works and the case
where it would be the wrong choice. Every entry is the work of some of the best product designers in
the world, chosen by hand because it is good: study it the way a designer studies a master's work,
not the way you skim an average page. It is searched by meaning - a description of what the piece has
to show - and entries carry tags in their curator's own words (`onboarding`, `dark popover`), which
nudge a search when you name one. It is an outside source: nothing in `PRODUCT.md` or `DESIGN.md` is decided by it or written in its
words. The collection is not in this skill or in the project; the commands below query it, and you
see what you asked for.

## The commands

```
npx -y eztweak@latest inspire --query "<what the piece has to show>" [--tag onboarding] [--limit 5]
```

A `--query`, `--tag`, or both. A search prints a block per result: what it is, its tags, `Shows:`
(what the entry is), `Components:` and `Actions:` (what is on it, and what can be done there),
`Why it works:` and `Wrong when:`, then local paths to its images and, when the entry has it,
`code:` - a working implementation of it. `(approximate)` in the heading means that entry was read
off a screenshot, so its inventory is an estimate rather than a reading. The images and the code
are downloaded to disk, so open them the way you open any file - when the steps below say to.

There is no fixed list of tags, so lean on the query: it finds by meaning, and a tag you guess only
helps when some entry happens to carry it.

It works without a review session, a daemon or a dev server. It needs a token, stored once by
`npx -y eztweak@latest login`.

When the prompt names the eztweak command to run, run that one instead of `npx -y eztweak@latest`.
Never look for another copy or version of eztweak to run - a repository checkout, a global install,
a different package version: the command you were given is the only one.

## How to search

- **A batch.** Write the query first: one or two sentences saying what the piece has to show - the
  elements on it, the register its wording is in, the actions it offers. "A settings page with a
  two-column form, a destructive delete behind a confirm dialog, labels in Traditional Chinese."
  Run it once, with `--limit 5`. The design takes one direction, but its moves may come from more
  than one result.
- **An explore.** Search only for a variant whose direction would gain from a precedent; a variant
  does not need one, and the round is about arrangement, not inspiration.
- **A plain request.** Even "a pricing table" is a query: `--query "a pricing table"` finds it by
  meaning.

## What to take from a result

A result need not match the request: one that covers most of it, or one part of it well, is a
result, since nothing in the collection was made for this product. Do not run the search again
because the first answer was not a fit.

**Learn why it works, and how it is made.** Every entry is the work of an outstanding designer, so
study it the way a designer studies a master's work, for both. The intent: what each element and
pattern is there to do for the person using it - why this surface is dark, why this gap is wider
than that one, why the description stops where it does, why the action sits there - and what would
go wrong without it. The surface, just as closely: how it arranges and presents the information,
and the refined details that make it look finished - how a label sits against its value, how a
group is framed, the size steps between a title, its text and its action, a subtle ground or edge.
That is where much of a precedent's value is, and what your first idea usually lacks. `Why it
works:` names the move; the image and the code show how it is carried out. Take a result seriously
before you judge it: a part you leave out is one you understood and found wrong for this product,
and your reply says why.

Read a result in two steps, and go on to the second only for the results you learn from:

1. **The text and the first image**, of every result. `Shows:`, `Components:` and `Actions:` say
   which part of your request it covers, `Why it works:` names the move, and `Wrong when:` says when
   it is the wrong choice; the first image is the whole piece at desktop size, and shows the move.
   Judge the direction by both: the text says what an entry is, the image whether it looks the part.
   The other images are the phone and further states: open as many of them as the judgment needs.
2. **The code**, of each result you learn from - one or several - and of none you set aside. A
   screenshot is one moment, and a precedent understood from it alone is understood wrong: the code
   is the precedent working. Read the whole file, not its first lines - the states and the motion are
   usually further down. Read it to understand how the piece behaves, not to paste it: what appears
   only on hover or focus, what is hidden until chosen, what moves, and the proportions behind what
   the image shows.

**Mind the motion.** The code shows what moves, when, how far and on what curve. Work out what each
motion is for - confirming an action, showing where something came from or went, drawing the eye to
what changed - and use motion in your piece only where it does that same job here. Keep it as short
and quiet as the job allows, in the easing the principles give, and let it fall away under
`prefers-reduced-motion`. Motion that is only there because the precedent had it is decoration.

**Make it yours.** Bring what you learned into a design of your own for this product: the intent
carried over, expressed in this project's tokens, type, components and motion, and held to
`baseline.md`. Carry relationships, not numbers: the space between groups against the space inside
them, the padding a surface gives its content, the size steps between a title, its text and its
action - each in the project token nearest in role, keeping the proportion, so a gap half its
card's padding stays half. The entry's palette, fonts, exact values and content do not transfer.
The piece should read as this product's own, not as the precedent in a new skin.

**Starting from a pattern.** When one pattern is right for this case - it solves the problem in
front of you, and `Wrong when:` does not describe this product - you may start from it: take its
structure as the base, then adapt it to this product's content, its point and hierarchy, and its
tokens. Even then it is a starting point, not a copy: every part you keep, you keep because you know
why it works here.

A move that `DESIGN.md` does not describe is not a reason to drop it: `DESIGN.md` is a direction,
and a precedent is how the design gets past its first idea. What does stop a move is `PRODUCT.md`,
`baseline.md`, the craft floor in `principles.md`, and `Wrong when:` - read it against the product
in `PRODUCT.md`, and when the situation it names is this one, drop that result.

You are not obliged to use a precedent's pattern. It is there to learn from, and the direction stays
yours: often what it teaches - a spacing rhythm, a way of bringing one thing forward, a motion that
explains a change - is the whole of what belongs in your design. When it does not fit at all, leave
it. The one thing not to do is set it aside unread.

## Where a result may be named

In your reply to the user, and nowhere else. Never write an entry, a slug, a source or an image
path into `DESIGN.md`, `PRODUCT.md`, a code comment, a commit message or any other file in the
project. A project repository is often shared; the collection is not.

## When it does not answer

`no matches for ...`, or an error and exit code 2 - no token, a refused token, a service that
cannot be reached. Either way, say nothing to the user about it, and carry on with `DESIGN.md`, the
project's own kin and your own judgment. This step never
blocks the work, never gets a retry, and never another way to run the command.
