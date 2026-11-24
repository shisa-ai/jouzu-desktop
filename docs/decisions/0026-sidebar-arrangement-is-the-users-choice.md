# 0026 — The sidebar's grouping, order and filter are the user's choice

Status: Accepted
Date: 2026-11-24

## Context

The sidebar header already has its controls: search, an archive toggle, a sort toggle
and add folder. Each toggle carries two states, and grouping has no control at all:

- Archive: hide or show, and the button only appears once something is archived. There
  is no "archived only".
- Sort: most recent or by name. There is no manual order, and the icon does not say
  which of the two is active.
- Grouping: fixed at one group per workspace.
- The list cannot be reordered by hand.

So the controls exist; what is missing is the set of choices behind them.

Issue #19 reports that with many workspaces the default workspace scrolls out of view,
and its "Expected behaviour" asks for it to be pinned. Three changes implemented that:
`c8b3d6b` (2026-11-09, "Fixes #19"), PR #225 (2026-11-22) and PR #245 (2026-11-24).
`6063028` (2026-11-11) removed the pinned block two days after `c8b3d6b` — "it is one
more group at the bottom of the same list, as the list always showed it" — and #225 was
closed unmerged: "pinning the default workspace to the bottom of the sidebar is a design
change that was never approved … we don't think the default workspace should be pinned."
#19 stays open until its behaviour is decided.

Pinning answers the report by hardcoding a second rule about one folder. The problem
behind the report is general: with many workspaces, which ones are in view, and in what
order, is the user's call.

## Decision

Each of the three settings becomes a menu on its control, with the full set of choices
and the active one marked. No new vocabulary, no second place to look:

- **Group by** — `Workspace`: one group per workspace (today's shape). `Workspace Tree`:
  workspaces nested by their folder path. `In one list`: sessions from every workspace in
  one list, each row naming its workspace. This is the one setting without a control
  today; it gets one beside the others.
- **Order by** — `Manual`: the user drags groups and sessions into the order they want,
  and the order is kept. `Last updated`: the most recently active first (today's shape).
  The sort icon opens this instead of flipping between two states.
- **Filter sessions** — `Hide archived` (default), `All conversations` (show archived),
  `Archived only`. The archive icon opens this instead of toggling; it stays hidden while
  nothing is archived and the filter is the default, as it is now.
- Defaults are today's behaviour: group by workspace, order by last updated, hide
  archived. A user who changes no setting sees no change.
- The arrangement is a client preference, kept with the sidebar's other preferences
  (collapsed groups, drafts), not host state.
- No workspace is special. The default workspace is one group among the others: no
  pinned block, no forced position, no promise that it is visible without scrolling. A
  user who wants it always at hand puts it there with manual order, or uses one list.
- #19's acceptance criterion ("the default workspace stays visible without scrolling")
  is withdrawn: the answer to "I cannot find it" is the arrangement the user chose, not
  a rule about one folder.

## Does not mean

- It does not pin the default workspace, and it does not add a per-workspace pin.
  Sessions keep their own pin.
- It does not remove the default workspace from the list, and it does not change where a
  new session goes when no folder is chosen.
- It does not move the arrangement into the host: two clients of the same data may
  arrange it differently.
- `Workspace Tree` groups what is already on disk; it does not create folders or move
  sessions.
- It does not decide how the UI learns which workspace is the default. It matches the
  folder name `default-workspace` today (`apps/desktop/src/chat-workspace.tsx:82`) while
  the host reports the path (`apps/desktop/host/src/lib.rs:1737`); that is a separate
  defect about identity, not about arrangement.
