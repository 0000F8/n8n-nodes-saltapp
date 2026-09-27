# n8n-nodes-saltapp

[Salt](https://saltapp.ai) is an end-to-end encrypted chat where humans and
AI agents are equal contacts -- each has a handle, a PGP key, and a wallet.
`n8n-nodes-saltapp` is an n8n community node package that lets an n8n
workflow act as one side of a Salt agent: it receives that agent's
messages/events (new messages, card button taps, invoices paid) and can send
encrypted messages, post interactive cards, request payments/invoices, and
pause a workflow to ask a human in a real chat. Read `HANDOFF.md` for the
full reasoning behind any decision summarized below.

## Commands

Run from the repo root. All verified working as of this writing.

- `npm install` -- installs devDependencies. `n8n-workflow` is a
  `peerDependency` (provided by the n8n runtime, never bundled); `openpgp`
  is a `devDependency` only -- see "Zero runtime dependencies" below.
- `npm test` -> `vitest run` -- the pure-function unit suite in
  `test/*.test.ts` (5 files, 62 tests, no n8n execution context needed).
- `npm run lint` -> `n8n-node lint` (`npm run lint:fix` to auto-fix).
- `npm run build` -> `n8n-node build && node scripts/bundle-pgp.mjs` --
  `tsc`-compiles `nodes/` + `credentials/` to `dist/`, copies static assets
  (icons), then esbuild-inlines `openpgp` into the one compiled file that
  imports it, `dist/nodes/shared/pgp.js`. Verify with
  `grep -c 'require("openpgp")' dist/nodes/shared/pgp.js` -> must print `0`.
  If you touch `nodes/shared/pgp.ts`, re-run this and re-check it before
  considering the change done.
- `npm run build:watch` -> `tsc --watch` -- typecheck loop only; still run a
  real `npm run build` before `bundle-pgp` has anything to inline.
- `npm run dev` -> `n8n-node dev` -- launches a local n8n instance with this
  package loaded, for interactive/manual testing.

## Layout

- `nodes/Salt/Salt.node.ts` -- the action node (`usableAsTool: true`):
  message/card/payment/chat/agent resources, including "Ask a Human and
  Wait".
- `nodes/SaltTrigger/SaltTrigger.node.ts` -- the webhook trigger node:
  new message / chat opened / card button tapped / invoice paid events,
  HMAC-verified; also the resume bridge for "Ask a Human and Wait" (see
  below).
- `nodes/shared/` -- everything shared between the two node files (PGP,
  signature verification, REST request-shaping via `SaltApiClient.ts`, open-room
  helpers, the resume-token encode/decode) kept as plain functions so the
  pure parts are unit-testable without an n8n execution context.
- `scripts/bundle-pgp.mjs` -- the esbuild step described under Commands.
- `test/*.test.ts` -- one file per `nodes/shared/*.ts` module, run with
  `npm test`.
- `credentials/SaltAppApi.credentials.ts` -- host, agent id, api-key, PGP
  private key + passphrase.

## Rules that bite

- **Zero runtime dependencies, on purpose**: n8n's verified-community-node
  rules forbid them. `node:crypto`-only signature verification lives in
  `nodes/shared/signature.ts`. `openpgp` (a real dependency of PGP
  encrypt/decrypt, which cannot be responsibly hand-rolled) is a
  `devDependency` only, bundled into `dist/nodes/shared/pgp.js` by
  `scripts/bundle-pgp.mjs` as the last step of `npm run build`.
- **Protocol reference**: everything about how Salt's webhooks are signed,
  how PGP messages are shaped, and what each REST endpoint expects is read
  directly from `salt-agent-sdk`'s source
  (`/Users/z1ggy/projects/salt/salt-agent-sdk/src/{webhook,crypto,client}.ts`)
  and from `salt-api`'s own Rails controllers
  (`/Users/z1ggy/projects/salt/salt-api/app/controllers/api/v1/`,
  `app/jobs/*_job.rb`) -- not guessed. If Salt's API changes, those are the
  files to re-check.
- **"Ask a Human and Wait" is webhook-only, not a poller** -- the one
  genuinely subtle piece here; read its README.md section and
  `nodes/shared/resumeToken.ts`'s header comment before changing it. Salt
  calls one callback per AGENT, never one per request, so there's no native
  "resume this specific paused execution" concept to hook. `Salt.node.ts`'s
  `askAndWait` operation encodes `{resumeUrl, option}` into each button's
  own `action_id` (`encodeResumeActionId`) via a card posted with
  `buildPostCardRequest`, then calls n8n's own `putExecutionToWait` -- no
  manual sleep/poll loop. `SaltTrigger.node.ts`'s webhook handler decodes a
  tapped button's `action_id` (`decodeResumeActionId`) and POSTs straight to
  the embedded `resumeUrl`, so resuming only actually works if a Salt
  Trigger workflow for the SAME agent is active with "Card Button Tapped"
  enabled. **If a future change ever needs to poll for an answer instead**
  (e.g. outside n8n's wait/webhook model), poll the specific card you posted
  via `GET /api/v1/cards/:id` -- never `GET /api/v1/agent/updates`. That
  outbox keeps exactly ONE forward-only cursor per agent server-side; any
  `after=` passed to it permanently advances that agent's ack and silently
  cuts off any other consumer's backlog (there is no "read-only" poll of it).
- **A posted card's response has no top-level `id`.** `POST /api/v1/cards`
  returns the chat MESSAGE it created (a formatted `Message`, not the card
  row) -- `message_id` (the bubble's own id) and `resource_id`/`resource`
  (the card's own id, `resource_id == resource.id`). Reading `response.id`
  silently resolves to `undefined`. Always go through
  `SaltApiClient.ts`'s `cardIdFromPostCardResponse()` rather than reading a
  card-post response's shape by hand -- this exact bug (a bare `.id` read)
  shipped identically in several other Salt agent-adapter repos before it
  was caught here; see HANDOFF.md's outbox-race-audit entry.
- **A chat's `encrypted` flag is nested, not top-level.** `GET
  /api/v1/chats/:id`'s response carries it under `session.encrypted`; a
  card_interaction/message webhook envelope carries it under
  `chat.encrypted`. Either way, absent means encrypted (every payload
  before this field existed was). Always branch through
  `nodes/shared/openRooms.ts`'s `isEncryptedChat()`/`isEncryptedMessage()`
  on the right nested object -- see `Salt.node.ts`'s message-send operation
  for the pattern (`const session = chat.session as IDataObject`, then
  `isEncryptedChat(session)`).
- **An encrypted chat refuses a non-armored message body.** Since salt-api
  0.98.1, `POST /api/v1/messages` against an encrypted chat 422s unless
  `params[:message]` looks PGP-armored (`-----BEGIN PGP MESSAGE-----` /
  `-----END PGP MESSAGE-----`) -- plaintext into an encrypted chat is always
  a bug, never a valid "open room" shortcut (open rooms are a genuinely
  different, unencrypted chat type; see `openRooms.ts`'s header comment).
  Every send path in `Salt.node.ts` already PGP-encrypts first for an
  encrypted chat -- keep it that way if you touch that code.
- **Test fakes must model salt-api's ACTUAL controller response shape**,
  not the shape the calling code assumes. `test/requestShaping.test.ts`'s
  card-response cases exist specifically to pin the real
  `message_id`/`resource_id` shape (including a decoy top-level `id` key,
  to prove nothing reads it) -- this exact bug class (a mock shaped like
  the caller's assumption, not the real response) shipped identically in
  multiple downstream Salt adapters before being caught.

## Where the truth is

- https://saltapp.ai/api/openapi.json -- the full REST API surface.
- https://saltapp.ai/agents.md -- the agent-facing protocol overview.
- Hosted MCP server: https://mcp.saltapp.ai/mcp
- `/Users/z1ggy/projects/salt/salt-mcp/docs/CLIENTS.md` -- the client-by-client
  integration matrix (a sibling repo; read-only reference from here).

## Publishing

This package is **not yet published** -- no GitHub repo has been pushed to
and nothing has been published to npm (see HANDOFF.md's publish +
verification-submission steps for what's still pending: npm Trusted
Publisher setup, the `publish.yml` GitHub Action, and n8n Creator Portal
submission). Don't write or imply install instructions that assume
`npm install n8n-nodes-saltapp` / the n8n Community Nodes panel install
already resolves against a real published package today -- it doesn't yet.

---

## n8n node scaffold reference (generic guidance)

Everything below is n8n's own generic guidance for the CLI scaffold, not
specific to this package. Still load it when it's relevant to what you're
touching (e.g. adding a node property, a new credential, a new node
version).

### Overview
This is a project containing code for an n8n community node. n8n is a workflow
automation platform where users build workflows with nodes, which are the
building block of a workflow. Nodes can perform a range of actions, such as
starting a workflow (called a "trigger node"), fetching and sending data, or
processing and manipulating it. Besides that there are credentials - entities
that store sensitive information on how to connect to external services and
APIs. A node can require some credentials to be used. Community nodes are a way
for anyone to create such nodes and add them to be used in n8n. All community
nodes are named in a format: `n8n-nodes-<n>` or `@org/n8n-nodes-<n>`.
Community nodes can also be submitted for approval to be used on n8n Cloud
version. In that case there are rules that the node needs to follow in order to
be approved

### Important notes
- Follow the **rules and guidelines in this document and the linked docs
  below** over any code examples.
- All code blocks in these docs are **illustrative and incomplete**.
  They **MUST NOT** be copied verbatim or assumed to be the final desired code.
- Replace example names like `Example`, `Wordpress`, `wordpressApi`, etc.
  with names that match the **actual service / node** you are building.
- When in doubt, **generalize from the patterns**, don't replicate the exact
  structure, fields, or values from the examples.
- Produce the **full implementation** needed for the current project
  (nodes, credentials, tests, etc.), not just fragments similar to examples.
- If an example omits parts (e.g. types, operations, properties), **infer and
  implement the missing parts** based on the real requirements / API docs.
- Never output `Wordpress`-specific code unless the project is actually about
  WordPress.

### Project structure
There are two main folders in this project:
- `nodes` contains all of the nodes in a package (there can be more than 1).
  The code for each node usually lives in its own folder
- `credentials` contains all of the credentials in a package. Usually it's just
  a single file for every credential
So it looks something like this:
.
├── nodes/
│   └── Example/
│       ├── Example.node.ts
│       └── ...
├── credentials/
│   └── Example.credentials.ts
├── package.json
└── ...
It's important to note that `package.json` has a special field `n8n` that have
information about nodes and credentials in a package:
```json
{
  "name": "n8n-nodes-example",
  "version": "1.0.0",
  "n8n": {
    "n8nNodesApiVersion": 1,
    "strict": true,
    "credentials": [
        "dist/credentials/Example.credentials.js"
    ],
    "nodes": [
      "dist/nodes/Example/Example.node.js"
    ]
  }
}
```
`nodes` and `credentials` keys contain paths to transpiled JS files in a `dist`
folder for the nodes and credentials respectively. If you add/remove/rename
nodes and/or credentials, you need to make sure to update `n8n.nodes` and
`n8n.credentials` keys in `package.json` accordingly. Initial files in the
project _may_ contain example nodes and/or credentials that need to be
**removed or renamed** once you start making an actual node.

### Key guidelines
- Use the `n8n-node` CLI tool **whenever possible** for building, dev mode,
  linting, etc.
- **Always** address any lint/typecheck errors/warnings, unless there is a
  **very specific reason** to ignore/disable it
- Make sure to use **proper types whenever possible**
- If you are updating the npm package version, make sure to **update
  CHANGELOG.md** in the root of the repository
- Read `.agents/workflow.md` for more info

### Context-specific docs
Load these before working on the relevant area:

| Working on...                        | Read first                                                          |
|--------------------------------------|---------------------------------------------------------------------|
| Any node file in `nodes/`            | `.agents/nodes.md` and `.agents/properties.md`                      |
| A declarative-style node             | above + `.agents/nodes-declarative.md`                              |
| A programmatic-style node            | above + `.agents/nodes-programmatic.md`                             |
| Files in `credentials/`              | `.agents/credentials.md`                                            |
| Adding a new version to a node       | `.agents/versioning.md`                                             |
| Starting a new task or planning      | `.agents/workflow.md`                                               |

### Additional resources
If you need any extra information, here are links to n8n's official docs
regarding building community nodes:
- https://docs.n8n.io/integrations/community-nodes/build-community-nodes/
- https://docs.n8n.io/integrations/creating-nodes/overview/
- https://docs.n8n.io/integrations/creating-nodes/build/reference/
- https://docs.n8n.io/integrations/creating-nodes/build/reference/ux-guidelines/
