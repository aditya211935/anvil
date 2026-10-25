# Legacy mainframe batch fixture

This synthetic z/OS export demonstrates the mainframe lane of the legacy
inventory. One JCL job (`JCL/PAYROLL1.jcl`) runs three steps, calls a cataloged
procedure (`PROCLIB/PAYRPT.proc`), reads and writes datasets by `DISP`, and
carries in-stream `SYSIN` data. One COBOL copybook (`COPYLIB/CUSTREC.cpy`)
describes the record that the job's `CUSTREC` DD references by PDS member name.

Nothing here is a real system. No dataset exists, no job is submitted, and no
credential appears.

Build the repository, then run the inventory:

```bash
node packages/cli/dist/bin-anvil.js legacy inventory \
  examples/legacy-batch-mainframe/export \
  --estate payroll-example \
  --environment prod \
  --application payroll \
  --source-kind source_repository \
  --source-id jcl-example \
  --revision fixture-v1 \
  --collector mainframe \
  --out generated/legacy-batch-mainframe.inventory.json
```

Two `batch_job` candidates appear: the job `PAYROLL1` (scheduler reference
`jcllib:PROD.PROCLIB`) and the procedure `PAYRPT` (`proclib`). Every claim is
`declared`: the ordered step list is the `binding_target`, datasets opened with
`DISP=SHR`/`OLD` are `input_schema` references, datasets opened with
`DISP=NEW`/`MOD` are `output_schema` references, and `COND=` / `IF` thresholds
are `error_semantics`. The `CUSTREC` copybook is linked as
`copybook:COPYLIB/CUSTREC.cpy` because the DD names its PDS member; the
in-stream `SYSIN` records are never copied into the report.

```bash
jq '.candidates[] | {invocation, claims: [.claims[] | {dimension, value: .assertions[0].value}]}' \
  generated/legacy-batch-mainframe.inventory.json
```

Convert the copybook into a JSON Schema with byte offsets:

```bash
node packages/cli/dist/bin-anvil.js legacy schema copybook \
  examples/legacy-batch-mainframe/export/COPYLIB/CUSTREC.cpy \
  --out generated/custrec.schema.json
```

Field names stay verbatim (`CUST-ID`, not `customerId`). Each field carries
its COBOL declaration, offset, byte length, usage, and picture under
`x-anvil-cobol`; the `88` conditions on `CUST-STATUS` become `enum`
candidates, `REDEFINES` becomes `oneOf`, and `FILLER` is counted but not named.

The inventory does not say what the job means, whether a step may be rerun, or
who may submit it. Those remain review decisions.
