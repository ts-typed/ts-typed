'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { analyzeProject } = require('../../../dist/compiler/analysis');
const { createContractTransformer } = require('../../../dist/compiler/transform');

const runtimeModule = join(__dirname, '../../../dist/runtime');

function writeProject(files) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-destructuring-'));
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

function emitProject(files) {
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

// Runs `body` and reports whether it threw StrictTypeError, or the result it produced.
const GUARDED = [
  "import { StrictTypeError } from 'ts-typed';",
  'function guarded(run: () => unknown): string {',
  '  try {',
  '    return "ok:" + JSON.stringify(run());',
  '  } catch (error) {',
  '    if (error instanceof StrictTypeError) return "threw:" + error.operation;',
  '    throw error;',
  '  }',
  '}',
];

test('destructuring an object whose source violates the annotated type throws StrictTypeError', () => {
  const project = emitProject({
    'main.ts': [
      ...GUARDED,
      'interface Profile { name: string; age: number; }',
      'const result = guarded(() => {',
      "  const { age }: Profile = { name: 'Ada', age: '36' as any };",
      '  return age;',
      '});',
      'process.stdout.write(result);',
    ].join('\n'),
  });

  const run = runEntry(project);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'threw:initialize');
});

test('destructuring an array whose source violates the annotated type throws StrictTypeError', () => {
  const project = emitProject({
    'main.ts': [
      ...GUARDED,
      "const result = guarded(() => {",
      "  const [first]: number[] = ['1' as any];",
      '  return first;',
      '});',
      'process.stdout.write(result);',
    ].join('\n'),
  });

  const run = runEntry(project);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'threw:initialize');
});

test('destructuring a valid source behaves normally and yields the right bindings', () => {
  const project = emitProject({
    'main.ts': [
      ...GUARDED,
      'interface Profile { name: string; age: number; }',
      "const profile: Profile = { name: 'Ada', age: 36 };",
      'const result = guarded(() => {',
      '  const { name, age }: Profile = profile;',
      '  const [first, second]: number[] = [10, 20];',
      '  return [name, age, first, second];',
      '});',
      'process.stdout.write(result);',
    ].join('\n'),
  });

  const run = runEntry(project);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'ok:["Ada",36,10,20]');
});

test('destructuring without an annotation validates against the source expression type', () => {
  // Documented behavior: with no annotation the declared type is the type of the
  // source expression. A statically typed source is checked; a source whose type
  // contains `any` (`"36" as any` inside the literal) is accepted, because `any`
  // has no runtime contract to enforce.
  const project = emitProject({
    'main.ts': [
      ...GUARDED,
      'interface Profile { name: string; age: number; }',
      "const typed: Profile = { name: 'Ada', age: 36 };",
      'const untyped = { name: "Ada", age: "36" as any };',
      'const ok = guarded(() => { const { age } = typed; return age; });',
      'const loose = guarded(() => { const { age } = untyped; return age; });',
      'process.stdout.write(ok + " " + loose);',
    ].join('\n'),
  });

  const run = runEntry(project);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'ok:36 ok:"36"');
});

test('destructuring a generic type parameter stays unsupported without breaking the build', () => {
  const project = emitProject({
    'main.ts': [
      ...GUARDED,
      'function pick<T extends { length: number }>(source: T): unknown {',
      '  const { length }: T = source;',
      '  return length;',
      '}',
      'process.stdout.write(guarded(() => pick({ length: 3 })));',
    ].join('\n'),
  });

  const run = runEntry(project);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'ok:3');
  // No materializable contract for T, so the declaration is emitted exactly as written.
  const emitted = readFileSync(join(project.outputRoot, 'main.js'), 'utf8');
  assert.match(emitted, /const \{ length \} = source;/);
});

test('the source expression of a destructuring is evaluated exactly once', () => {
  const project = emitProject({
    'main.ts': [
      ...GUARDED,
      'interface Profile { name: string; age: number; }',
      'let calls = 0;',
      "function source(): Profile { calls += 1; return { name: 'Ada', age: 36 }; }",
      'const result = guarded(() => {',
      '  const { name, age }: Profile = source();',
      '  return [name, age, calls];',
      '});',
      'process.stdout.write(result);',
    ].join('\n'),
  });

  const run = runEntry(project);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'ok:["Ada",36,1]');
});
