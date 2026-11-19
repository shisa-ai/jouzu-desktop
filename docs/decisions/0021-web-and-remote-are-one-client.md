# 0021 — Web and remote are one client

Status: Accepted
Date: 2026-11-14

## Context

[0009](0009-ui-platform-api.md) introduced separate `WebApi` and `RemoteApi`
implementations. They differ only in scope and pairing; keeping two classes invites
two behaviours.

## Decision

- Web and remote access are one client: the same UI, the same `/v1` HTTP and SSE.
  Only the listening scope (loopback, LAN, tailnet) and pairing differ.
- Remote access ([0008](0008-remote-access.md)) is built on that client, not as a
  separate product path.

## Does not mean

- Native-only actions are still unavailable to a browser client and say so.
