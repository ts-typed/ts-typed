import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { ConfigError } from './config-error';
import type { JsonObject, JsonValue } from './config-json.type';
import {
  ASSET_KEYS,
  COMPILER_KEYS,
  CONFIG_KEYS,
  DIAGNOSTICS_KEYS,
  NCC_BOOLEAN_KEYS,
  NCC_KEYS,
} from './config-validation.const';
import { DEFAULT_CONFIG } from './config.const';
import type { AssetConfig, ProjectConfig } from './config.interface';
import type { ConfigOverrides } from './config.type';

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

const isArray = (value: unknown): value is JsonValue[] => Array.isArray(value);

const requireObject = (value: JsonValue): JsonObject => {
  if (!isObject(value)) {
    throw new ConfigError('Expected configuration object');
  }

  return value;
};

const requireNonEmptyString = (value: unknown, label: string): string => {
  if (!isString(value) || value.length === 0) {
    throw new ConfigError(`${label} must be a non-empty string`);
  }

  return value;
};

const requireBoolean = (value: unknown, label: string): boolean => {
  if (!isBoolean(value)) {
    throw new ConfigError(`${label} must be boolean`);
  }

  return value;
};

const toJsonValue = (value: unknown): JsonValue => {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }

  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]),
    );
  }

  throw new ConfigError('Configuration contains an unsupported value');
};

const mergeConfig = (base: JsonObject, extra: JsonObject): JsonObject => {
  const result: JsonObject = { ...base };

  for (const [key, value] of Object.entries(extra)) {
    const baseValue = result[key];
    result[key] = isObject(baseValue) && isObject(value)
      ? mergeConfig(baseValue, value)
      : value;
  }

  return result;
};

const isRelativeIntegrationModule = (specifier: string): boolean =>
  specifier === '.'
  || specifier === '..'
  || specifier.startsWith('./')
  || specifier.startsWith('../')
  || specifier.startsWith('.\\')
  || specifier.startsWith('..\\');

const normalizeConfig = (fragment: JsonObject, baseDirectory: string): JsonObject => {
  const result: JsonObject = { ...fragment };

  for (const key of ['entry', 'tsconfig', 'outDir']) {
    const value = result[key];
    if (isString(value)) {
      result[key] = resolve(baseDirectory, value);
    }
  }

  const integration = result.integration;
  if (isString(integration) && isRelativeIntegrationModule(integration)) {
    result.integration = resolve(baseDirectory, integration);
  }

  const assets = result.assets;
  if (isArray(assets)) {
    result.assets = assets.map((item) => {
      if (!isObject(item) || !isString(item.from)) {
        return item;
      }

      return {
        ...item,
        from: resolve(baseDirectory, item.from),
      };
    });
  }

  const diagnostics = result.diagnostics;
  if (isObject(diagnostics) && isString(diagnostics.reportFile)) {
    result.diagnostics = {
      ...diagnostics,
      reportFile: resolve(baseDirectory, diagnostics.reportFile),
    };
  }

  return result;
};

const validateKnownKeys = (
  value: JsonObject,
  knownKeys: ReadonlySet<string>,
  path: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) {
      throw new ConfigError(`${path}.${key} is unknown`);
    }
  }
};

const validateOptionalNonEmptyString = (value: JsonValue | undefined, path: string): void => {
  if (value !== undefined) {
    requireNonEmptyString(value, path);
  }
};

const validateCompiler = (value: JsonValue | undefined, path: string): void => {
  if (value === undefined) {
    return;
  }
  if (!isObject(value)) {
    throw new ConfigError(`${path} must be an object`);
  }

  validateKnownKeys(value, COMPILER_KEYS, path);
  if (value.sourceMap !== undefined) {
    requireBoolean(value.sourceMap, `${path}.sourceMap`);
  }
  if (
    value.onUnsupported !== undefined
    && value.onUnsupported !== 'warn'
    && value.onUnsupported !== 'error'
  ) {
    throw new ConfigError(`${path}.onUnsupported must be warn or error`);
  }
  if (value.strictClass !== undefined) {
    requireBoolean(value.strictClass, `${path}.strictClass`);
  }
  if (value.enforcePrivate !== undefined) {
    requireBoolean(value.enforcePrivate, `${path}.enforcePrivate`);
  }
  if (value.enforceReadonly !== undefined) {
    requireBoolean(value.enforceReadonly, `${path}.enforceReadonly`);
  }
  if (value.enforceClosedInstances !== undefined) {
    requireBoolean(value.enforceClosedInstances, `${path}.enforceClosedInstances`);
  }
  if (value.enforceMutationGuards !== undefined) {
    requireBoolean(value.enforceMutationGuards, `${path}.enforceMutationGuards`);
  }
};

