import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-legacy-inventory-database-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function anvil(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

function ddlFixture(): string {
  const source = join(work, "ledger-ddl");
  mkdirSync(join(source, "ledger"), { recursive: true });
  mkdirSync(join(source, "dbo"), { recursive: true });
  writeFileSync(
    join(source, "ledger", "pkg_ledger.pks"),
    `CREATE OR REPLACE PACKAGE ledger.pkg_ledger AS
  PROCEDURE post_entry(p_account_id IN VARCHAR2, p_amount IN NUMBER, p_entry_id OUT NUMBER);
  FUNCTION balance_of(p_account_id IN VARCHAR2) RETURN NUMBER;
END pkg_ledger;
/
`,
  );
  writeFileSync(
    join(source, "ledger", "pkg_ledger.pkb"),
    `CREATE OR REPLACE PACKAGE BODY ledger.pkg_ledger AS
  PROCEDURE post_entry(p_account_id IN VARCHAR2, p_amount IN NUMBER, p_entry_id OUT NUMBER) IS
  BEGIN
    INSERT INTO ledger.entries VALUES (p_account_id, p_amount) RETURNING id INTO p_entry_id;
    COMMIT;
  END post_entry;
  FUNCTION balance_of(p_account_id IN VARCHAR2) RETURN NUMBER IS
  BEGIN
    RETURN 0;
  END balance_of;
END pkg_ledger;
/
`,
  );
  writeFileSync(
    join(source, "dbo", "usp_PostEntry.sql"),
    `CREATE OR ALTER PROCEDURE [dbo].[usp_PostEntry]
  @AccountId INT, @Amount DECIMAL(18,2), @EntryId BIGINT OUTPUT
AS
BEGIN
  BEGIN TRANSACTION;
  INSERT INTO dbo.Entries VALUES (@AccountId, @Amount);
  SET @EntryId = SCOPE_IDENTITY();
  COMMIT TRANSACTION;
END
GO
`,
  );
  writeFileSync(join(source, "README.txt"), "operator notes, not DDL\n");
  return source;
}

describe("anvil legacy inventory --collector database", () => {
  it("recovers stored-procedure candidates from DDL exports as review-bound evidence", async () => {
    const source = ddlFixture();
    const result = await anvil(
      "legacy",
      "inventory",
      source,
      "--collector",
      "database",
      "--environment",
      "prod",
      "--application",
      "ledger-service",
      "--source-kind",
      "source_repository",
      "--json",
    );

    expect(result.code, result.err).toBe(0);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({
      schemaVersion: 1,
      reportType: "anvil.legacy-estate-inventory",
      summary: { artifacts: 4, candidates: 3, conflicts: 0 },
      collectors: [{ collector: "database", inputMembers: 3, observations: 3, diagnostics: 0 }],
    });
    expect(report.inventory.inventoryId).toMatch(/^li_[a-f0-9]{64}$/);
    for (const candidate of report.candidates) {
      expect(candidate.invocation.kind).toBe("stored_procedure");
      expect(candidate.businessSemantics).toBe("unknown");
      expect(["triage", "review_required"]).toContain(candidate.disposition);
      expect(candidate.claims.map((claim: { dimension: string }) => claim.dimension)).not.toContain(
        "idempotency",
      );
    }
    const procedures = report.candidates
      .map((candidate: { invocation: { procedure: string } }) => candidate.invocation.procedure)
      .sort();
    expect(procedures).toEqual(["PKG_LEDGER.BALANCE_OF", "PKG_LEDGER.POST_ENTRY", "usp_PostEntry"]);

    const second = await anvil(
      "legacy",
      "inventory",
      source,
      "--collector",
      "database",
      "--environment",
      "prod",
      "--application",
      "ledger-service",
      "--source-kind",
      "source_repository",
      "--json",
    );
    expect(second.out).toBe(result.out);
  });

  it("refuses credential-bearing DDL with a non-zero exit and no leaked value", async () => {
    const source = join(work, "secrets");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "users.sql"),
      `CREATE USER svc IDENTIFIED BY "fixture-not-a-real-secret";
CREATE OR REPLACE PROCEDURE svc.noop AS BEGIN NULL; END;
`,
    );
    const result = await anvil(
      "legacy",
      "inventory",
      source,
      "--collector",
      "database",
      "--environment",
      "prod",
      "--application",
      "ledger-service",
      "--json",
    );

    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report.summary.candidates).toBe(0);
    expect(report.inventory.diagnostics).toContainEqual(
      expect.objectContaining({ level: "error", code: "legacy/database/secret_like_value" }),
    );
    expect(result.out).not.toContain("fixture-not-a-real-secret");
  });
});
