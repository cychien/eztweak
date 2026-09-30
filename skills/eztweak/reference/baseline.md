# Baseline

> Only for a turn whose prompt says 增強設計 (the design harness) is on for it, or a request that
> asks for it by name. In any other turn, handle the request as if you had never read this file.

This is the taste the harness is built on, and the standard every piece is held to, whatever its
direction. `DESIGN.md` sets how this product looks; the baseline is what good means under any look.
The user's own words, in the request or in `.eztweak/taste.md`, can move a rule here; nothing else
does.

Everything below serves one goal: the person on the page understands it quickly and gets done what
they came to do.

## Usability comes first

- **Never hide what matters to look minimal.** The information and the actions the page exists for
  stay in view and within one step. Only what matters less goes a level deeper, behind a menu, a
  tab, a disclosure or a settings page. A product with a lot to do, like a Stripe or Shopify
  dashboard, cannot be sparse, but it keeps the everyday work in front.
- **Easy to use first; the looks follow.** A paragraph set in one colour leaves the reader to find
  what matters. Darken what carries the point and lighten the rest, and it reads at ease and looks
  better for it.
- **Design serves the viewer and the business.** `PRODUCT.md` says who they are and what they need.
  A striking home page is not there to be beautiful; it is there so the visitor stays.
- **Start from the least the screen can do its job with.** Add an element only when it is needed;
  each one has to earn its place.

The check: every choice can be justified by what it does for the viewer or the business, and taking
any element away makes the screen worse at its job.

## Aim for outstanding, never average

- **Do not settle for the safe average.** The first design that comes to mind is usually the mean
  of every interface you have seen: competent, interchangeable, and forgettable. Aim for the
  version an outstanding designer would ship, and for refined over merely correct.
- **Outstanding comes from judgment and precision, not novelty.** Hierarchy that is exactly right,
  spacing that is exactly right, details finished down to the states: that is what sets great work
  apart. A clever gimmick is not the way there.
- **Safe is not the same as right.** Do not reach for the conventional treatment because it cannot
  be wrong. Use it when it is the best answer for this screen, and then make it better than usual.

The check: someone who cares about design would stop and notice how well it is made. A piece
nobody would comment on is not done.

## Know what the point of the page is

The point is what the person most wants to get done on this page, or what the business most wants
them to do there. Purpose, in `make.md`, works it out; every rule below leans on it, so decide it
before you style anything.

It depends on the page, not on the kind of element:

- On a blog post, the body text is the point.
- On a list of posts, each post's title is the point, and its excerpt is not.
- On a pricing page, the plans and the action that buys one are the point.

One point per view, sometimes one per repeated item. When everything is emphasised, nothing is:
a page with many points has none.

## Design for the whole screen

- **A component is designed in its screen, never on its own.** Before changing one, work out what
  this screen is for: what the person should get done here, and what they should feel, such as
  confident, calm or eager to start. Style the component for that.
- **Its role on the screen sets its weight.** Its size, colour, emphasis and spacing are decided
  against its neighbours and the point of the screen: as loud as its role, no louder.
- **Better alone and worse on the screen is worse.** A change that polishes the component and
  pulls the screen out of balance has failed.

The check: look at the whole screen after the change, not only the component, and it reads better
as a whole.

## Hierarchy is always visible

- **Rank shows before a word is read.** Size, weight, spacing, borders, colour and type set what
  leads, what follows and what recedes. The eye lands first on the point.
- **Nearness and likeness mean relation.** Put related things close together and give them a
  shared style: a ground laid under the group, the same colour, the same shape or treatment. A
  ground or border that holds a group is its one container, so its members are not boxed again.
- **Distance and difference mean separation.** Unrelated information sits further apart, in a
  different style, or across a divider. The same means that set groups apart bind the members of a
  group together.

The check: at a glance, before reading anything, it is plain what leads and which things go
together.

## Grey first, colour sparingly

- **Build on the grey tokens.** Most of a page is greys: the ground, the surfaces, the text, the
  lines. The primary colour appears in small amounts, on what the user acts on or needs to find,
  such as the main action, the current selection or a live state.
- **The darkest greys are for the point.** Near-black is kept for what matters most, such as the
  key heading or the key text. Everything else steps down to a lighter grey, so the point is what
  stands out.
- **Lines and borders are light grey.** A divider, a card's edge or a table rule uses the lightest
  grey that still separates. Do not reach for a dark-grey token to draw a line. A form field's
  outline can be a step darker so it can be found, but not dark enough to compete with the text.
- **Weight and colour balance each other.** A heavier weight emphasises and a lighter colour
  recedes, so the two can be set against each other: a list a step above regular weight (around
  450) in a lighter grey stays quiet beside the heading while still reading full. Regular weight
  made lighter looks thin, and the whole UI with it. An in-between weight needs a variable font;
  with only static weights it snaps to the nearest one, so check it renders.

## Quality comes from proportion and detail

- **Quality is built, not added.** It comes from proportion, a clear type scale, precise spacing,
  exact alignment and finished states: hover, focus, pressed, selected, disabled, empty, loading,
  error. It never comes from a gimmick.
- **Spacing is a decision each time, and it depends on what the page is for.**
  - On a page that presents, such as a landing or marketing page, spacing only has to feel
    comfortable: room to breathe around each section and its content.
  - On a page people work in, such as a dashboard, a table, a settings page or an editor, spacing
    is compact but easy to scan: tight rows, consistent columns and edges the eye can run down, and
    groups set apart by a clearly larger gap than the one inside them.
- **Type runs small.** Most text is set smaller than a first instinct picks, and that restraint is
  much of what makes a screen look refined. Rank comes from weight, colour and space as much as
  from size, so a heading does not need to be big to lead. Large, heavy type needs a real reason,
  such as the one headline of a landing page or the number that is the point of a dashboard; it is
  never the default for titles, labels or buttons. Small never means hard to read: the craft
  floor's legibility still holds.
- **Few elements, each finished with care.** Simple is about how many things there are, not how
  plainly each is made.

## Decoration serves, never competes

- **Decoration is welcome when it belongs.** A considered shadow, ground, icon, illustration or
  transition that makes a piece feel finished is worth it. Flatness and bareness are not virtues in
  themselves; refined beats plain.
- **It stays in harmony with the whole,** in the page's colours, radii and weight.
- **It never takes attention from the task.** Nothing decorative is louder than the point of the
  page.
