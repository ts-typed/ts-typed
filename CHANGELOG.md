# Changelog

All notable changes to `@ts-typed/compiler` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-10-27

### Added

- **New `closeAggregateWindowOrThrow(instance)` closes an `@AggregateErrors()` instance's aggregate window explicitly and synchronously.** The GC-driven close (see "Changed" below) is necessarily a best-effort report, not a throw, and may run arbitrarily late. For manual population you know won't cross a typed parameter boundary — e.g. right after `class-transformer`'s `plainToInstance()`, or after hand-setting every field — call this immediately afterward to get an immediate, synchronous `AggregateStrictTypeError` throw instead, with no GC-timing race. It is a no-op (no throw) when the window was already closed, was open but empty, or was never open at all.
- **`@AggregateErrors()` now supports array-of-DTOs parameters.** A declared parameter like `dtos: CreateUserDto[]`, where `CreateUserDto` is `@AggregateErrors()`-decorated, used to fail fast at the first invalid element — every later element's violations went unreported. It now aggregates violations from every invalid element into a single `ArrayAggregateStrictTypeError` (exported from `src/runtime/index.ts`), with one nested `AggregateStrictTypeError` per invalid element. Each nested error carries its own `elementIndex`, the element's real original position in the array (not its position among the invalid elements, which skips any valid ones in between) — so `error.errors[1].elementIndex` can be `2` if `error.errors[0]` was element `0`'s error and element `1` was valid. Each nested error's own violations also carry a `propertyPath` consistent with the parameter's structural violations (`"dtos[0].name"`, or `"dtos[0].address.zip"` for a nested field), including violations collected from property writes during the element's own construction — the compiler already writes these as bare field paths relative to the element (e.g. `"name"`, `"address.zip"`), so they are re-rooted by directly prefixing with the element's structural path, with nothing stripped or reparsed.

### Changed

- **An `@AggregateErrors()` instance that never crosses a typed parameter boundary is now reported when garbage collected, instead of silently forgotten forever.** Previously, an instance constructed but never passed through a typed parameter (or discarded before it could be) buffered its violations in memory with nothing left to ever read them out, and 0.2.0 had no auto-close mechanism at all for this case. Closing is now driven by a `FinalizationRegistry`: once such an instance becomes unreachable, its buffered violations (if any) are reported through a new settable `setAggregateWindowLeakHandler(handler)` (exported from `src/runtime`), whose default implementation logs via `console.error`. This has no effect on the normal validation path — a real parameter crossing still synchronously throws `AggregateStrictTypeError`/`ArrayAggregateStrictTypeError` for an invalid value before the function body runs, exactly as before; this change only concerns instances that never cross a boundary at all. Garbage-collection timing is non-deterministic, so the handler may run long after construction, or not at all before process exit — it is a best-effort leak report, not a replacement for the real crossing's synchronous guarantee.
- **`elementIndex` now appears in array-aggregation HTTP 400 response bodies.** When an `@ts-typed/nestjs` `StrictTypeErrorFilter` serializes an `ArrayAggregateStrictTypeError` (from the array-of-DTOs aggregation above), each nested `AggregateStrictTypeError`'s `elementIndex` is included via `toJSON()`, so API consumers can tell which array element each nested error group belongs to.

## [0.2.0] - 2026-10-27

### Changed (breaking)

- **`allowExtraPropertiesAll` / `AllowExtraProperties()` replaced by a two-value `extraProperties` policy.** The only extra-property behavior besides the default `'error'` throw used to be "allow and keep" (via the global `allowExtraPropertiesAll: true` flag or the `AllowExtraProperties()` decorator), which let data the TypeScript type never declared flow into the rest of the program unchecked. That option is removed outright — there is no boolean-compat shim.
  - **Config:** `typets.config.json`'s `allowExtraPropertiesAll: boolean` is now `extraProperties: 'error' | 'strip'` (default `'error'`, same as before).
  - **Decorator:** `AllowExtraProperties()` is now `ExtraProperties(policy: 'error' | 'strip')`, settable per class or per property; precedence is unchanged (property-level overrides class-level overrides the global config default). A class-level policy covers that class's instances and everything nested under them; when nested classes disagree, the value's own class wins over an enclosing owner's class.
  - **Strip is all-or-nothing.** Undeclared keys are only deleted once the whole value has validated; a rejected value comes back untouched, and which union member matches never depends on the policy (an exact match is preferred over one that needs stripping).
  - **Mutation guards (`enforceMutationGuards`):** writing an undeclared key to a guarded plain object now throws `EXTRA_PROPERTY` under `'error'` (it was previously forwarded) and is a silent no-op under `'strip'`.
  - **Migration:** if you previously set `allowExtraPropertiesAll: true` or used `AllowExtraProperties()` because you wanted unknown data silently discarded, switch to `extraProperties: 'strip'` / `ExtraProperties('strip')`. If you actually wanted that data to flow through and be usable, add an index signature (`[key: string]: T`) to the type instead — index signatures were already, and remain, a separate mechanism unaffected by this change.
  - `getExtraPropertiesPolicy(target, propertyKey?)` replaces `isExtraPropertiesAllowed(target, propertyKey?)` for anyone reading decorator metadata directly; it returns `'error' | 'strip' | undefined` instead of a boolean.

## [0.1.35] - 2026-10-21

### Fixed

- **`TTOptImmut` could partially freeze a rejected value.** `protectOptimizedImmutableValue` froze each node as it walked the graph, so a sibling visited before an unsupported node (a class instance, a `Map`/`Set`, an accessor property) was already frozen by the time the call threw — the caller's input came back silently, unpredictably mutated instead of untouched. The unsupported-shape check now runs as its own complete pass before any freezing starts, so a rejected call never freezes anything.

### Known limitations (found during this round's review, not fixed — a
legitimate JS engine constraint, not a quick patch)

- **A legitimately very deep value (roughly 500+ nested levels) throws a raw
  `RangeError: Maximum call stack size exceeded`** from `assertValue`,
  `protectValue` and `protectOptimizedImmutableValue`, instead of a
  `StrictTypeError` or a successful result. Validation and protection are
  recursive, at roughly 5-10 stack frames per nested level; a self-referential
  (cyclic) structure terminates correctly via the existing visited-set
  tracking regardless of depth, so this only affects genuinely deep
  non-cyclic data. Fixing it would mean rewriting the traversal iteratively
  with an explicit stack, a substantial change to the hottest code path in
  the runtime, not attempted this round.

## [0.1.34] - 2026-10-21

### Fixed

- **`TypeErrorResponse()`, `isServerPopulated` and `AllowExtraProperties()` on a
  nested class instance were only applied by the later protection-install
  pass, never by the FIRST structural validation that runs when a value
  crosses a typed boundary.** A `@Body() dto: UserDto` whose nested/own field
  had a `TypeErrorResponse('message', status)` always reported the generic
  400 with the raw type-mismatch message on the first violation — the custom
  response only took effect on a later direct field write
  (`dto.email = 123`), which real request bodies never go through. The same
  gap applied to `ServerPopulated()` on an entity nested inside a plain,
  undecorated parent (its violations incorrectly reported as client faults),
  and to `AllowExtraProperties()` on a nested class instance (its own
  permission was ignored, since only the top-level value's decorators were
  consulted). `validateObject` in `assert-value.ts` now resolves all three
  against the actual nested owner it is walking, not just the value
  `protectValue` was first called with.
