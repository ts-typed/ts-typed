'use strict';

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

// The `@AggregateErrors()` decorator's provenance check (mirroring the
// ValueObject one in value-object-embedding.test.cjs) requires its
// declaration to live under a `.../@ts-typed/core/.../runtime/
// aggregate-errors.decorator.d.ts` path, the same way a real installed copy
// of this package would be laid out. The friendlier `ts-typed` package only
// re-exports the error classes used for type-checking the fixture; the
// decorator itself is imported straight from `@ts-typed/core`, same as
// `ValueObject` is in the value-object fixture.
function writeProject(files) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-aggregate-errors-'));
  const sourceRoot = join(projectRoot, 'src');
  const tsTypedRoot = join(projectRoot, 'node_modules', 'ts-typed');
  const compilerRoot = join(projectRoot, 'node_modules', '@ts-typed', 'core');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(tsTypedRoot, { recursive: true });
  mkdirSync(join(compilerRoot, 'dist', 'runtime'), { recursive: true });

  writeFileSync(
    join(tsTypedRoot, 'index.d.ts'),
    [
      'export class StrictTypeError extends TypeError {}',
      'export class AggregateStrictTypeError extends StrictTypeError {',
      '  readonly errors: readonly { propertyPath: string }[];',
      '}',
      'export class ArrayAggregateStrictTypeError extends StrictTypeError {',
      '  readonly errors: readonly AggregateStrictTypeError[];',
      '}',
    ].join('\n'),
  );
  writeFileSync(
    join(compilerRoot, 'package.json'),
    JSON.stringify({ name: '@ts-typed/core', main: 'dist/index.js', types: 'dist/index.d.ts' }),
  );
  writeFileSync(
    join(compilerRoot, 'dist', 'index.js'),
    `module.exports = require(${JSON.stringify(runtimeIndex)});\n`,
  );
  writeFileSync(
    join(compilerRoot, 'dist', 'index.d.ts'),
    "export { AggregateErrors } from './runtime/aggregate-errors.decorator';\n",
  );
  writeFileSync(
    join(compilerRoot, 'dist', 'runtime', 'aggregate-errors.decorator.d.ts'),
    'export declare function AggregateErrors(): ClassDecorator;\n',
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
        module: 'CommonJS',
        moduleResolution: 'Node',
        rootDir: './src',
        outDir: './out',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  for (const [relativePath, source] of Object.entries(files)) {
    const absolutePath = join(sourceRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, source);
  }
  return { projectRoot, tsconfigPath: join(projectRoot, 'tsconfig.json') };
}

function emitProject(files) {
  const project = writeProject(files);
  const analysis = analyzeProject({ tsconfigPath: project.tsconfigPath });
  assert.equal(
    analysis.tsDiagnostics.length,
    0,
    analysis.tsDiagnostics.map((diagnostic) => diagnostic.messageText).join('\n'),
  );
  const emitResult = analysis.program.emit(
    undefined,
    undefined,
    undefined,
    false,
    {
      before: [
        createContractTransformer({
          analysis,
          runtimeModule,
          onDiagnostic: () => undefined,
        }),
      ],
    },
  );
  assert.equal(emitResult.emitSkipped, false);
  return { ...project, outputRoot: join(project.projectRoot, 'out') };
}

