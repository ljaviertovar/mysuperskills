#!/usr/bin/env node
// FULL PROFILE ONLY. Generates a complete, compiling resource with service and repository layers, tenant scoping,
// cursor pagination and ETag from the skill's reference resource ("meal-plans"), renamed. Do not run it just
// because it is available: a simple CRUD app (single user or tenant, internal UI, no retries or concurrency
// concerns) uses the minimal profile instead (SKILL.md, "Complexity budget"). Requires:
//   node scripts/install-helpers.mjs <project-root> --profile full
//
//   node scripts/scaffold-resource.mjs <project-root> --name workout-sessions [--singular workout-session]
//                                       [--version 1] [--src-dir src] [--force]
//
// Files created (the route tree always lives under src/app/api/v{version}/):
//   src/app/api/v1/<name>/route.ts            GET list (cursor pagination) + POST create
//   src/app/api/v1/<name>/[id]/route.ts       GET one + PATCH (If-Match) + DELETE
//   src/app/api/v1/<name>/contract.ts         Zod schemas (params, query, cursor, bodies, DTO) + toDto
//   src/app/api/v1/<name>/route.test.ts       contract tests against the in-memory repository
//   src/server/<name>/model.ts                domain types
//   src/server/<name>/service.ts              business rules over the repository
//   src/server/<name>/repository.ts           interface + rules + stub to implement with the project's data layer
//   src/server/<name>/repository.memory.ts    in-memory implementation used by the tests
// Then: edit the fields in model.ts / contract.ts, implement repository.ts, run `tsc` and the tests.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templates = join(skillDir, 'assets', 'templates', 'resource');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const valueIndexes = new Set(['--name', '--singular', '--version', '--src-dir'].map((f) => args.indexOf(f) + 1).filter((i) => i > 0));
const root = args.find((a, i) => !a.startsWith('--') && !valueIndexes.has(i));
const name = flag('name');
const force = args.includes('--force');
const srcDir = flag('src-dir', 'src');
const version = Number(flag('version', '1'));

if (!root || !name || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name) || !Number.isInteger(version) || version < 1) {
  console.error('Usage: node scripts/scaffold-resource.mjs <project-root> --name <kebab-case-plural> [--singular <kebab>] [--version 1] [--src-dir src] [--force]');
  process.exit(2);
}

// kebab-plural -> kebab-singular (categories -> category, addresses -> address, sessions -> session).
function singularOf(plural) {
  const parts = plural.split('-');
  const last = parts.pop();
  const s = /ies$/.test(last) ? last.replace(/ies$/, 'y') : /(ss|sh|ch|x|z)es$/.test(last) ? last.replace(/es$/, '') : last.replace(/s$/, '');
  return [...parts, s].join('-');
}
const pluralKebab = name;
const singularKebab = flag('singular', singularOf(name));
const words = (kebab) => kebab.split('-');
const pascal = (kebab) => words(kebab).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const camel = (kebab) => pascal(kebab)[0].toLowerCase() + pascal(kebab).slice(1);
const human = (kebab) => { const t = words(kebab).join(' '); return t[0].toUpperCase() + t.slice(1); };

// Template token -> replacement. Plural forms first, so "meal-plans" never degrades into "meal-plan" + "s".
const replacements = [
  ['meal-plans', pluralKebab], ['meal_plans', pluralKebab.replaceAll('-', '_')],
  ['MealPlans', pascal(pluralKebab)], ['mealPlans', camel(pluralKebab)],
  ['meal-plan', singularKebab], ['meal_plan', singularKebab.replaceAll('-', '_')],
  ['MealPlan', pascal(singularKebab)], ['mealPlan', camel(singularKebab)],
  ['MEAL_PLAN', singularKebab.replaceAll('-', '_').toUpperCase()],
  ['Meal plan', human(singularKebab)], ['meal plan', words(singularKebab).join(' ')],
];
function rename(text) {
  let out = text;
  for (const [from, to] of replacements) out = out.replaceAll(from, to);
  // `api/v1` in paths and strings, `api\/v1` inside regex literals, `V1` in schema ids.
  if (version !== 1) out = out.replace(/api(\\?\/)v1\b/g, `api$1v${version}`).replace(/V1\b/g, `V${version}`);
  return out;
}

const apiDir = join(root, srcDir, 'app', 'api', `v${version}`, pluralKebab);
const serverDir = join(root, srcDir, 'server', pluralKebab);
const files = [
  ['route.collection.ts', join(apiDir, 'route.ts')],
  ['route.item.ts', join(apiDir, '[id]', 'route.ts')],
  ['contract.ts', join(apiDir, 'contract.ts')],
  ['route.test.ts', join(apiDir, 'route.test.ts')],
  ['model.ts', join(serverDir, 'model.ts')],
  ['service.ts', join(serverDir, 'service.ts')],
  ['repository.ts', join(serverDir, 'repository.ts')],
  ['repository.memory.ts', join(serverDir, 'repository.memory.ts')],
];

const created = [];
const skipped = [];
for (const [template, target] of files) {
  if (existsSync(target) && !force) {
    skipped.push(relative(root, target));
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, rename(readFileSync(join(templates, template), 'utf8')));
  created.push(relative(root, target));
}

console.log(`Resource "${pluralKebab}" (singular "${singularKebab}"), API version v${version}`);
console.log(`Created (${created.length}):${created.length ? '\n  ' + created.join('\n  ') : ' none'}`);
if (skipped.length) console.log(`Skipped, already exist (${skipped.length}):\n  ${skipped.join('\n  ')}`);
console.log(`Next:
  1. Edit the resource fields in ${srcDir}/server/${pluralKebab}/model.ts and ${srcDir}/app/api/v${version}/${pluralKebab}/contract.ts (the sample has name, starts_on, notes, status).
  2. Implement createXRepository in ${srcDir}/server/${pluralKebab}/repository.ts for the project's data layer, following the rules in its header.
  3. Update ${srcDir}/server/${pluralKebab}/service.ts business rules and the sample tests; run tsc and the tests.`);
