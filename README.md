<p align="center">
  <a href="https://ts-typed.com" target="_blank" rel="noopener noreferrer">
    <img src=".github/logo.svg" alt="ts-typed" width="260" />
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@ts-typed/core"><img src="https://img.shields.io/npm/v/@ts-typed/core.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@ts-typed/core"><img src="https://img.shields.io/npm/dm/@ts-typed/core.svg" alt="npm downloads"></a>
  <a href="https://github.com/ts-typed/ts-typed/actions/workflows/ci.yml"><img src="https://github.com/ts-typed/ts-typed/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white" alt="Node >=18">
  <a href="https://github.com/ts-typed/ts-typed/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License"></a>
</p>

# @ts-typed/core

`@ts-typed/core` instruments a TypeScript project so runtime values are checked against the same types the compiler already knows about. No schema definitions, no decorators required for the basics — write normal TypeScript, and a transform pass inserts the runtime checks for you.

```bash
npm install --save-dev @ts-typed/core
npx ts-typed init
npx ts-typed build
```

- `ts-typed init` creates `typets.config.json` in the current project. It detects Nest and Express projects the same way: it installs the matching `@ts-typed/*` integration package (`@ts-typed/nestjs` or `@ts-typed/express`) and writes `build`/`start`/`dev`/`start:prod` scripts for plain TypeScript and Express projects. Existing scripts are never overwritten. For Nest and Express it asks before wiring up global error handling, and it always asks before installing `@ts-typed/validators`.
- `ts-typed build` runs the transform and emits the instrumented project to `outDir`. It auto-detects a Nest project and uses the Nest build path, so `ts-typed nest build` remains only as an explicit alias.
- `ts-typed start [--watch] [--debug]` runs the instrumented project. It auto-detects a Nest project as well, so `ts-typed nest start` remains only as an explicit alias.

