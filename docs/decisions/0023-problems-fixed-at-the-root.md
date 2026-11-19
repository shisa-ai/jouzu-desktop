# 0023 — Problems are recorded, then fixed at the root

Status: Accepted
Date: 2026-11-15 (filing clarified 2026-11-18)

## Context

Fixes patched visible symptoms (text matching, extra waits, hidden controls) and new
bugs followed from each patch. At times problems found in testing were fixed without
a record, and at other times not recorded at all.

## Decision

- Every real problem found is filed as an issue promptly, after searching for an
  existing one: symptom, version it appeared in, evidence, and severity.
- Before code, the fix states the root cause and where it sits in the system: which
  layer and which state owner ([0014](0014-three-layers-single-owner.md)). A problem
  that belongs to the runtime is recorded as a runtime gap
  ([0015](0015-runtime-facts-relayed-not-reinterpreted.md)).
- No temporary patches. A fix that only hides the symptom is not a fix.
- An issue is closed only with evidence: the commit, the released version it shipped
  in, and a release check that covers it.
- Everything on GitHub is in English.

## Does not mean

- No ritual issue per pull request: a pull request is a coherent change and refers to
  the issues it addresses.
- Old issues are not deferred silently: every pure-desktop bug is in scope until it
  is fixed or explicitly moved, with a reason.
- An issue is assigned only when someone has started on it.
