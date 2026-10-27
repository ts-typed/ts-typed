# Performance

## AggregateErrors overhead (auto-close + array aggregation)

Measured with `node benchmarks/runtime-benchmark.cjs` after `npm run build`.
Environment: macOS 27.0.1 (arm64, Darwin 27.0.0), Node.js v22.22.3. Single run on a
laptop; treat as indicative, not a guarantee.

| Scenario | ns/op |
|---|---|
| construct an undecorated instance | 8.4 |
| construct a decorated instance + beginAggregateWindow (schedules 1 microtask) | 422.4 |
| protectValue: array of 5 valid decorated DTOs | 8903.9 |
| protectValue: array of 200 valid decorated DTOs | 326437.6 |
| protectValue: array of 200 decorated DTOs, all invalid (worst case, no early exit) | 896842.8 |

The 422.4 ns/op microtask row measures only the `queueMicrotask` scheduling cost at
construction time. The window-close work that runs inside that microtask later is
not included.

The array-aggregation path is O(n) in the array length by design (it must check
every element to collect every violation). This is a real trade-off versus the
old fail-fast behavior, whose best case stops at the first bad element and is O(1).
That O(1) comparison is reasoned from the algorithm's asymptotics; no fail-fast-array
baseline was measured. The trade-off only applies to arrays whose item type is an
`AggregateErrors()`-decorated class; every other array keeps its existing fail-fast
cost profile unchanged.
