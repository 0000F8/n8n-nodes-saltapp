# HANDOFF -- n8n-nodes-saltapp

## 2026-09-26 outbox-race audit (no outbox here; a real card-id bug found and fixed instead)

Requested: audit and fix the "shared socket-mode outbox" bug class already
fixed in `salt-mcp` 0.2.1 and `saltapp-agentkit` -- `GET /api/v1/agent/updates`
keeps exactly ONE forward-only cursor per agent server-side (`after=0` ≡
omit; a lower `after` is silently ignored), so a stateless poller of it races
every other poller on the same agent and can strand or drop deliveries.

**Finding: this package never reads that endpoint, in the ask/answer path or
anywhere else.** `grep -rn "agent/updates" nodes/` turns up exactly one hit
(`nodes/shared/SaltApiClient.ts`'s doc comment on `buildSetDeliveryModeRequest`,
explaining what happens to an agent's undelivered updates if it's switched to
socket mode with nobody consuming them -- not a call site). "Ask a Human and
Wait" was built webhook-first from 0.1.0: it posts a card whose buttons each
carry a **self-contained** resume token (`{resumeUrl, option}`, base64url-JSON,
`nodes/shared/resumeToken.ts`), pauses the execution with n8n's own
`putExecutionToWait` (not a manual sleep/poll loop), and resumes when Salt's
webhook delivers the tapped button's `card_interaction` to the Salt Trigger,
which decodes the token and POSTs straight to that execution's `resumeUrl`.
There is no shared cursor anywhere in this design -- each ask carries its own
destination -- so the concurrency property the other repos had to *build*
(unlimited concurrent asks per agent, no poller racing another) was already
true here for a structural reason (no polling, no shared state) rather than
needing a fix. Nothing was removed or gated, because there was no trigger or
"read updates" operation reading the outbox to begin with, and no timer loop
inside `execute()` to replace with a bounded `Wait` node -- `putExecutionToWait`
already *is* n8n's own equivalent of that. See README.md's new "Concurrency"
note under "Ask a Human and Wait" for the user-facing version of this.

