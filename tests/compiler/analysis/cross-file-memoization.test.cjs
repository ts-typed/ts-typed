'use strict';

// Regression coverage for Spec 1 (performance), item 3: cross-file schema
// memoization by `ts.Type` identity. `TypeSchemaResolver` is instantiated
// ONCE per `ts.Program` (see `analyzeProject`) and already caches a resolved
// object/class/interface definition by `ts.Type` identity in
// `_definitionResolutions` (see `type-schema-resolver.ts`). Since the
// TypeScript checker reuses the same `ts.Type` object for identical generic
// instantiations within one `ts.Program`, the same `Repository<User>` used
// in two different files of the same build already shares one resolved
// schema — this test proves that behavior holds, rather than re-implementing
// a cache that already exists.

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, relative } = require('node:path');
const test = require('node:test');

const { analyzeProject } = require('../../../dist/compiler/analysis');

function createProject() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-cross-file-memo-'));
  const sourceRoot = join(projectRoot, 'src');
  mkdirSync(sourceRoot, { recursive: true });

  writeFileSync(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'CommonJS', skipLibCheck: true },
      include: ['src/**/*.ts'],
    }),
  );
  writeFileSync(
    join(sourceRoot, 'repository.ts'),
    [
      'export interface IUser { id: string; name: string; }',
      'export interface Repository<T> { get(id: string): T; save(item: T): void; }',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(sourceRoot, 'a.ts'),
    [
      "import type { IUser, Repository } from './repository';",
      'export function useInA(repo: Repository<IUser>): IUser { return repo.get("1"); }',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(sourceRoot, 'b.ts'),
    [
      "import type { IUser, Repository } from './repository';",
      'export function useInB(repo: Repository<IUser>): void { repo.save({ id: "1", name: "x" }); }',
      '',
    ].join('\n'),
  );

  return { tsconfigPath: join(projectRoot, 'tsconfig.json') };
}

test('resolves the same generic instantiation used across files to one shared definition', () => {
  const project = createProject();
  const result = analyzeProject({ tsconfigPath: relative(process.cwd(), project.tsconfigPath) });

  assert.equal(result.tsDiagnostics.length, 0);

  const contracts = [...result.contracts.values()];
  const repoParamA = contracts.find((c) => c.file.endsWith('a.ts') && c.kind === 'parameter');
  const repoParamB = contracts.find((c) => c.file.endsWith('b.ts') && c.kind === 'parameter');
  assert.ok(repoParamA, 'expected a Repository<IUser> parameter contract in a.ts');
  assert.ok(repoParamB, 'expected a Repository<IUser> parameter contract in b.ts');

  assert.equal(repoParamA.resolution.schema?.kind, 'ref');
  assert.equal(repoParamB.resolution.schema?.kind, 'ref');
  // Same generic instantiation, same `ts.Type` identity inside one
  // `ts.Program` -> same definition name, no independently-recomputed,
  // collision-suffixed duplicate (`Repository<IUser>#2`).
  assert.equal(repoParamA.resolution.schema.name, repoParamB.resolution.schema.name);

  const definitions = result.resolver.getDefinitions();
  const matchingNames = Object.keys(definitions).filter((name) => name.startsWith('Repository<'));
  assert.deepEqual(matchingNames, [repoParamA.resolution.schema.name]);
});
