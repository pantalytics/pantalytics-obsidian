# The screen, and what it refuses to be

**Design document.** What a person sees in Obsidian, and why it has this shape.
[`architecture.md`](architecture.md) is what sits underneath it. The design the
fork was being cut down to before the rebuild is
[`archive/ui-ux-fork.md`](archive/ui-ux-fork.md), and nothing in it describes
what ships.

The decisions live as ADRs in the admin repository, `knap-mcp-admin/docs/adr/`:
**0030** sign-in, **0031** one control surface, **0033** one server, **0034**
permissions, **0038** the words, **0043** a vault is one unit, **0045** the
plugin is Knap, **0066** one local vault to one cloud vault, **0071** what a
failure may say, **0088** what the corner counts, **0089** which way it says
they are going. Where this page and an ADR
disagree, the ADR wins.

## The rule

**Everything about the vault is set here in Obsidian. Knap's page reports.**
One row is taken out of that: **who may read a cloud vault is set on Knap's page
and nowhere else**, because that is a fact about a vault rather than about a
device, and two places to set it is how two places come to disagree.

So this side owns: whether this device is signed in, and which cloud vault this
local vault is linked to. That is the whole list, and it is why the screen is
this short.

## The screen

One settings tab. Obsidian's own `setting-item` rows, so it reads like the pages
either side of it rather than like a panel we built.

```
  Settings → Pantalytics Knap
  ┌──────────────────────────────────────────────────────────────┐
  │ next.knap.pantalytics.com                                    │  ← the host,
  │                                                              │    once, quietly
  │ Account                                       [ Sign out ]   │
  │ Signed in.                                                   │
  │                                                              │
  │ ┌──────────────────────────────────────────────────────────┐ │
  │ │ Cloud vault                                 [ Unlink ]   │ │  ← the vault
  │ │ Work notes                                               │ │
  │ ├──────────────────────────────────────────────────────────┤ │
  │ │ ● Initializing                       290 of 3,127      ▾ │ │  ← the strip
  │ ├──────────────────────────────────────────────────────────┤ │
  │ │ Leave Obsidian open until it finishes.                   │ │
  │ │ Checked                                290 of 2,979 notes │ │
  │ │ Uploading                       412 notes, 3 attachments │ │
  │ │ Downloading                                 2,567 notes  │ │
  │ │ Total                       2,979 notes, 148 attachments │ │
  │ └──────────────────────────────────────────────────────────┘ │
  │                                                              │
  │ Read-only link                                    [ Open ]   │  ← to the vault's
  │ Let anybody with the link read this vault's notes. ...       │    Settings page
  │                                                              │
  │ Pantalytics dashboard                            (i)  [ Open ]      │  ← the way out
  │ Opens next.knap.pantalytics.com in your browser. Invite      │    (i) pressed
  │ your team, connect your AI over MCP.                         │
  └──────────────────────────────────────────────────────────────┘

  signed out:                        signed in, not linked yet:
  ┌────────────────────────────┐     ┌────────────────────────────┐
  │ Account       [ Sign in ]  │     │ Cloud vault  [ Choose... ] │
  │ Not signed in. Signing in  │     │ Not linked.                │
  │ opens your browser and     │     └────────────────────────────┘
  │ comes back here.           │
  └────────────────────────────┘
```

Each of the four parts earns its place, and they are in the order they depend
on each other. **Account** is who. **Cloud vault** is what this vault syncs
with. **The strip** under it is how that vault is going, and it is inside that
row's block rather than beside it: one border round both, a hairline between.
**Read-only link**, once there is a link, opens that cloud vault's Settings on
the dashboard, where the switch is: who may read a vault is set there and
nowhere else (admin ADR-0111). **Pantalytics dashboard** is last, because it is
the way out to everything else.

**The strip belonged to nothing until 2026-09-02.** It sat above both rows, the
first thing on the screen, which said it was a third subject on a screen with
two things on it. It is a fact about one cloud vault, so it is drawn under the
row that names one, and the name it used to carry in its own head went with the
move: the row a hairline above spells it out.

**The strip waits for a link**, which is why it is absent from both the small
screens above. How it is going is a question about a cloud vault, and before
there is one every word is wrong for the state: nothing is syncing, so nothing
is behind, so it settled on *Up to date* over notes that had never left the
device. The row above it says *Not linked*, which is truer and is also the way
out of it. A vault with an account and no link reads **Paused** where it has to
be said in one word, in the corner of the window: nothing is moving, and nothing
is going to until somebody picks a cloud vault.