const validateNcc = (value: JsonValue | undefined, path: string): void => {
  if (value === undefined) {
    return;
  }
  if (!isObject(value)) {
    throw new ConfigError(`${path} must be an object`);
  }

  validateKnownKeys(value, NCC_KEYS, path);
  for (const key of NCC_BOOLEAN_KEYS) {
    if (value[key] !== undefined) {
      requireBoolean(value[key], `${path}.${key}`);
    }
  }

  validateOptionalNonEmptyString(value.target, `${path}.target`);

  const externals = value.externals;
  if (externals !== undefined) {
    if (!isArray(externals)) {
      throw new ConfigError(`${path}.externals must be string[]`);
    }
    for (const external of externals) {
      requireNonEmptyString(external, `${path}.externals`);
    }
  }

  if (value.license !== undefined && value.license !== null) {
    requireNonEmptyString(value.license, `${path}.license`);
  }
};

const validateAssets = (value: JsonValue | undefined, path: string): void => {
  if (value === undefined) {
    return;
  }
  if (!isArray(value)) {
    throw new ConfigError(`${path} must be an array`);
  }

  for (const [index, asset] of value.entries()) {
    const assetPath = `${path}[${index}]`;
    if (!isObject(asset)) {
      throw new ConfigError(`${assetPath} must be an object`);
    }
    validateKnownKeys(asset, ASSET_KEYS, assetPath);
    requireNonEmptyString(asset.from, `${path}.from`);
    requireNonEmptyString(asset.to, `${path}.to`);
  }
};

const validateDiagnostics = (value: JsonValue | undefined, path: string): void => {
  if (value === undefined) {
    return;
  }
  if (!isObject(value)) {
    throw new ConfigError(`${path} must be an object`);
  }

  validateKnownKeys(value, DIAGNOSTICS_KEYS, path);
  if (value.format !== undefined && value.format !== 'pretty' && value.format !== 'json') {
    throw new ConfigError(`${path}.format must be pretty or json`);
  }
  if (
    value.coverage !== undefined
    && value.coverage !== 'summary'
    && value.coverage !== 'detailed'
  ) {
    throw new ConfigError(`${path}.coverage must be summary or detailed`);
  }
  if (value.reportFile !== undefined && value.reportFile !== null) {
    requireNonEmptyString(value.reportFile, `${path}.reportFile`);
  }
};

function validateConfig(value: unknown, path = 'config'): asserts value is JsonObject {
  if (!isObject(value)) {
    throw new ConfigError(`${path} must be an object`);
  }

  validateKnownKeys(value, CONFIG_KEYS, path);
  for (const key of ['$schema', 'integration', 'entry', 'tsconfig', 'outDir']) {
    validateOptionalNonEmptyString(value[key], `${path}.${key}`);
  }

  if (value.extends !== undefined && value.extends !== null) {
    requireNonEmptyString(value.extends, `${path}.extends`);
  }
  if (
    value.extraProperties !== undefined
    && value.extraProperties !== 'error'
    && value.extraProperties !== 'strip'
  ) {
    throw new ConfigError(`${path}.extraProperties must be error or strip`);
  }

  validateCompiler(value.compiler, `${path}.compiler`);
  validateNcc(value.ncc, `${path}.ncc`);
  validateAssets(value.assets, `${path}.assets`);
  validateDiagnostics(value.diagnostics, `${path}.diagnostics`);
}

