#!/usr/bin/env node
// Inlines `openpgp` into the one compiled file that imports it, so the
// shipped npm package needs nothing from node_modules at install/runtime --
// see nodes/shared/pgp.ts's header comment and HANDOFF.md for why. Runs
// after `n8n-node build` (which is plain `tsc` + asset copy, no bundling of
// its own) as part of `npm run build`.
//
// `openpgp` itself has zero runtime dependencies of its own (checked via
// `npm view openpgp dependencies` before this was written), so this bundle
// is self-contained -- nothing transitive to worry about.
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'dist', 'nodes', 'shared', 'pgp.js');

if (!existsSync(entry)) {
	console.error(`bundle-pgp: expected ${entry} to exist after "n8n-node build" -- did the build step run first?`);
	process.exit(1);
}

await build({
	entryPoints: [entry],
	outfile: entry,
	allowOverwrite: true,
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node18',
	// n8n-workflow is provided by the n8n runtime itself, never bundled or
	// shipped -- it's a peerDependency, not something this file imports
	// anyway, but kept external defensively if that ever changes.
	external: ['n8n-workflow'],
	logLevel: 'warning',
});

console.log(`bundle-pgp: inlined openpgp into ${path.relative(process.cwd(), entry)}`);