**What the audit DID find and fix**: `Salt.node.ts`'s `askAndWait` timeout
branch read `card.id` off `POST /api/v1/cards`'s response for its diagnostic
`cardId` output field. That response has no top-level `id` -- verified
directly against salt-api's source (`app/controllers/api/v1/cards_controller.rb`'s
`create` action renders `message.formatted_message(Card.to_s, ...)`, and
`Message#formatted_message` in `app/models/message.rb:113-181` only ever sets
`message_id` (the bubble message's own id) and, when a resource is attached,
`resource_id`/`resource` (the card's own id, `resource_id == resource.id`) --
never a bare `id` key). `card.id` therefore always resolved to `undefined` on
this path. This is the same bug class the coordinator flagged in AgentKit's
history ("card.id ... its mocks hid it") -- and it was likewise untested here:
no test in this repo exercises `Salt.node.ts`'s `execute()`/`executeOne` at
all (the whole testing strategy here is pulling logic into pure
`nodes/shared/` functions specifically so it's unit-testable without a full
n8n execution context -- see AGENTS.md -- and this one small mapping had never
been pulled out). Fixed by extracting `cardIdFromPostCardResponse()` into
`SaltApiClient.ts` (reads `resource_id`, falls back to `resource.id`, returns
`undefined` rather than throwing on neither) and calling it from the timeout
branch instead of `card.id`; three new tests in `test/requestShaping.test.ts`
model the real response shape (including a case with a *decoy* top-level `id`
key, to prove the fix doesn't regress back to reading it).

Only `nodes/shared/SaltApiClient.ts`, `nodes/Salt/Salt.node.ts`,
`test/requestShaping.test.ts`, README.md and this file changed. 59 -> 62
tests passing (still 5 files -- no test file added or removed, only cases);
`npx tsc --noEmit`, `npm run lint` (`n8n-node lint`), and `npm run build`
(including the `bundle-pgp` step -- `grep -c 'require("openpgp")'
dist/nodes/shared/pgp.js` is still `0`) are all clean. Committed to a new
branch, `lane/card-poll`, off `main`; not pushed, per the standing "the
coordinator's call" note below.

## 2026-09-22 alignment pass (round-4 socket contract, real brand icons)

- **Trigger deactivation now silences Salt's retries.** `delete()` PATCHes
  `PATCH /api/v1/agents/delivery {mode: "socket"}` (new
  `buildSetDeliveryModeRequest` in `SaltApiClient.ts`) before clearing its
  own static data; `create()` symmetrically PATCHes back to `mode: "webhook"`
  on (re)activation, since `delivery_mode` is a separate, sticky column from
  the callback URL that doesn't reset itself. Both calls are best-effort
  (logged via `this.logger.warn`, not thrown) so an older salt-api without
  this endpoint doesn't break activation/deactivation. See "Other decisions
  worth knowing about" below for the full reasoning.
- **Real brand icons.** `nodes/shared/icons/salt.svg`/`salt.dark.svg` were
  hand-drawn approximations; they're now exact copies of
  `salt-fe/brand/salt-mark-paper.svg` / `salt-mark.svg`.
- **No poll loop here to align** -- this package is webhook-only by design
  (n8n trigger nodes are HTTP-endpoint-based, not long-running processes);
  the round-4 socket contract (adaptive short-poll, `after` omission on a
  fresh cursor, 300s tolerance) applies to the OTHER five repos' pollers,
  not to this one.
- 36 -> 38 tests passing, `n8n-node lint` and `n8n-node build` (+
  `bundle-pgp`) both clean.

---

Lane `n8n` (design-fleet run `2026-09-17-distribution`). New standalone
repository at `/Users/z1ggy/projects/salt/n8n-nodes-saltapp`, git-initialized
and committed locally by the scaffolding tool + this session. **No GitHub
repo was created, nothing was pushed, nothing was published to npm** -- per
LANES.md, that's the coordinator's call.

## What this is

An n8n community node package (`n8n-nodes-saltapp`) for Salt
(https://saltapp.ai): a webhook trigger (`Salt Trigger`) and an action node
(`Salt`, `usableAsTool: true`) covering messages, cards, payments/invoices,
chat lookup, and a "Ask a Human and Wait" human-in-the-loop action.

## Files

```
credentials/SaltAppApi.credentials.ts     Host, agent id, api key, PGP private key + passphrase
nodes/SaltTrigger/SaltTrigger.node.ts     Webhook trigger: message / chatOpened / cardInteraction / invoicePaid
nodes/Salt/Salt.node.ts                   Action node: message / card / payment / chat / agent resources
nodes/shared/signature.ts                 HMAC-SHA256 verify (node:crypto only, zero deps)
nodes/shared/pgp.ts                       PGP encrypt/decrypt/keygen (openpgp -- bundled, see below)
nodes/shared/SaltApiClient.ts             Pure request-shaping functions (unit-testable, no n8n context)
nodes/shared/resumeToken.ts               "Ask a Human and Wait" resume-bridge encode/decode
nodes/shared/icons/salt.{svg,dark.svg}    Shared node/credential icon
scripts/bundle-pgp.mjs                    esbuild step that inlines openpgp into dist/ after tsc
test/*.test.ts                            36 vitest tests over the four shared/ modules above
examples/*.json                           Two importable example workflows
README.md, AGENTS.md, CHANGELOG.md, LICENSE (MIT, Copyright (c) 2026 0x0000F8)
```

Everything else (`.agents/`, `.github/workflows/`, `eslint.config.mjs`,
`tsconfig.json`, `.prettierrc.js`, `.vscode/`) is what `npm create @n8n/node`
scaffolded, unmodified except `.github/workflows/ci.yml` (added an `npm test`
step) and `package.json` (see below).

## The two decisions the task asked me to make explicitly

### 1. Zero runtime dependencies

Read first: `https://docs.n8n.io/connect/create-nodes/build-your-node/reference/verification-guidelines`
("No external dependencies... Ensure that your package does not include any
external dependencies") and `.../deploy-your-node/submit-community-nodes`
("verified community nodes aren't allowed to use any run-time dependencies").
This is checked by `npx @n8n/scan-community-package n8n-nodes-saltapp`
against the published tarball, and is a hard requirement for Creator Portal
verification (not just cloud eligibility).

- **HMAC signature verification** (`nodes/shared/signature.ts`) needs
  nothing beyond `node:crypto` -- zero dependencies, no decision to make.
- **PGP encrypt/decrypt** cannot be responsibly hand-rolled against bare
  Node built-ins (armor, packet framing, curve25519 ECC, session-key
  wrapping, MDC -- this is exactly the kind of security-critical protocol
  code nobody should reimplement to dodge a dependency line). `openpgp` has
  **zero runtime dependencies of its own** (checked with
  `npm view openpgp dependencies` before deciding this, and again matters
  because it means bundling it drags in no transitive tree). So: `openpgp`
  is a `devDependency` only; `package.json`'s `dependencies` is `{}`;
  `scripts/bundle-pgp.mjs` runs `esbuild` on the one compiled file that
  imports it (`dist/nodes/shared/pgp.js`) after `n8n-node build`'s plain
  `tsc`, inlining `openpgp`'s code in place. Verified:
  `grep -c "require(\"openpgp\")" dist/nodes/shared/pgp.js` → `0` after
  `npm run build`. `openpgp` is pinned to `^5.11.3` (the same major version
  `salt-agent-sdk` itself pins, `^5.11.0`) rather than the newer v6 line --
  v6 renamed several APIs (e.g. the `curve25519` generate-key option became
  `curve25519Legacy`) and matching the rest of the Salt ecosystem's major
  version avoids any risk of a wire-format or API-shape surprise, even
  though both majors can read/write the same armored key format.
- `package.json`'s `build` script is `n8n-node build && node scripts/bundle-pgp.mjs`
  -- if this package ever grows a second file that imports `openpgp` (or any
  other genuinely-needed library), either bundle that file too or refactor
  so every such import funnels through `nodes/shared/pgp.ts`.

### 2. The webhook signing secret has no credential field

`salt-agent-sdk/src/webhook.ts`'s `secretForAgent()` fetches the signing
secret dynamically via `GET /api/v1/agents/webhook_secret`, using the
identity's own api-key, rather than storing it as static config -- the
SDK's own comment explains why (a shared secret leaks to anyone who asks for
it; fetching per-identity is what makes it a real per-agent secret). This
package does the same: `SaltTrigger.node.ts`'s `create()` webhook-lifecycle
method fetches and caches it in `getWorkflowStaticData('node')`, and
`webhook()` refetches once (handling rotation) if verification fails. The
credential has a `notice`-type field explaining this instead of an unused
input. See `credentials/SaltAppApi.credentials.ts`.

## Other decisions worth knowing about

- **Deactivating the Salt Trigger cannot clear Salt's callback -- but it
  now switches this agent to socket mode instead (fixed 2026-09-22).**
  `AgentsController#set_callback` refuses a blank `webhook` value -- an
  agent can set its OWN callback but never clear it via that
  api-key-authenticated endpoint; only the owner can, from the dashboard (a
  different, session-authenticated path). What CAN be self-serviced is
  `delivery_mode` (`PATCH /api/v1/agents/delivery {mode}`, LANES.md's K2
  socket-mode contract, `User#socket_mode?`): it's a separate, sticky
  column from the callback URL, and an explicit `delivery_mode: "socket"`
  wins even with a real callback configured. So `delete()` now PATCHes this
  agent to `mode: "socket"` (best-effort; logs a warning rather than
  failing if the endpoint isn't deployed) before clearing its own cached
  static data, which stops Salt from POSTing to the dead URL at all rather
  than just letting `AgentWebhookRetries` exhaust its 3 attempts and fire
  the owner's `agent_webhook_failing` notification for a trigger that was
  deliberately turned off. `create()` (reactivation) symmetrically PATCHes
  back to `mode: "webhook"` -- otherwise a re-enabled trigger would set a
  fresh, valid callback that Salt still never uses, because
  `delivery_mode` doesn't reset itself.
- **`checkExists()` can't ask Salt "what's my current callback?"** -- there
  is no read endpoint for it (only the write-only `PATCH .../callback`, which
  echoes back what it just set). `checkExists()` compares against this
  node's own last-registered URL in static data instead -- the standard
  fallback pattern for a service with create/delete but no read.
- **"Ask a Human and Wait"** bridges Salt's one-callback-per-agent model onto
  n8n's per-execution `$execution.resumeUrl` by encoding `{resumeUrl, option}`
  into the tapped button's `action_id` (`nodes/shared/resumeToken.ts`) and
  having the Salt Trigger's `card_interaction` handler recognize and forward
  it. **This requires a second, active Salt Trigger workflow for the same
  agent with "Card Button Tapped" enabled** -- documented in the node's own
  `notice` property and in README.md. This is architecturally necessary
  (Salt has no per-request callback the way Slack's shared Interactivity URL
  + n8n's core wait-webhook router can lean on) but it is a real limitation
  worth restating to whoever ships this.
- **Invoice line-item totals are computed, never typed twice.** Salt's own
  `TransferRequest` validation requires each item's `subtotal == qty *
  unit_price` and the sum to equal the request's `amount`
  (see `CLAUDE.md`'s Commerce section). Rather than asking an n8n user to
  type an `amount` that must agree with items they also typed, the node
  computes both from `qty`/`unit_price` alone (`Salt.node.ts`'s
  `sendInvoice` branch) -- removing the footgun entirely rather than just
  validating it (`SaltApiClient.ts`'s `validateLineItems` still runs
  defensively, but should never actually fire from this path).
- **Card `blocks`** are a raw JSON property, not a fully-modeled n8n UI (the
  block vocabulary in `CARD_PROTOCOL_SPEC.md` -- section/fields/image/divider/
  actions+buttons -- would need a large `fixedCollection` tree to express
  natively). Documented as a known simplification; a follow-up could add a
  friendlier "Quick Card" mode alongside the raw JSON escape hatch.
- ~~**Icons**: ... placeholder renderings ... not exports from
  `salt-fe/brand/`~~. **Fixed 2026-09-22**: `nodes/shared/icons/salt.svg`
  (used as `icon.light`) and `salt.dark.svg` (`icon.dark`) are now exact,
  byte-for-byte copies of `salt-fe/brand/salt-mark-paper.svg` (the paper
  form, for light grounds) and `salt-fe/brand/salt-mark.svg` (the dark
  form, white cap + brand-blue body, for dark grounds) respectively --
  never hand-redrawn.

## How to test

```bash
cd /Users/z1ggy/projects/salt/n8n-nodes-saltapp
npm ci                 # already run once in this session; re-run if you pull fresh
npx tsc --noEmit -p tsconfig.json   # typecheck: clean
npm run lint            # n8n-node lint: clean (0 problems)
npm run build           # tsc + asset copy + openpgp bundling: clean
npm test                # vitest: 36/36 passing
```

All four commands were run in this session and are clean as of this
handoff. What was **not** run: `npm run dev` (spins up a real local n8n with
this node loaded) and any live call against a real salt-api instance --
this lane's scope is the standalone package, not standing up salt-api or a
browser session. See UAT below for what the coordinator/owner should verify
live.

## UAT steps (for whoever picks this up)

1. `cd n8n-nodes-saltapp && npm run dev` -- starts a local n8n at
   `localhost:5678` with this package linked in.
2. Create a **Salt App API** credential using a real test agent's api-key
   and PGP key (an `SALT-…` test account per workspace convention -- see
   `salt-api`'s account-naming rule in the workspace CLAUDE.md). Confirm the
   credential test succeeds (green check) against `https://saltapp.ai` or a
   local salt-api.
3. Import `examples/new-message-autoreply.json`, activate it (needs n8n
   reachable over public HTTPS from Salt -- a tunnel like `ngrok` for local
   dev), and send the agent a message containing "ping" from another Salt
   account. Confirm it replies "pong".
4. Import `examples/ask-human-and-wait.json`, activate **both** its Salt
   Trigger and a workflow using the "Ask a Human and Wait" action (the
   example file has both in one workflow, which satisfies "a Salt Trigger is
   active for the same agent" -- but confirm this really is the shape that
   works, since it's untested end-to-end per the note above). Send
   "approve expense: $50", tap "Approve" on the resulting card, and confirm
   the paused execution resumes and posts "Recorded: Approve" rather than
   timing out.
5. If step 4 does NOT resume correctly, the most likely culprits, in order:
   the two node instances' `webhookMethods`/`webhooks` wiring on the SAME
   underlying n8n webhook path; whether `$execution.resumeUrl` is populated
   in the execution context this early; whether Salt's `card_interaction`
   payload's `action_id` field survives round-trip without truncation or
   escaping. Fix forward from whichever of those breaks first, and update
   `nodes/shared/resumeToken.ts`'s header comment + this file if the design
   changes.

## What's left / not done

- **No live end-to-end run** against real salt-api (see above) -- everything
  verified is unit-level (pure functions) plus `build`/`lint` static checks.
- **Not published, no GitHub repo, no PR** -- per LANES.md, that's the
  coordinator's step.
- **Real brand icons** not used (see icons note above).
- **No "Quick Card" builder UI** -- Card blocks are raw JSON only.
- **Verification submission** not started (see below) -- needs a real GitHub
  org/repo to exist first, plus an npm account with Trusted Publisher
  configured.

## Publish + verification-submission steps (for the coordinator)

1. Create the GitHub repo at `github.com/0000F8/n8n-nodes-saltapp` (already
   referenced in `package.json`'s `repository`/`bugs` fields) and push this
   local repo's `main` branch to it.
2. One-time npm setup for provenance publishing (no long-lived token needed):
   on npmjs.com, create/claim the `n8n-nodes-saltapp` package, then under
   **Publish access > Trusted Publishers**, add a GitHub Actions publisher
   naming this repo and workflow file `publish.yml` (already scaffolded at
   `.github/workflows/publish.yml` with full instructions in its header
   comments -- read them before touching npm settings).
3. Locally: `npm run release` (wraps `release-it`: bumps the version, updates
   `CHANGELOG.md`, commits, tags, pushes the tag) -- this triggers
   `publish.yml`, which builds, lints, and publishes with an npm provenance
   statement.
4. Sanity-check the published package before submitting for verification:
   `npm view n8n-nodes-saltapp dependencies` should print `{}`, and
   `npx @n8n/scan-community-package n8n-nodes-saltapp` (n8n's own verified-node
   linter, run against the real published tarball) should pass -- this is a
   different, stricter check than this repo's local `npm run lint`, and
   hasn't been run against a real published version yet.
5. Sign up / log in at the [n8n Creator Portal](https://creators.n8n.io/nodes)
   and submit the package. Re-read
   `https://docs.n8n.io/connect/create-nodes/build-your-node/reference/verification-guidelines`
   for anything that's changed since this was written (2026-09-18) --
   notably the "GitHub Actions + provenance required" rule takes effect
   **May 1, 2026**, which is already in the past relative to this handoff,
   so it applies now, not later.
6. Also worth listing (out of scope for this lane, flagging for whoever owns
   distribution strategy): the [n8n community forum](https://community.n8n.io)
   and template gallery submission, once the node is verified and has real
   usage to show.

## CLAUDE.md paragraph (proposed, NOT applied -- LANES.md forbids editing the workspace CLAUDE.md from this lane)

> **`n8n-nodes-saltapp`** -- a standalone n8n community node package
> (`~/projects/salt/n8n-nodes-saltapp`, own git repo, MIT, not yet published)
> exposing Salt as a channel/tool in n8n: `Salt Trigger` (webhook, events
> message/chatOpened/cardInteraction/invoicePaid, HMAC-verified) and `Salt`
> (`usableAsTool: true`; message/card/payment/chat/agent resources, the last
> including an "Ask a Human and Wait" human-in-the-loop action bridged
> through the trigger's card_interaction handler since Salt has one callback
> per agent rather than n8n's usual per-request webhook). Zero runtime npm
> dependencies (n8n's verified-node rule): HMAC verification is
> `node:crypto`-only, and `openpgp` -- a devDependency -- is bundled into
> `dist/` at build time via esbuild rather than shipped as a dependency.

## What's new (user-facing candidate)

Internal only -- this is a new, unpublished integration package with no
Salt-side product surface change. Nothing to add to `salt-fe/src/whatsNew.js`
from this lane.