function runMain(files) {
  const project = emitProject(files);
  const result = spawnSync(process.execPath, [join(project.outputRoot, 'main.js')], {
    cwd: project.projectRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('a plain object literal (never instantiated) crossing a parameter typed by a cross-file @AggregateErrors() DTO is fully aggregated', () => {
  const result = runMain({
    'dto.ts': [
      "import { AggregateErrors } from '@ts-typed/core';",
      '',
      '@AggregateErrors()',
      'export class CreateUserDto {',
      "  name: string = '';",
      '  age: number = 0;',
      '}',
    ].join('\n'),
    'main.ts': [
      "import { AggregateStrictTypeError } from 'ts-typed';",
      "import { CreateUserDto } from './dto';",
      '',
      'function createUser(dto: CreateUserDto): void { /* noop */ }',
      '',
      'let caught: any = undefined;',
      'try {',
      "  createUser({ name: 42, age: 'old' } as any);",
      '} catch (error) {',
      '  caught = error;',
      '}',
      'const results = {',
      '  isAggregate: caught instanceof AggregateStrictTypeError,',
      '  errorCount: caught === undefined ? 0 : caught.errors.length,',
      '  paths: caught === undefined ? [] : caught.errors.map((e: any) => e.propertyPath),',
      '};',
      'process.stdout.write(JSON.stringify(results));',
    ].join('\n'),
  });

  assert.equal(result.isAggregate, true, JSON.stringify(result));
  assert.equal(result.errorCount, 2, JSON.stringify(result));
  assert.ok(result.paths.some((path) => path.endsWith('.name')), JSON.stringify(result));
  assert.ok(result.paths.some((path) => path.endsWith('.age')), JSON.stringify(result));
});

test('a plain object literal crossing a parameter typed by an undecorated cross-file DTO stays fail-fast', () => {
  const result = runMain({
    'dto.ts': [
      'export class PlainDto {',
      "  name: string = '';",
      '  age: number = 0;',
      '}',
    ].join('\n'),
    'main.ts': [
      "import { StrictTypeError, AggregateStrictTypeError } from 'ts-typed';",
      "import { PlainDto } from './dto';",
      '',
      'function createUser(dto: PlainDto): void { /* noop */ }',
      '',
      'let caught: any = undefined;',
      'try {',
      "  createUser({ name: 42, age: 'old' } as any);",
      '} catch (error) {',
      '  caught = error;',
      '}',
      'const results = {',
      '  isStrictTypeError: caught instanceof StrictTypeError,',
      '  isAggregate: caught instanceof AggregateStrictTypeError,',
      '};',
      'process.stdout.write(JSON.stringify(results));',
    ].join('\n'),
  });

  assert.equal(result.isStrictTypeError, true, JSON.stringify(result));
  assert.equal(result.isAggregate, false, JSON.stringify(result));
});

test('a locally-defined, unrelated same-named AggregateErrors() decorator does not trigger aggregation', () => {
  const result = runMain({
    'dto.ts': [
      'function AggregateErrors(): ClassDecorator {',
      '  return () => { /* noop: not the real decorator */ };',
      '}',
      '',
      '@AggregateErrors()',
      'export class CreateUserDto {',
      "  name: string = '';",
      '  age: number = 0;',
      '}',
    ].join('\n'),
    'main.ts': [
      "import { StrictTypeError, AggregateStrictTypeError } from 'ts-typed';",
      "import { CreateUserDto } from './dto';",
      '',
      'function createUser(dto: CreateUserDto): void { /* noop */ }',
      '',
      'let caught: any = undefined;',
      'try {',
      "  createUser({ name: 42, age: 'old' } as any);",
      '} catch (error) {',
      '  caught = error;',
      '}',
      'const results = {',
      '  isStrictTypeError: caught instanceof StrictTypeError,',
      '  isAggregate: caught instanceof AggregateStrictTypeError,',
      '};',
      'process.stdout.write(JSON.stringify(results));',
    ].join('\n'),
  });

  assert.equal(result.isStrictTypeError, true, JSON.stringify(result));
  assert.equal(result.isAggregate, false, JSON.stringify(result));
});

test('a subclass of an @AggregateErrors() DTO is detected through the base-class chain', () => {
  const result = runMain({
    'dto.ts': [
      "import { AggregateErrors } from '@ts-typed/core';",
      '',
      '@AggregateErrors()',
      'export class BaseDto {',
      "  name: string = '';",
      '}',
      '',
      'export class DerivedDto extends BaseDto {',
      '  age: number = 0;',
      '}',
    ].join('\n'),
    'main.ts': [
      "import { AggregateStrictTypeError } from 'ts-typed';",
      "import { DerivedDto } from './dto';",
      '',
      'function createUser(dto: DerivedDto): void { /* noop */ }',
      '',
      'let caught: any = undefined;',
      'try {',
      "  createUser({ name: 42, age: 'old' } as any);",
      '} catch (error) {',
      '  caught = error;',
      '}',
      'const results = {',
      '  isAggregate: caught instanceof AggregateStrictTypeError,',
      '  errorCount: caught === undefined ? 0 : caught.errors.length,',
      '  paths: caught === undefined ? [] : caught.errors.map((e: any) => e.propertyPath),',
      '};',
      'process.stdout.write(JSON.stringify(results));',
    ].join('\n'),
  });

  assert.equal(result.isAggregate, true, JSON.stringify(result));
  assert.equal(result.errorCount, 2, JSON.stringify(result));
  assert.ok(result.paths.some((path) => path.endsWith('.name')), JSON.stringify(result));
  assert.ok(result.paths.some((path) => path.endsWith('.age')), JSON.stringify(result));
});

test('a generic @AggregateErrors() DTO instantiated as a parameter type is detected (TypeReference unwrap)', () => {
  const result = runMain({
    'dto.ts': [
      "import { AggregateErrors } from '@ts-typed/core';",
      '',
      '@AggregateErrors()',
      'export class GenericDto<T> {',
      '  value: T = 0 as any;',
      "  name: string = '';",
      '}',
    ].join('\n'),
    'main.ts': [
      "import { AggregateStrictTypeError } from 'ts-typed';",
      "import { GenericDto } from './dto';",
      '',
      'function createUser(dto: GenericDto<number>): void { /* noop */ }',
      '',
      'let caught: any = undefined;',
      'try {',
      "  createUser({ value: 'nope', name: 42 } as any);",
      '} catch (error) {',
      '  caught = error;',
      '}',
      'const results = {',
      '  isAggregate: caught instanceof AggregateStrictTypeError,',
      '  errorCount: caught === undefined ? 0 : caught.errors.length,',
      '  paths: caught === undefined ? [] : caught.errors.map((e: any) => e.propertyPath),',
      '};',
      'process.stdout.write(JSON.stringify(results));',
    ].join('\n'),
  });

  assert.equal(result.isAggregate, true, JSON.stringify(result));
  assert.equal(result.errorCount, 2, JSON.stringify(result));
  assert.ok(result.paths.some((path) => path.endsWith('.value')), JSON.stringify(result));
  assert.ok(result.paths.some((path) => path.endsWith('.name')), JSON.stringify(result));
});

test('a subclass of a generic @AggregateErrors() base, instantiated as a parameter type, is detected through the base-class chain', () => {
  const result = runMain({
    'dto.ts': [
      "import { AggregateErrors } from '@ts-typed/core';",
      '',
      '@AggregateErrors()',
      'export class GenericBaseDto<T> {',
      '  value: T = 0 as any;',
      '}',
      '',
      'export class DerivedGenericDto extends GenericBaseDto<number> {',
      '  age: number = 0;',
      '}',
    ].join('\n'),
    'main.ts': [
      "import { AggregateStrictTypeError } from 'ts-typed';",
      "import { DerivedGenericDto } from './dto';",
      '',
      'function createUser(dto: DerivedGenericDto): void { /* noop */ }',
      '',
      'let caught: any = undefined;',
      'try {',
      "  createUser({ value: 'nope', age: 'old' } as any);",
      '} catch (error) {',
      '  caught = error;',
      '}',
      'const results = {',
      '  isAggregate: caught instanceof AggregateStrictTypeError,',
      '  errorCount: caught === undefined ? 0 : caught.errors.length,',
      '  paths: caught === undefined ? [] : caught.errors.map((e: any) => e.propertyPath),',
      '};',
      'process.stdout.write(JSON.stringify(results));',
    ].join('\n'),
  });

  assert.equal(result.isAggregate, true, JSON.stringify(result));
  assert.equal(result.errorCount, 2, JSON.stringify(result));
  assert.ok(result.paths.some((path) => path.endsWith('.value')), JSON.stringify(result));
  assert.ok(result.paths.some((path) => path.endsWith('.age')), JSON.stringify(result));
});

test('a plainToInstance-style population (construct, then assign each field separately) now aggregates, once the populated instance crosses a real parameter boundary', () => {
  const result = runMain({
    'dto.ts': [
      "import { AggregateErrors } from '@ts-typed/core';",
      '',
      '@AggregateErrors()',
      'export class CreateUserDto {',
      "  name: string = '';",
      '  age: number = 0;',
      '}',
    ].join('\n'),
    'main.ts': [
      "import { AggregateStrictTypeError } from 'ts-typed';",
      "import { CreateUserDto } from './dto';",
      '',
      'function createUser(dto: CreateUserDto): void { /* noop */ }',
      '',
      // Mirrors class-transformer's plainToInstance exactly: the instance is
      // constructed through an UNTYPED helper (`ctor: any`, matching
      // plainToInstance's own internal, type-erased construction — there is
      // no typed local variable binding the instance to its concrete class
      // anywhere in this flow), THEN each real value is assigned as a
      // separate statement (this is the part that must collect instead of
      // throwing on the first bad field).
      'function populate(ctor: any, plain: Record<string, unknown>): any {',
      '  const instance = new ctor();',
      '  for (const key of Object.keys(plain)) {',
      '    instance[key] = plain[key];',
      '  }',
      '  return instance;',
      '}',
      '',
      "const dto = populate(CreateUserDto, { name: 42, age: 'old' });",
      '',
      'let caught: any = undefined;',
      'try {',
      '  createUser(dto);',
      '} catch (error) {',
      '  caught = error;',
      '}',
      'const results = {',
      '  isAggregate: caught instanceof AggregateStrictTypeError,',
      '  errorCount: caught === undefined ? 0 : caught.errors.length,',
      '  paths: caught === undefined ? [] : caught.errors.map((e: any) => e.propertyPath),',
      '};',
      'process.stdout.write(JSON.stringify(results));',
    ].join('\n'),
  });

  assert.equal(result.isAggregate, true, JSON.stringify(result));
  assert.equal(result.errorCount, 2, JSON.stringify(result));
  assert.ok(result.paths.some((path) => path.endsWith('name')), JSON.stringify(result));
  assert.ok(result.paths.some((path) => path.endsWith('age')), JSON.stringify(result));
});

test('the same plainToInstance-style population also reports a field that was never assigned at all (stays at its required-but-missing gap) once the schema declares a third required field not present at all in this scenario', () => {
  const result = runMain({
    'dto.ts': [
      "import { AggregateErrors } from '@ts-typed/core';",
      '',
      '@AggregateErrors()',
      'export class CreateUserDto {',
      "  name: string = '';",
      '  age: number = 0;',
      '}',
    ].join('\n'),
    'main.ts': [
      "import { AggregateStrictTypeError } from 'ts-typed';",
      "import { CreateUserDto } from './dto';",
      '',
      // `email` is typed as a required part of the parameter contract via an
      // intersection the transformer resolves structurally, exercising the
      // "never written at all" path distinctly from "written with a bad
      // type" — see the design doc's §2.3 merge reasoning.
      "function createUser(dto: CreateUserDto & { email: string }): void { /* noop */ }",
      '',
      // Same untyped, plainToInstance-faithful construction as the test
      // above — no typed local variable ever binds to `CreateUserDto`.
      'function populate(ctor: any, plain: Record<string, unknown>): any {',
      '  const instance = new ctor();',
      '  for (const key of Object.keys(plain)) {',
      '    instance[key] = plain[key];',
      '  }',
      '  return instance;',
      '}',
      '',
      'const dto = populate(CreateUserDto, { name: 42 });',
      '',
      'let caught: any = undefined;',
      'try {',
      '  createUser(dto as any);',
      '} catch (error) {',
      '  caught = error;',
      '}',
      'const results = {',
      '  isAggregate: caught instanceof AggregateStrictTypeError,',
      '  codes: caught === undefined ? [] : caught.errors.map((e: any) => e.code).sort(),',
      '};',
      'process.stdout.write(JSON.stringify(results));',
    ].join('\n'),
  });

  assert.equal(result.isAggregate, true, JSON.stringify(result));
  assert.deepEqual(result.codes, ['REQUIRED_PROPERTY', 'TYPE_MISMATCH'], JSON.stringify(result));
});

test('a bad nested @AggregateErrors() child is never silently accepted inside an @AggregateErrors() parent', () => {
  const result = runMain({
    'dto.ts': [
      "import { AggregateErrors } from '@ts-typed/core';", '',
      '@AggregateErrors()', 'export class Profile {', "  bio: string = '';", '  age: number = 0;', '}', '',
      '@AggregateErrors()', 'export class CreateUserDto {', "  name: string = '';", '  profile: Profile = new Profile();', '}',
    ].join('\n'),
    'main.ts': [
      "import { AggregateStrictTypeError, StrictTypeError } from 'ts-typed';", "import { CreateUserDto, Profile } from './dto';", '',
      'function createUser(dto: CreateUserDto): void { /* noop */ }', '',
      'function populate(ctor: any, plain: Record<string, unknown>): any {',
      '  const instance = new ctor();', '  for (const key of Object.keys(plain)) {', '    instance[key] = plain[key];', '  }', '  return instance;', '}', '',
      'let caught: any = undefined;', 'try {',
      "  const profile = populate(Profile, { bio: 7, age: 'old' });",
      "  const dto = populate(CreateUserDto, { name: 'Ada' });",
      '  (dto as any).profile = profile;', '  createUser(dto);', '} catch (error) {', '  caught = error;', '}',
      'process.stdout.write(JSON.stringify({', '  threwSomething: caught !== undefined,', '  isAggregate: caught instanceof AggregateStrictTypeError,', '  isStrictTypeError: caught instanceof StrictTypeError,', '}));',
    ].join('\n'),
  });

  assert.equal(result.threwSomething, true, JSON.stringify(result));
  assert.ok(result.isAggregate || result.isStrictTypeError, JSON.stringify(result));
});

test('a bad nested @AggregateErrors() child is never silently accepted inside an undecorated parent', () => {
  const result = runMain({
    'dto.ts': [
      "import { AggregateErrors } from '@ts-typed/core';", '',
      '@AggregateErrors()', 'export class Profile {', "  bio: string = '';", '  age: number = 0;', '}', '',
      'export class CreateUserDto {', "  name: string = '';", '  profile: Profile = new Profile();', '}',
    ].join('\n'),
    'main.ts': [
      "import { StrictTypeError } from 'ts-typed';", "import { CreateUserDto, Profile } from './dto';", '',
      'function consume(dto: CreateUserDto): void { /* noop */ }', '',
      'function populate(ctor: any, plain: Record<string, unknown>): any {',
      '  const instance = new ctor();', '  for (const key of Object.keys(plain)) {', '    instance[key] = plain[key];', '  }', '  return instance;', '}', '',
      'let caught: any = undefined;', 'try {',
      "  const profile = populate(Profile, { bio: 7, age: 'old' });",
      "  const dto = populate(CreateUserDto, { name: 'Ada' });",
      '  (dto as any).profile = profile;', '  consume(dto);', '} catch (error) {', '  caught = error;', '}',
      'process.stdout.write(JSON.stringify({ threwSomething: caught !== undefined, isStrictTypeError: caught instanceof StrictTypeError }));',
    ].join('\n'),
  });

  assert.equal(result.threwSomething, true, JSON.stringify(result));
  assert.equal(result.isStrictTypeError, true, JSON.stringify(result));
});

test('an array of bad nested @AggregateErrors() items is never silently accepted', () => {
  const result = runMain({
    'dto.ts': [
      "import { AggregateErrors } from '@ts-typed/core';", '',
      '@AggregateErrors()', 'export class Item {', "  label: string = '';", '}', '',
      '@AggregateErrors()', 'export class CreateOrderDto {', '  items: Item[] = [];', '}',
    ].join('\n'),
    'main.ts': [
      "import { AggregateStrictTypeError, StrictTypeError } from 'ts-typed';", "import { CreateOrderDto, Item } from './dto';", '',
      'function createOrder(dto: CreateOrderDto): void { /* noop */ }', '',
      'function populate(ctor: any, plain: Record<string, unknown>): any {',
      '  const instance = new ctor();', '  for (const key of Object.keys(plain)) {', '    instance[key] = plain[key];', '  }', '  return instance;', '}', '',
      'let caught: any = undefined;', 'try {', '  const badItem = populate(Item, { label: 7 });', '  const dto = populate(CreateOrderDto, {});', '  (dto as any).items = [badItem];', '  createOrder(dto);', '} catch (error) {', '  caught = error;', '}',
      'process.stdout.write(JSON.stringify({', '  threwSomething: caught !== undefined,', '  isAggregate: caught instanceof AggregateStrictTypeError,', '  isStrictTypeError: caught instanceof StrictTypeError,', '}));',
    ].join('\n'),
  });

  assert.equal(result.threwSomething, true, JSON.stringify(result));
  assert.ok(result.isAggregate || result.isStrictTypeError, JSON.stringify(result));
});

test('an array parameter of bad @AggregateErrors() instances re-roots a window violation on a NESTED field to the full "dtos[i].address.zip" path, not just the last segment', () => {
  const result = runMain({
    'dto.ts': [
      "import { AggregateErrors } from '@ts-typed/core';", '',
      'export class AddressDto {', '  zip: number = 0;', '}', '',
      '@AggregateErrors()', 'export class CreateUserDto {', "  name: string = '';", '  address: AddressDto = new AddressDto();', '}',
    ].join('\n'),
    'main.ts': [
      "import { ArrayAggregateStrictTypeError } from 'ts-typed';", "import { CreateUserDto } from './dto';", '',
      'function createUsers(dtos: CreateUserDto[]): void { /* noop */ }', '',
      // Mirrors class-transformer's plainToInstance: construct through an
      // untyped helper, then assign each field as a separate statement, so
      // the nested `address` assignment collects a window violation instead
      // of throwing immediately.
      'function populate(ctor: any, plain: Record<string, unknown>): any {',
      '  const instance = new ctor();', '  for (const key of Object.keys(plain)) {', '    instance[key] = plain[key];', '  }', '  return instance;', '}', '',
      'let caught: any = undefined;', 'try {',
      "  const dto = populate(CreateUserDto, { name: 'Ada' });",
      // A plain object literal (not a guarded AddressDto instance), so this
      // assignment itself never fail-fast throws -- it is checked
      // structurally under `dto`'s own open aggregate window, which is what
      // produces the nested "address.zip" window violation this test needs.
      "  (dto as any).address = { zip: 'not-a-number' };",
      '  createUsers([dto]);', '} catch (error) {', '  caught = error;', '}',
      'const results = {',
      '  isArrayAggregate: caught instanceof ArrayAggregateStrictTypeError,',
      '  paths: caught === undefined ? [] : caught.errors.flatMap((e: any) => e.errors.map((v: any) => v.propertyPath)),',
      '};',
      'process.stdout.write(JSON.stringify(results));',
    ].join('\n'),
  });

  assert.equal(result.isArrayAggregate, true, JSON.stringify(result));
  assert.ok(
    result.paths.some((path) => path.endsWith('dtos[0].address.zip')),
    `expected a path ending in "dtos[0].address.zip", got: ${JSON.stringify(result)}`,
  );
});

test('an array parameter of bad @AggregateErrors() instances is never silently accepted', () => {
  const result = runMain({
    'dto.ts': [
      "import { AggregateErrors } from '@ts-typed/core';", '',
      '@AggregateErrors()', 'export class CreateUserDto {', "  name: string = '';", '  age: number = 0;', '}',
    ].join('\n'),
    'main.ts': [
      "import { AggregateStrictTypeError, StrictTypeError } from 'ts-typed';", "import { CreateUserDto } from './dto';", '',
      'function createUsers(dtos: CreateUserDto[]): void { /* noop */ }', '',
      'function populate(ctor: any, plain: Record<string, unknown>): any {',
      '  const instance = new ctor();', '  for (const key of Object.keys(plain)) {', '    instance[key] = plain[key];', '  }', '  return instance;', '}', '',
      'let caught: any = undefined;', 'try {', "  const dto = populate(CreateUserDto, { name: 42, age: 'old' });", '  createUsers([dto]);', '} catch (error) {', '  caught = error;', '}',
      'process.stdout.write(JSON.stringify({', '  threwSomething: caught !== undefined,', '  isAggregate: caught instanceof AggregateStrictTypeError,', '  isStrictTypeError: caught instanceof StrictTypeError,', '}));',
    ].join('\n'),
  });

  assert.equal(result.threwSomething, true, JSON.stringify(result));
  assert.ok(result.isAggregate || result.isStrictTypeError, JSON.stringify(result));
});
