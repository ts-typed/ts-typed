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

// Compiles a small CommonJS project through the contract transformer and returns
// the emitted output location. Mirrors the harness in destructuring.test.cjs.
function emitProject(files) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-module-bindings-'));
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
    [
      'declare const process: { stdout: { write(chunk: string): boolean } };',
      'declare function require(id: string): any;',
      '',
    ].join('\n'),
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
          runtimeModule,
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      ],
    },
  );
  assert.equal(emitResult.emitSkipped, false);
  return { projectRoot, outputRoot: join(projectRoot, 'out'), diagnostics };
}

function runEntry(project, relativePath = 'main.js') {
  return spawnSync(process.execPath, [join(project.outputRoot, relativePath)], {
    cwd: project.projectRoot,
    encoding: 'utf8',
  });
}

const COUNTER_MODULE = [
  'export let exportedCounter: number = 0;',
  'export function incrementExportedCounter(): number {',
  '  exportedCounter = exportedCounter + 1;',
  '  return exportedCounter;',
  '}',
  'export var exportedTotal: number = 10;',
  'export function bumpTotal(): number {',
  '  exportedTotal++;',
  '  return exportedTotal;',
  '}',
].join('\n');

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

test('internal reads and writes of an exported let keep working normally', () => {
  const project = emitProject({
    'counter.ts': COUNTER_MODULE,
    'main.ts': [
      "import { exportedCounter, incrementExportedCounter, exportedTotal, bumpTotal } from './counter';",
      'const first = incrementExportedCounter();',
      'const second = incrementExportedCounter();',
      'const total = bumpTotal();',
      'process.stdout.write([first, second, exportedCounter, total, exportedTotal].join(","));',
    ].join('\n'),
  });

  const run = runEntry(project);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '1,2,2,11,11');
});

test('writing a wrong type to an exported let through the module namespace throws StrictTypeError', () => {
  const project = emitProject({
    'counter.ts': COUNTER_MODULE,
    'main.ts': [
      "import * as counter from './counter';",
      ...GUARDED,
      'const result = guarded(() => Reflect.set(counter, "exportedCounter", "many"));',
      'process.stdout.write(result + "|" + counter.exportedCounter);',
    ].join('\n'),
  });

  const run = runEntry(project);
  assert.equal(run.status, 0, run.stderr);
  // The rejected write leaves the previous value untouched.
  assert.equal(run.stdout, 'threw:set|0');
});

test('a direct assignment of a wrong type through the namespace throws StrictTypeError', () => {
  const project = emitProject({
    'counter.ts': COUNTER_MODULE,
    'main.ts': [
      "import * as counter from './counter';",
      ...GUARDED,
      'const result = guarded(() => { (counter as any).exportedCounter = "wrong"; return null; });',
      'process.stdout.write(result);',
    ].join('\n'),
  });

  const run = runEntry(project);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'threw:set');
});

test('writing a wrong type to an exported var through the namespace throws StrictTypeError', () => {
  const project = emitProject({
    'counter.ts': COUNTER_MODULE,
    'main.ts': [
      "import * as counter from './counter';",
      ...GUARDED,
      'const result = guarded(() => Reflect.set(counter, "exportedTotal", null));',
      'process.stdout.write(result + "|" + counter.exportedTotal);',
    ].join('\n'),
  });

  const run = runEntry(project);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'threw:set|10');
});

test('a valid external write through the namespace succeeds and is seen by the module', () => {
  const project = emitProject({
    'counter.ts': COUNTER_MODULE,
    'main.ts': [
      "import * as counter from './counter';",
      ...GUARDED,
      'const result = guarded(() => Reflect.set(counter, "exportedCounter", 41));',
      'const next = counter.incrementExportedCounter();',
      'process.stdout.write(result + "|" + next + "|" + counter.exportedCounter);',
    ].join('\n'),
  });

  const run = runEntry(project);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'ok:true|42|42');
});

test('require() returns the same exports object, so a wrong-type write from another module throws', () => {
  const project = emitProject({
    'counter.ts': COUNTER_MODULE,
    'writer.ts': [
      "const viaRequire = require('./counter');",
      'export function tamper(): boolean {',
      '  viaRequire.exportedCounter = "tampered";',
      '  return true;',
      '}',
    ].join('\n'),
    'main.ts': [
      "import * as counter from './counter';",
      "import { tamper } from './writer';",
      ...GUARDED,
      'const sameObject = require("./counter") === counter;',
      'const result = guarded(() => tamper());',
      'process.stdout.write(sameObject + "|" + result + "|" + counter.exportedCounter);',
    ].join('\n'),
  });

  const run = runEntry(project);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'true|threw:set|0');
});
