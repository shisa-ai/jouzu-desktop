# 0019 — Development checks are fast; release checks judge the installed product

Status: Accepted
Date: 2026-11-15 (user-visible timing 2026-11-18, error paths 2026-11-18)

## Context

Every pull request ran the full suite serially (about 19 minutes), which slowed
development. At the same time, release acceptance had been narrowed step by step to
"what the host controls": timings started at Send, a wait for Send to become usable
was dropped as noise, and checks were loosened in the same commit as code. 1.1.3-rc.3
passed its playbook while new-session-to-reply had regressed by seconds. Refines the
gate list of [0006](0006-desktop-release-gates.md).

## Decision

- **Development checks** (every push): fast, path-filtered and cached — typecheck,
  unit tests, host and shell tests, audit when lock files change. Release builds,
  mocked UI end-to-end tests and installers run before a release, not on every push.
- **Release checks** run on the installed package, as a user would get it, with an
  isolated data directory:
  - normal paths and abnormal paths (provider errors, runtime exit, slow start,
    unwritable settings, Stop at awkward moments), in every shipped language;
  - timings measured from the person's action (click New session, open a session):
    model shown, Send usable, own message visible, first reply visible;
  - a look at the screens as a user: nothing shifts, nothing is shown twice, no
    endless spinner, words are plain and localized.
- A stable release requires the full release checks on every platform with real
  models. A QA release does not require them.
- Thresholds and scenarios are never changed in the same commit as the code they
  judge. Failure evidence is kept, not overwritten by a later passing run.
- Host-internal numbers are diagnostics, never the pass criterion.

## Does not mean

- Timing runs never block a development pull request.
- Comparing with earlier releases is a reference, not the bar: a build is judged on
  its own against the product promises and design docs.
- A busy machine (other programs running) is a valid test condition; tests never
  close a person's other programs to improve numbers.
