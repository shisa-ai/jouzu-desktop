# 0008 — Remote access: LAN and Tailscale first, public deferred

> Migrated on 2026-11-19 from the former planning repository, unchanged except for
> this note and the status line. Links to `spec/`, `contracts/` and `tasks/` point to
> drafts that were not migrated; the current design is in [`../design/`](../design/).

Status: Implemented (Settings → Web access: loopback, LAN and Tailscale scopes with pairing;
public scope still refused). Amended by [0021](0021-web-and-remote-are-one-client.md).
Date: 2026-10-30
Related: ADR 0007, ADR 0009, ADR 0010, `spec/03-host.md`,
`tasks/0085-remote-access.md`

## Context

ADR 0007 makes the host serve the UI and API/SSE, so the desktop and a remote
device are the same client. Remote access is required, but **public exposure is
not in the first version**. The controlled scopes are:

- **LAN** — devices on the same network;
- **Tailscale** — devices on the user's tailnet (WireGuard, private overlay).

Public access (cloudflared quick tunnel, named tunnel with our domain, or an own
relay) is designed for but **not shipped** until the security review is done.

## Reference: DSH Desktop

DSH's **web CLI** requires `--public-url` and a proxy; its **Desktop** app is
different: `data/remote/bin/cloudflared.exe` (55 MB) plus `data/remote/access.json`
with `tunnel.mode = "quick"` and a `*.trycloudflare.com` hostname, link token,
pairing code and QR. That is the public path we reserve, not the v1 path.

## Decision

Remote access is **pairing-first** and **controlled-scope** in v1.

### LAN

- One toggle: "Allow devices on this network".
- Bind one concrete LAN interface (user can change it); no wildcard bind.
- Show a **QR + short pairing code**; the desktop approves the device.
- Plain HTTP on the LAN is warned; TLS is optional later.

### Tailscale

- Detect a Tailscale interface/IP (100.64.0.0/10; MagicDNS name when available)
  and show "Allow devices on Tailscale" **only when detected**.
- Bind that one address (not `0.0.0.0`); the tailnet carries WireGuard encryption,
  so the hop is encrypted and there is no public edge.
- Pairing and device tokens are still required; Tailscale ACLs are
  defense-in-depth, not the auth.
- If the Tailscale IP changes, rebind and refresh the QR.

### Deferred public path (reserved, not implemented)

- Listener configuration accepts a scope `loopback | lan | tailnet | public`;
  `public` is rejected until implemented.
- The tunnel provider interface exists but has no public implementation; adding
  one must not change the UI or auth contracts.
- Candidate transports, in order of evaluation: bundled cloudflared quick tunnel
  (the DSH Desktop approach) for testing, named tunnel with our domain for a
  stable URL, own relay or application-level E2E if privacy requires it.
- No public toggle is shown before the security review.

### Pairing and sessions

- Pairing: short-lived code (minutes), single use, bound to the device's public
  key; the desktop shows the requesting device (name, platform, network) before
  approval.
- After pairing: a device token (rotatable, revocable) authenticates HTTP and
  SSE; browsers derive an `HttpOnly` cookie from it.
- Device list: name, platform, last seen, sessions, **Revoke** — revoking
  invalidates the token and closes its streams immediately.
- Host/Origin fence accepts the bind address and explicitly paired origins; a
  valid token from an unknown origin is still rejected.
- Remote off by default; only the host can stop a session.

### UX (Settings → Remote)

```text
Remote access
  [ ] Allow devices on this network     -> QR, pairing code, LAN address
  [ ] Allow devices on Tailscale         -> shown only when Tailscale is detected
  Devices: phone · last seen 2m · [Revoke]
  [Stop remote access]

  Public access                          -> not available yet (security review)
```

- LAN and Tailscale are one action each; both off by default.
- The panel shows listening address, plain-HTTP warning, and connected devices.
- Native-only features (file pickers, reveal, tray, updater) are explicitly
  unavailable to remote clients or mapped to host endpoints; no pretend UI.

## Consequences

Positive: no public surface in v1; LAN covers the same room, Tailscale covers
remote devices without a third-party edge; the auth and pairing model is the
same one a future public transport will use.

Negative: Tailscale requires the user to install/configure Tailscale (detected,
not bundled); public access waits; device key storage on mobile browsers needs a
decision.

## Alternatives

- Public cloudflared quick tunnel in v1: rejected for now — public exposure and a
  third-party edge need a security review first.
- A user-run reverse proxy: not a product path.
- LAN only: insufficient for remote devices; Tailscale covers it without public
  exposure.

## Migration

1. Host serves SPA + API/SSE; desktop loads it (spec 03–05).
2. Pairing + device tokens + Host/Origin; loopback only.
3. LAN toggle + QR + device list.
4. Tailscale detection + bind + QR.
5. Later: public transport behind the reserved provider interface, after review.

## Open questions

- Tailscale detection details (interface name, MagicDNS, IP change) across
  Windows/macOS.
- LAN TLS: required or optional?
- Device key storage in mobile browsers (WebCrypto/passkey).
- Public transport choice and the privacy statement (Cloudflare edge vs own
  relay vs E2E) — deferred with the public scope.
