# Performance

## AggregateErrors overhead (auto-close + array aggregation)

Measured with `node benchmarks/runtime-benchmark.cjs` after `npm run build`
(single run, macOS, Node.js; treat as indicative, not a guarantee).

| Scenario | ns/op |
|---|---|
| construct an undecorated instance | 3.7 |
| construct a decorated instance + beginAggregateWindow (schedules 1 microtask) | 430.6 |
| protectValue: array of 5 valid decorated DTOs | 8896.4 |
| protectValue: array of 200 valid decorated DTOs | 334526.0 |
| protectValue: array of 200 decorated DTOs, all invalid (worst case, no early exit) | 863512.7 |

The microtask scheduling cost on construction is a small, constant per-instance
overhead. The timed loop only covers scheduling; the deferred window-close work
runs after the loop and is not included in the figure above.

The array-aggregation path is O(n) in the array length by design (it must check
every element to collect every violation). This is a real trade-off versus the
old fail-fast behavior's best case (stopping at the first bad element). It only
applies to arrays whose item type is an `AggregateErrors()`-decorated class;
every other array keeps its existing fail-fast cost profile unchanged.