**The dashboard row is a name, a button and an (i).** What is on the other side
of it is two sentences, and two sentences under a row somebody reads every week
is two sentences they read every week, so they sit behind the (i): *Opens
mcp.pantalytics.com in your browser. Add people to your workspace, connect your AI
over MCP.* Those are the two things this side deliberately cannot do, which is
the whole reason to leave for a browser. The (i) toggles rather than hovers,
because settings get touched on a phone, and Open lands on the linked vault's
own page (the one with the member list on it) rather than on the front door.
There is no ribbon icon and no command for it: this screen is where somebody
already is when they wonder how to let a colleague in.

**The Cloud vault row is a name.** The sentence about a delete travelling both
ways moved to the screen that links (#116 put it on this row, and a row read
every week is not where a decision taken once belongs). It is the first thing
under the heading on the linking modal now.

The screen exists at all because the commands were the only way in, and a
command palette is where somebody looks after they already know the thing is
there. Asked to try the beta, the first thing a person does is open Settings and
look for a button.

Four things that are absent on purpose:

- **No server field.** There is one server and no second one to point at.
- **No scope or folder picker.** A vault is one unit. Somebody who must keep
  part of their notes off the cloud uses a second vault, which is Obsidian's own
  answer.
- **No second kind of member to set.** There is one kind of person in a vault.
- **No Change button on Cloud vault.** Linking somewhere else is Unlink and then
  Choose, which is what happens underneath either way. A third button to say so
  is a third button.

And one thing that is present on purpose: **signed in, there is always a way
back out.** A screen that can only sign in is one a person cannot hand their
laptop on from, and the only alternative was uninstalling the plugin, which
leaves the token alive anyway.

### The strip, and the fold

The strip is the only thing on the screen that folds, and that is the hierarchy.
The dot and the word are always out. How big the vault is sits at the far end,
pushed there rather than following the word so the eye finds the word in the
same place whatever it is about. **While the pass at start is going, the far end
is how far it has got instead**, *290 of 3,127*, notes and attachments added
together the way the corner adds them. Everything else comes out when somebody
asks:

| Behind the fold | When |
|---|---|
| Leave Obsidian open until it finishes | Under *Initializing*, and no other word |
| **Checked** | While the pass at start is going: *412 of 2,505 notes*, then *all notes, 12 of 338 attachments* |
| Uploading, Downloading | While either direction has something in it, naming notes and attachments separately |
| Could not sync, *N* changes | When something failed and stayed failed |
| **Total** | Whenever the tree has been read, ruled off from the rows above it |
| **Try again** | Only under *Problem* and *Offline*, the two words a person can act on |

Nothing deeper is kept here at all. What went wrong in detail is the server's;
this device only ever tells it four content-free facts (ADR-0071).

**Every word's instruction went on 2026-09-02 except one.** They told somebody
to wait, over rows that now say what is being waited for, in numbers. What
Initializing asks for is different in kind: leave Obsidian open, which is not
what a person would otherwise do (ADR-0090). *Signed out* keeps its sentence
where it is still read, which is the corner of the window rather than here: this
strip only exists over a link, and a link needs an account.

