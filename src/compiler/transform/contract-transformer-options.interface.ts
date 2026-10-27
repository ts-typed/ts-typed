import type { AnalysisResult, CoverageDiagnostic } from '../analysis';

export interface ContractTransformerOptions {
  readonly analysis: AnalysisResult;
  readonly runtimeModule?: string | ((sourceFile: import('typescript').SourceFile) => string);
  readonly extraProperties?: 'error' | 'strip';
  /**
   * Compiled-in default for class-typed contracts: `false` (default)
   * validates structurally; `true` requires `instanceof` wherever a live
   * class reference can be embedded (same file as the validation point).
   * A per-class `@StrictClass()`/`@StructuralClass()` decorator overrides
   * this at validation time regardless of what is compiled in here.
   */
  readonly strictClass?: boolean;
  /**
   * When true, `readonly` class fields are validated like any other field
   * and then locked against further writes once their declaring
   * constructor finishes, instead of being left entirely unprotected.
   */
  readonly enforceReadonly?: boolean;
  /**
   * When true, `private` class fields are rewritten into real ECMAScript
   * `#private` fields with an inlined validating accessor pair, instead of
   * staying reflectively public and entirely unprotected. Requires
   * {@link AnalyzeProjectContext.enforcePrivate} to have been set to true
   * on the same `analysis` so `privateBracketAccessConflicts` is populated;
   * converting a field accessed through bracket notation anywhere in the
   * program throws synchronously, failing the build, since that access
   * pattern has no `#private` equivalent.
   */
  readonly enforcePrivate?: boolean;
  /**
   * When true, every named class's instances are made non-extensible via
   * `Object.preventExtensions(this)` once the most-derived class's constructor
   * finishes, so properties not declared on the class (string or symbol keys)
   * can no longer be added. Opt-in: other libraries that copy onto `new Dto()`
   * instances (e.g. class-transformer's plainToInstance) will hit a native
   * TypeError unless configured to write only declared keys.
   */
  readonly enforceClosedInstances?: boolean;
  /**
   * When true, an array that crosses a typed boundary via `protectValue` is
   * wrapped in a Proxy so that later `push`/`splice`/index/`length` writes of
   * an invalid item throw a `StrictTypeError` instead of succeeding silently.
   * Opt-in; default off.
   */
  readonly enforceMutationGuards?: boolean;
  readonly onDiagnostic?: (diagnostic: CoverageDiagnostic) => void;
}
