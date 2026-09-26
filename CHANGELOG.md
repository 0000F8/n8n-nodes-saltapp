# Changelog

## 0.2.1

`POST /api/v1/cards` answers the card's chat bubble (`message_id`, `resource_id`,
`resource.id`), never a top-level `id`; Ask a Human and Wait's timeout output read
`card.id` and reported `cardId: undefined` since 0.1.0. `cardIdFromPostCardResponse()`
now reads the real shape, with tests that include a decoy top-level `id`. Audit of
the shared-outbox race the other Salt tool hosts fixed today: it never applied here,
because a paused execution resumes through a self-contained per-ask token delivered
by Salt's ordinary webhook callback, and nothing in this package reads
`GET /api/v1/agent/updates`. README says so under "Concurrency".

## 0.2.0

Open rooms (salt-api, `lane/open-rooms`): a chat can now be an unencrypted,
plain-text **open room** instead of the usual PGP-encrypted kind, decided
once at creation. This package adapts to whichever a chat is, on both
nodes, with no configuration required:

- **Salt Trigger**, "New Message": a plain-text open-room post is passed
  through at `message.text` the same way a decrypted one is -- no PGP
  attempted on it. The output also carries `encrypted` (boolean) and, for
  an open-room delivery, `delivered_because` (`"mention"`/`"reply"`/
  `"keyword"`/`"all"`).
- **Salt**, Message > Send: looks the chat up first (as before) and posts
  plain text with no encryption step for an open room, the existing
  encrypt-and-post path for an encrypted chat.
- **Salt**, Message > List Recent: an open room's messages land at `text`
  as plain text instead of attempting (and always failing) a PGP decrypt.
- **Salt**, Chat resource: new Get Interests / Set Interests / Clear
  Interests operations (`GET`/`PUT`/`DELETE /api/v1/chats/:id/subscription`)
  -- an agent's own follow setting (addressed / keywords / all) for an open
  room. Refused on an encrypted chat, which has nothing to tune.
- New `nodes/shared/openRooms.ts` -- pure encrypted/open and
  delivered-because branching logic, unit-tested independently of any n8n
  execution context (`test/openRooms.test.ts`), the same pattern as
  `pgp.ts`/`SaltApiClient.ts`.
- Still zero runtime dependencies, still no polling: the trigger stays a
  webhook (`checked: grep -rniE '\bpoll(ing)?\b|setInterval|pollTimes'` over
  `nodes/` turns up nothing but a comment).

## 0.1.0

Initial release.

- **Salt Trigger**: webhook-based trigger. Activation sets the agent's
  `callback` via `PATCH /api/v1/agents/callback`; events are New Message
  (decrypted), Chat Opened, Card Button Tapped, and Invoice Paid. Every
  delivery's HMAC signature is verified before the workflow runs.
- **Salt** (action, `usableAsTool: true`): Message (send / list), Card (post
  / update), Payment (request payment / send invoice), Chat (get), Agent
  (ask a human and wait).
- Credential `Salt App API`: host, agent id, api key, PGP private key +
  passphrase. No static webhook-signing-secret field -- fetched dynamically,
  same as `salt-agent-sdk`.
- Zero runtime npm dependencies: HMAC verification uses `node:crypto` only;
  `openpgp` is a devDependency bundled into `dist/nodes/shared/pgp.js` at
  build time (see HANDOFF.md).
