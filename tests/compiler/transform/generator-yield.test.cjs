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
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-generator-'));
  const sourceRoot = join(projectRoot, 'src');
  const declarationRoot = join(projectRoot, 'node_modules', 'ts-typed');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(declarationRoot, { recursive: true });
  writeFileSync(
    join(declarationRoot, 'index.d.ts'),
    [
      'export class StrictTypeError extends TypeError { readonly operation: string; }',
      "export function ExtraProperties(policy: 'error' | 'strip'): ClassDecorator & PropertyDecorator;",
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
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
          ...transformerOptions,
        }),
      ],
    },
  );
  assert.equal(emitResult.emitSkipped, false);
  return { ...project, diagnostics, outputRoot: join(project.projectRoot, 'out') };
}

function runEntry(project, relativePath = 'main.js') {
  return spawnSync(process.execPath, [join(project.outputRoot, relativePath)], {
    cwd: project.projectRoot,
    encoding: 'utf8',
  });
}

const STEP_HELPER = [
  "import { StrictTypeError } from 'ts-typed';",
  'function step(iterator: Iterator<unknown>): string {',
  '  try {',
  '    const result = iterator.next();',
  '    return result.done ? "done" : "value:" + JSON.stringify(result.value);',
  '  } catch (error) {',
  '    if (error instanceof StrictTypeError) return "threw:" + error.operation;',
  '    throw error;',
  '  }',
  '}',
];

test('a yielded value that violates the declared element type throws StrictTypeError at the yield', () => {
  const project = emitProject({
    'main.ts': [
      ...STEP_HELPER,
      'function* gen(): Generator<number> {',
      '  yield 1;',
      '  yield 2;',
      '  yield ("oops" as any);',
      '}',
      'const iterator = gen();',
      'const results = [step(iterator), step(iterator), step(iterator)];',
      'process.stdout.write(JSON.stringify(results));',
    ].join('\n'),
  });

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['value:1', 'value:2', 'threw:yield']);
});

test('a generator without an explicit return annotation still validates its yields', () => {
  // No annotation: TypeScript infers the element type from the yields (here `number`).
  // Writing `yield x as any` would collapse that inference to `any` and disable the check,
  // so the bad value comes from an unwrapped global typed `() => number` whose runtime
  // implementation returns a string. The yield is then the only check that can fire.
  const project = emitProject({
    'main.ts': [
      ...STEP_HELPER,
      'declare const rawSource: () => number;',
      'Object.assign(globalThis, { rawSource: () => "oops" });',
      'function* gen() {',
      '  yield 1;',
      '  yield rawSource();',
      '}',
      'const iterator = gen();',
      'const results = [step(iterator), step(iterator), step(iterator)];',
      'process.stdout.write(JSON.stringify(results));',
    ].join('\n'),
  });

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['value:1', 'threw:yield', 'done']);
});

test('a bare yield without a value is not treated as a contract violation', () => {
  const project = emitProject({
    'main.ts': [
      ...STEP_HELPER,
      'function* gen(): Generator<void> {',
      '  yield;',
      '}',
      'const iterator = gen();',
      'const results = [step(iterator), step(iterator)];',
      'process.stdout.write(JSON.stringify(results));',
    ].join('\n'),
  });

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['value:undefined', 'done']);
});

test('an async generator validates each yielded value once it is awaited', () => {
  const project = emitProject({
    'main.ts': [
      "import { StrictTypeError } from 'ts-typed';",
      'async function* gen(): AsyncGenerator<number> {',
      '  yield 1;',
      '  yield ("oops" as any);',
      '}',
      'async function collect(): Promise<string[]> {',
      '  const seen: string[] = [];',
      '  try {',
      '    for await (const value of gen()) seen.push("value:" + value);',
      '  } catch (error) {',
      '    if (error instanceof StrictTypeError) { seen.push("threw:" + error.operation); return seen; }',
      '    throw error;',
      '  }',
      '  seen.push("done");',
      '  return seen;',
      '}',
      'collect().then((results) => process.stdout.write(JSON.stringify(results)));',
    ].join('\n'),
  });

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['value:1', 'threw:yield']);
});

test('yield* delegation keeps working and yields the delegated values', () => {
  const project = emitProject({
    'main.ts': [
      'function* inner(): Generator<number> { yield 1; yield 2; }',
      'function* outer(): Generator<number> { yield* inner(); }',
      'const values: number[] = [];',
      'for (const value of outer()) values.push(value);',
      'process.stdout.write(JSON.stringify(values));',
    ].join('\n'),
  });

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [1, 2]);
});

test('generator yield and return contracts are checked independently', () => {
  const project = emitProject({
    'main.ts': [
      ...STEP_HELPER,
      'function* good(): Generator<number, string> { yield 1; return "ok"; }',
      'function* badReturn(): Generator<number, string> { yield 1; return 123 as any; }',
      'function* badYield(): Generator<number, string> { yield "x" as any; return "ok"; }',
      'const goodIterator = good();',
      'const goodResults = [step(goodIterator), step(goodIterator)];',
      'const returnIterator = badReturn();',
      'const returnResults = [step(returnIterator), step(returnIterator)];',
      'const yieldIterator = badYield();',
      'const yieldResults = [step(yieldIterator)];',
      'process.stdout.write(JSON.stringify([goodResults, returnResults, yieldResults]));',
    ].join('\n'),
  });

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    ['value:1', 'done'],
    ['value:1', 'threw:return'],
    ['threw:yield'],
  ]);
});