**Checked is the line for the work the two directions cannot see.** A restart
over a vault that is already here opens every note, compares it against its
document and closes it, and on a few thousand notes that is minutes with nothing
going up or down. Until 2026-09-02 the strip said *Syncing* beside *2,505 notes*
through all of it, which reads as 2,505 notes still to go and gives no way to
tell a pass that is getting somewhere from one that is stuck. The pass counts
every piece it found before it runs any of them, uploads, downloads and compares
alike, so the number climbs from the first second and reaches the total at the
moment the word changes. It is not a new word: what a person does under it is
wait, which is what Syncing already says (ADR-0089's test). There is no estimate
of how long is left, on purpose. The rate of a pass depends on the line and on
the server's pool of sockets, and a minute that becomes four is worse than a
count that climbs.

**Total is the line that is there when nothing is moving.** It is what the cloud
vault holds, counted off the tree, and it is the one number on this screen that
can be held against what Knap's own page says about the same vault. That is why
it survives *Up to date*, where the fold used to hold nothing at all and the
head stopped being a control.

**The fold holds nothing the head already carries.** The vault's name used to
be behind it as well as on it, which put that name on one phone screen three
times, in the head, behind the fold and again on the Cloud vault row (#125). It
is now on the row and nowhere else, which is what moving the strip under that
row cost and bought at once.

**The chevron is not decoration.** A touch screen has no hover, so without it
there is nothing on a phone saying the strip opens at all.

### On a phone

The strip was drawn for a width it does not always have, and #125 was the bill.
Three rules keep it honest on a narrow window:

- **The row shrinks rather than overflowing.** Without `min-width: 0` the flex
  items refuse to give, the head runs past its own padding, and the card's
  `overflow: hidden` cuts it. Measured at 390px, the cut is 9px at Obsidian's
  smaller UI font and 44px at its larger one, and it is the note count that
  goes: negative free space in a flex row packs the items left and spills the
  tail. **The dot is never cut**, which #125 and the PR that closed it both
  claimed off a screenshot before anybody measured it.
  [`scripts/spikes/status_bar_on_a_phone/`](../scripts/spikes/status_bar_on_a_phone/README.md)
  is where that was settled, and it fails against the stylesheet as it stood.
- **The head carries a count and not a name.** It used to carry both, in two
  spans, so the name could give way first on a narrow window. The name is on the
  Cloud vault row directly above now, so the head has one thing at its far end
  and nothing to choose between.
- **Hover only where there is a pointer.** On iOS `:hover` sticks after the tap
  and the head sat shaded, reading as jammed down.

Two things about the mobile screen are not ours to fix and are worth knowing
anyway. Obsidian stacks `setting-item` into a column, so *Sign out* and *Unlink*
render as full width pills: the two loudest controls on the screen are both
undos, which is the reverse of the weight they have on a desktop. And the host
line, muted grey under the sheet title with a back arrow above it, sits exactly
where a browser puts an address. It stays, because a beta build talks somewhere
other than a release does, but that is the frame it is read in.

## The words

Nine, from `src/syncStatus.ts`, and no screen invents a tenth. That file is the
list. It used to mirror a `status.py` in the admin repository, and that file went
with the rebuild, so there is nothing on the other side to keep in step with
today.

| Word | Dot | The instruction under it |
|---|---|---|
| **Initializing** | accent | The first sync brings the whole vault over, and it takes a while. Leave Obsidian open until it finishes. |
| **Syncing** | accent | Leave Obsidian open until it finishes. It picks up where it left off if you close it. |
| **Uploading** | accent | the same sentence |
| **Downloading** | accent | the same sentence |
| **Up to date** | green | none |
| **Paused** | yellow | Nothing is moving while this device is paused. |
| **Offline** | yellow | Your changes are saved here and go up when the connection is back. |
| **Signed out** | red | Your notes are all still on this device. Sign in again to carry on. |
| **Problem** | red | Everything else is up to date, and nothing was lost. |

The order they are decided in is the argument: no account beats everything,
because nothing else is even attempted without one. Paused beats the rest
because the person did it on purpose. **Offline beats Problem**, because a device
with no connection has everything stuck, and blaming the notes for what the
tunnel did sends somebody looking in the wrong place.

**Two words share each of the two unhappy dots**, and that is what having both
carriers is for. Yellow is wait: Paused and Offline both resolve with nobody
doing anything. Red is act: Signed out and Problem both need a person.

Offline and Problem were added on 2026-09-01, because four words could not say
that something was wrong and Signed out held the only error dot, so a refused
upload had to present itself as a missing account. **The rule for adding a
seventh was that a word earns its place when the reader's next move is
different**, and Uploading and Downloading broke it on 2026-09-01 (ADR-0089,
which supersedes ADR-0088 on this one point). They mean the same move as
Syncing, which is wait. What they add is whose work is in flight: your own
notes going up, or somebody else's arriving. Somebody watching a first sync for
an hour wants to know which of the two it is, and the three moving words are
chosen off the same two gauges the numbers come from. A vault moving both ways
at once is Syncing, and so is one whose queue cannot say which way it is going,
because a word that guesses is worse than the general one.

**Initializing came on 2026-09-02 (ADR-0090)**, and it passes the older,
stricter test rather than the one ADR-0089 loosened. Under Syncing a person may
close the laptop, and the sentence under it says so. Under Initializing they may
not yet: this is the first pass over a vault that has just been linked, and the
whole of it is still on its way. It beats the three direction words for as long
as it lasts, because a first sync is usually both directions at once and which
way it is going is the least interesting thing about it. It clears the first
time the vault falls quiet, and that is written into the settings, so quitting
Obsidian in the middle of a first sync comes back to Initializing rather than to
Syncing over a vault that is still half here.

Counts are one phrasing: *412 of 1,202* once something has counted the far side,
*412 notes so far* while the first pass is still discovering how much there is.
Inventing the second number would be worse than not saying it.

### The corner of the window

The same reading, drawn small: the icon wears the dot, the count sits beside it,
and a two pixel bar follows while there is a denominator to draw it against. The
word itself is in the tooltip rather than on screen, because the corner is read
out of the side of the eye during a first sync and what is wanted there is how
far along, not a sentence.

**The word carries the direction, and so do two numbers.** Three things move notes: notes
going up to the cloud vault, notes coming down to this device, and edits to a
note both sides already have. The first two are countable and answer different
questions, so they are counted apart, `↑ 412 ↓ 2,567`, either alone when the
other is zero. Attachments travel the same two roads and are added into the same
two numbers here; the settings screen behind this is where they are named
separately. Edits are not counted at all, in either place.

**And the corner is two seconds behind the vault, deliberately.** Saving a note
pushes its document, which used to flip the icon, grow a count and draw a bar,
all inside a second, every time anybody typed. So nothing is said until the
vault has been moving for two seconds, and Up to date is held for two seconds
after it stops. **Problem, Offline and Signed out are never held back**: the
delay is for the state a person waits out, not the ones they act on. ADR-0088.

It reads `readVaultStatus()` in `main.ts`, which returns the Knap client's own
`status()` whenever there is one. **The corner and the settings screen cannot
word one vault two ways**, which is the whole reason it is read there and not
computed beside the icon. The bar is absent rather than empty when nothing is
moving: an empty track beside a finished vault reads as work that never started.

**Clicking it opens the settings screen, and that is all it does.** There was a
menu behind it with Sync vault and Sync this file above Settings. Sync is not a
thing a person asks for here: it is running or it is not, and the corner already
says which. A button that tells it to do what it does anyway asks somebody to
make a decision and hands them no outcome for it, and the one time it would have
mattered, a vault that is stuck, pressing it changes nothing either.

## Choosing a cloud vault

A suggest modal, and the list is fetched every time it opens. That is the whole
answer to the gap between two windows: somebody who has just made a cloud vault
in the browser closes the picker, opens it again, and it is there. No refresh
button, no polling, and no message telling them to reopen it.

```
  ┌ Search cloud vaults... ───────────────────────────────┐
  │ Work notes                                            │
  │ Tuinplannen                                           │
  │ New cloud vault                 opens Knap in browser │  ← always last,
  └───────────────────────────────────────────────────────┘     survives every query
```

The state of the fetch goes in the placeholder (*Asking Pantalytics...*, *Could not
reach Pantalytics. Your notes are safe here.*), never into the list, so there is never
a row somebody can select that is not a thing they can choose.

**The way out is in the list rather than beside it**, because it answers the same
question. A person with no cloud vaults used to be told to go and make one in the
panel and then left in Obsidian with nothing to press. It sits last, under
everything real, and it survives every query: somebody typing the name of a vault
that does not exist yet is exactly the person who needs it.

Each row is the vault's name and nothing else. There is one kind of person in a
vault, so there is no access level to qualify it with.

## Linking, while it happens

Pressing a vault in the picker used to do this: the picker closed, the screen
behind it did not change, and somewhere between one second and four minutes
later a notice said *Linked*. It was not hung. The reconciliation was running,
and linking did not resolve until the whole of it had, so the only reading
available to a person was that the button had not worked.

So the link reports itself, eight steps, in `src/knap/linkSteps.ts`:

```
  ┌ Linking to Work notes ────────────────────────────────┐
  │ ✓ Connecting                                          │
  │ ✓ Notes in the cloud vault                      1,204 │
  │ ✓ Attachments in the cloud vault                   88 │
  │ ✓ Notes on this device                          1,190 │
  │ ✓ Attachments on this device                       80 │
  │ ✓ To download                  14 notes, 8 attachments│
  │ ⟳ To upload                                           │
  │   Linked                                              │
  └───────────────────────────────────────────────────────┘
```

**The two rows near the end are what the modal is for.** Everything above them
is how they were arrived at, and *To download* and *To upload* are the answer to
how long the next part is going to take. They say *Nothing* rather than *0*,
because a zero in a column of counts reads as a number rather than as an answer.

The work does not happen in quite that order. The local counts are taken before
the first socket opens, because they ride along on it, and the cloud counts
cannot be read until the tree has synced. Every number is true at the moment its
step is reported, and the far side is read first because it is the side a person
cannot see.

**Under the heading, one sentence**: deleting a note here deletes it in the
cloud vault too, and the other way round. It sat on the Cloud vault row in
Settings until 2026-09-02 (#116), which is a row somebody reads every week about
a decision they took once. This is the screen that takes it.

**It closes itself on the last step**, and the last step is said before the fill
rather than after it. That is the fix: the link exists once both bindings stand
over a synced tree, and what follows is the first sync, which the strip behind
has a word for. A modal held open over minutes of downloading would be a second
place saying the same thing, over a vault a person cannot use while it is up.

A step that fails stops the list where it stood, with that step marked and the
sentence under it. The modal stays, because a modal that vanished would leave
the failure to a notice in the corner over a screen that still says *Not linked*
and does not say why.

**One of the two move rows is always *Nothing*, because a link with notes on
both sides is refused.** The check runs on the four counts above it, at the last
moment nothing has been written, and it is the only thing those counts do
besides being read. ADR-0098: a cloud vault made in the panel takes what is on
this device, a vault somebody was added to comes down onto a device that has
nothing yet, and notes on both sides is somebody linking the wrong pair. The
refusal is a failure like any other, marked on the *To download* row, and it
names both counts, because what is in the cloud vault is the one thing a person
cannot see from here:

```
  ┌ Linking to Work notes ────────────────────────────────┐
  │ ✓ Notes in the cloud vault                        318 │
  │ ✓ Attachments in the cloud vault                    0 │
  │ ✓ Notes on this device                          1,204 │
  │ ✓ Attachments on this device                        7 │
  │ ✗ To download                                         │
  │                                                       │
  │ This device holds 1,204 notes, 7 attachments and Work │
  │ notes holds 318 notes. Linking two vaults that both   │
  │ hold notes would merge them, and there is no undo for │
  │ that, so it does not happen. Make a new cloud vault   │
  │ for the notes on this device, or open an empty local  │
  │ vault to take this cloud vault down.                  │
  │                                                       │
  │ Nothing was changed. Your notes are all still on this │
  │ device.                                               │
  └───────────────────────────────────────────────────────┘
```

The link is taken off again on the way out, so the screen behind reads *Not
linked* rather than pointing at a cloud vault this device never joined.

**Obsidian's own settings run the same arrow, and it is the one part of linking
that replaces something a person set up.** A cloud vault that already carries
settings is the source: its theme, hotkeys and plugins land on this device, and
nothing of this device's goes up. A cloud vault with none is seeded from here.
ADR-0099. Because it changes something nobody asked about in the picker, it is
said in a notice that stays until it is dismissed, names the vault, and says the
notes were not touched:

> This device now uses Work notes' settings: its theme, hotkeys and plugins.
> Your notes were not touched. Plugins that arrived start the next time you open
> Obsidian.

**Whether settings travel at all is the vault's, not this screen's.** The
switch is *Sync settings* on the vault's page in the Pantalytics panel, on by
default, and the plugin reads it from `/api/vaults` once per start
(odoo-mcp-pro-admin ADR-0102). Off, nothing of `.obsidian` goes up or comes
down, and the first settings pass above stays owed until it is turned on. An
answer the plugin cannot get reads as off: settings are last write wins
across everybody in the vault, so guessing on could push one device's theme
over everybody's.

## The commands

Four, all still labelled *(beta)*, which is a name that has outlived its
accuracy now that this is the only shipping path.

| Command | The same act as |
|---|---|
| Sign in (beta) | the Account row's button |
| Link this vault (beta) | Cloud vault, Choose |
| Sign out (beta) | the Account row's button |
| Unlink from the cloud vault (beta) | Cloud vault, Unlink |

Both entry points share one implementation, so the palette and the screen cannot
drift into two accounts of the same act. `signOutNotice` exists for exactly that
reason.

## What a notice says

A notice is what this plugin has instead of a page, so each one says what
happened and what is now true.

| After | It says |
|---|---|
| Signing in | Signed in. Now link this vault. |
| Linking | Linked. This vault now syncs with *name*. Leave Obsidian open while it fills up. |
| Unlinking | Unlinked. Nothing was deleted, anywhere. |
| Signing out | Signed out. Nothing was deleted, anywhere. |
| Signing out with no connection | Signed out here only. Knap could not be reached, so it may still count this device as signed in. |
| A file too large | *path*: This file is 24 MB, and the cloud vault takes attachments up to 10 MB. It stays on this device. Both numbers, because *too large* leaves somebody guessing by how much. Refused here rather than uploaded and refused there, so nobody spends their upstream first |
| A vault that is full | *path*: The cloud vault is full. Remove some attachments from it, or use a second vault. |
| A sign-in that started elsewhere | That sign-in did not start here. Run sign in (beta) and try again. |
| A link that cannot come back up | Knap could not bring your cloud vault up. Your notes are safe here; open Settings and press Try again. A server that is merely away is not this: the start waits for it and the status says Offline. |

Two shapes to copy. **Say what is still true**, because the fear behind most of
these is losing notes: *nothing was deleted, anywhere*, *your notes are safe
here*, *it stays on this device*. And **never claim what was not measured**: the
sign-out that could not reach the server says so rather than reporting success.

## The look

**Everything is Obsidian's, not ours.** The colours are the vault's theme
variables and the accent is whichever one the person picked, because a settings
tab that looks like our website is the one tab in the list that looks wrong.
Ours is how short the sentences are, not what colour they sit on.

The classes are in `styles.css` under `.knap-`: the host line, the vault block,
the strip and its fold, the four dots, the picker's way out. All of them are built from
`--background-*`, `--text-*`, `--size-*` and `--color-green|yellow|red`.

## The words a person sees

The admin repo's `docs/nomenclature.md` carries the same table, because somebody
moves between the two applications in one sitting and matching up two
vocabularies is not their job.

| On screen | What it means |
|---|---|
| **Vault** | This Obsidian vault. **Cloud vault** is the one on Knap, and *local vault* is this one when both halves are in view |
| **Folder** | A folder inside the vault. It syncs because the vault does, so it is never a thing to turn on |
| **Sync** | What happens between them |
| **Link** and **Unlink** | The relationship, and ending it. Unlink stops the syncing and deletes nothing, which is what tells it apart from deleting a vault |
| **Account**, **Sign in**, **Sign out** | Who, and the two ends of it |

| Not on screen | Say instead |
|---|---|
| share, workspace, space | folder |
| relay, control plane, server, a hostname | Knap, or the cloud vault. The one exception is the host line at the top of the tab, which is there because a beta build talks somewhere other than a release does, and it sits nowhere near a button because it is not a choice |
| client | device |
| pair, pairing code, token | **Sign in** |
| viewer, editor, owner, role | nothing. There is one kind of person in a vault |
| remote vault | cloud vault |

*Relay* is upstream's word for their product and their server, and neither is
something a person using this plugin has to know about.

**Upstream's own screens still say all of it, and they are left that way.**
`Relays.svelte`, `ManageRelay.svelte`, `ManageSharedFolder.svelte` and
`ManageRemoteFolder.svelte`, and every folder picker reached from them, render
only in a world this build does not have. Renaming a file we rebase from
upstream costs every future rebase to buy a word nobody reads. **A picker that
turns up on a screen we do render is a bug**, and that is the check to run before
believing they are gone.

## Changing any of this

- The screen is `src/knap/KnapSettingsTab.ts`. `statusFacts`, `hasFold` and `hasRetry` are
  exported and pure precisely so the branching is pinned in
  `__tests__/knap/settingsTab.test.ts` rather than asserted against a screen.
- The words are `src/syncStatus.ts`, and adding one means the rule above.
- The picker is `ObsidianKnap.ts`; `vaultChoices` and `pickerPlaceholder` are
  exported for the same reason.
- Run the `humanizer` skill over any sentence a person reads before it ships,
  and keep em-dashes out of it.
