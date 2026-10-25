# Legacy modernization scorecard `lms_be62b6854050f27a8ecb58971c178ca70a82661184e35afd7725027c447fc8f9`

Estate `refunds-prod` (Refunds (production)) · inventory `li_436d85c668b8f0bf6ad0a9ae1eecd29ed83dc69a6ac313e4d82bbeeb363feea0` · content hash `sha256:be62b6854050f27a8ecb58971c178ca70a82661184e35afd7725027c447fc8f9`

Every figure below is a count over inventory or binding records. The scorecard proposes no approval, asserts no idempotency, and reports no capability as ready; `executable_shape` means only that the queue bridge can conformance-test that transport shape.

## Estate

| Measure | Count |
| --- | --- |
| deployment coordinates (environment/application) | 1 |
| artifacts | 4 |
| evidence records | 7 |
| invocation observations | 3 |
| diagnostics: error | 0 |
| diagnostics: warning | 0 |
| diagnostics: info | 0 |
| safety refusals | 0 |

## Capabilities

3 candidate(s).

### By invocation kind

| Kind | Count |
| --- | --- |
| message | 2 |
| remote_method | 1 |

### By protocol

| Kind/protocol | Count |
| --- | --- |
| message/other | 2 |
| remote_method/ejb_rmi | 1 |

### Disposition and business semantics

| State | Count |
| --- | --- |
| disposition: triage | 3 |
| disposition: review_required | 0 |
| business semantics: unknown | 3 |
| business semantics: asserted_unverified | 0 |
| business semantics: conflicting | 0 |

### Conflicts

1 candidate(s) carry 1 conflict(s).

| Dimension in conflict | Candidates |
| --- | --- |
| binding_target | 1 |

### Unknown claim dimensions

Candidates with no evidenced claim for the dimension, most often absent first.

| Dimension | Candidates without a claim |
| --- | --- |
| business_effect | 3 |
| business_operation | 3 |
| delivery_guarantee | 3 |
| error_semantics | 3 |
| idempotency | 3 |
| input_schema | 3 |
| output_schema | 3 |
| owner | 3 |
| transaction_boundary | 3 |
| interaction_pattern | 2 |
| binding_target | 0 |
| technical_name | 0 |

## Coverage

Coverage report `lcr_9dd20b106294c1417c70438ca9788b92fcd99bb098ee2b3ee995cbe53febc00f` against the default requirements.

| Measure | Value |
| --- | --- |
| outcome | supported |
| semantic completeness | complete |
| requirements satisfied | 2 |
| requirements partial | 0 |
| requirements missing | 0 |
| requirements not applicable | 0 |
| unsatisfied | none |

## Review

2 reviewed binding(s) supplied; 2 candidate(s) reviewed, 1 unreviewed.

| Measure | Count |
| --- | --- |
| lineage: matched | 2 |
| lineage: unmatched_candidate | 0 |
| lineage: stale_inventory | 0 |
| lineage: stale_candidate | 0 |
| runtime: not_implemented | 2 |
| runtime: conformance_passed | 0 |
| shape: executable_shape | 1 |
| shape: needs_driver | 1 |

### Adapter families still required

| Family | Bindings |
| --- | --- |
| WebLogic remote EJB | 1 |

### Bindings

| Binding | Operation | Transport | Runtime | Shape | Family | Lineage |
| --- | --- | --- | --- | --- | --- | --- |
| lcb_7aa37b787e1bfd9b0b7c538b267d973637b37915e20e3c1a033efece94965c81 | refunds.submit_refund | message/jms | not_implemented | executable_shape | — | matched |
| lcb_7b670fe5686c8e2b6301f7d14b022b937ca42c750bfd84196778737dda2e5ee0 | refunds.submit_refund | remote_method/ejb_rmi | not_implemented | needs_driver | WebLogic remote EJB | matched |

## Blockers

| Code | Count | Detail | Next action |
| --- | --- | --- | --- |
| candidate_conflict | 1 | 1 candidate(s) carry 1 unresolved claim conflict(s). | Resolve each conflicting dimension inside a hash-bound refinement proposal with cited evidence (`anvil legacy refine task`); the inventory keeps the disagreement. |
| business_semantics_unknown | 3 | 3 candidate(s) have no evidenced business operation or effect. | Run one refinement task per candidate; inventory evidence cannot supply business meaning and the scorecard does not infer it. |
| binding_needs_driver (WebLogic remote EJB) | 1 | 1 binding(s) need the 'WebLogic remote EJB' adapter family; no conformance runner exists for it. | No conformance runner exists for this transport family; the adapter must be built and pass conformance before the binding can be tested. |
| binding_not_implemented | 2 | 2 binding(s) have runtime status not_implemented; no conformance report has moved them. | For executable-shape bindings run `anvil legacy bridge plan` then `anvil legacy bridge conformance`; every other binding waits on its adapter family. |

## What this scorecard does not say

- It does not approve, rank, or recommend any candidate; approval is a separate human decision bound to one proposal.
- It does not assert idempotency, retry safety, or business completion for any operation.
- `executable_shape` is the shape `anvil legacy bridge conformance` can test against a broker double, not a statement that the binding runs or that a broker was reached.
- `conformance_passed` is a statement about the bridge's own code against a double; live readiness is unverified for every binding.