- **A decorated collection field's `TypeErrorResponse` leaked onto violations
  found inside its own array/tuple/Map/Set elements**, both during structural
  validation and during later protection-install/mutation guarding — e.g. a
  field `@TypeErrorResponse('Itens inválidos', 409) items: Item[]` turned
  every violation inside `items[0]` into the same 409, even though an
  element has no property key of its own to carry that response and the
  documented rule is that a decorated parent does not customize its nested
  children.

### Known limitations (found during review, not fixed this round — both
pre-date the recent perf work and need a deliberate design decision, not a
quick patch)

- **A value that already crossed one typed boundary keeps only that
  boundary's contract.** `protectValue` recognizes a value it already wrapped
  in a mutation-guard proxy (`mutationGuardProxies.has(array)`) and returns it
  unchanged, so a SECOND `protectValue` call on the SAME array/object with a
  DIFFERENT (stricter or looser) declared type is silently ignored — the
  proxy still only enforces the FIRST contract. Fixing this properly needs
  the array/Map/Set/object mutation guards to support multiple contracts per
  value the way `DataPropertyGuardState.contracts` already does for class
  fields, rather than a quick patch to the existing single-contract proxy
  cache.
- **`Object.create(protectedInstance)` can leak a write onto the prototype
  instance itself**, visible to every other object sharing it as a
  prototype. `guardOwnerOf`'s prototype-chain walk is required for normal
  class-field inheritance (a subclass instance finding a guard installed by
  an ancestor's constructor), but it cannot currently distinguish that case
  from a plain object manually given an already-guarded instance as its OWN
  prototype — a pattern `ts-typed`-compiled TypeScript does not itself
  produce, but hand-written `Object.create` can.

## [0.1.33] - 2026-10-20

### Performance

- **Schema-specialized protection installer.** Repeated object protections now
  reuse a compiled per-schema/per-prototype installer with precomputed property
  schemas, paths and decorator metadata. The generic installer remains active
  for index signatures and other special cases.
- In the 10,000-object benchmark, response protection improved from 39.24 ms to
  36.21 ms in the full pipeline run (about 7.7%); the isolated runtime sample
  improved to 34.44 ms (about 12.2%).

## [0.1.32] - 2026-10-20

### Performance

- **Shared validation/protection traversal session.** `protectValue` now records
  the reference values visited during its complete validation pass and applies
  mutable guards only after validation succeeds. Protection replays the recorded
  plan shallowly, reusing the same per-boundary schema metadata and preserving
  atomic failure behavior without changing the public API.
- **Stage-level performance measurements.** The TypeORM/Express/Nest harness now
  reports database hydration, entity validation, projection, response
  validation, protection, and JSON serialization independently.

## [0.1.31] - 2026-10-20

### Added

- **`TTOptImmut<T>` for high-volume immutable response DTOs.** This opt-in type
  validates the complete contract and then deeply freezes plain objects and
  arrays instead of installing a mutable accessor guard for every field. The
  result is deeply `readonly` in TypeScript and remains an ordinary POJO for
  `Object.keys`, spread, JSON and `structuredClone`. It is intended for fresh,
  read-only response DTOs such as `TTOptImmut<IUserData[]>`; entities, classes,
  `Date`, `Map`, `Set`, functions, accessor-backed objects, indexed shapes,
  unions and intersections receive an explicit unsupported diagnostic rather
  than a silent fallback.
- **Expanded performance battery.** The reproducible TypeORM/Express/Nest
  harness now compares baseline, mutable `protectValue`, and `TTOptImmut` at
  1, 50 and 10,000 DTOs while verifying `passwordHash` never reaches the
  response.

## [0.1.30] - 2026-10-20

### Fixed

- **Nested `ValueObject` values are auto-constructed at typed boundaries.** A raw string in an interface/object property, array item, or tuple item now becomes the declared `ValueObject` instance before structural validation. The handler receives the materialized instance, so its domain methods are safe to call without a manual `new` or a separate boundary.

## [0.1.29] - 2026-10-20

### Added

- **Native Nest npm workflow.** `ts-typed init` now recognizes a conventional Nest project and configures its ordinary `build`, `start`, `start:dev`, and `start:debug` scripts to run through TS Typed. `ts-typed nest build` emits unbundled protected JavaScript into Nest's normal `dist` directory; `ts-typed nest start` builds and runs `dist/main.js`; watch mode rebuilds and restarts only after a successful compilation. Initialization is idempotent and custom scripts are deliberately untouched.
- **Safe Nest builder gate.** The Nest command explicitly supports Nest's `tsc` builder. It rejects SWC, Rspack, and webpack before emitting output, because those builders cannot execute TS Typed's TypeScript transformer and would otherwise create an application that looks built but has no runtime contract protection.

## [0.1.28] - 2026-10-19

### Changed

- **Object-schema metadata is now cached for each runtime traversal.** A `WeakMap` reuses the declared property keys and key set while one `assertValue` or protection walk validates many objects with the same schema (for example, a 10,000-row response). The cache is local to that operation, so it neither retains schemas nor survives into a later boundary crossing. Validation and guard installation remain separate phases, preserving the guarantee that an invalid value is never accepted with a partially installed protection graph.

## [0.1.27] - 2026-10-19

### Fixed

- **`@AggregateErrors()` now works when the DTO is populated field-by-field after construction**, which is what `class-transformer`'s `plainToInstance` does and therefore what Nest's `ValidationPipe({ transform: true })` does. Previously the decorator had no effect in that path: the first invalid field write threw immediately, so the caller got a single `StrictTypeError` instead of the aggregated list. A decorated instance now opens a per-instance "aggregate window" at construction; field writes made while it is open collect instead of throwing, and the window closes — merging the collected violations with a full structural check, including a missing required field or an undeclared extra key — the first time the instance crosses a real parameter boundary.
- **Nested aggregate windows are drained during structural validation.** A decorated DTO inside another DTO (decorated or not), an array, or an array parameter can no longer silently accept a rejected field write by retaining its old default value. Validation now surfaces the violation at the enclosing typed boundary. Field writes also preserve every violation found in a nested value instead of retaining only the first one.
- Known limitation: a decorated instance that is constructed and then only ever mutated by application code, never passed through a typed parameter, never closes its window. Field-write protection is effectively suspended on that instance from then on. `@AggregateErrors()` is intended for DTO-style classes that are freshly constructed and validated at a parameter boundary; see the README's [`AggregateErrors()`](./README.md#aggregateerrors) section.
- Known limitations: invalid raw input for a `ValueObject` field still throws before it can join the aggregate, and a field with no initializer while `strictPropertyInitialization` is disabled can yield a duplicate diagnostic. Neither limitation accepts invalid data.

## [0.1.26] - 2026-10-19

### Added

- **`AggregateErrors()` class decorator**: opts a class into collecting every validation violation found in it — at any depth, including nested objects, arrays of objects, and an optional/nullable nested DTO (`profile?: Profile`, `profile: Profile | null`) — into one `AggregateStrictTypeError`, instead of ts-typed's default fail-fast (first violation only). This is scoped to the parameter boundary (a function/method argument — the typed-DTO-in-a-request-body case), which is the only place ts-typed validates "a whole incoming value" in one shot; construction, a field write after construction, variables and return values all stay fail-fast regardless of this decorator.
- Detection is static: the compiler reads the decorator directly off the class declaration via the type checker, so it works regardless of which file declares the class (the realistic case — a DTO is almost always imported from its own file) and regardless of whether the value is ever instantiated (ts-typed validates a parameter DTO structurally, without instantiating it, by design — see the README's "How it works"). A runtime check on the value's own prototype chain is also kept as a fallback, for a hand-built instance that bypasses the compiler's schema (e.g. constructed and passed directly, not through a compiled parameter boundary).
- `AggregateStrictTypeError extends StrictTypeError`, so every existing `instanceof StrictTypeError` consumer (application `try`/`catch`, `@ts-typed/nestjs`'s `StrictTypeErrorFilter`) keeps working unchanged — it sees the first violation's fields through the inherited properties, with the full list additionally available as `.errors`.
- Known scope boundaries: an array-typed **parameter itself** (`dtos: Dto[]`, as opposed to a nested array field) is not aggregated; a namespace-qualified decorator call (`@someNamespace.AggregateErrors()`) is not detected and falls back to fail-fast; a per-field `TypeErrorResponse()` message/status override is not folded into an `AggregateStrictTypeError`'s own fields yet. See the README's [Known limitations](./README.md#known-limitations) and the new [`AggregateErrors()`](./README.md#aggregateerrors) section.

## [0.1.25] - 2026-10-19

### Changed

- Widened the supported range to `Node >=18` (from `>=22`) and `TypeScript >=5.4 <7` (from `>=5.9 <6`). Neither floor was backed by an actual API dependency: the Node APIs used throughout the codebase (`fs/promises` `cp`/`rm`/`mkdir`, `readline/promises`, `module.createRequire`, `util.inspect`, `Object.hasOwn`, `Array.prototype.at`) have all been available since Node 16/17, and the TypeScript Compiler API surface used (`ModuleKind.Node16`/`NodeNext`/`Preserve`, `isSatisfiesExpression`, `canHaveDecorators`/`getDecorators`) has been stable since TS 5.4. The `>=5.9` floor was an explicit, undocumented policy check in `validateTypescriptModule` rather than a technical requirement; it's now `>=5.4 <7` to match the real compatibility surface while still rejecting the next major (TS 7) by default.

## [0.1.24] - 2026-10-19

### Added

- **`tsconfig.json` `paths` aliases are now resolved and rewritten at build time**, instead of failing the build outright. A project organized with `@app/*` -> `src/*`-style aliases now builds and runs correctly with no separate runtime resolver — the compiler resolves every aliased `import`/`export ... from`/`require()`/dynamic `import()` the same way TypeScript's own checker already does (`ts.resolveModuleName`, so it can never disagree with what type-checked) and rewrites the specifier to a plain relative path, in both the unbundled output and the `ncc`-bundled one (by the time `ncc` sees the file, the import is already an ordinary relative path). See the README's new [Path aliases](./README.md#path-aliases-tsconfigjson-paths) section.

### Changed

- **Replaced the previous "refuse to build at all if `paths` is configured" behavior.** That check existed because TypeScript never rewrites an aliased specifier in its own JS output, and a plain build would silently emit a `require('@app/...')` that fails at runtime with "Cannot find module" — the check is still there, just much narrower now: the build still fails up front, but only for an alias that genuinely can't be turned into something runtime-resolvable (nothing on disk matches it, or it resolves only to a `.d.ts` with no JS behind it), and the error now points at the exact `file:line:column` of each occurrence instead of blocking literally any use of `paths`.

## [0.1.23] - 2026-10-19

### Added

- Generic call/construct validation now covers **inferred type arguments**, not just explicit ones: `identity(x)` and `new Box(x)` are now validated the same way `identity<Person>(x)` and `new Box<Person>(x)` already were. The caller-side transport (`checker.getResolvedSignature`) already returned the per-call-site instantiated signature regardless of whether `T` was written explicitly or inferred — the only thing that previously gated this off was a check on the call's own syntax (`node.typeArguments`), not on whether the declaration was actually generic. Removing that gate is what makes `function response<T>(data: T): IResponse<T>`, called as `response(user)` with no explicit `<T>`, now validate the returned `IResponse<T>` shape against `T` inferred straight from `user`.
- If inference can't pin `T` down to anything concrete (no argument references it and no contextual/expected type is available), TypeScript resolves it to `unknown`, which the existing `isUncheckableType` guard already treats as "no contract" rather than validating against the wrong thing — the same safe fallback unsupported types already got.

### Fixed

- Generic calls/constructs whose declaration lives in one of TypeScript's own bundled lib files (`Array.prototype.map`, `Promise.resolve`, `Map`/`Set`'s own methods, `new Map(...)`/`new Set(...)` themselves, etc.) are now explicitly excluded from the generic call/construct guard above. Without this, lifting the explicit-type-argument gate would have meant instrumenting essentially every array/collection operation in a project with argument+return validation — far outside this feature's intended scope of a project's OWN generic functions and classes. It also fixes a real conflict surfaced by the project's own test suite: `new Map(...)`/`new Set(...)` already get dedicated handling elsewhere (entry validation, `compiler.enforceMutationGuards`' mutation-tracking Proxy) keyed off the destination variable's name; guarding the inferred constructor call too double-wrapped the same value under a second, differently-labeled protect call (the constructor name instead of the variable name), and the mutation-guard Proxy ended up reporting the wrong one.

## [0.1.22] - 2026-10-18

### Fixed

- `ValueObject` subclass detection (0.1.21) failed to find a cross-file reference when the class was imported with `import type { CPF } from '...'` (or an individual `import { type CPF } from '...'` specifier) — a VERY common way to import something that's only ever used as a type annotation, which is the entire point of this feature (no `new CPF(...)` anywhere in application code). The detection silently fell back to treating the type as `unknown` (no validation, no auto-construction at all) in this case. The fix removes the `isTypeOnly` exclusion: the synthesized import `createValueObjectDefinitionExpression` adds for the constructor reference is already a completely fresh, independent `require`/namespace import (confirmed in the code, not assumed) — it never depended on the user's own import surviving TypeScript's emit, so there was no reason to skip a type-only import in the first place. Caught end-to-end via a real multi-file build in a consuming application (not just the internal test suite), where `import type` is a common, idiomatic style.

## [0.1.21] - 2026-10-18

### Added

- Step 3/3, completing the auto-constructed value types feature end to end: the compiler now recognizes, in real TypeScript source, when a declared type is a class extending `ValueObject` — **including when that class is imported from a different file or package** (the realistic case: a concrete type like a document-number value object typically lives in its own module, not the file using it) — and embeds a live reference to it in the emitted schema automatically. No manual schema authoring is needed anymore: declaring a parameter, variable, or class field with a `ValueObject` subclass as its type is now enough on its own.

  ```ts
  // value-objects.ts
  export class CPF extends ValueObject {
    protected isValid(raw: string): boolean { /* ... */ }
    public masked(): string { /* ... */ }
  }

  // app.ts
  import { CPF } from './value-objects';
  function searchByCPF(cpf: CPF) { console.log(cpf.masked()); }
  searchByCPF('12345678901'); // auto-constructs a CPF instance, no `new CPF(...)` anywhere
  ```

  Detection walks the full base-class chain (so a class extending an intermediate subclass of `ValueObject` is still recognized, not just a direct subclass), and verifies the matched ancestor is genuinely this package's own `ValueObject` export (by declaration file path), not a coincidentally same-named class. A `ValueObject` subclass's own methods/fields are never walked as structural properties — the schema treats the whole class as an opaque, already-correct unit once detected. The existing `compiler.strictClass`/`instanceOf` mechanism (same-file classes only) is completely unchanged; this new mechanism has its own, looser scoping rules since it needs to work for an imported class.

  **Known limitations, not covered by this release**: a class reached through a symlinked/workspace `node_modules` install (common in some monorepo setups) is not detected — the heuristic looks for `@ts-typed/compiler` in the resolved file's real path, which a symlink can route around; this currently fails SILENTLY (the class falls back to ordinary, unsupported class resolution) rather than with a diagnostic, a gap worth tightening in a follow-up. A `ValueObject` subclass reached only through inference, a namespace import, or NOT imported by name into the file resolving it, is not detected either. `CPF | undefined` (a union including a `ValueObject` type) does not auto-construct — only a direct, non-union reference does. A cyclic ES module import involving the `ValueObject` subclass's own module is unhandled.

## [0.1.20] - 2026-10-18

### Added

- Step 2/3 of auto-constructed value types: when an `ObjectSchema` carries a new `valueObjectCtor` field (a live reference to a `ValueObject` subclass, embedded the same way `instanceOf` already is — set manually for now; a follow-up release teaches the compiler to set it automatically for a real `ValueObject` subclass declared as a boundary's type), a raw string crossing that boundary is now auto-constructed into an instance instead of being validated structurally or rejected outright: `protectValue` (variables, parameters, returns, casts) and a class field's write-time guard both run the value through a new shared `autoConstructValueObject` helper. An existing instance passes through unchanged (no re-validation); a raw string is handed to `new Ctor(raw, context)` — the class's own `isValid()` check runs and throws `StrictTypeError` on failure, with the SAME `propertyPath`/`contractKind`/`operation`/`className` the boundary already carries, so an auto-constructed validation failure reads exactly like any other one; any other value (not a string, not already an instance) is rejected as `TYPE_MISMATCH`.

  **Known limitations, not covered by this release**: a `ValueObject`-typed property NESTED inside a plain object/array that itself crosses a boundary as a whole is not converted — `validateObject`'s property walk has no way to substitute a value in its parent object, so a raw string there now fails loudly (`TYPE_MISMATCH`) instead of silently passing, which is at least safe, but not yet auto-constructed. An intersection of object schemas including a `valueObjectCtor` schema drops it, the same way `instanceOf` already does. This is runtime-only — no compiler change yet; the compiler side (recognizing a `ValueObject` subclass in real TypeScript source and setting `valueObjectCtor` automatically) is a separate, upcoming step.

## [0.1.19] - 2026-10-18

### Added

- A new abstract `ValueObject` base class (extends the boxed `String` object) for "value object" types that behave like a string — `console.log`, template literals, string concatenation, and `JSON.stringify` all show the raw value — while carrying custom validation and custom methods. A subclass implements `protected isValid(raw: string): boolean`; the constructor calls it after `super(raw)` and throws `StrictTypeError` (`contractKind: 'construction'`) when it returns `false`. Subclasses inherit every `String.prototype` method for free (`.toUpperCase()`, `.trim()`, `.includes()`, …) and add their own on top (e.g. `.masked()`, `.numbers()` for a document-formatting value object). This is step 1 of 2 for a new feature: today a `ValueObject` subclass must be constructed explicitly (`new CPF(raw)`); a follow-up release teaches the compiler to construct one automatically when a raw string crosses a typed boundary declared as that class, so an application never has to call `new CPF(...)` by hand.

  **Trade-offs inherent to JavaScript, not fixable**: `typeof instance` is `'object'`, not `'string'` (a primitive can never carry extra methods); strict equality against a primitive string fails (`instance === 'abc'` is `false` — compare with `instance.toString()` or `String(instance)` instead).

## [0.1.18] - 2026-10-18

### Documentation

- Full `README.md` rewrite: configuration reference (every `compiler.*`/top-level flag), every decorator (`AllowExtraProperties`, `StrictClass`/`StructuralClass`, `ServerPopulated`, `TypeErrorResponse`), the `StrictTypeError` shape, the explicit-generics feature, and a clear, grouped list of known limitations. No code changes.

## [0.1.17] - 2026-10-18

### Added

- A new `TypeErrorResponse(message, status?)` property decorator lets an application attach a custom, HTTP-facing message (and optional status code) to a specific class field. When a `StrictTypeError` is thrown for that field, the error carries `typeErrorResponseMessage`/`typeErrorResponseStatus`. **Both are deliberately excluded from `StrictTypeError#toJSON()`** — same non-leak rule as `ServerPopulated()`'s `isServerPopulated` (0.1.12) — they are an internal signal for code that catches the real exception object, never serialized into a generic JSON error body. This package has no HTTP awareness on its own; a follow-up `@ts-typed/nestjs` release reads these fields to build a fully custom `HttpException` for a decorated DTO field, as an alternative to `class-validator`'s per-property messages. The fields are scoped per-property: a parent property's custom response does not leak into a nested child property's own violation.

  This is deliberately a single-violation mechanism (fail-fast), consistent with how the rest of ts-typed works today — it customizes the response for whichever ONE violation happens to fire on the decorated property, not an aggregate of multiple violations across an object (that would be a separate, materially larger architectural change: ts-typed validates and populates a DTO field-by-field as `class-transformer` assigns each one, throwing on the first bad field, unlike `class-validator`'s "populate everything, then validate the whole object in one pass, collect every violation" model).

## [0.1.16] - 2026-10-18

### Added

- `GENERIC_TRANSPORT`'s call-site validation now also covers rest parameters and spread arguments, for both explicit-generic calls and `new` expressions. `function collect<T>(...items: T[]): T[]` called as `collect<number>(1, 2, 'bad')` now validates each plain argument landing in the rest parameter individually against its element type (catching `'bad'` specifically). A spread argument landing in the rest parameter (`collect<number>(...mixed)`) is validated as a whole array against an array schema built from the rest element's type. A spread BEFORE the rest parameter (`f<T>(a: T, ...rest: T[])` called as `f(...arr, x)`) still stops the check at that point, since its length can't be known at transform time.

## [0.1.15] - 2026-10-18

### Added

- `GENERIC_TRANSPORT`'s call-site validation now also covers `new` expressions with an explicit type argument (`new Box<Person>(x)`), mirroring the existing explicit-call-expression support (0.1.11): each checkable constructor argument is validated against the instantiated parameter type, and the constructed instance is validated against the instantiated instance type (`checker.getResolvedSignature(node)` works the same way for a construct signature as for a call signature). A generic class's type parameters live on the CLASS declaration, not on an implicit/default constructor, so the owning class's `typeParameters` are checked when the resolved declaration is a constructor without its own; a class with no declared constructor at all (the implicit default) is handled too. There is no async equivalent for a constructor — construction is always synchronous in JS/TS, so unlike the call-expression case there's no `.then()` branch needed here.

  **Known limitations, not covered by this release** (same scope boundaries as the call-expression feature): an inferred type argument (`new Box(x)`, no explicit `<T>`) is not validated. Rest/spread constructor arguments are skipped.

## [0.1.14] - 2026-10-18

### Added

- `GENERIC_TRANSPORT`'s call-site validation now also covers the RETURN side of a plain `async` function called with an explicit type argument (`identityAsync<Person>(x)`). Previously, an async callee's return was skipped entirely (the instantiated return type is `Promise<X>`, and wrapping the whole call in `protectValue` would validate the Promise object itself, not `X`) — the fix instead extracts `X` via the same generic-reference unwrapping helper already used for `Generator<T, ...>`/`Iterable<T>`, and chains `.then((resolved) => protectValue(schema, resolved, context))` onto the call. The expression's own type is unaffected — it's still a `Promise`, so code that chains `.then()` on it elsewhere, or never awaits it at all, keeps working exactly as before. A failed check now REJECTS the chained promise (consistent with how any other failure inside an async operation surfaces), rather than throwing synchronously — `await identityAsync<Person>(bad)` throws at the `await`, same as any other rejected promise.

  **Known limitation, not covered by this release:** generators (`function*`, `async function*`) still have no call-site return validation — a generator's call doesn't produce a single return value the same way, it produces an iterator; checking what it YIELDS would mean intercepting the returned iterator's own `.next()` calls, a materially bigger, separate problem left for a future release if it turns out to matter in practice.

## [0.1.13] - 2026-10-18

### Added

- `compiler.enforceMutationGuards` now wraps NESTED arrays/`Map`s/`Set`s/plain-objects recursively, not just the top-level value that crosses a typed boundary. Previously, `const config: { items: number[] } = value;` wrapped `config` itself but left `config.items` — a nested array — completely unguarded, so `config.items.push('wrong')` slipped through even with the flag on. Now, when a guard proxy is first created, every declared nested position already present (array items, object properties, Map keys/values, Set items) whose value is itself a container with a matching declared schema gets recursively wrapped too, and the wrapped version is written back in place so later reads see the guarded version. The same recursive wrapping applies when a NEW container value is written into an already-guarded structure (`config.items = [1, 2, 3]` — the newly-assigned array is wrapped before being stored, so it stays protected too). Circular references (an object referencing itself, or two objects referencing each other) are handled via a per-wrap session that reuses the proxy already being built instead of recursing forever.

  **Known limitations, not covered by this release:** a `Set`'s pre-existing items (present before the guard was created) cannot be swapped for their wrapped versions without removing and re-adding them, which would change iteration order — only each item's OWN nested children get wrapped in place; the item itself stays unguarded for direct top-level writes. A `Map`'s keys keep their identity for the same lookup-by-reference reason (only walked, never replaced). A value declared as a union with more than one container member of the same runtime kind (e.g. a schema ambiguous between two different array shapes) is left unwrapped rather than guessing which one applies. Wrapping changes identity: a nested value's wrapped (proxy) version is no longer `===` the raw reference the caller originally held onto, and `Set.has(rawItem)` after `add(rawItem)` reflects the wrapped version, not the raw one passed in.

## [0.1.12] - 2026-10-18

### Added

- A new class-level `ServerPopulated()` decorator (mirroring the existing `AllowExtraProperties()`), for marking a class whose instances are populated by the server/database rather than by client input — the intended use is a TypeORM `@Entity()` class. When a `StrictTypeError` is thrown for a declared field on a `@ServerPopulated()`-marked instance, the error instance carries `isServerPopulated: true`; for an unmarked class it's `undefined`. **This flag is deliberately excluded from `StrictTypeError#toJSON()`** — it is an internal signal for code that catches the real exception object (like `@ts-typed/nestjs`'s `StrictTypeErrorFilter`, coming in a follow-up release of that package), never something serialized into an HTTP response body. This is the compiler/runtime half of closing `FILTER_STATUS_FOR_ENTITY_HYDRATION`: a filter can now tell "this field belongs to a server-populated Entity, a wrong value here is a server/database fault" apart from "this field belongs to a request DTO, a wrong value here is a client's bad input" — something `contractKind`/`operation` alone could never express, since a TypeORM Entity's field and a `class-transformer`-populated DTO's field both go through the exact same `contractKind: 'property'` path.

## [0.1.11] - 2026-10-18

### Added

- Closes the `GENERIC_TRANSPORT` gap for the explicit-type-argument case: calling a generic function with an explicit type argument (`identity<Person>(x)`, `wrap<number>(x)`) now validates both the arguments and the return value against the CONCRETE, call-site-specific type, instead of the unresolvable bare type parameter the function's own body sees. This is unconditional, not behind a config flag — unlike `enforceMutationGuards`/`enforceClosedInstances`, there is no existing behavior to preserve for a case that previously did nothing at all.

  **Why this needed a new mechanism, not a tweak to existing checks:** every OTHER parameter check ts-typed emits is injected inside the CALLEE's own function body, compiled once; for a generic function that body is the SAME compiled code for every call, so a bare `T` has no concrete type to check against there — this is why `identity<Person>(wrongShapedValue)` + `identity<string>(wrongShapedValue)` always looked identical from inside `identity`. The fix works from the CALLER's side instead: for a call expression with an explicit type argument, `checker.getResolvedSignature(node)` hands back a signature TypeScript itself has ALREADY instantiated with the concrete type substituted in — no manual substitution needed. Each argument whose instantiated parameter type is checkable gets wrapped in `protectValue` (`contractKind: 'parameter'`, `operation: 'argument'`) before the call runs, and the whole call expression gets wrapped in `protectValue` against the instantiated return type (`contractKind: 'return'`, `operation: 'return'`) — both using the exact same transform-time resolver call already used for destructuring (0.1.4) and type predicates (0.1.5).

  **Known limitations, not covered by this release:** an INFERRED type argument (`identity(x)`, no explicit `<T>`) is not transported — replicating the checker's own inference at the call site is a separate, harder problem. Rest parameters and spread arguments are skipped (iteration stops at the first one encountered). `async`/generator functions have their arguments checked but not their return value (the instantiated return type is a `Promise<...>`/iterator wrapper, not the resolved inner value). `new Box<Person>(x)` construct expressions are not covered, only plain call expressions. Generic classes and generic methods with no call-expression form are untouched.

## [0.1.10] - 2026-10-18

### Added

- `compiler.enforceMutationGuards` now also covers plain objects/interfaces, closing `SEALED_OBJECTS` and the plain-object half of `REFLECTIVE_MUTATION` (the class-instance half was already fixed in an earlier release via non-configurable fields). A plain object crossing a typed boundary (not a class instance — identified by its prototype being `Object.prototype` or `null`, so class instances keep their identity and private-field semantics untouched) is wrapped in a `Proxy` with three traps: `set` validates a declared property's new value before the write goes through (this is what finally protects an `Object.seal()`-ed object, whose properties stay writable-but-non-configurable — the existing per-property accessor guards can't be installed on a non-configurable property via `defineProperty`, so this was previously silently unprotected); `deleteProperty` refuses to remove a REQUIRED declared property; `defineProperty` refuses a declared property whose new `value` fails its schema. All three refusals use native semantics (returning `false`) rather than throwing `StrictTypeError` directly, matching the convention already established for class instances' non-configurable required fields — the engine itself then produces the native effect (`delete` throws in strict code, `Object.defineProperty` throws a plain `TypeError`). `Object.freeze`d objects needed no new work: freezing already makes properties non-writable, so the JS engine itself rejects a bad write with no help from ts-typed.

  Like the array/Map/Set cases, this is additive to `enforceMutationGuards` (no new flag) and off by default. Undeclared keys are forwarded untouched, consistent with the existing `allowExtraProperties`/`allowExtraPropertiesAll` boundary-crossing behavior, which this does not change.

## [0.1.9] - 2026-10-18

### Added

- `compiler.enforceMutationGuards` now also covers `MAP_SET_MUTATION`: a `Map`/`Set` crossing a typed boundary gets wrapped in a `Proxy` whose `.set()` (Map) / `.add()` (Set) are replaced with validating wrappers — a Map's key AND value, or a Set's item, are checked against the declared schema before the real entry is written, throwing `StrictTypeError` (`operation: 'mutate'`) on a mismatch instead of silently accepting it. `.delete()`/`.clear()` need no validation (removing an entry can't introduce a violation) and are forwarded as-is. Because `Map`/`Set` store entries in an internal engine slot that only the genuine `Map.prototype`/`Set.prototype` methods can touch, every read and every forwarded call runs against the real underlying collection, never against the proxy itself — the wrapped `.set()`/`.add()` return the proxy (not the raw target) so chained calls (`map.set(a, 1).set(b, 2)`) keep going through the guard.

  **Known limitations, not covered by this release:** `WeakMap`/`WeakSet` remain entirely unguarded (same as before this change — they were already out of scope for the boundary-crossing check too). A reference to the collection obtained through `.forEach()`'s third callback argument is the raw, unwrapped target, so mutating through it bypasses the guard. Method references taken off the proxy are rebuilt on every property access (`map.get !== map.get` across two reads) — functionally harmless, but not something to rely on for identity comparisons.

## [0.1.8] - 2026-10-18

### Added

- A new opt-in `compiler.enforceMutationGuards` config flag (default `false`) closes the `ARRAY_MUTATION` gap for the common case: when set to `true`, an array crossing a typed boundary (e.g. `const scores: number[] = value;`) is wrapped in a `Proxy` whose `set` trap validates any new element written to a numeric index — directly (`scores[3] = 'x'`), or indirectly through a mutating method that writes indices under the hood (`.push()`, `.splice()`, `.unshift()`, …) — against the array's item schema before the write is allowed to go through, throwing `StrictTypeError` (`operation: 'mutate'`, same `TYPE_MISMATCH` shape as any other boundary violation) on a mismatch. `length` reads/writes are left alone (truncating or growing an array is not itself a type violation). This is opt-in because validating every element write has a real per-write cost, and because the wrapped proxy is a different object reference from the original array — any code comparing the two by identity after assignment would need to be aware of it.

  **Known limitations, not covered by this release:** only the direct result of a boundary crossing is wrapped — an array stored in a typed class field (assigned through `installFieldGuard`'s own setter path) is not wrapped, nor is an array nested inside a plain object/another array. A value typed as `T[] | undefined` (or any other union containing an array) is not wrapped, since the schema resolves to `kind: 'union'`, not `kind: 'array'`, at the point `protectValue` runs — a real gap for the common optional-array case, left for a follow-up. A reference to the same array taken BEFORE it crosses the boundary (`const raw = []; const typed: number[] = raw; raw.push('x')`) bypasses the proxy entirely, since `raw` was never replaced by the wrapped value. `Map`/`Set` mutation (`.set()`/`.add()` after the boundary) remains open as the separate `MAP_SET_MUTATION` gap.

## [0.1.7] - 2026-10-18

### Added

- A new opt-in `compiler.enforceClosedInstances` config flag (default `false`) closes the `CLOSED_INSTANCES`/`SYMBOL_KEYS` gap: when set to `true`, a class instance becomes non-extensible (`Object.preventExtensions(this)`) once construction of its most-derived class fully completes, reusing the same `new.target` guard already used for readonly/required field locking so a subclass's own fields are still installed before the seal. Once sealed, no new property — string- or symbol-keyed — can be added to the instance; declared fields can still be reassigned normally. Rejection uses native `Object.preventExtensions` semantics (a `Reflect.set` of a new property returns `false`; a direct strict-mode assignment throws a native `TypeError`), not `StrictTypeError` — turning that into a catchable `StrictTypeError` would need a `Proxy` wrapper around every instance, which is more overhead than this opt-in trade-off calls for.

  **This is deliberately opt-in, and enabling it is a cross-cutting decision, not a free correctness upgrade.** The previous attempt at this (see 0.1.3's "deliberately NOT shipped" note) broke NestJS's `class-transformer` + `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` pattern, which copies every request-body key onto a `new Dto()` instance first and only strips non-whitelisted keys afterward — sealing the instance makes that first copy throw before the whitelist step ever runs. If you turn `enforceClosedInstances` on, you must configure the rest of your stack to never write an undeclared key to that class in the first place (e.g. `class-transformer`'s `excludeExtraneousValues: true` with `@Expose()` decorators, which only ever writes known keys, instead of copy-then-strip). **A mismatch between this flag and another library's config is an application configuration bug, not a ts-typed bug**: the same rule applies to any other ts-typed/third-party option pair (e.g. `allowExtraPropertiesAll` vs. a validator's own whitelist setting) — pick one behavior and configure every layer to agree with it.

  Anonymous class expressions are not sealed (there is no name for `new.target` to compare against, the same limitation `lockReadonlyField`/`lockRequiredField` already have).

## [0.1.6] - 2026-10-18

### Added

- An exported `let`/`var` module-level binding (`export let exportedCounter: number = 0;`), when compiled to CommonJS, now has a guard installed directly on the `exports` object for that property, reusing `installFieldGuard`. Internal reads/writes within the module keep working exactly as before. An external write through the same `exports` object — e.g. `Reflect.set(importedNamespace, 'exportedCounter', 'wrong')`, or a direct property assignment on an `import * as ns` namespace object, or on the object returned by a separate file's own `require(...)` call (CommonJS gives both the same object) — now throws a `StrictTypeError` (`contractKind: 'variable'`, `operation: 'set'`) when the value doesn't match the declared type, instead of silently corrupting the binding. `export const` is unaffected (TypeScript already rejects reassignment at compile time). Native ESM output is unaffected for a different reason: ES module namespace objects are non-writable by spec, so an external write already throws a plain `TypeError` with no help needed from ts-typed; internal writes there remain covered by the existing per-assignment check. AMD/UMD/System module output and the `let x; export { x };` export-list form are not covered (documented limitation — neither shape exposes the binding as a plain, guardable `exports.x` property in the emitted code).

## [0.1.5] - 2026-10-17

### Added

- A user-defined type guard (`function isProfile(x: unknown): x is Profile`) now validates its target parameter against the asserted type whenever it returns `true` — returning `true` is the claim being made, so it is checked then; returning `false` makes no claim, so nothing is checked in that path. An assertion function (`asserts x is T` / `asserts x`) validates its target at every normal return path (an explicit `return` and falling off the end of the function), since returning normally at all is exactly the claim an assertion function makes; throwing is unaffected. Both are resolved directly by the type resolver at transform time, the same pattern already used for destructuring (0.1.4), async returns and generator yields. A predicate/assertion on `this` (`this is T`, `asserts this`) is not checked (documented limitation, consistent with class instances being excluded from the readonly-structural lock added in 0.1.3).

## [0.1.4] - 2026-10-17

### Added

- A destructured variable declaration (`const { age }: Profile = value;`, `const [first]: number[] = value;`) now validates the WHOLE source value against its declared (or, absent an annotation, inferred) type before destructuring extracts individual bindings — resolved directly by the type resolver at transform time. Individual bindings are not validated separately; validating the source as a whole already covers the real case of a malformed value escaping validation through destructuring. Destructured function parameters remain unsupported (a harder, separate problem: it would require rewriting the function's own signature).

## [0.1.3] - 2026-10-17

Continues the same fix/test/document loop against the real teste-ts-typed app.

### Added

- A `readonly` member of a plain object's interface or type-alias shape (as opposed to a class field, already covered by `compiler.enforceReadonly`) is now locked immediately when the value crosses a typed boundary: `interface Config { readonly version: string }` rejects a later `config.version = 'x'` with `READONLY_PROPERTY`. Unlike a class, a plain object/literal value has no "still under construction" phase, so there is no deferred-lock timing concern here — it is safe to enforce immediately. A `Readonly<T>` mapped type and `readonly` members of index signatures are not detected (documented limitation); class instances are deliberately left out of this specific lock (a `readonly` view of an instance must not freeze that instance's own mutable state).

### Investigated and deliberately NOT shipped this release

- Sealing a class instance with `Object.preventExtensions` right after construction (to reject undeclared/extra properties, `CLOSED_INSTANCES`/`SYMBOL_KEYS`) was implemented and tested in isolation, then reverted before publishing once it broke a real, common pattern found by re-running teste-ts-typed's full suite: NestJS's own `class-transformer` + `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` combination copies every key from the request body onto the DTO instance first, and only strips the non-whitelisted ones afterward as a second step — sealing the instance makes that first copy throw a native, unguarded `TypeError` instead of ever reaching the whitelist step. A general fix would need a way to tell "this class is meant to be populated after construction, by design" apart from a genuinely closed instance, which is not something `contractKind`/`operation` alone can express.

## [0.1.2] - 2026-10-17

A continuation of the same real-app fix/test/document loop that produced 0.1.1: closes three more coverage gaps (`static` fields, `Map`/`Set` adapters), and fixes a severe regression that 0.1.1 itself introduced.

### Fixed

- **Regression in 0.1.1, now fixed**: fixing `installFieldGuard`'s silent give-up (0.1.1) exposed a pre-existing bug in how `compiler.enforceReadonly` decides whether to lock a field. A class with no user constructor installs and locks a readonly field in the SAME synthesized constructor, which completes immediately on `new X()` — correct for a bare field (TypeScript's own `strictPropertyInitialization` guarantees it already has a real value by then), but wrong for a field declared with `?` or `!`: both mean the field may legitimately still be unset, or is only "promised" to be set later, when construction completes. The single most common real-world shape hit by this was NestJS's own `ValidationPipe`: `new Dto()` then `instance.field = value` for every field, assigned by `class-transformer` entirely outside any constructor. 0.1.1 as published locked every such field immediately, making every DTO shaped this way (`readonly name!: string` or `readonly role?: UserRole`) reject the framework's own deserialization step with `READONLY_PROPERTY`, regardless of whether the value being assigned was valid. A readonly field is now only locked when it has neither `?` nor `!`.

### Added

- `static` class fields (public, not combined with `private`/`protected`) are now instrumented: a static field's guard is installed in a `static { ... }` initializer block, where `this` is the class itself, reusing the exact same install/lock machinery already used for instance fields. `delete`/`Object.defineProperty` bypass and `compiler.enforceReadonly` locking both work the same way they do for instance fields.
- `Map<K, V>`, `ReadonlyMap<K, V>`, `Set<T>` and `ReadonlySet<T>` are now first-class schema kinds: their entries/items are validated against the declared key/value/item types when the collection crosses a typed boundary. `WeakMap`/`WeakSet` remain out of scope, and mutating an already-validated collection afterward via `.set()`/`.add()` is not intercepted (the same category of limitation as array mutation) — only the state at the moment of crossing a boundary is checked.

## [0.1.1] - 2026-10-17

A real NestJS + TypeORM project was upgraded to 0.1.0 and its full test suite rerun, surfacing two bugs in the coverage this release had just added.

### Fixed

- `installFieldGuard` silently gave up — installing no guard at all — for any field that keeps its `PropertyDeclaration` in the output (every decorated field, to preserve decorator emission) and has no inline initializer: native class fields (target ES2022+) pre-define such a field as `undefined` before the constructor body runs, and that pre-defined, still-uninitialized placeholder was mistaken for "something else already initialized this field, leave it alone." In practice this left every field of a typical `class CreateUserDto { @IsString() name: string; constructor(data) { this.name = data.name; } }` — the common pattern of assigning fields inside the constructor body rather than inline — completely unguarded, decorated or not.
- A class field whose own type is a pure function (e.g. `class WithHandler { onClick: () => void = () => {}; }`) never had a guard installed at all: the `function` leaf added in 0.1.0 was only wired into the path used when a property is resolved as part of its *containing object's* structural shape, not into the general resolution path a field's own top-level contract candidate goes through to build its `installFieldGuard` call. A property/interface member with a callback type (fixed in 0.1.0) was unaffected; only a *class field's own* candidate took the unpatched path.

## [0.1.0] - 2026-10-17

A pass over real NestJS + TypeORM + SQLite usage found that the single highest-impact gap was coverage, not any individual bug: class methods, constructors and decorated fields were never instrumented at all, and several common type shapes (`Date`, callback-typed properties) made their whole containing contract silently `unsupported`. This release closes those gaps and fixes twelve runtime-breaking or silently-incorrect bugs found along the way.

### Added

- Class methods, getters, setters and constructors are now instrumented (parameters and return values), closing the largest coverage gap: a NestJS controller/service/repository method is now protected the same way a free function always was.
- Decorated class fields and parameters (`class-validator`, `@nestjs/swagger`, TypeORM `@Column`/`@OneToMany`, etc.) are resolved by their own type instead of being unconditionally marked `unsupported`.
- `Date` is supported as a first-class runtime contract, including explicitly rejecting `Invalid Date` with a `StrictTypeError` instead of letting it surface later as an unrelated `RangeError`.
- A property or parameter typed as a plain function (a callback field, an interface method signature) is validated as `typeof value === 'function'` instead of making its whole containing object type `unsupported`.
- Template literal types (`` `${number}px` ``, `` `user_${string}` ``, `` `${boolean}-flag` ``, etc.) are converted to an anchored regular expression at compile time and validated against it.
- `yield` inside a generator function is validated against its declared/inferred yielded type; `AsyncGenerator`/`Iterable`/`IterableIterator` are supported the same way. (`yield*` delegation is left unprotected — validating a whole delegated iterable up front is a different, larger problem.)
- A required class field (no `?`) can no longer be removed with `delete` or have its guard replaced via `Object.defineProperty`, bypassing validation entirely. The lock is deferred to the most-derived class's own constructor (checked via `new.target`), so a subclass that legitimately redeclares the same field is unaffected.
- Compound assignment on a guarded variable (`+=`, `-=`, `*=`, `/=`, `%=`, `**=`, shifts, bitwise) is now rewritten into a validated assignment instead of running unguarded. `&&=`, `||=` and `??=` are left exactly as before — rewriting them would change short-circuit evaluation — and keep warning as unsupported.
- Every coverage-affecting diagnostic computed during analysis (not just the ones a transform happens to touch) now reaches the build's coverage report and `compiler.onUnsupported: "error"`'s failure message, which now names the offending contract and reason instead of only a count.
- `diagnostics.reportFile` actually writes the coverage report to disk, as JSON, creating parent directories as needed; a write failure fails the build instead of being silently swallowed.
- `strictNullChecks` (directly, or via `strict: true`) is now a hard requirement, checked before any analysis runs, per the original spec — a project without it now fails fast with a clear diagnostic instead of building successfully on a checker view that is already too lossy to protect against.
- A project configuring `paths` aliases in `tsconfig.json` now fails the build with a clear diagnostic, in both the bundled and the unbundled output: TypeScript never rewrites aliases in its own emitted JavaScript, and `@vercel/ncc` does not read tsconfig `paths` either, so either path previously reported success while producing a "Cannot find module" failure at runtime.
- The package's `exports` map now exposes `./package.json`, so `require.resolve('@ts-typed/compiler/package.json')` and similar version-probing patterns work.

### Fixed

- A type assertion or cast used directly as an assignment target (`(x as T) = v`, `(x as T) += 1`, `(x as any)++`/`--`) produced invalid JavaScript (`Invalid left-hand side in assignment`) instead of being erased the way `tsc` itself erases a cast. Casting the *object* of a member assignment (`(a as T).b = v`) is unaffected and continues to validate `a` as a read.
- `compiler.enforcePrivate` (the default) broke construction of any class with a plain `private` field: the structural schema still required the field under its pre-`#private` name after the transformer had already converted it to a real `#private` accessor. The field is now correctly excluded from the structural schema instead of marking the whole class `unsupported`.
- A branded/tagged primitive type (`string & { readonly __brand: 'Id' }`, the standard TypeScript nominal-typing idiom) rejected every value, because the phantom `object` member of the intersection was validated against primitive values that can never carry it. It is now ignored when the value being checked is a primitive; an intersection applied to a real object value is unaffected and still enforces every member.
- A project compiling to native ESM (`module` resolving to an ES module kind) got a `require(...)` call injected into the generated ES module, crashing immediately with `ReferenceError: require is not defined`. The injected runtime reference is now an `import` declaration when the target module format is ESM, and unchanged (`require`) for CommonJS.
- A comparison against a guarded variable (`port >= MIN`, `x === y`, …) emitted a false "compound assignment" coverage warning, because every non-`=` binary operator was treated as an assignment attempt regardless of whether it actually was one.
- `compiler.onUnsupported: "error"` could fail a build without ever saying which contract caused it.

### Fixed (`@ts-typed/nestjs`-relevant, surfaced through NestJS testing)

- See `@ts-typed/nestjs`'s own changelog for the HTTP exception filter fix (`StrictTypeError` from a return-value violation now maps to 500, not 400).

### Known limits (new, in addition to the ones already listed below)

- Generic type parameters still have no concrete runtime contract inside a generic function's own body (`identity<User>(x)` validates nothing extra inside `identity`): the type is erased before any single call site's concrete argument is known to the instrumented body.
- `Map`/`Set` contents, `static` class fields, and reflective mutation of a validated array (`push`/`splice`/index assignment/`length`) are still unprotected.
- A destructuring binding (`const { age }: T = value`) still does not validate `value` against `T` before destructuring.
- A user-authored type predicate (`x is T`) or assertion function (`asserts x is T`) is trusted as-is; a predicate that lies is not caught.
- `readonly` on an interface or type-alias member (as opposed to a class field) is not enforced — the value is still writable through that property.
- Extra properties or `symbol`-keyed properties added directly to a class instance after construction are not rejected (property-level extras on a *nested* plain object already were, and remain, rejected by default).

## [0.0.1] - 2026-10-16

Initial release.

### Added

- Runtime protection layer: `StrictTypeError`, `assertValue`, `protectValue`, `SchemaRegistry`, and the `Schema` model covering primitives, literals, unions, intersections, arrays, tuples, objects (including index signatures and deferred-assignment fields), and references.
- `AllowExtraProperties()` decorator (class- and property-level) for explicit, auditable exceptions to the closed-object default.
- `StrictClass()` / `StructuralClass()` decorators and `compiler.strictClass` to choose between structural (default) and nominal (`instanceof`) validation for class-typed contracts.
- Compiler analysis (`analyzeProject`) that resolves materializable TypeScript types into runtime schemas via the TypeChecker, including generics, mapped types, conditional types, discriminated unions, recursive types, and `Pick`/`Omit`/`Partial`/`Required`/`Record`/`Readonly` utility types.
- Contract transformer (`createContractTransformer`) that instruments variables, parameters, returns, class fields, and type assertions with runtime guards, preserving evaluation order and identity.
- `compiler.enforcePrivate`: rewrites TypeScript `private` class fields into real ECMAScript `#private` fields with a validating accessor pair, since TypeScript's own `private` has no runtime effect. Fails the build if a field being converted is accessed through bracket notation anywhere in the program (no `#private` equivalent exists for that pattern).
- `compiler.enforceReadonly`: locks `readonly` class fields against further writes once their declaring constructor finishes, instead of leaving them silently writable.
- Project configuration (`typets.config.json`): `loadConfig`, `initializeProject`, published JSON Schema with editor autocomplete, `extends` inheritance with cycle detection, and full precedence (defaults < inherited < project file < explicit overrides).
- Build pipeline (`buildProject`): atomic output (rename-based swap, never erases a previously valid `outDir` before a new build succeeds), per-file emit, asset copying, and optional `@vercel/ncc` bundling over already-instrumented JavaScript (never over TypeScript sources directly).
- CLI (`ts-typed init|build|help`) with `--root`, `--config`, `--no-bundle`, `--minify`, `--sourcemap` flags, each mapping to an existing configuration option.
- Coverage reporting (`createCoverageReport`, `formatCoverageReport`): every typed point is classified as protected, partial, unsupported, or open, with file/line/column and a human-readable reason — never silently reported as fully protected when it is not.
- Versioned integration adapter contract (`IntegrationAdapterV1`) so framework-specific packages (starting with `@ts-typed/nestjs`) can resolve project configuration without the core depending on any framework.
- Internal, undocumented per-stage build timing (`TS_TYPED_BUILD_METRICS=1`), inert by default and not part of the public configuration surface — used only for this project's own development to spot bottlenecks.

### Known limits (by design, reported honestly rather than hidden)

- External aliases of a protected value and some reflective operations can escape local guards; this is accepted under the project's compatibility policy and surfaced as partial-protection warnings, never silently promoted to full protection.
- `compiler.strictClass`'s `instanceof` check can only be attached when the compiler can embed a live reference to the class — i.e., when it is declared in the same file as the validation point. Cross-file classes fall back to structural validation with a coverage warning when `compiler.strictClass` is enabled.
- `compiler.enforcePrivate` is scoped to plain property declarations; parameter properties (`constructor(private foo: string)`) remain unconditionally unsupported, since there is no conversion path for that shorthand yet.
- A class with a true `#private` field, or any method (callable member), cannot be represented as a structural object schema and is reported `unsupported` rather than silently treated as open.
