# Read a legacy modernization scorecard

`anvil legacy scorecard` turns one verified inventory, an optional collection
plan, and any reviewed bindings into a content-addressed report an architect
can bring to a steering meeting: what the estate contains, how much of it is
understood, which candidates have been reviewed, which reviewed bindings have
the one transport shape the queue bridge can conformance-test, and what blocks
the rest.

Every figure is a count over inventory or binding records. The scorecard does
not read names, infer business meaning, rank candidates, or recommend an
approval. The same inputs always produce the same report and the same
Markdown.

## Produce one

```bash
anvil legacy scorecard legacy.inventory.json \
  --plan collection-plan.addressed.json \
  --bindings reviewed-bindings/ \
  --out legacy.scorecard.json

anvil legacy scorecard legacy.inventory.json \
  --bindings reviewed-bindings/ \
  --format md --out legacy.scorecard.md
```

| Input | Accepted forms | What happens when it fails |
| --- | --- | --- |
| `<inventory>` | An `anvil legacy inventory` report or a bare inventory snapshot | Refused with `legacy/scorecard_input_*`; candidates are re-reconciled from the verified snapshot |
| `--plan <file>` | An addressed collection plan from `anvil legacy plan` | Refused unless the plan verifies and names the same estate |
| `--bindings <paths...>` | Binding JSON files, approval decision reports, or directories of `*.json` | One unverifiable file refuses the whole scorecard, naming the file (`legacy/scorecard_binding_unverifiable`) |
| `--format json\|md` | Chooses what `--out` writes and what prints without `--json` | `legacy/scorecard_invalid_option` |

The command exits 0 whenever its inputs verify. A scorecard is a reading of
the estate, not a gate; `anvil legacy gaps --check` and `anvil legacy
inventory --check` remain the gates for coverage and conflicts.

The JSON envelope is `{ schemaVersion: 1, reportType:
"anvil.legacy-modernization-scorecard", scorecard }`. The scorecard carries
`scorecardId` (`lms_<hash>`) and `contentHash`; both are derived from every
other field, so a printed Markdown copy headed by the same id is the same
reading.

## What each section says

### `estate`

The inventory identity and its raw sizes: distinct deployment coordinates
(environment and application pairs that produced a candidate), artifacts,
evidence records, invocation observations, diagnostics by level, and the
number of diagnostics that are safety refusals. A safety refusal is identified
by its stable code (`isLegacySafetyRefusal`), never by its message.

### `capabilities`

Histograms over the reconciled candidates:

- by invocation kind (`message`, `remote_method`, `resource_adapter`,
  `stored_procedure`, `batch_job`) and by kind/protocol
  (`message/jms`, `remote_method/ejb_rmi`, and so on);
- by disposition (`triage`, `review_required`) and by business semantics
  (`unknown`, `asserted_unverified`, `conflicting`);
- conflicts: how many candidates carry at least one unresolved claim
  conflict, how many conflicts in total, and which dimensions are in conflict
  (counted once per candidate per dimension);
- unknown dimensions: for each of the twelve claim dimensions, how many
  candidates have no evidenced claim at all, most often absent first.

A high `unknownDimensions` count for `business_operation` or `idempotency` is
the expected state of an inventory. Offline configuration cannot prove those
facts; refinement supplies them with cited evidence.

### `coverage`

The identity (`reportId`, `contentHash`, optional `planId`) of the
`assessLegacyCoverage` report computed for the same inventory, plus its
outcome, semantic completeness, requirement counts by status, and the list of
unsatisfied requirements. The scorecard embeds the coverage report by hash
rather than copying it; run `anvil legacy gaps` for the full report and the
evidence requests.

### `review`

Reviewed bindings are matched to candidates by `candidateId`, then checked
against the inventory they claim:

| Lineage | Meaning |
| --- | --- |
| `matched` | The binding names a candidate in this inventory, this inventory id, and this candidate's current hash |
| `unmatched_candidate` | No candidate in this inventory has that id |
| `stale_inventory` | The candidate exists, but the binding was reviewed against a different inventory |
| `stale_candidate` | The candidate exists in this inventory, but its content has changed since review |

