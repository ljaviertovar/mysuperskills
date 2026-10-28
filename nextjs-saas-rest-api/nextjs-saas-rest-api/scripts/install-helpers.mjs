#!/usr/bin/env node
// Copies the skill's shared HTTP helpers into a Next.js project so they don't have to be read and retyped.
//
//   node scripts/install-helpers.mjs <project-root> --profile minimal|full [--src-dir src] [--force]
//
// The profile is required on purpose: choose it after reading the application's context (SKILL.md, "Complexity
// budget"), and skip this script when the project already has equivalent helpers.
//   minimal  HTTP basics for a simple app: config, withApi, errors, request parsing, responses, pagination
//            helpers, logger, requireAuth, and a user-only principal.ts (no tenant concept).
//   full     Everything above, plus a principal.ts with tenantId, ETag and 304, deprecation headers,
//            idempotency, rate limit and fetchWithTimeout. Required by scaffold-resource.mjs.
// Never overwrites an existing file unless --force; skipped files are listed so they can be compared.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templates = join(skillDir, 'assets', 'templates');

// [template path relative to assets/templates, destination path relative to <src-dir>]
const MINIMAL = [
  ['config/api.ts', 'config/api.ts'],
  ['lib/api/auth.ts', 'lib/api/auth.ts'],
  ['lib/api/principal.minimal.ts', 'lib/api/principal.ts'],
  ['lib/api/errors.ts', 'lib/api/errors.ts'],
  ['lib/api/handler.ts', 'lib/api/handler.ts'],
  ['lib/api/logger.ts', 'lib/api/logger.ts'],
  ['lib/api/pagination.ts', 'lib/api/pagination.ts'],
  ['lib/api/request.ts', 'lib/api/request.ts'],
  ['lib/api/responses.ts', 'lib/api/responses.ts'],
  ['server/domain-errors.ts', 'server/domain-errors.ts'],
];
const FULL = [
  ...MINIMAL.filter(([from]) => from !== 'lib/api/principal.minimal.ts'),
  ['lib/api/principal.ts', 'lib/api/principal.ts'],
  ['lib/api/etag.ts', 'lib/api/etag.ts'],
  ['lib/api/deprecation.ts', 'lib/api/deprecation.ts'],
  ['lib/api/idempotency.ts', 'lib/api/idempotency.ts'],
  ['lib/api/rate-limit.ts', 'lib/api/rate-limit.ts'],
  ['server/outbound.ts', 'server/outbound.ts'],
];

const args = process.argv.slice(2);
const force = args.includes('--force');
const flagValue = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const profile = flagValue('profile');
const srcDir = flagValue('src-dir') ?? 'src';
const valueIndexes = new Set(['--profile', '--src-dir'].map((f) => args.indexOf(f) + 1).filter((i) => i > 0));
const root = args.find((a, i) => !a.startsWith('--') && !valueIndexes.has(i));

if (!root || !['minimal', 'full'].includes(profile ?? '')) {
  console.error(
    'Usage: node scripts/install-helpers.mjs <project-root> --profile minimal|full [--src-dir src] [--force]\n' +
      '  minimal: HTTP basics for a simple app (no tenants, no layers).\n' +
      '  full:    adds tenant principal, ETag, deprecation, idempotency, rate limit, outbound calls.\n' +
      'Choose after reading the application context (SKILL.md, "Complexity budget").',
  );
  process.exit(2);
}
const projectRoot = resolve(root);
mkdirSync(projectRoot, { recursive: true });

const copied = [];
const skipped = [];
for (const [from, to] of profile === 'full' ? FULL : MINIMAL) {
  const target = join(projectRoot, srcDir, to);
  if (existsSync(target) && !force) {
    skipped.push(relative(projectRoot, target));
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(templates, from), target);
  copied.push(relative(projectRoot, target));
}

const notes = [];
const pkgPath = join(projectRoot, 'package.json');
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of ['next', 'zod']) if (!deps[name]) notes.push(`Dependency "${name}" is not in package.json.`);
  if (deps.zod && /^[~^]?3\./.test(deps.zod)) {
    notes.push('Zod 3 detected: templates use Zod 4 syntax (references/stack-notes.md has the mapping).');
  }
} else {
  notes.push('No package.json found (fine when writing into an output folder; the target project needs next and zod).');
}
const tsconfigPath = join(projectRoot, 'tsconfig.json');
if (existsSync(tsconfigPath) && !/"@\/\*"\s*:/.test(readFileSync(tsconfigPath, 'utf8'))) {
  notes.push('tsconfig.json has no "@/*" path alias; the templates import from "@/...". Add it or rewrite the imports.');
}
notes.push(`Implement ${srcDir}/lib/api/principal.ts with the project's authentication: until then every protected endpoint answers 500 (fails closed).`);
notes.push(
  `Limits live in ${srcDir}/config/api.ts; every value can be overridden with an API_* environment variable (validated at startup). ` +
    (profile === 'minimal' ? 'Delete the groups this endpoint does not use. ' : '') +
    'Set API_ALLOWED_ORIGINS for cross-origin browser clients.',
);
if (profile === 'minimal') {
  notes.push('Minimal profile: write contract.ts and the routes by hand (patterns, "Minimal profile") against the project data access. Do not run scaffold-resource.mjs.');
}

console.log(`Profile: ${profile}`);
console.log(`Copied (${copied.length}):${copied.length ? '\n  ' + copied.join('\n  ') : ' none'}`);
if (skipped.length) console.log(`Skipped, already exist (${skipped.length}), compare them with the templates before reusing:\n  ${skipped.join('\n  ')}`);
console.log(`Notes:\n  - ${notes.join('\n  - ')}`);
