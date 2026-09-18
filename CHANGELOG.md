# Changelog

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