const readConfig = async (file: string, stack: readonly string[]): Promise<JsonObject> => {
  const source = resolve(file);
  const identity = await realpath(source).catch(() => source);
  if (stack.includes(identity)) {
    throw new ConfigError(`Configuration extends cycle detected at ${identity}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(identity, 'utf8'));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : 'invalid JSON';
    throw new ConfigError(`Unable to read ${source}: ${detail}`);
  }

  validateConfig(parsed);
  const declarationDirectory = dirname(identity);
  const normalized = normalizeConfig(parsed, declarationDirectory);
  const parent = normalized.extends;
  const inherited = isString(parent)
    ? await readConfig(resolve(declarationDirectory, parent), [...stack, identity])
    : {};
  const own: JsonObject = { ...normalized };
  delete own.extends;

  return mergeConfig(inherited, own);
};

const normalizeAssetDestination = (value: string, outDir: string): string => {
  if (isAbsolute(value)) {
    throw new ConfigError('assets.to must be relative to outDir');
  }

  const destination = resolve(outDir, value);
  const relativeDestination = relative(outDir, destination);
  const escapesOutDir = relativeDestination === '..'
    || relativeDestination.startsWith(`..${sep}`)
    || isAbsolute(relativeDestination);
  if (escapesOutDir) {
    throw new ConfigError('assets.to escapes outDir');
  }

  return relativeDestination.length === 0 ? '.' : relativeDestination;
};

const toProjectConfig = (value: JsonObject): ProjectConfig => {
  validateConfig(value);
  const compiler = value.compiler;
  const ncc = value.ncc;
  const diagnostics = value.diagnostics;
  const assets = value.assets;
  if (!isObject(compiler) || !isObject(ncc) || !isObject(diagnostics) || !isArray(assets)) {
    throw new ConfigError('Configuration is incomplete');
  }

  const compilerSourceMap = requireBoolean(compiler.sourceMap, 'compiler.sourceMap');
  const onUnsupported = compiler.onUnsupported;
  if (onUnsupported !== 'warn' && onUnsupported !== 'error') {
    throw new ConfigError('compiler.onUnsupported must be warn or error');
  }
  const extraProperties = value.extraProperties;
  if (extraProperties !== 'error' && extraProperties !== 'strip') {
    throw new ConfigError('extraProperties must be error or strip');
  }
  const nccSourceMap = requireBoolean(ncc.sourceMap, 'ncc.sourceMap');
  if (nccSourceMap && !compilerSourceMap) {
    throw new ConfigError('ncc.sourceMap requires compiler.sourceMap to be true');
  }

  const outDir = resolve(requireNonEmptyString(value.outDir, 'outDir'));
  const externals = isArray(ncc.externals)
    ? ncc.externals.map((external) => requireNonEmptyString(external, 'ncc.externals'))
    : [];
  const finalAssets: AssetConfig[] = assets.map((asset) => {
    if (!isObject(asset)) {
      throw new ConfigError('assets is invalid');
    }

    return {
      from: requireNonEmptyString(asset.from, 'assets.from'),
      to: normalizeAssetDestination(
        requireNonEmptyString(asset.to, 'assets.to'),
        outDir,
      ),
    };
  });

  return {
    $schema: requireNonEmptyString(value.$schema, '$schema'),
    integration: requireNonEmptyString(value.integration, 'integration'),
    extends: null,
    entry: requireNonEmptyString(value.entry, 'entry'),
    tsconfig: requireNonEmptyString(value.tsconfig, 'tsconfig'),
    outDir,
    extraProperties,
    compiler: {
      sourceMap: compilerSourceMap,
      onUnsupported,
      strictClass: requireBoolean(compiler.strictClass, 'compiler.strictClass'),
      enforcePrivate: requireBoolean(compiler.enforcePrivate, 'compiler.enforcePrivate'),
      enforceReadonly: requireBoolean(compiler.enforceReadonly, 'compiler.enforceReadonly'),
      enforceClosedInstances: requireBoolean(compiler.enforceClosedInstances, 'compiler.enforceClosedInstances'),
      enforceMutationGuards: requireBoolean(compiler.enforceMutationGuards, 'compiler.enforceMutationGuards'),
    },
    ncc: {
      enabled: requireBoolean(ncc.enabled, 'ncc.enabled'),
      minify: requireBoolean(ncc.minify, 'ncc.minify'),
      sourceMap: nccSourceMap,
      sourceMapRegister: requireBoolean(ncc.sourceMapRegister, 'ncc.sourceMapRegister'),
      target: requireNonEmptyString(ncc.target, 'ncc.target'),
      externals,
      cache: requireBoolean(ncc.cache, 'ncc.cache'),
      license: ncc.license === null
        ? null
        : requireNonEmptyString(ncc.license, 'ncc.license'),
      quiet: requireBoolean(ncc.quiet, 'ncc.quiet'),
      debugLog: requireBoolean(ncc.debugLog, 'ncc.debugLog'),
    },
    assets: finalAssets,
    diagnostics: {
      format: diagnostics.format === 'json' ? 'json' : 'pretty',
      coverage: diagnostics.coverage === 'detailed' ? 'detailed' : 'summary',
      reportFile: diagnostics.reportFile === null
        ? null
        : requireNonEmptyString(diagnostics.reportFile, 'diagnostics.reportFile'),
    },
  };
};

export const loadConfig = async (
  file: string,
  overrides: ConfigOverrides = {},
): Promise<ProjectConfig> => {
  const source = resolve(file);
  const declarationDirectory = dirname(source);
  const defaults = requireObject(toJsonValue(DEFAULT_CONFIG));
  validateConfig(defaults);

  validateConfig(overrides);
  const overrideFragment = requireObject(toJsonValue(overrides));

  const normalizedDefaults = normalizeConfig(defaults, declarationDirectory);
  const loaded = mergeConfig(normalizedDefaults, await readConfig(source, []));
  const normalizedOverrides = normalizeConfig(overrideFragment, declarationDirectory);

  return toProjectConfig(mergeConfig(loaded, normalizedOverrides));
};
