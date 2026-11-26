# 0028 — The agent's tools run at a permission level the host owns

Status: Proposed (this pull request; merging accepts it). Windows first; macOS and Linux
follow in their own records once their platform support (#183) is in.
Date: 2026-11-25

## Context

The agent's tools run with everything the person can do. A shell command can write
anywhere in the person's profile, change the Desktop installation, its runtime and its
extensions, edit the data home (sessions, settings, credentials) and reach any network
address. A prompt injection or a plain mistake has the same reach. #197 asks for
operating-system isolation of the agent by default.

The runtime already has one protection of its own, TextGuard (a check on content, with
read-only status published by jouzu#72). It does not stop a command from doing what the
command does; that needs a boundary enforced by the operating system.

The runtime's public extension API lets an extension register a tool under the name of a
built-in one (`bash`, `powershell`, `write`, `edit`, …) and replace how it executes. Desktop
already ships its own extensions this way. So the boundary can be drawn around the tools
alone, with no change to the runtime: the agent process and its
model calls stay outside, only what the tools execute is inside.

## Decision

**Four permission levels.** The person picks one; a new session starts at **Workspace**.
The first three run the tools inside the sandbox with different settings; the fourth
turns it off.

| | Read-only | Workspace (default) | Unattended | Full access |
|---|---|---|---|---|
| Writes | None (own temporary folder only) | Workspace and own temporary folder, minus protected locations | As Workspace | Unrestricted |
| Reads | Whole machine; secrets masked before they reach the model | As Read-only | As Read-only | Unrestricted |
| Command network | Off | A list of common development domains; others ask | As Workspace | Unrestricted |
| Crossing the boundary | Asks the person; approval grants what the request names (a folder, a domain) to that one invocation and does not change the level | Asks the person: grant the named folder or domain to that one invocation, or to this session | Never asks: refused, the reason goes to the model and is recorded in the session | No boundary |
| Tools covered | Commands in the sandbox; file tools checked against the same boundary | As Read-only | As Read-only | None |
| Sandbox unavailable | Every command asks first and, if approved, runs without the sandbox (the question says so); reading files still works | Commands and file changes refused; reading files still works | As Workspace | Not affected |
| The person sees | Level name and "changes no files without your approval" | Level name, workspace path, network scope | Level name and the count of refusals, with details | A prominent risk marker, always visible |
| Switching to it | Any time; applies from the next tool call | Any time; the default for new sessions | Any time; switching away lists what was refused meanwhile | Confirmed against the risk every time; never remembered as the default |

In every case where the sandbox is unavailable, the person is told why and how to fix it.
Nothing runs unprotected without the person's knowledge. Workspace and Unattended refuse
rather than asking on every command; the way out is an explicit switch to Full access.

**Rules shared by all levels.**

- Protected locations are never writable (except by a command the person approves in
  Read-only while the sandbox is unavailable, which the question states): the installation, the data home, and anything in
  the workspace that runs outside the sandbox later (git hooks and git configuration such as
  `.git/hooks`, `.git/config` and `.gitattributes`, and the runtime's own extension and
  settings folders). Only Full access lifts this; approving a boundary crossing never does.
- Reading is safe rather than blocked. Commands may read credentials (`~/.ssh`, cloud
  credentials) so that ordinary work such as `git push` keeps working. What the agent's
  tools return is screened on the machine before it goes to the model: secrets in it (keys,
  tokens, credential files) are masked. This is best-effort protection against secrets
  reaching the model by accident. It does not stop a command that deliberately sends a
  readable secret to an allowed domain, or encodes it first; that is a known limit of
  readable credentials, stated rather than implied away. Which layer owns the screening, and how it relates to TextGuard's
  content check in the runtime, is settled before it is built and recorded then; it is not
  a second, unrelated content check.
- Only a person approves, in the UI. Neither the agent nor a model approves anything, and
  no path lets the agent change the level or its approvals. This includes the host's own
  API: a call from inside the sandbox is refused (the host authenticates its callers and the
  sandbox cannot reach it), so a command cannot raise its own level.
- A question shows the literal request: the exact command, the absolute path, the domain.
  It never shows a description written by the model in place of the request.
- A level change applies from the next tool call. Processes already running keep the level
  they started with until they end.
- An approval grants exactly the folder or domain the request names, to that invocation and
  the processes it starts (or to the session, if chosen), and nothing else. It never runs a
  command unrestricted, and protected locations stay denied. If the backend cannot express
  the grant, the request is refused, not run without the sandbox.
- Grants are isolated per session: a folder or domain approved in one session is not usable
  from another, including an Unattended one. After a crash, leftover grants are removed
  before any sandboxed command runs again.
- Every process a tool starts belongs to its session (on Windows, the session runtime's
  job) and ends with it. An approval "for the rest of the session" is both a record in the
  host and an operating-system grant; when the session ends both are removed, and the host
  removes any grant left by a crash when it starts again. A record expiring is not enough;
  the access itself is revoked.
- MCP servers run outside the sandbox. Each server's tool calls are asked about unless the
  person has chosen to allow that server; asking is the default. In Unattended, calls to a
  server that is not allowed are refused and recorded, never left waiting. The person sees which
  servers are allowed. The prototype confirms that the runtime lets Desktop ask before an
  MCP call; if it does not, that is raised with the runtime.
- TextGuard is a separate setting with its own owner (the runtime) and does not change
  with the level.

**Who owns it.** The host ([0014](0014-three-layers-single-owner.md)). The host owns the
level, the session's approvals and whether the sandbox is available, and reports them in
its views. It hands the configuration for the current level to Desktop's extension and the
sandbox backend; neither keeps it as its own state, and it is never read from a file the
agent can write. The UI shows the level and requests a change; it does not hold the level.

**Where it plugs in.** The runtime is not changed. Desktop's extension uses the runtime's
public tool-override API, the only integration point that needs no runtime change. Every
tool the runtime gives the agent that runs a command or touches the filesystem (shells,
`read`, `write`, `edit`, search and listing tools, and any background or delegated
execution) is listed from the runtime's actual tools and covered:

- Commands (shells and any background or delegated execution) run under the sandbox
  identity.
- File tools run as before. `write` and `edit` are checked against the writable folders
  and protected locations, using the real path with junctions and links resolved, not the
  path as given. Reading tools are not restricted; their results are screened like every
  tool's. Reading keeps working when the sandbox is unavailable, because it cannot change
  anything.

A boundary question is asked through the runtime's extension UI request and relayed by the
host to the UI.

- Precondition: Desktop's tools cannot be replaced by another extension. If one could, the
  boundary would silently disappear. The prototype proves it; if the runtime cannot
  guarantee it, it is raised with the runtime as a requirement, and until then the host
  reports the level as not enforced.
- Anything else the API cannot guarantee is a runtime gap
  ([0015](0015-runtime-facts-relayed-not-reinterpreted.md)), recorded and raised, not worked
  around.

**Windows backend.** One backend serves the three sandboxed levels with different
configuration, so the prototype validates all four levels on it rather than one level
first. Candidate mechanisms: a separate sandbox user with a write-restricted token, file
ACLs and outbound filtering (needs an administrator once at install), and a
write-restricted token with a Desktop-owned SID and folder ACLs. The second runs as the
person, so it restricts writes only: reads and network stay the person's. It can serve the
levels' write column but not their read and network columns; those need a separate user and
outbound filtering. The choice is made on these requirements and recorded with its evidence:

- Git, npm, Node and Python work inside, in PowerShell and in Git Bash (each a hypothesis
  until shown).
- Commands writing outside the boundary are refused by the operating system, not by a
  check in the extension.
- Grants made on the person's folders are recorded and removed on uninstall.
- Grants are per session (two sessions running at once cannot use each other's), and are
  gone after the session ends and after a crash and restart.
- A sandboxed process cannot obtain the host's or the person's authority through other
  processes: inherited handles, opening other processes, local IPC, or window messages on
  the person's desktop.
- Junction, symbolic-link and hard-link escapes are refused, for commands and file tools
  alike, and are part of the prototype's tests, including a junction swapped in while a
  file tool runs and a hard link to a protected file created beforehand. If a file tool's
  check is shown to be escapable, the file tool's change is moved under the sandbox
  identity.
- The cost per command is measured on real machines and does not slow a session noticeably.

## Does not mean

- It does not sandbox the runtime process, the model calls, MCP servers or third-party
  extensions. They run outside the boundary. MCP calls are asked about (above); a
  third-party extension that adds a tool able to write or run commands makes the level
  unenforced for that tool, and the host shows that beside the level rather than implying
  a guarantee.
- It is not a list of blocked paths or commands patched one by one. A gap found later is
  fixed by moving the boundary, not by adding a special case.
- It does not tie TextGuard to the levels or merge their state. Flow is run control, not
  permissions, and keeps its own panel.
- It does not fix the shell. PowerShell and Git Bash are both tried inside the sandbox;
  whichever works is used.
- It does not change readiness: the sandbox is applied per tool call, so a new session is
  still ready at once ([0016](0016-new-session-ready-at-once.md)). The cost per command is
  measured, not assumed.
- It does not let a model review boundary crossings, and it has no "ask every step" level:
  with the sandbox in place that only adds interruptions; Read-only is the careful choice.
- The concrete lists of development domains and protected locations, and what counts as a
  secret to mask, do not exist yet. They come with the prototype, derived from what the tools and the
  runtime actually use, and are then kept in [`../design/host-layer.md`](../design/host-layer.md);
  changing them does not need a new record.
- The Windows mechanism is a hypothesis until the prototype confirms it. If it fails, this
  record is revised before anything is built on it.
