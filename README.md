# n8n-nodes-saltapp

An n8n community node package for [Salt](https://saltapp.ai) -- an end-to-end
encrypted chat where humans and AI agents are the same kind of contact: each
has a handle, a PGP key and a wallet. This package lets an n8n workflow *be*
one side of a Salt agent: it receives that agent's messages/events and can
send messages, post cards, request payments and invoices, and pause a
workflow to ask a human a question in a real chat.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation)
[Custody -- read this first](#custody----read-this-first)
[Credentials](#credentials)
[Nodes](#nodes)
[Open rooms and interests](#open-rooms-and-interests)
[Ask a Human and Wait](#ask-a-human-and-wait)
[Examples](#examples)
[Compatibility](#compatibility)
[Resources](#resources)
[Version history](#version-history)

## Installation

Follow n8n's [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/):

- **Self-hosted n8n**: Settings > Community Nodes > Install, and enter
  `n8n-nodes-saltapp`.
- **n8n Cloud**: only nodes verified by n8n's Creator Portal can be installed
  from the panel today. See [HANDOFF.md](./HANDOFF.md) for this package's
  path to verification.

This package has **zero runtime npm dependencies** (see
[Custody](#custody----read-this-first) below for why that matters here
specifically, and [HANDOFF.md](./HANDOFF.md) for how) -- installing it pulls
in nothing beyond what n8n already ships.

## Custody -- read this first

An agent's Salt account is only as private as whoever holds its PGP private
key. This package's credential asks you to paste that key in directly.

**Whoever holds this key can read this agent's chats. On n8n Cloud, that
includes n8n.** If that custody boundary matters to you -- and for most
Salt agents handling real conversations or real money, it should -- **self-host
n8n** rather than using n8n Cloud for this credential. Rotate the agent's PGP
key (and its api-key) if this credential is ever exposed; both are best
generated fresh for an agent that will live in n8n, rather than reusing one
already deployed elsewhere.

## Credentials

**Salt App API** (`saltAppApi`):

| Field | What it is |
| --- | --- |
| Host | The salt-api host, default `https://saltapp.ai` |
| Agent ID | This agent's own Salt user id (informational + a sanity check; not required for any call to succeed) |
| API Key | The agent's api-key. Sent as the `api-key` header on every request. |
| Agent PGP Private Key | The agent's armored private key. **This is the key from the custody section above.** |
| PGP Passphrase | The passphrase that key was generated with |

There is deliberately **no static "webhook signing secret" field**. Salt's
own reference SDK (`salt-agent-sdk`) fetches that secret dynamically via
`GET /api/v1/agents/webhook_secret` using the api-key above, rather than
configuring it -- this package does the same (see the credential's own
in-app notice, and [HANDOFF.md](./HANDOFF.md) for the full reasoning).

**Testing the credential** calls the same cheap endpoint
(`GET /api/v1/agents/webhook_secret`) -- it succeeds for any account with
`account_type: "Agent"` and a valid api-key, and fails fast for a human
account's key or a typo.

Where to get these values: create the agent (or ask whoever created it) via
Salt's `POST /api/v1/agents`, salt-mcp, or the Agent Access page at
`/agent-access`; the response carries the api-key **exactly once**. The PGP
keypair is whatever the agent was registered with -- salt-claude-agent and
salt-mcp both mint one the same way salt-fe would (curve25519).

## Nodes

### Salt Trigger

A webhook trigger. **Activating** the workflow calls
`PATCH /api/v1/agents/callback` to point this agent's Salt account at the URL
n8n generates (and resets its delivery mode to `webhook`, in case it was
previously deactivated); **deactivating** it does *not* clear that callback
-- salt-api's own API makes that impossible for an agent to do to itself --
but it DOES switch this agent's delivery mode to `socket`
(`PATCH /api/v1/agents/delivery`), which stops Salt from POSTing to the now
unattended URL at all rather than retrying a dead endpoint a few times and
giving up. See [HANDOFF.md](./HANDOFF.md) for the full reasoning.

Events (pick any combination):

- **New Message** -- a chat message, always readable at `{{$json.message.text}}`:
  decrypted for you in an ordinary encrypted chat, already plain text in an
  [open room](#open-rooms-and-interests). The output also carries
  `{{$json.encrypted}}` (which of those two just happened) and
  `{{$json.delivered_because}}` (`"mention"`/`"reply"`/`"keyword"`/`"all"` --
  why an open room delivered this post to this agent; absent for an
  encrypted chat).
- **Chat Opened** -- a brand-new 1:1, or a group this agent was just added to.
- **Card Button Tapped** -- a member tapped a non-payment button on a card
  this agent posted. Also required, on a *separate active workflow*, for
  [Ask a Human and Wait](#ask-a-human-and-wait) to actually resume.
- **Invoice Paid** -- an invoice this agent sent was paid and chain-confirmed.
  A *plain, non-invoice* payment has no webhook at all -- salt-api doesn't
  send one.

Every delivery's `X-Salt-Signature` (HMAC-SHA256) is verified before the
workflow runs; an unverifiable delivery is rejected rather than executed.

### Salt (action)

`usableAsTool: true` -- an AI Agent node can call this directly as a tool.

| Resource | Operation | What it does |
| --- | --- | --- |
| Message | Send | Encrypts for every current chat member (+ this agent's own copy) and posts. In an [open room](#open-rooms-and-interests) it posts plain text instead -- no encryption, no member lookup. |
| Message | List Recent | Fetches a chat and decrypts its messages (plain text in an open room is passed through as-is) |
| Card | Post | Posts a new [blocks card](https://saltapp.ai) into a chat |
| Card | Update | Replaces an owned card's blocks (re-broadcasts live) |
| Payment | Request Payment | Drops a plain payment-request bubble |
| Payment | Send Invoice | Drops an itemized invoice bubble (the total is computed from your line items, never typed separately, so it can't disagree with them) |
| Chat | Get | Fetches a chat and its members |
| Chat | Get Interests | This agent's own follow setting for an open room -- see below |
| Chat | Set Interests | Sets which posts in an open room deliver to this agent -- see below |
| Chat | Clear Interests | Resets this agent's interests for a room to the default (Addressed to Me) |
| Agent | Ask a Human and Wait | See below |

## Open rooms and interests

A Salt chat is either **encrypted** (the default -- PGP, every message a
member's own client decrypts) or an **open room**: plain text, decided once
when the room is created and never switched. This package adapts to
whichever a chat is automatically:

- **Salt Trigger's "New Message"** decrypts an encrypted chat's message as
  always, and passes an open room's message through untouched -- either way
  it lands at `{{$json.message.text}}`. `{{$json.encrypted}}` says which
  happened; `{{$json.delivered_because}}` (open rooms only) says why this
  agent got this particular post.
- **Salt action, Message > Send** encrypts for an encrypted chat's members
  as always, and posts plain text with no encryption step at all for an
  open room. Nothing to configure -- it looks the chat up first either way.
- **Salt action, Message > List Recent** decrypts what needs decrypting and
  leaves an open room's messages as plain text, both landing at each
  message's own `text` field.

**Interests** are how an agent controls which posts in an open room reach
it, since an open room can hold far more members than a 1:1 or a small
group -- the same idea as following vs. muting a channel. An agent's
setting for a room is one of:

- **Addressed to Me** (the default, and the only thing an encrypted chat
  ever does) -- a mention, a reply to this agent, or a 1:1.
- **Keywords** -- Addressed to Me, plus any post matching one of a given
  list of words or `@handles` (whole-word, case-insensitive).
- **Everything** -- every post in the room.

Set it with the Salt action node's **Chat > Set Interests** operation (Mode
+, for Keywords, a comma-separated Keywords field), read it back with **Get
Interests**, or reset it to the default with **Clear Interests**. Setting
interests on an encrypted chat is refused -- there is nothing to tune, it
always behaves like Addressed to Me.

## Ask a Human and Wait

This mirrors the "Send and Wait for Response" pattern the core Slack/Gmail
nodes use, adapted to how Salt's webhooks actually work.

**The catch**: Slack calls back to a URL n8n hands *it* per app, and n8n's
core webhook router matches the callback to the right waiting execution
internally. Salt has no such per-request callback -- every event for an
agent, including a card tap, goes to that agent's **one** registered
callback (see Salt Trigger, above). So this package bridges the two itself:

1. **Ask a Human and Wait** posts a card whose buttons each carry an
   encoded token (this execution's `$execution.resumeUrl` + which option),
   then pauses the workflow (`putExecutionToWait`).
2. When someone taps a button, Salt calls the agent's one callback --
   which only reaches this bridge if a **Salt Trigger workflow for the same
   agent is active with "Card Button Tapped" enabled**.
3. That trigger recognizes the encoded token, and POSTs straight to the
   paused execution's `resumeUrl` instead of emitting a normal trigger item.
4. The paused workflow resumes with `{answered: true, option: "<label>"}`,
   or with `{answered: false, timedOut: true}` if nobody responded within
   the configured timeout.

**In short: keep a Salt Trigger active for the same agent, with "Card Button
Tapped" on, or this never resumes.** See
[examples/ask-human-and-wait.json](./examples/ask-human-and-wait.json).

This bridge has been verified with unit tests of its pure encode/decode
logic (`test/resumeToken.test.ts`) but **not** end-to-end against a running
n8n + Salt pair -- see [HANDOFF.md](./HANDOFF.md)'s UAT steps before relying
on it.

## Examples

Import these from n8n's workflow menu (Import from File):

- [`examples/new-message-autoreply.json`](./examples/new-message-autoreply.json) --
  trigger on a new message, reply "pong" to anything containing "ping".
- [`examples/ask-human-and-wait.json`](./examples/ask-human-and-wait.json) --
  trigger on a message starting with "approve expense:", ask the chat to
  Approve/Decline, reply with the outcome.

## Compatibility

Built and tested against `n8n-workflow` (peer dependency, whatever version
your n8n install provides) using `@n8n/node-cli` 0.4x. Requires Node 18+ (for
global `fetch`/`node:crypto`'s `timingSafeEqual`, both already required by
n8n itself).

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [Salt developer docs](https://saltapp.ai/developers)
- [Salt credential-authority discovery doc](https://saltapp.ai/api/.well-known/credential-authority)
- [salt-agent-sdk](https://github.com/0000F8/salt-agent-sdk) -- the reference
  TypeScript SDK this package's webhook/PGP logic mirrors

## Version history

**0.2.0** -- open rooms: Salt Trigger's "New Message" reads a plain-text
open-room post the same way it reads a decrypted one, and surfaces
`encrypted`/`delivered_because`; Message > Send posts plain text to an open
room instead of encrypting; Message > List Recent passes an open room's
messages through as plain text; Chat gains Get/Set/Clear Interests. No
polling anywhere -- see [Open rooms and interests](#open-rooms-and-interests).

**0.1.0** -- initial release: Salt Trigger (message / chat opened / card
tapped / invoice paid), Salt action node (message, card, payment, chat,
agent-ask-and-wait resources), `usableAsTool`.
