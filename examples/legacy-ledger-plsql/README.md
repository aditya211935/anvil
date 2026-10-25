# Legacy ledger stored-procedure fixture

This synthetic DDL export demonstrates the `database` legacy collector. It
holds one PL/SQL package specification, its body, and one T-SQL procedure.
Anvil reads the files as inert text: it never connects to a database, never
evaluates SQL, and never guesses what a procedure means for the business.

What the fixture is designed to show:

- signatures come from the package **specification**; the body is retained as
  evidence and contributes only literal facts (`COMMIT`,
  `PRAGMA AUTONOMOUS_TRANSACTION`, `RAISE_APPLICATION_ERROR` codes);
- the private helper `assert_account` exists only in the body, so it never
  becomes a candidate;
- `open_entries` declares a `SYS_REFCURSOR` OUT parameter, which is the only
  output shape the inventory claims for it;
- the T-SQL procedure declares one `OUTPUT` parameter, `BEGIN TRANSACTION`,
  `COMMIT`, and `RAISERROR(50001, ...)`, and also returns a result set whose
  shape is **not** claimed, with `legacy/database/result_set_unproven` left as
  acquisition work.

Build the repository, then run:

```bash
node packages/cli/dist/bin-anvil.js legacy inventory \
  examples/legacy-ledger-plsql/export \
  --collector database \
  --estate ledger-example \
  --environment prod \
  --application ledger-service \
  --source-kind source_repository \
  --source-id ledger-ddl-example \
  --revision fixture-v1 \
  --out generated/legacy-ledger.inventory.json
```

Every candidate is a `stored_procedure` invocation with `declared` claims only.
Inspect them:

```bash
jq '.candidates[] | {
  candidateId,
  invocation,
  disposition,
  claims: [.claims[] | {dimension, value: .assertions[0].value}]
}' generated/legacy-ledger.inventory.json
```

Trace one candidate to every observation, claim, and source span:

```bash
ANVIL_LEGACY_CANDIDATE_ID=$(
  jq -r '.candidates[] | select(.invocation.procedure == "PKG_LEDGER.POST_ENTRY") | .candidateId' \
    generated/legacy-ledger.inventory.json
)

node packages/cli/dist/bin-anvil.js legacy explain \
  generated/legacy-ledger.inventory.json \
  "$ANVIL_LEGACY_CANDIDATE_ID"
```

The explanation cites both the `.pks` and `.pkb` spans for `post_entry`, a
`transaction_boundary` of `commits_internally`, and `error_semantics` of
`raise_application_error:-20001`. It does not contain an `idempotency` claim:
re-running `post_entry` posts another entry, and nothing in DDL can prove
otherwise. That decision, like the business operation each procedure
implements, belongs to a reviewed refinement, not to the inventory.

## Extending the corpus

`tools/legacy-corpus/systems.json` pins real GitHub repositories by commit and
SHA-256 for the network-gated corpus gate. This fixture is synthetic and is not
a corpus row. When a real, permissively licensed PL/SQL or T-SQL export is
identified, add it as a pinned row with the expected `database` collector,
candidate counts, and diagnostic codes rather than copying its text here.
