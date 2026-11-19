# Documentation

| You want to know | Read |
| --- | --- |
| What the product is and promises | [`product.md`](product.md) |
| Why something is the way it is | [`decisions/`](decisions/README.md) |
| What the runtime provides and what we still need from it | [`design/runtime-layer.md`](design/runtime-layer.md) |
| Who owns which state, the host contract, error slots | [`design/host-layer.md`](design/host-layer.md) |
| What the person sees and can do | [`design/ui-layer.md`](design/ui-layer.md) |
| How to report a problem or send a change | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
| How releases and channels work | [`../packaging/launcher/RELEASE-CHANNELS.md`](../packaging/launcher/RELEASE-CHANNELS.md) |

Rules for these documents:

- One place per fact. If two documents disagree, the newer decision record wins and
  the other document is fixed in its own commit.
- Documents describe how things are meant to be. Known bugs belong in issues, not in
  the design documents.
- A design or decision change is never in the same commit as the code it judges.
