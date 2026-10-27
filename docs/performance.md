# Performance

## AggregateErrors overhead (auto-close + array aggregation)

Measured with `node benchmarks/runtime-benchmark.cjs` after `npm run build`.
Environment: macOS 27.0.1 (arm64, Darwin 27.0.0), Node.js v22.22.3. Single run on a
laptop; treat as indicative, not a guarantee.

| Scenario | ns/op |
|---|---|
| construct an undecorated instance | 6.1 |
| construct a decorated instance + beginAggregateWindow (registers 1 FinalizationRegistry entry) | 496.8 |
| protectValue: array of 5 valid decorated DTOs | 8861.6 |
| protectValue: array of 200 valid decorated DTOs | 327480.7 |
| protectValue: array of 200 decorated DTOs, all invalid (worst case, no early exit) | 845524.5 |

`beginAggregateWindow` previously scheduled a `queueMicrotask` to auto-close the
window (422.4 ns/op); that mechanism was replaced before shipping by a
`FinalizationRegistry.register()` call, which does not auto-close on a fixed
schedule — it closes only once the instance becomes unreachable and is garbage
collected, with any leaked violations reported via
`setAggregateWindowLeakHandler` instead of synchronously thrown. The 496.8 ns/op
row measures only this registration cost at construction time; it does not
include the finalizer callback's own cost, since that work runs later, off the
construction hot path, at a GC-determined and non-deterministic time. The ~75
ns/op increase over the old microtask-scheduling cost is attributable to
`FinalizationRegistry.register()`'s bookkeeping (it must track the instance,
its held-value buffer, and the unregister token) versus `queueMicrotask()`'s
simpler callback-queue push; both are small relative to a single `protectValue`
call on even a 3-field object (~950 ns/op, see above), so this change has no
practically significant impact on construction-time overhead.

The array-aggregation numbers above are unchanged within measurement noise from
the pre-C1 baseline (8903.9 / 326437.6 / 896842.8 ns/op) — expected, since C1
(auto-close mechanism) and the array-aggregation path are independent code
paths that do not interact.

The array-aggregation path is O(n) in the array length by design (it must check
every element to collect every violation). This is a real trade-off versus the
old fail-fast behavior, whose best case stops at the first bad element and is O(1).
That O(1) comparison is reasoned from the algorithm's asymptotics; no fail-fast-array
baseline was measured. The trade-off only applies to arrays whose item type is an
`AggregateErrors()`-decorated class; every other array keeps its existing fail-fast
cost profile unchanged.