Only `matched` bindings count a candidate as reviewed. The section also counts
bindings by `runtime.status` (`not_implemented`, `conformance_passed`) and by
shape:

| Shape | Rule |
| --- | --- |
| `executable_shape` | A `message` transport whose reply mode is `reply_to` or `fixed_destination`, with a correlation field (and a reply target when the destination is fixed) |
| `needs_driver` | Everything else |

The rule is `classifyLegacyTransportShape` in `@anvil/compiler/legacy`, and a
test in `packages/cli` asserts it agrees with `buildQueueWireBinding` in
`@anvil/legacy-bridge`: a binding is `executable_shape` exactly when the queue
bridge would build a wire binding for it instead of refusing. It means the
shape can be conformance-tested against a broker double. It does not mean the
binding runs, that a broker was reached, or that conformance passed;
`runtime.status` carries that claim and only a conformance report moves it.

Each `needs_driver` binding names the adapter family it waits on, using the
names in [Adapter families still required](legacy-runtime-bridges.md#adapter-families-still-required):
JMS, IBM MQ, MSMQ, WCF, JCA resource adapter, Stored procedure, Batch or
scheduler, and for `ejb_rmi` the vendor family only when the reviewed target's
URL scheme proves it (`t3://` for WebLogic, `iiop`/`corbaloc`/`corbaname` for
WebSphere, `remote+http://` or `http-remoting://` for JBoss), otherwise
"remote EJB". Protocols the table does not list are named by kind and
protocol, such as `message broker (kafka)`.

### `blockers`

An ordered list of `{ code, count, detail, nextAction }` entries, present only
when the count is non-zero, in this fixed order:

| Code | Counts |
| --- | --- |
| `safety_refusal` | Diagnostics that are safety refusals |
| `coverage_requirement_unsatisfied` | Coverage requirements that are `partial` or `missing` |
| `candidate_conflict` | Candidates with at least one unresolved claim conflict |
| `business_semantics_unknown` | Candidates whose business semantics are `unknown` |
| `business_semantics_conflicting` | Candidates whose business semantics are `conflicting` |
| `binding_lineage_mismatch` | Bindings that are not `matched` |
| `binding_needs_driver` | Bindings per adapter family, one entry per family, largest first |
| `binding_not_implemented` | Bindings whose runtime status is `not_implemented` |

`nextAction` is one fixed sentence per code naming the existing step that
addresses it. It is the only prose the scorecard generates.

## What the scorecard deliberately does not say

- It does not propose approvals. Approval is a separate human decision bound
  to one proposal hash (`anvil legacy refine approve`).
- It does not assert idempotency, retry safety, transaction behavior, or
  business completion for any operation; those stay `unknown` until refinement
  evidences them.
- It does not call any capability ready. `executable_shape` is a statement
  about transport shape, and `conformance_passed` is a statement about the
  bridge's own code against a double. Live readiness is unverified for every
  binding in every release.
- It does not merge, rename, or de-duplicate candidates, and it does not read
  destination or interface names for meaning.
- It does not replace `anvil legacy gaps`, `anvil legacy explain`, or
  `anvil legacy diff`; it summarizes counts that those commands explain.

## From TypeScript

```ts
import {
  assessLegacyModernization,
  renderLegacyModernizationScorecard,
} from "@anvil/compiler/legacy";

const scorecard = assessLegacyModernization(inventoryResult, { bindings, plan });
const markdown = renderLegacyModernizationScorecard(scorecard);
```

`assessLegacyModernization` verifies the inventory and every binding before
counting anything and throws for malformed or stale input. The result parses
with `LegacyModernizationScorecard`.

## Continue

- [Understand the legacy-estate model](legacy-estates.md)
- [Measure coverage and request evidence](legacy-inventory.md)
- [Refine and review one candidate](legacy-refinement.md)
- [Design a deployment-local bridge](legacy-runtime-bridges.md)
