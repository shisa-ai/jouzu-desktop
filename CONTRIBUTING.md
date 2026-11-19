# Contributing to Jouzu Desktop

Thanks for your interest in improving Jouzu Desktop. Bug reports, fixes and improvements are
welcome. Everyone taking part is expected to follow our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

Read [`docs/README.md`](docs/README.md): what the product promises, the decisions behind it,
and how the runtime, host and UI layers divide the work.

## Reporting a problem

Open a [GitHub issue](https://github.com/shisa-ai/jouzu-desktop/issues). Include the app
version, your operating system, the steps to reproduce, what you expected and what happened,
and the relevant part of `logs/` if there is one. **Settings → System → Report a problem** in
the app opens the issue page. Never paste API keys or other credentials.

## Pull requests

- **Target `develop`.** `main` holds released code only.
- **Start from an issue.** Link the issue the pull request fixes. For a larger change, discuss
  it in the issue before writing code.
- **Explain the root cause.** Say why the problem happens, which layer and which state owner
  it sits in ([`docs/design/`](docs/design/)), and how the change addresses it. A change that
  only hides the symptom is not accepted ([0023](docs/decisions/0023-problems-fixed-at-the-root.md)).
- **Respect the layers.** The UI renders host state, the host relays runtime facts, and
  neither works around something the runtime lacks ([0014](docs/decisions/0014-three-layers-single-owner.md),
  [0015](docs/decisions/0015-runtime-facts-relayed-not-reinterpreted.md)).
- **Keep it focused.** One coherent change per pull request; it may address several related
  issues. Unrelated cleanups go in their own.
- **Keep design and checks separate from code.** Changes to `docs/design/`, `docs/decisions/`
  or acceptance thresholds go in their own commit, never in the commit that changes the code
  they judge.
- **Follow the existing code.** Reuse the existing components and patterns.
- **Add a test.** A fix comes with a test that fails before the change and passes after it.
  UI specs in `apps/desktop/e2e/` run against a stubbed host; follow an existing spec.
- **Write in English** for code, comments, commit messages, issues and pull requests.

Changes to CI workflows, dependencies, or build and release tooling should be discussed in an
issue first.

If a pull request was produced with an AI tool, please mention it in the description.

## Development

See [README.md](README.md#development) for how to build the app and run the tests. The CI
checks (`desktop-checks.yml`) must pass before a pull request is merged.

## License

By contributing, you agree that your contributions are licensed under the
[Apache-2.0 License](LICENSE).
