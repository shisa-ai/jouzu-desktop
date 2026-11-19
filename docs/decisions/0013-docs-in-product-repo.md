# 0013 — Decisions and design live in the product repository

Status: Accepted
Date: 2026-11-19

## Context

Decisions, specs and task notes were kept in a separate planning repository. It
stopped being updated on 2026-11-13, while the code moved on to the three-layer
design (`docs/design/`). Decisions also piled up in working notes outside any
repository. Nobody could tell which version was current, and rules were forgotten
or applied in the wrong direction.

## Decision

- This repository is the only place for product decisions and design:
  - `docs/product.md` — what the product is and promises;
  - `docs/design/` — how each layer works today;
  - `docs/decisions/` — one short record per decision, numbered, never rewritten;
    a changed decision gets a new record and the old one's status points to it.
- Each record states what the decision does **not** mean, so a correction is not
  later applied too broadly.
- A design or decision change is its own commit, never the commit that changes the
  code it judges (see [0014](0014-three-layers-single-owner.md)).
- The planning repository is archived. Its task logs and run reports stay there as
  history; only the ADRs (0001–0012) and still-valid product requirements moved here.
- Acceptance assets (exam scripts, thresholds, baselines) belong to QA, not to this
  repository (see [0022](0022-independent-qa.md)).

## Does not mean

- Not every discussion needs a record. A record is for a choice someone would
  otherwise have to ask about again.
- Not a review ceremony: a record is written when the decision is made.
