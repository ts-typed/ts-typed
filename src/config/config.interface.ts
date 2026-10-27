export interface CompilerConfig {
  readonly sourceMap: boolean;
  readonly onUnsupported: 'warn' | 'error';
  readonly strictClass: boolean;
  readonly enforcePrivate: boolean;
  readonly enforceReadonly: boolean;
  readonly enforceClosedInstances: boolean;
  readonly enforceMutationGuards: boolean;
}

export interface NccConfig {
  readonly enabled: boolean;
  readonly minify: boolean;
  readonly sourceMap: boolean;
  readonly sourceMapRegister: boolean;
  readonly target: string;
  readonly externals: readonly string[];
  readonly cache: boolean;
  readonly license: string | null;
  readonly quiet: boolean;
  readonly debugLog: boolean;
}

export interface AssetConfig {
  readonly from: string;
  readonly to: string;
}

export interface DiagnosticsConfig {
  readonly format: 'pretty' | 'json';
  readonly coverage: 'summary' | 'detailed';
  readonly reportFile: string | null;
}

export interface ProjectConfig {
  readonly $schema: string;
  readonly integration: string;
  readonly extends: string | null;
  readonly entry: string;
  readonly tsconfig: string;
  readonly outDir: string;
  readonly extraProperties: 'error' | 'strip';
  readonly compiler: CompilerConfig;
  readonly ncc: NccConfig;
  readonly assets: readonly AssetConfig[];
  readonly diagnostics: DiagnosticsConfig;
}

export interface InitResult {
  readonly created: boolean;
  readonly configPath: string;
  readonly config: ProjectConfig;
  readonly suggestedScripts: readonly string[];
}

export interface InitializeProjectOptions {
  /** Adapter selected only when the configuration file is first created. */
  readonly integration?: string;
}
