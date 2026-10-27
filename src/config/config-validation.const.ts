export const CONFIG_KEYS = new Set([
  '$schema',
  'integration',
  'extends',
  'entry',
  'tsconfig',
  'outDir',
  'extraProperties',
  'compiler',
  'ncc',
  'assets',
  'diagnostics',
]);

export const COMPILER_KEYS = new Set([
  'sourceMap',
  'onUnsupported',
  'strictClass',
  'enforcePrivate',
  'enforceReadonly',
  'enforceClosedInstances',
  'enforceMutationGuards',
]);

export const NCC_KEYS = new Set([
  'enabled',
  'minify',
  'sourceMap',
  'sourceMapRegister',
  'target',
  'externals',
  'cache',
  'license',
  'quiet',
  'debugLog',
]);

export const NCC_BOOLEAN_KEYS: readonly string[] = [
  'enabled',
  'minify',
  'sourceMap',
  'sourceMapRegister',
  'cache',
  'quiet',
  'debugLog',
];

export const DIAGNOSTICS_KEYS = new Set(['format', 'coverage', 'reportFile']);

export const ASSET_KEYS = new Set(['from', 'to']);