Full behavior spec: [`docs/SPEC.md`](https://github.com/ts-typed/ts-typed/blob/main/docs/SPEC.md) in the [ts-typed/ts-typed](https://github.com/ts-typed/ts-typed) repository. Architecture notes: [`docs/architecture.md`](https://github.com/ts-typed/ts-typed/blob/main/docs/architecture.md).

## Table of contents

- [How it works](#how-it-works)
- [What gets checked](#what-gets-checked)
- [Error handling](#error-handling)
- [Configuration reference](#configuration-reference)
- [NestJS: native npm scripts](#nestjs-native-npm-scripts)
- [Decorators](#decorators)
- [Generics](#generics)
- [Path aliases (`tsconfig.json` `paths`)](#path-aliases-tsconfigjson-paths)
- [Performance](#performance)
- [Known limitations](#known-limitations)

## How it works

The compiler walks your TypeScript project with the real TypeScript type checker, finds every place a value crosses a **typed boundary** — a variable declaration, a function parameter, a return statement, a class field assignment, a cast, a `satisfies` expression — and inserts a runtime check there, built from the *actual declared type* at that exact point. There is no separate schema language to maintain: the type you already wrote in TypeScript IS the contract.

If a value doesn't match, the check throws a `StrictTypeError` (a subclass of `TypeError`) instead of letting a wrong-shaped value quietly flow through your program.

## What gets checked

- **Primitives, literals, unions, intersections, tuples, template literal types** — including `bigint`, `symbol`, `null`/`undefined` distinguished correctly, and `NaN`/`Infinity` accepted as ordinary numbers (no domain checks).
- **Objects are closed by default**: an object with an extra, undeclared property fails (`EXTRA_PROPERTY`), stricter than plain TypeScript. Change the policy to silently drop extras with [`ExtraProperties('strip')`](#extraproperties) or the `extraProperties` config field. A type that genuinely wants dynamic extra fields should declare an index signature (`[key: string]: T`) instead — that is a separate, unaffected mechanism.
- **`Date`** is validated as a real `Date` instance, not just "any object."
- **Branded types** (`type UserId = string & { __brand: 'UserId' }`) are accepted at their underlying primitive type.
- **Classes**: `private`/`protected` fields (`compiler.enforcePrivate`), `readonly` fields (`compiler.enforceReadonly` — skipped for a field declared with `?` or `!`, so `class-transformer`-style post-construction population keeps working), required fields (locked non-configurable from the most-derived constructor onward — `delete`/`Object.defineProperty` bypass is blocked natively), and `static` fields.
- **Destructuring**: `const { age }: Profile = value;` validates the *whole source value* before extracting individual bindings.
- **Type guards and assertion functions**: a user-defined `x is T` validates its target when it returns `true`; `asserts x is T` / `asserts x` validates at every normal return path.
- **`Map`/`Set`/`ReadonlyMap`/`ReadonlySet`**: entries present when the collection crosses a boundary are validated against the declared key/value/item types. `WeakMap`/`WeakSet` are out of scope (see [Known limitations](#known-limitations)).
- **Generators, `async`/`await`**, and **explicit-generic calls and constructors** — see [Generics](#generics).
- **CommonJS module bindings**: an exported `let`/`var` gets a guard on the `exports` object itself, so an external write through the import namespace or another file's `require(...)` call is checked too.

## Error handling

Every violation throws a `StrictTypeError`:

```ts
class StrictTypeError extends TypeError {
  code: 'TYPE_MISMATCH' | 'EXTRA_PROPERTY' | 'REQUIRED_PROPERTY' | 'READONLY_PROPERTY' | 'INVALID_MUTATION';
  propertyPath: string;   // e.g. "CreateUserDto.email"
  expected: string;
  received: string;
  contractKind: 'variable' | 'parameter' | 'property' | 'return' | ...;
  operation: string;      // e.g. "initialize" | "set" | "argument" | "return" | "mutate"
  className?: string;
  functionName?: string;

  toJSON(): { code, propertyPath, expected, received, contractKind, operation, className?, functionName? };
}
```

`toJSON()` is deliberately the ONLY thing safe to send over the wire as-is: it never includes the raw value that failed validation, and never includes a stack trace. Some fields set by a decorator (see below) are intentionally excluded from `toJSON()` too, since they're meant for code catching the real exception object, not for a generic serialized body — [`@ts-typed/nestjs`](https://www.npmjs.com/package/@ts-typed/nestjs) is the reference consumer of those.

**ts-typed is fail-fast**: the first violation found throws immediately. It does not collect every violation across an object into one aggregated error the way some validation libraries do — see [Known limitations](#known-limitations).

## Configuration reference

`typets.config.json` (schema at `./node_modules/@ts-typed/core/schema.json`):

| Key | Default | Meaning |
|---|---|---|
| `entry` | `"src/main.ts"` | Project entry point. |
| `tsconfig` | `"tsconfig.json"` | TypeScript config to compile with. |
| `outDir` | `"dist"` | Output directory. |
| `integration` | `"typescript"` | Framework adapter (e.g. `"nestjs"`). |
| `extraProperties` | `"error"` | `"error"` reports `EXTRA_PROPERTY` on every undeclared object property (default); `"strip"` silently deletes it instead. Same precedence as any other decorator override: property-level `ExtraProperties()` > class-level (the value's own class first, then the enclosing owner's) > this global default. A rejected value is never partially stripped. |
| `compiler.onUnsupported` | `"warn"` | `"warn"` or `"error"` when a type can't be given a runtime contract (e.g. a generic type parameter with no concrete type). |
| `compiler.strictClass` | `true` | Default nominal (`instanceof`) vs. structural validation for class-typed values. Override per class with [`StrictClass()`](#strictclass--structuralclass)/`StructuralClass()`. |
| `compiler.enforcePrivate` | `true` | Instrument `private`/`protected` class fields. |
| `compiler.enforceReadonly` | `true` | Lock a `readonly` class field after its first validated assignment (skipped for `?`/`!` fields). |
| `compiler.enforceClosedInstances` | `false` | **Opt-in.** Seal a class instance (`Object.preventExtensions`) once its most-derived constructor completes — no new property, string- or symbol-keyed, can be added afterward. See the warning below before enabling this. |
| `compiler.enforceMutationGuards` | `false` | **Opt-in.** Wrap an array/`Map`/`Set`/plain-object crossing a typed boundary in a `Proxy` that validates mutations (`push`/`splice`/index writes, `.set()`/`.add()`, `delete`/`defineProperty`, nested containers too) instead of only checking the value once at the boundary. |
| `compiler.sourceMap` | `true` | Emit source maps. |
| `diagnostics.format` | `"pretty"` | `"pretty"` or `"json"` coverage output. |
| `diagnostics.coverage` | `"summary"` | `"summary"` or `"detailed"`. |
| `diagnostics.reportFile` | `null` | Write the coverage report to a file instead of stdout. |
| `ncc.*` | — | Bundling options (passed through to `@vercel/ncc`): `enabled`, `minify`, `target`, `externals`, `cache`, `license`, `quiet`, `debugLog`. |

### About the two opt-in flags

Both `enforceClosedInstances` and `enforceMutationGuards` are off by default because they trade off against other libraries' own conventions, not because they're half-finished:

- **`enforceClosedInstances`** conflicts with the extremely common NestJS pattern of `class-transformer` + `ValidationPipe({ whitelist: true })`, which copies every key from a request body onto a `new Dto()` instance *first*, and only strips non-whitelisted keys *afterward*. Sealing the instance makes that first copy throw before the whitelist step ever runs. If you enable this flag, you must also configure `class-transformer` to only ever write declared keys in the first place (e.g. `excludeExtraneousValues: true` with `@Expose()` decorators, instead of copy-then-strip).
- **`enforceMutationGuards`** wraps the value in a `Proxy`, which has a real per-mutation validation cost and changes the value's identity (the returned value is a proxy, not the original reference) — acceptable for many use cases, not something to turn on blindly everywhere.

**The governing rule for any ts-typed config flag that overlaps with another library's own setting: ts-typed's config decides the behavior, and the rest of your stack must be configured to agree with it.** A mismatch (e.g. `enforceClosedInstances: true` with `class-transformer` still doing copy-then-strip) is an application configuration bug, not a ts-typed bug.

## NestJS: native npm scripts

Install the compiler and Nest adapter, then initialize from the root of a conventional Nest project:

```bash
npm install --save-dev @ts-typed/core @ts-typed/nestjs
npx ts-typed init
```

`init` detects the normal Nest scripts and changes only their compiler command. The familiar commands continue to be the public workflow, and `ts-typed build` and `ts-typed start` auto-detect the Nest project:

```json
{
  "scripts": {
    "build": "ts-typed build",
    "start": "ts-typed start",
    "start:dev": "ts-typed start --watch",
    "start:debug": "ts-typed start --debug --watch",
    "start:prod": "node dist/main"
  }
}
```

`ts-typed nest build` and `ts-typed nest start` still work as explicit aliases. The Nest build path builds the project through the TS Typed transformer without NCC bundling, so Nest's normal `dist/main.js` production entry remains intact. In watch mode it rebuilds the protected output and only restarts the application after a successful build. Initialization is idempotent and leaves unrelated or custom scripts unchanged.

This path requires Nest's TypeScript (`tsc`) builder. SWC, Rspack, and webpack do not run TypeScript custom transformers, so TS Typed rejects them rather than emitting code that appears built but is not runtime-protected. Set `"compilerOptions": { "builder": "tsc" }` in `nest-cli.json` when necessary.

## Performance

`assertValue` validates a value at a boundary; `protectValue` validates and installs the deep mutation protection required by that boundary. The second operation necessarily does more work for large object graphs. Compiler 0.1.28 caches object-schema keys per traversal; a local TypeORM/Express/Nest stress battery with 10,000 entities found a median 4.89 ms for validating a response array and 43.44 ms for projecting away a password field and protecting that array. This intentionally extreme response shape is not a production capacity promise.

Use bounded pagination/cursors before optimizing a path that sends thousands of records at once. Keep `enforceMutationGuards` opt-in: proxies add per-mutation cost and change identity. The full methodology, reproducible harness, bottleneck study and reference results are in [the project performance notes](https://github.com/ts-typed/ts-typed/blob/main/docs/performance.md).

## Decorators

Import from `@ts-typed/core`.

### `ExtraProperties(policy)`

Class or property decorator. Sets the `'error' | 'strip'` policy for that class (or that one property's value) — the per-target override for the global `extraProperties` config field. `'error'` reports `EXTRA_PROPERTY` as usual; `'strip'` silently deletes the undeclared property instead of rejecting it.

```ts
@ExtraProperties('strip')
class LooseConfig { /* undeclared keys are silently dropped, never rejected or kept */ }
```

There is no "allow and keep" option. A type that needs genuinely dynamic extra fields should declare an index signature (`[key: string]: T`) instead, which is validated against `T` and never considered "extra."

### `StrictClass()` / `StructuralClass()`

Class decorator. Overrides `compiler.strictClass` for one class: `StrictClass()` forces nominal (`instanceof`) validation, `StructuralClass()` forces structural (shape-only) validation, regardless of the global default. Inherited by subclasses unless they override it themselves.

### `AggregateErrors()`

By default ts-typed is fail-fast: the first bad field throws and validation stops there (see [Known limitations](#known-limitations)). A class decorated with `AggregateErrors()` changes that at two points: at the parameter boundary, when a value crossing a typed function/method parameter is declared as that class (the DTO-in-an-HTTP-body case — the headline case is a plain object literal that was never actually instantiated, as below), and on field writes to a decorated instance while its aggregate window is open (the writes between construction and that first parameter crossing; see below). At either point, every violation anywhere in it, at any depth, is collected into one `AggregateStrictTypeError` instead:

```ts
import { AggregateErrors, AggregateStrictTypeError } from '@ts-typed/core';

@AggregateErrors()
class CreateUserDto {
  name: string = '';
  age: number = 0;
}

function createUser(dto: CreateUserDto): void { /* ... */ }

try {
  createUser({ name: 42, age: 'old' } as any);
} catch (error) {
  if (error instanceof AggregateStrictTypeError) {
    console.log(error.errors); // every violation, not just the first
  }
}
```

This walks every nested object and array to full depth, including an optional or nullable nested DTO (`profile?: Profile`, `profile: Profile | null`) — as long as exactly one non-nullish branch of that field's type is object/array-shaped. A field whose type has two or more genuinely ambiguous object-shaped branches reports one generic violation for that field instead, same as a plain type mismatch would. A union field with a `Date`, `Map`/`Set`, or tuple member (`profile: Date | Profile`, `items: [number, number] | string[]`) is unaffected by aggregation when the value actually matches that non-object/array-shaped member — it's accepted or rejected exactly as it would be without the decorator.

Nested decorated instances are also checked when an enclosing object, array, tuple, `Map`, or `Set` is structurally validated. That prevents a rejected field write on a nested DTO from being silently accepted with its previous default value, even when its parent is undecorated or the DTO appears in an array parameter.

An array **parameter** whose declared item type resolves to an `AggregateErrors()`-decorated class (`dtos: CreateUserDto[]`) aggregates too: every element is checked, and a single `ArrayAggregateStrictTypeError` reports one `AggregateStrictTypeError` per invalid element (each with its own `.errors`, path-prefixed `dtos[i].field`) instead of stopping at the first bad one. Valid elements are returned unchanged. A tuple parameter, or an array whose item type is an undeclared/ambiguous union, is not in scope — both stay fail-fast. A namespace-qualified decorator call (`@someNamespace.AggregateErrors()`) is not detected and falls back to ordinary fail-fast validation; import `AggregateErrors` by name instead.

`AggregateStrictTypeError extends StrictTypeError`, so existing `instanceof StrictTypeError` code (including `@ts-typed/nestjs`'s `StrictTypeErrorFilter`) keeps working unchanged — it sees the first violation's fields through the inherited properties, with the full list additionally available as `.errors`. Variables and return values stay fail-fast regardless of this decorator — there's no "whole form" to aggregate at a single-field write there.

Aggregation also holds when your parameter is populated by `class-transformer`'s `plainToInstance` — the default behind Nest's `ValidationPipe({ transform: true })` — because the window closes at a parameter boundary. A field write made after construction (which is what `plainToInstance` does: construct first, then assign each field as a separate statement) collects into a per-instance "aggregate window" instead of throwing immediately, and the window closes — merging whatever it collected with a full structural check (including a missing required field or an undeclared extra key) — the first time the instance crosses a real parameter boundary.

If a decorated instance is constructed and then only ever mutated by application code — never passed through a typed parameter again — its aggregate window stays open until the instance is garbage collected. Buffered violations are then reported (not thrown — there's no caller left to catch it) via `setAggregateWindowLeakHandler`, which defaults to a `console.error` warning. GC timing is non-deterministic: it may run arbitrarily late, or not at all before process exit, so don't rely on this path for anything you need to fail fast on.

For that case — manual population that you know won't cross a typed parameter — close the window yourself with `closeAggregateWindowOrThrow(instance)`, right after population ends:

```ts
import { closeAggregateWindowOrThrow } from '@ts-typed/core';

const dto = new CreateUserDto();
dto.name = 'Ada';
dto.age = 30;
closeAggregateWindowOrThrow(dto); // throws AggregateStrictTypeError here, synchronously, if anything was invalid
```

This is a no-op if the window was already closed, or was open but empty — safe to call even when you're not sure a window exists. Because it's caller-triggered rather than timing-based, it has no race window: it throws synchronously, right where you call it, instead of waiting on GC. Field writes after the window closes (by any path — a real parameter crossing, GC, or this explicit call) go back to ordinary fail-fast `StrictTypeError`.

**Additional limitations:** a `ValueObject` field is constructed before its owner can collect field-write violations, so an invalid raw value still throws immediately rather than joining the aggregate. Also, a DTO field declared without an initializer while `strictPropertyInitialization` is disabled can report the same bad write twice (once from the field window and once from the structural pass). These are diagnostic-quality limitations; neither accepts invalid data.

### `ServerPopulated()`

Class decorator. Marks a class whose instances are populated by the server/database, not by client input — the intended use is a TypeORM `@Entity()` class. A `StrictTypeError` thrown for one of that class's fields then carries `isServerPopulated: true` (never present in `toJSON()`). This is the compiler-side half of telling an Entity's corrupted field apart from a DTO's bad client input; [`@ts-typed/nestjs`](https://www.npmjs.com/package/@ts-typed/nestjs)'s `StrictTypeErrorFilter` reads this flag to answer HTTP 500 instead of 400.

```ts
@Entity({ name: 'todos' })
@ServerPopulated()
export class TodoEntity { /* ... */ }
```

### `TypeErrorResponse(message, status?)`

Property decorator. Attaches a custom, HTTP-facing message (and optional status code) to a specific field. A `StrictTypeError` thrown for that field then carries `typeErrorResponseMessage`/`typeErrorResponseStatus` (never present in `toJSON()`). On its own this package has no HTTP awareness — see [`@ts-typed/nestjs`](https://www.npmjs.com/package/@ts-typed/nestjs)'s `StrictTypeErrorFilter`/`StrictTypeHttpError` for how these fields turn into an actual HTTP response, as a per-property alternative to `class-validator`'s messages.

```ts
export class CreateUserDto {
  @TypeErrorResponse('Email inválido', 422)
  public readonly email!: string;
}
```

This is still a single-violation (fail-fast) mechanism, like the rest of ts-typed — it customizes the response for whichever one violation fires on that property, not an aggregate of every violation across the object.

## Generics

Calling a generic function or constructing a generic class validates both the arguments and the result against the concrete type for that call — whether the type argument is written explicitly or left for TypeScript to infer:

```ts
function identity<T>(x: T): T { return x; }

identity<Person>(wrongShapedValue); // throws StrictTypeError, validated against Person
identity(wrongShapedValue);         // same check: T is inferred from the argument's own type
new Box<Person>(wrongShapedValue);  // same, for constructors
new Box(wrongShapedValue);          // and for an inferred constructor call
```

The inferred case uses the exact same instantiated signature TypeScript itself resolves for that call site (the same one a hover tooltip shows) — so it also covers `T` driven purely by a contextual/expected type when no argument pins it down:

```ts
function response<T>(data: T): IResponse<T> {
  return { data } as IResponse<T>;
}

const user: User = { name: 'Ada', age: 36 };
const result = response(user); // T inferred as User from `user` itself — validates the full IResponse<User> shape
```

This also covers:
- An `async` function's resolved return value (`identityAsync<Person>(x)` or its inferred form — validated via `.then()`, so the call stays a `Promise`; a failed check rejects it, consistent with how any other async failure surfaces).
- Rest parameters and spread arguments landing in them (`collect<number>(1, 2, 'bad')`, `collect<number>(...mixed)`, and their inferred forms).

If inference can't pin `T` down to anything concrete (no argument references it and no contextual type is available), TypeScript resolves it to `unknown`, and that's treated the same as any other unsupported type: no contract is generated, rather than validating against the wrong thing. A method whose generic declaration lives in one of TypeScript's own bundled lib files (`Array.prototype.map`, `Promise.resolve`, `Map`/`Set`'s own methods, etc.) is deliberately excluded — guarding those would mean instrumenting essentially every array/collection operation in a project, far outside this feature's intended scope of the project's OWN generic functions and classes, and some of those built-ins (`Map`/`Set`) already get their own dedicated, purpose-built handling elsewhere (entry validation, `compiler.enforceMutationGuards`). Generators' yielded values aren't validated either (a generator call produces an iterator, not a single return value).

## Path aliases (`tsconfig.json` `paths`)

A project organized with `paths` aliases (`@app/*` -> `src/*`, and similar) works out of the box — no separate runtime resolver needed:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@app/*": ["src/*"] }
  }
}
```

```ts
import { createUser } from '@app/users/create-user';
```

TypeScript itself never rewrites an aliased specifier in the JavaScript it emits — `paths` only ever affected the type checker and your editor, so a plain `tsc` build (or a bundler that doesn't understand tsconfig `paths`, like `@vercel/ncc`) would emit a literal `require('@app/users/create-user')` that Node can't resolve, failing with "Cannot find module" the first time that line actually runs. The compiler resolves every aliased `import`/`export ... from`/`require()`/dynamic `import()` the same way the checker already does (so it can never disagree with what type-checked) and rewrites it to a plain relative path at build time — in both the unbundled output and the `ncc`-bundled one, since by the time `ncc` sees the file the import is already an ordinary relative path, exactly like one you'd have written by hand.

If an alias can't be turned into something runtime-resolvable — nothing on disk actually matches it, or it resolves only to a `.d.ts` declaration file with no JavaScript behind it — the build fails up front with a precise `file:line:column` pointer per occurrence, instead of silently emitting something that breaks later.

## Known limitations

These are deliberate, documented scope boundaries, not oversights:

- **Multiple violations aren't aggregated by default**, and aggregation (via [`AggregateErrors()`](#aggregateerrors)) applies at the parameter boundary (including an array of decorated DTOs) and, for a decorated class, to field writes while its aggregate window is open (including `plainToInstance`) — that window auto-closes on the next microtask if nothing else closes it first; a variable or a return value still stops at the first violation, same as ever. A per-field `TypeErrorResponse()` message/status override is also not folded into an `AggregateStrictTypeError`'s fields yet (only the first violation's own fields are, via inheritance) — a future enhancement, not done in this first version. A genuinely ambiguous union field (two or more object-shaped, non-nullish branches) reports one generic violation for that field rather than walking into either branch.
- **`WeakMap`/`WeakSet`** are unsupported at the schema level (not just unprotected at runtime) — they can't be iterated, so there's nothing to validate at a boundary crossing.
- **AMD/UMD/System module output**, and the `let x; export { x };` list form, aren't covered by the CommonJS `exports` guard (ESM needs no equivalent — module namespace objects are already non-writable by spec).
- **Mutation guards only wrap the boundary-crossing value and its nested containers** at the moment the guard was created or a new value is written through it — a raw reference taken *before* the boundary, or a `Set`'s pre-existing items (which can't be swapped without changing iteration order), bypass the guard.
- **Generic classes/methods with no call-expression form** (e.g. a generic value used only as a type annotation, never actually called or constructed) have nothing for the [Generics](#generics) support to attach to — there's no call site to resolve an instantiated signature from.

## License

Apache-2.0
