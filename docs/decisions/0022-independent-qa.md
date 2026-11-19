# 0022 — QA is independent of development

Status: Accepted; not set up yet.
Date: 2026-11-19

## Context

When the same people (or agents) write the code and the acceptance checks, the
checks drift toward the code: scenarios get narrowed, timers start later, and
regressions are found late.

## Decision

- QA tests only public builds, the way an outside user gets them: download, install,
  run the normal and abnormal-path scenarios, look at the screens, and file issues.
- QA does not fix code. Development does not change QA's scenarios, thresholds or
  baselines.
- QA's exam scripts, thresholds and baselines live outside this repository, owned by
  QA, and change only with the maintainers' approval.
- QA files issues like any user: version found in, steps, evidence, no labels or
  assignee. Maintainers judge severity and scope.
- QA runs one worker per test machine with the same entry point, so more machines can
  be added without changing the process.

## Does not mean

- Development still runs its own fast tests (see [0019](0019-development-and-release-gates.md)).
- Product requirements stay in this repository; QA reads them at the tested
  version's tag and judges against them.
