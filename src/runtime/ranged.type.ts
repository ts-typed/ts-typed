declare const ttRangedBrand: unique symbol;

type RangedBounds<Min extends number, Max extends number> = readonly [Min, Max];

/**
 * A `number` narrowed to integers within `[Min, Max]`, each bound
 * independently optional (default `number` on either side means "no check
 * on that side"). Resolved by the compiler into a `numericConstraint`
 * runtime schema (`type-schema-resolver.ts`) — no decorator required.
 *
 * `age: Int<0, 150>`, `count: Int<0>` (min only), `page: Int<number, 100>`
 * (max only).
 */
export type Int<Min extends number = number, Max extends number = number> = number & {
  readonly [ttRangedBrand]?: { readonly kind: 'int'; readonly bounds: RangedBounds<Min, Max> };
};

/** Same as {@link Int}, but accepts any finite number, not just integers. */
export type Float<Min extends number = number, Max extends number = number> = number & {
  readonly [ttRangedBrand]?: { readonly kind: 'float'; readonly bounds: RangedBounds<Min, Max> };
};

/**
 * A `string` narrowed by `value.length`, each bound independently optional.
 * Resolved into a `stringLength` runtime schema.
 */
export type Str<MinLen extends number = number, MaxLen extends number = number> = string & {
  readonly [ttRangedBrand]?: { readonly kind: 'str'; readonly bounds: RangedBounds<MinLen, MaxLen> };
};
