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

function writeProject(files) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-complex-transform-'));
  const sourceRoot = join(projectRoot, 'src');
  const declarationRoot = join(projectRoot, 'node_modules', 'ts-typed');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(declarationRoot, { recursive: true });
  writeFileSync(
    join(declarationRoot, 'index.d.ts'),
    [
      'export class StrictTypeError extends TypeError {}',
      'export function StrictClass(): ClassDecorator;',
      'export function StructuralClass(): ClassDecorator;',
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

function emitProject(files, transformerOptions = {}) {
  const project = writeProject(files);
  const analysis = analyzeProject({ tsconfigPath: project.tsconfigPath });
  assert.equal(
    analysis.tsDiagnostics.length,
    0,
    analysis.tsDiagnostics.map((diagnostic) => diagnostic.messageText).join('\n'),
  );
  const diagnostics = [];
  const emitResult = analysis.program.emit(undefined, undefined, undefined, false, {
    before: [
      createContractTransformer({
        analysis,
        runtimeModule,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        ...transformerOptions,
      }),
    ],
  });
  assert.equal(emitResult.emitSkipped, false);
  return {
    ...project,
    diagnostics,
    analysisDiagnostics: analysis.diagnostics,
    outputRoot: join(project.projectRoot, 'out'),
  };
}

function runEntry(project, relativePath = 'main.js') {
  return spawnSync(process.execPath, [join(project.outputRoot, relativePath)], {
    cwd: project.projectRoot,
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
}

test('a generic discriminated union with a nested mapped type accepts every valid branch and rejects malformed ones at runtime', () => {
  const project = emitProject({
    'main.ts': [
      "import { StrictTypeError } from 'ts-typed';",
      'class FormControl<T> { constructor(public value: T) {} }',
      'interface IValue<T extends object> { value: { [K in keyof T]: FormControl<T[K]>; }; }',
      'interface IValor<T> { valor: T; }',
      'interface IValorDesc<T> { valor: T; desc: string; }',
      'type ValueType<T extends object> = IValue<T> | IValor<T> | IValorDesc<T>;',
      'interface IValueClass { name: string; age: number; }',
      'const results: string[] = [];',
      'function expectTypeError(name: string, action: () => void): void {',
      '  try { action(); } catch (error) {',
      '    if (error instanceof StrictTypeError) { results.push(`rejected:${name}`); return; }',
      '    throw error;',
      '  }',
      '  throw new Error(`missing error: ${name}`);',
      '}',
      'function expectAccepted(name: string, action: () => void): void {',
      '  action();',
      '  results.push(`accepted:${name}`);',
      '}',
      // Branch 1: IValue<T> — a mapped-type FormControl per field.
      'expectAccepted("value-branch", () => {',
      '  const v: ValueType<IValueClass> = { value: { name: new FormControl<string>("Ada"), age: new FormControl<number>(30) } };',
      '  void v;',
      '});',
      // Branch 2: IValor<T> — a bare value of T.
      'expectAccepted("valor-branch", () => {',
      '  const v: ValueType<IValueClass> = { valor: { name: "Ada", age: 30 } };',
      '  void v;',
      '});',
      // Branch 3: IValorDesc<T> — value of T plus a description.
      'expectAccepted("valor-desc-branch", () => {',
      '  const v: ValueType<IValueClass> = { valor: { name: "Ada", age: 30 }, desc: "note" };',
      '  void v;',
      '});',
      // None of the three branches match: wrong field type inside valor, extra unexpected field.
      'expectTypeError("no-matching-branch", () => {',
      '  const invalid: any = { valor: { name: "Ada", age: "not-a-number" } };',
      '  const v: ValueType<IValueClass> = invalid;',
      '  void v;',
      '});',
      // Extra undeclared top-level property disqualifies every branch (closed objects by default).
      'expectTypeError("extra-property-closes-every-branch", () => {',
      '  const invalid: any = { valor: { name: "Ada", age: 30 }, unexpected: true };',
      '  const v: ValueType<IValueClass> = invalid;',
      '  void v;',
      '});',
      'process.stdout.write(JSON.stringify(results));',
    ].join('\n'),
  });

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    'accepted:value-branch',
    'accepted:valor-branch',
    'accepted:valor-desc-branch',
    'rejected:no-matching-branch',
    'rejected:extra-property-closes-every-branch',
  ]);
});

test('Pick, Partial and Record contracts enforce their narrowed shape at runtime', () => {
  const project = emitProject({
    'main.ts': [
      "import { StrictTypeError } from 'ts-typed';",
      'interface IUser { id: number; name: string; email?: string; }',
      'function expectTypeError(action: () => void): void {',
      '  try { action(); } catch (error) { if (error instanceof StrictTypeError) return; throw error; }',
      '  throw new Error("missing StrictTypeError");',
      '}',
      'const picked: Pick<IUser, "id" | "name"> = { id: 1, name: "Ada" };',
      'expectTypeError(() => {',
      '  const invalid: any = { id: 1, name: "Ada", email: "a@b.c" };',
      '  const p: Pick<IUser, "id" | "name"> = invalid;',
      '  void p;',
      '});',
      'const partial: Partial<IUser> = { id: 1 };',
      'expectTypeError(() => {',
      '  const invalid: any = { id: "not-a-number" };',
      '  const p: Partial<IUser> = invalid;',
      '  void p;',
      '});',
      'const record: Record<"a" | "b", number> = { a: 1, b: 2 };',
      'expectTypeError(() => {',
      '  const invalid: any = { a: 1 };',
      '  const r: Record<"a" | "b", number> = invalid;',
      '  void r;',
      '});',
      'void picked; void partial; void record;',
      'process.stdout.write("OK");',
    ].join('\n'),
  });

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('a self-referential generic rejects a cycle broken by a mismatched leaf type without infinite recursion', () => {
  const project = emitProject({
    'main.ts': [
      "import { StrictTypeError } from 'ts-typed';",
      'interface INode<T> { value: T; next?: INode<T>; }',
      'function expectTypeError(action: () => void): void {',
      '  try { action(); } catch (error) { if (error instanceof StrictTypeError) return; throw error; }',
      '  throw new Error("missing StrictTypeError");',
      '}',
      'const chain: INode<number> = { value: 1, next: { value: 2, next: { value: 3 } } };',
      'expectTypeError(() => {',
      '  const invalid: any = { value: 1, next: { value: "not-a-number" } };',
      '  const n: INode<number> = invalid;',
      '  void n;',
      '});',
      'void chain;',
      'process.stdout.write("OK");',
    ].join('\n'),
  });

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('a plain data class used directly as a generic argument is validated structurally at runtime, accepting a non-instanceof literal with the same shape', () => {
  const project = emitProject({
    'main.ts': [
      "import { StrictTypeError } from 'ts-typed';",
      'interface IValor<T> { valor: T; }',
      'class ValueClass { name = "Ada"; age = 30; }',
      'type V<T> = IValor<T>;',
      'function expectTypeError(action: () => void): void {',
      '  try { action(); } catch (error) { if (error instanceof StrictTypeError) return; throw error; }',
      '  throw new Error("missing StrictTypeError");',
      '}',
      // A real instance is accepted.
      'const fromInstance: V<ValueClass> = { valor: new ValueClass() };',
      // Per docs/SPEC.md §3 ("não reduzir tudo a instanceof"): a plain object',
      // literal with the same public shape is structurally valid too, even',
      // though it is not `instanceof ValueClass`.',
      'const fromLiteral: V<ValueClass> = { valor: { name: "Bob", age: 20 } };',
      'expectTypeError(() => {',
      '  const invalid: any = { valor: { name: "Bob", age: "not-a-number" } };',
      '  const v: V<ValueClass> = invalid;',
      '  void v;',
      '});',
      'void fromInstance; void fromLiteral;',
      'process.stdout.write("OK");',
    ].join('\n'),
  });

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('a class with a method cannot be represented structurally and emits an unsupported warning rather than silently faking protection', () => {
  const project = emitProject({
    'main.ts': [
      'interface IValor<T> { valor: T; }',
      'class ValueClass { name = "Ada"; greet(): string { return `hi ${this.name}`; } }',
      'type V<T> = IValor<T>;',
      'const v: V<ValueClass> = { valor: new ValueClass() };',
      'void v;',
    ].join('\n'),
  });

  const unsupported = project.analysisDiagnostics.filter(
    (diagnostic) => diagnostic.code === 'TT_UNSUPPORTED_TYPE' && diagnostic.name === 'v',
  );
  assert.equal(unsupported.length, 1);
  assert.equal(unsupported[0].category, 'warning');
  assert.equal(unsupported[0].status, 'unsupported');
  assert.match(unsupported[0].message, /Callable and constructable contracts/);

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
});

test('compiler.strictClass requires instanceof for a class declared in the same file, rejecting a structurally matching literal', () => {
  const project = emitProject(
    {
      'main.ts': [
        "import { StrictTypeError } from 'ts-typed';",
        'class ValueClass { name = "Ada"; age = 30; }',
        'interface IValor<T> { valor: T; }',
        'function expectTypeError(action: () => void): void {',
        '  try { action(); } catch (error) { if (error instanceof StrictTypeError) return; throw error; }',
        '  throw new Error("missing StrictTypeError");',
        '}',
        'const fromInstance: IValor<ValueClass> = { valor: new ValueClass() };',
        'expectTypeError(() => {',
        '  const invalid: any = { valor: { name: "Bob", age: 20 } };',
        '  const v: IValor<ValueClass> = invalid;',
        '  void v;',
        '});',
        'void fromInstance;',
        'process.stdout.write("OK");',
      ].join('\n'),
    },
    { strictClass: true },
  );

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('compiler.strictClass requires instanceof for a class declared in a different file but imported by name, rejecting a structurally matching literal', () => {
  const project = emitProject(
    {
      'model.ts': ['export class ValueClass { name = "Ada"; age = 30; }'].join('\n'),
      'main.ts': [
        "import { StrictTypeError } from 'ts-typed';",
        "import { ValueClass } from './model';",
        'interface IValor<T> { valor: T; }',
        'function expectTypeError(action: () => void): void {',
        '  try { action(); } catch (error) { if (error instanceof StrictTypeError) return; throw error; }',
        '  throw new Error("missing StrictTypeError");',
        '}',
        'const fromInstance: IValor<ValueClass> = { valor: new ValueClass() };',
        'expectTypeError(() => {',
        '  const invalid: any = { valor: { name: "Bob", age: 20 } };',
        '  const v: IValor<ValueClass> = invalid;',
        '  void v;',
        '});',
        'void fromInstance;',
        'process.stdout.write("OK");',
      ].join('\n'),
    },
    { strictClass: true },
  );

  const warning = project.diagnostics.find(
    (diagnostic) => diagnostic.code === 'TT_UNSUPPORTED_SYNTAX' && diagnostic.name === 'ValueClass',
  );
  assert.equal(warning, undefined);

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('compiler.strictClass falls back to structural validation and warns when the class is declared in a different file and not imported by name', () => {
  const project = emitProject(
    {
      'model.ts': ['export class ValueClass { name = "Ada"; age = 30; }'].join('\n'),
      'reexport.ts': ["export * as Model from './model';"].join('\n'),
      'main.ts': [
        "import { Model } from './reexport';",
        'interface IValor<T> { valor: T; }',
        'const v: IValor<Model.ValueClass> = { valor: { name: "Bob", age: 20 } };',
        'void v;',
      ].join('\n'),
    },
    { strictClass: true },
  );

  const warning = project.diagnostics.find(
    (diagnostic) => diagnostic.code === 'TT_UNSUPPORTED_SYNTAX' && diagnostic.name === 'ValueClass',
  );
  assert.notEqual(warning, undefined);
  assert.match(warning.message, /not imported by name into this file/);

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
});

test('a per-class @StructuralClass() decorator overrides a global compiler.strictClass: true default', () => {
  const project = emitProject(
    {
      'main.ts': [
        "import { StrictTypeError, StructuralClass } from 'ts-typed';",
        '@StructuralClass()',
        'class ValueClass { name = "Ada"; age = 30; }',
        'interface IValor<T> { valor: T; }',
        'function expectTypeError(action: () => void): void {',
        '  try { action(); } catch (error) { if (error instanceof StrictTypeError) return; throw error; }',
        '  throw new Error("missing StrictTypeError");',
        '}',
        // Would be rejected under plain strictClass (not an instance), but',
        '// @StructuralClass() opts this class back out, so it must be accepted.',
        'const fromLiteral: IValor<ValueClass> = { valor: { name: "Bob", age: 20 } };',
        'void fromLiteral;',
        'process.stdout.write("OK");',
      ].join('\n'),
    },
    { strictClass: true },
  );

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});
