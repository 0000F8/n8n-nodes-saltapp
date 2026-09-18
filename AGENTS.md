# n8n community node

## Overview
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

## Important notes
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

## Project structure
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

## Key guidelines
- Use the `n8n-node` CLI tool **whenever possible** for building, dev mode,
  linting, etc.
- **Always** address any lint/typecheck errors/warnings, unless there is a
  **very specific reason** to ignore/disable it
- Make sure to use **proper types whenever possible**
- If you are updating the npm package version, make sure to **update
  CHANGELOG.md** in the root of the repository
- Read `.agents/workflow.md` for more info

## Context-specific docs
Load these before working on the relevant area:

| Working on...                        | Read first                                                          |
|--------------------------------------|---------------------------------------------------------------------|
| Any node file in `nodes/`            | `.agents/nodes.md` and `.agents/properties.md`                      |
| A declarative-style node             | above + `.agents/nodes-declarative.md`                              |
| A programmatic-style node            | above + `.agents/nodes-programmatic.md`                             |
| Files in `credentials/`              | `.agents/credentials.md`                                            |
| Adding a new version to a node       | `.agents/versioning.md`                                             |
| Starting a new task or planning      | `.agents/workflow.md`                                               |

## Additional resources
If you need any extra information, here are links to n8n's official docs
regarding building community nodes:
- https://docs.n8n.io/integrations/community-nodes/build-community-nodes/
- https://docs.n8n.io/integrations/creating-nodes/overview/
- https://docs.n8n.io/integrations/creating-nodes/build/reference/
- https://docs.n8n.io/integrations/creating-nodes/build/reference/ux-guidelines/

## What this specific package is (Salt-specific)
Everything above is n8n's own generic guidance for the CLI scaffold. This
section is what's specific to `n8n-nodes-saltapp`. Read HANDOFF.md too --
it has the full reasoning for the decisions summarized here.

- **Salt** (https://saltapp.ai) is an end-to-end encrypted chat where humans
  and AI agents are the same kind of contact. This package lets an n8n
  workflow act as one side of a Salt agent.
- **Zero runtime dependencies, on purpose**: n8n's verified-community-node
  rules forbid them. `node:crypto`-only signature verification lives in
  `nodes/shared/signature.ts`. `openpgp` (a real dependency of PGP
  encrypt/decrypt, which cannot be responsibly hand-rolled) is a
  `devDependency` only, bundled into `dist/nodes/shared/pgp.js` by
  `scripts/bundle-pgp.mjs` as the last step of `npm run build`. If you touch
  `nodes/shared/pgp.ts`, re-run `npm run build` and check
  `grep -c "require(\"openpgp\")" dist/nodes/shared/pgp.js` is `0` before
  considering it done.
- **Protocol reference**: everything about how Salt's webhooks are signed,
  how PGP messages are shaped, and what each REST endpoint expects is read
  directly from `salt-agent-sdk`'s source
  (`/Users/z1ggy/projects/salt/salt-agent-sdk/src/{webhook,crypto,client}.ts`)
  and from `salt-api`'s own Rails controllers
  (`/Users/z1ggy/projects/salt/salt-api/app/controllers/api/v1/`,
  `app/jobs/*_job.rb`) -- not guessed. If Salt's API changes, those are the
  files to re-check.
- **`nodes/shared/`** holds everything shared between the two node files
  (PGP, signature verification, the REST request-shaping functions, the
  "Ask a Human and Wait" resume-token encode/decode) so it's includable
  under `tsconfig.json`'s `nodes/**/*` glob without editing that file, and
  so the pure parts are unit-testable (`test/*.test.ts`, run with
  `npm test`) without an n8n execution context.
- **"Ask a Human and Wait"** is the one genuinely subtle piece --
  read its README.md section and `nodes/shared/resumeToken.ts`'s header
  comment before changing it. Salt has one callback per agent, not one per
  request, so resuming a specific paused execution needs a bridge through
  the Salt Trigger node.
