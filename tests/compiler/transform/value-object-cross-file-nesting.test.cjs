'use strict';

// Regression coverage for a ValueObject class (e.g. a validators package's
// `FullName`/`Email`) used only as a NESTED property inside another type
// (interface, type alias, class) — where the file consuming that container
// type never itself imports the ValueObject class by name. Before this fix,
// `resolveCrossFileClassReference` only looked at the CURRENT file's own
// import declarations for a named binding of the class; when the consuming
// file only imported the container type (commonly `import type { Dto } from
// '...'`), the class reference could not be found, and the compiler silently
// fell back to `{ kind: 'unknown' }` for that property — no construction, no
// validation, no diagnostic. See `value-object-embedding.test.cjs` for the
// single-file / direct-import baseline this suite extends.

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { analyzeProject } = require('../../../dist/compiler/analysis');
const { createContractTransformer } = require('../../../dist/compiler/transform');

const runtimeModule = join(__dirname, '../../../dist/runtime');
const runtimeIndex = join(runtimeModule, 'index.js');

function emitProject(files, { esm = false } = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-value-object-nesting-'));
  const sourceRoot = join(projectRoot, 'src');
  const tsTypedRoot = join(projectRoot, 'node_modules', 'ts-typed');
  const compilerRoot = join(projectRoot, 'node_modules', '@ts-typed', 'core');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(tsTypedRoot, { recursive: true });
  mkdirSync(join(compilerRoot, 'dist', 'runtime'), { recursive: true });

  writeFileSync(
    join(tsTypedRoot, 'index.d.ts'),
    [
      'export class StrictTypeError extends TypeError {',
      '  readonly contractKind: string;',
      '  readonly operation: string;',
      '  readonly propertyPath: string;',
      '}',
    ].join('\n'),
  );
  writeFileSync(
    join(compilerRoot, 'package.json'),
    JSON.stringify(
      esm
        ? {
          name: '@ts-typed/core',
          type: 'commonjs',
          exports: { '.': { types: './dist/index.d.ts', import: './dist/index.mjs' } },
        }
        : { name: '@ts-typed/core', main: 'dist/index.js', types: 'dist/index.d.ts' },
    ),
  );
  if (esm) {
    writeFileSync(
      join(compilerRoot, 'dist', 'index.mjs'),
      [
        "import { createRequire } from 'node:module';",
        `const runtime = createRequire(import.meta.url)(${JSON.stringify(runtimeIndex)});`,
        'export const ValueObject = runtime.ValueObject;',
        'export const StrictTypeError = runtime.StrictTypeError;',
        '',
      ].join('\n'),
    );
  } else {
    writeFileSync(
      join(compilerRoot, 'dist', 'index.js'),
      `module.exports = require(${JSON.stringify(runtimeIndex)});\n`,
    );
  }
  writeFileSync(
    join(compilerRoot, 'dist', 'index.d.ts'),
    "export { ValueObject } from './runtime/value-object.class';\n",
  );
  writeFileSync(
    join(compilerRoot, 'dist', 'runtime', 'value-object.class.d.ts'),
    [
      'export declare abstract class ValueObject extends String {',
      '  protected constructor(raw: string, context?: unknown);',
      '  protected abstract isValid(raw: string): boolean;',
      '  toJSON(): string;',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(sourceRoot, 'globals.d.ts'),
    'declare const process: { stdout: { write(chunk: string): boolean } };\n',
  );
  writeFileSync(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: esm ? 'ESNext' : 'CommonJS',
        moduleResolution: esm ? 'Bundler' : 'Node',
        rootDir: './src',
        outDir: './out',
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  if (esm) {
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }));
  }
  for (const [relativePath, source] of Object.entries(files)) {
    const absolutePath = join(sourceRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, source);
  }

  const analysis = analyzeProject({ tsconfigPath: join(projectRoot, 'tsconfig.json') });
  assert.equal(
    analysis.tsDiagnostics.length,
    0,
    analysis.tsDiagnostics.map((diagnostic) => diagnostic.messageText).join('\n'),
  );
  const diagnostics = [];
  const emitResult = analysis.program.emit(
    undefined,
    undefined,
    undefined,
    false,
    {
      before: [
        createContractTransformer({
          analysis,
          runtimeModule: esm ? runtimeIndex : runtimeModule,
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      ],
    },
  );
  assert.equal(emitResult.emitSkipped, false);
  return { projectRoot, outputRoot: join(projectRoot, 'out'), diagnostics, emitted: emitResult };
}

const VALUE_OBJECTS = [
  "import { ValueObject } from '@ts-typed/core';",
  'export class CPF extends ValueObject {',
  '  protected isValid(raw: string): boolean { return raw.length === 11; }',
  "  public masked(): string { return '***' + this.toString().slice(-2); }",
  '}',
  'export class Code extends ValueObject {',
  "  protected isValid(raw: string): boolean { return raw.startsWith('A'); }",
  "  public tagged(): string { return 'code:' + this.toString(); }",
  '}',
].join('\n');

function runProject(files, entryRelativePath, options = {}) {
  const project = emitProject(files, options);
  const result = spawnSync(process.execPath, [join(project.outputRoot, entryRelativePath)], {
    cwd: project.projectRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return { out: JSON.parse(result.stdout), diagnostics: project.diagnostics };
}

test('an interface declared (and its ValueObject imported) in one file auto-constructs when used as a parameter type in a DIFFERENT file that never imports the ValueObject', () => {
  const { out } = runProject(
    {
      'value-objects.ts': VALUE_OBJECTS,
      'dto.ts': [
        "import { CPF } from './value-objects';",
        'export interface SearchDto { cpf: CPF; label: string; }',
      ].join('\n'),
      'app.ts': [
        "import type { SearchDto } from './dto';",
        'function search(input: SearchDto): { isObject: boolean; masked: string } {',
        "  return { isObject: typeof input.cpf === 'object', masked: input.cpf.masked() };",
        '}',
        "process.stdout.write(JSON.stringify(search({ cpf: '12345678901', label: 'x' } as any)));",
      ].join('\n'),
    },
    'app.js',
  );
  assert.deepEqual(out, { isObject: true, masked: '***01' });
});

test('an invalid raw string on a cross-file-nested ValueObject property still throws StrictTypeError, not a silent pass-through', () => {
  const { out } = runProject(
    {
      'value-objects.ts': VALUE_OBJECTS,
      'dto.ts': [
        "import { CPF } from './value-objects';",
        'export interface SearchDto { cpf: CPF; }',
      ].join('\n'),
      'app.ts': [
        "import { StrictTypeError } from 'ts-typed';",
        "import type { SearchDto } from './dto';",
        'function search(input: SearchDto): string { return input.cpf.masked(); }',
        'let outcome = "none";',
        "try { search({ cpf: '123' } as any); } catch (error) { outcome = error instanceof StrictTypeError ? 'StrictTypeError' : 'other'; }",
        'process.stdout.write(JSON.stringify({ outcome }));',
      ].join('\n'),
    },
    'app.js',
  );
  assert.deepEqual(out, { outcome: 'StrictTypeError' });
});

test('the same cross-file nesting scenario works unchanged under ESM output', () => {
  const { out } = runProject(
    {
      'value-objects.ts': VALUE_OBJECTS,
      'dto.ts': [
        "import { CPF } from './value-objects.js';",
        'export interface SearchDto { cpf: CPF; }',
      ].join('\n'),
      'app.ts': [
        "import type { SearchDto } from './dto.js';",
        'function search(input: SearchDto): string { return input.cpf.masked(); }',
        "process.stdout.write(JSON.stringify({ masked: search({ cpf: '12345678901' } as any) }));",
      ].join('\n'),
    },
    'app.js',
    { esm: true },
  );
  assert.deepEqual(out, { masked: '***01' });
});

test('a type alias (not an interface) carrying a nested ValueObject also auto-constructs across files', () => {
  const { out } = runProject(
    {
      'value-objects.ts': VALUE_OBJECTS,
      'dto.ts': [
        "import { CPF } from './value-objects';",
        'export type SearchDto = { cpf: CPF };',
      ].join('\n'),
      'app.ts': [
        "import type { SearchDto } from './dto';",
        'function search(input: SearchDto): string { return input.cpf.masked(); }',
        "process.stdout.write(JSON.stringify({ masked: search({ cpf: '12345678901' } as any) }));",
      ].join('\n'),
    },
    'app.js',
  );
  assert.deepEqual(out, { masked: '***01' });
});

test('a class (not an interface) carrying a nested ValueObject field auto-constructs across files', () => {
  const { out } = runProject(
    {
      'value-objects.ts': VALUE_OBJECTS,
      'dto.ts': [
        "import { CPF } from './value-objects';",
        'export class SearchDto { cpf!: CPF; }',
      ].join('\n'),
      'app.ts': [
        "import type { SearchDto } from './dto';",
        'function search(input: SearchDto): string { return input.cpf.masked(); }',
        "const dto = { cpf: '12345678901' } as any;",
        'process.stdout.write(JSON.stringify({ masked: search(dto) }));',
      ].join('\n'),
    },
    'app.js',
  );
  assert.deepEqual(out, { masked: '***01' });
});

test('an interface nested two levels deep (outer interface holds an inner interface holding the ValueObject) auto-constructs across files', () => {
  const { out } = runProject(
    {
      'value-objects.ts': VALUE_OBJECTS,
      'dto.ts': [
        "import { CPF } from './value-objects';",
        'export interface Identity { cpf: CPF; }',
        'export interface SearchDto { identity: Identity; label: string; }',
      ].join('\n'),
      'app.ts': [
        "import type { SearchDto } from './dto';",
        'function search(input: SearchDto): string { return input.identity.cpf.masked(); }',
        "const dto = { identity: { cpf: '12345678901' }, label: 'x' } as any;",
        'process.stdout.write(JSON.stringify({ masked: search(dto) }));',
      ].join('\n'),
    },
    'app.js',
  );
  assert.deepEqual(out, { masked: '***01' });
});

test('a union of two interfaces, each nesting a different ValueObject, auto-constructs whichever member matches across files', () => {
  const { out } = runProject(
    {
      'value-objects.ts': VALUE_OBJECTS,
      'dto.ts': [
        "import { CPF, Code } from './value-objects';",
        'export interface ByCpf { kind: "cpf"; cpf: CPF; }',
        'export interface ByCode { kind: "code"; code: Code; }',
        'export type SearchDto = ByCpf | ByCode;',
      ].join('\n'),
      'app.ts': [
        "import type { SearchDto } from './dto';",
        'function describe(input: SearchDto): string {',
        "  return input.kind === 'cpf' ? input.cpf.masked() : input.code.tagged();",
        '}',
        "const byCpf = { kind: 'cpf', cpf: '12345678901' } as any;",
        "const byCode = { kind: 'code', code: 'Axyz' } as any;",
        'process.stdout.write(JSON.stringify({ cpf: describe(byCpf), code: describe(byCode) }));',
      ].join('\n'),
    },
    'app.js',
  );
  assert.deepEqual(out, { cpf: '***01', code: 'code:Axyz' });
});

test('an intersection of two interfaces nesting different ValueObjects auto-constructs both across files', () => {
  const { out } = runProject(
    {
      'value-objects.ts': VALUE_OBJECTS,
      'dto.ts': [
        "import { CPF, Code } from './value-objects';",
        'export interface HasCpf { cpf: CPF; }',
        'export interface HasCode { code: Code; }',
        'export type SearchDto = HasCpf & HasCode;',
      ].join('\n'),
      'app.ts': [
        "import type { SearchDto } from './dto';",
        'function describe(input: SearchDto): string { return input.cpf.masked() + "|" + input.code.tagged(); }',
        "const dto = { cpf: '12345678901', code: 'Axyz' } as any;",
        'process.stdout.write(JSON.stringify({ out: describe(dto) }));',
      ].join('\n'),
    },
    'app.js',
  );
  assert.deepEqual(out, { out: '***01|code:Axyz' });
});

test('an array of a nested-DTO type auto-constructs the ValueObject in every element across files', () => {
  const { out } = runProject(
    {
      'value-objects.ts': VALUE_OBJECTS,
      'dto.ts': [
        "import { CPF } from './value-objects';",
        'export interface Item { cpf: CPF; }',
      ].join('\n'),
      'app.ts': [
        "import type { Item } from './dto';",
        'function maskAll(items: Item[]): string[] { return items.map((item) => item.cpf.masked()); }',
        "const items = [{ cpf: '12345678901' }, { cpf: '10987654321' }] as any;",
        'process.stdout.write(JSON.stringify(maskAll(items)));',
      ].join('\n'),
    },
    'app.js',
  );
  assert.deepEqual(out, ['***01', '***21']);
});

test('a tuple holding a nested-DTO type auto-constructs the ValueObject across files', () => {
  const { out } = runProject(
    {
      'value-objects.ts': VALUE_OBJECTS,
      'dto.ts': [
        "import { CPF } from './value-objects';",
        'export interface Item { cpf: CPF; }',
      ].join('\n'),
      'app.ts': [
        "import type { Item } from './dto';",
        'function maskFirst(pair: [Item, string]): string { return pair[0].cpf.masked(); }',
        "process.stdout.write(JSON.stringify({ masked: maskFirst([{ cpf: '12345678901' }, 'tag'] as any) }));",
      ].join('\n'),
    },
    'app.js',
  );
  assert.deepEqual(out, { masked: '***01' });
});

test('a Map value type holding a nested-DTO type auto-constructs the ValueObject across files', () => {
  const { out } = runProject(
    {
      'value-objects.ts': VALUE_OBJECTS,
      'dto.ts': [
        "import { CPF } from './value-objects';",
        'export interface Item { cpf: CPF; }',
      ].join('\n'),
      'app.ts': [
        "import type { Item } from './dto';",
        'function maskOne(entries: Map<string, Item>): string {',
        "  return entries.get('a')!.cpf.masked();",
        '}',
        "const entries = new Map([['a', { cpf: '12345678901' }]]) as any;",
        'process.stdout.write(JSON.stringify({ masked: maskOne(entries) }));',
      ].join('\n'),
    },
    'app.js',
  );
  assert.deepEqual(out, { masked: '***01' });
});

test('a Set item type holding a nested-DTO type auto-constructs the ValueObject across files', () => {
  const { out } = runProject(
    {
      'value-objects.ts': VALUE_OBJECTS,
      'dto.ts': [
        "import { CPF } from './value-objects';",
        'export interface Item { cpf: CPF; }',
      ].join('\n'),
      'app.ts': [
        "import type { Item } from './dto';",
        'function maskFirst(items: Set<Item>): string {',
        '  for (const item of items) { return item.cpf.masked(); }',
        "  return '';",
        '}',
        "const items = new Set([{ cpf: '12345678901' }]) as any;",
        'process.stdout.write(JSON.stringify({ masked: maskFirst(items) }));',
      ].join('\n'),
    },
    'app.js',
  );
  assert.deepEqual(out, { masked: '***01' });
});

test('two different ValueObjects nested in the same cross-file DTO both auto-construct independently', () => {
  const { out } = runProject(
    {
      'value-objects.ts': VALUE_OBJECTS,
      'dto.ts': [
        "import { CPF, Code } from './value-objects';",
        'export interface SearchDto { cpf: CPF; code: Code; }',
      ].join('\n'),
      'app.ts': [
        "import type { SearchDto } from './dto';",
        'function describe(input: SearchDto): string { return input.cpf.masked() + "|" + input.code.tagged(); }',
        "const dto = { cpf: '12345678901', code: 'Axyz' } as any;",
        'process.stdout.write(JSON.stringify({ out: describe(dto) }));',
      ].join('\n'),
    },
    'app.js',
  );
  assert.deepEqual(out, { out: '***01|code:Axyz' });
});

test('a ValueObject reached through a barrel re-export is still found and auto-constructs across files', () => {
  const { out } = runProject(
    {
      'value-objects.ts': VALUE_OBJECTS,
      'barrel.ts': "export { CPF } from './value-objects';",
      'dto.ts': [
        "import { CPF } from './barrel';",
        'export interface SearchDto { cpf: CPF; }',
      ].join('\n'),
      'app.ts': [
        "import type { SearchDto } from './dto';",
        'function search(input: SearchDto): string { return input.cpf.masked(); }',
        "process.stdout.write(JSON.stringify({ masked: search({ cpf: '12345678901' } as any) }));",
      ].join('\n'),
    },
    'app.js',
  );
  assert.deepEqual(out, { masked: '***01' });
});

test('the relocated import specifier is recomputed correctly when the consuming file sits at a different folder depth than the file that imports the ValueObject', () => {
  const { out } = runProject(
    {
      'value-objects.ts': VALUE_OBJECTS,
      'dto/search-dto.ts': [
        "import { CPF } from '../value-objects';",
        'export interface SearchDto { cpf: CPF; }',
      ].join('\n'),
      'handlers/api/search-handler.ts': [
        "import type { SearchDto } from '../../dto/search-dto';",
        'export function search(input: SearchDto): string { return input.cpf.masked(); }',
      ].join('\n'),
      'app.ts': [
        "import { search } from './handlers/api/search-handler';",
        "process.stdout.write(JSON.stringify({ masked: search({ cpf: '12345678901' } as any) }));",
      ].join('\n'),
    },
    'app.js',
  );
  assert.deepEqual(out, { masked: '***01' });
});

test('a mapped/generic container type (Record<string, Dto>) over a cross-file nested DTO auto-constructs the ValueObject in every value', () => {
  const { out } = runProject(
    {
      'value-objects.ts': VALUE_OBJECTS,
      'dto.ts': [
        "import { CPF } from './value-objects';",
        'export interface SearchDto { cpf: CPF; }',
      ].join('\n'),
      'app.ts': [
        "import type { SearchDto } from './dto';",
        'function maskAll(byLabel: Record<string, SearchDto>): string[] {',
        '  return Object.values(byLabel).map((dto) => dto.cpf.masked());',
        '}',
        "const byLabel = { a: { cpf: '12345678901' }, b: { cpf: '10987654321' } } as any;",
        'process.stdout.write(JSON.stringify(maskAll(byLabel)));',
      ].join('\n'),
    },
    'app.js',
  );
  assert.deepEqual(out, ['***01', '***21']);
});

test('a ValueObject that is never imported or re-exported by name anywhere in the whole program still degrades to no check and reports a diagnostic (no false fix from the cross-file fallback)', () => {
  const project = emitProject({
    'value-objects.ts': [
      VALUE_OBJECTS,
      'export function makeCpf(raw: string): CPF { return raw as any; }',
    ].join('\n'),
    'dto.ts': [
      "import { makeCpf } from './value-objects';",
      'export function buildDto(raw: string) { return { cpf: makeCpf(raw) }; }',
    ].join('\n'),
    'app.ts': [
      "import { buildDto } from './dto';",
      "const dto = buildDto('12345678901');",
      'process.stdout.write(JSON.stringify({ masked: dto.cpf.masked() }));',
    ].join('\n'),
  });
  const result = spawnSync(process.execPath, [join(project.outputRoot, 'app.js')], {
    cwd: project.projectRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { masked: '***01' });
  const limit = project.diagnostics.find((diagnostic) => diagnostic.name === 'CPF');
  assert.ok(limit, 'expected a limitation diagnostic for CPF even though the overall program still ran correctly');
});
