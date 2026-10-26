import { describe, expect, it } from "vitest";
import { collectLegacyInventory, type LegacySourceMember } from "./inventory.js";

const encoder = new TextEncoder();

function member(path: string, content: string): LegacySourceMember {
  return { path, bytes: encoder.encode(content) };
}

function inventory(members: LegacySourceMember[], collector?: "auto" | "database") {
  return collectLegacyInventory({
    estate: { id: "ledger-prod" },
    environment: "prod",
    application: "ledger-service",
    source: { kind: "source_repository", systemId: "ledger-git", revision: "abc123" },
    ...(collector ? { collector } : {}),
    members,
  });
}

const SPEC = `CREATE OR REPLACE PACKAGE ledger.pkg_ledger AS
  PROCEDURE post_entry(p_account_id IN VARCHAR2, p_amount IN NUMBER, p_entry_id OUT NUMBER);
  FUNCTION balance_of(p_account_id IN VARCHAR2) RETURN NUMBER;
END pkg_ledger;
/`;

const BODY = `CREATE OR REPLACE PACKAGE BODY ledger.pkg_ledger AS
  PROCEDURE post_entry(p_account_id IN VARCHAR2, p_amount IN NUMBER, p_entry_id OUT NUMBER) IS
  BEGIN
    INSERT INTO ledger.entries VALUES (p_account_id, p_amount) RETURNING id INTO p_entry_id;
    IF p_amount = 0 THEN RAISE_APPLICATION_ERROR(-20001, 'zero'); END IF;
    COMMIT;
  END post_entry;
  FUNCTION balance_of(p_account_id IN VARCHAR2) RETURN NUMBER IS
  BEGIN
    RETURN 0;
  END balance_of;
END pkg_ledger;
/`;

const TSQL = `CREATE OR ALTER PROCEDURE [dbo].[usp_PostEntry]
  @AccountId INT, @Amount DECIMAL(18,2), @EntryId BIGINT OUTPUT
AS
BEGIN
  BEGIN TRANSACTION;
  INSERT INTO dbo.Entries VALUES (@AccountId, @Amount);
  SET @EntryId = SCOPE_IDENTITY();
  IF @Amount = 0 RAISERROR(50001, 16, 1);
  COMMIT TRANSACTION;
END
GO`;

const EJB = `<ejb-jar><enterprise-beans><session>
  <ejb-name>LedgerBean</ejb-name><remote>com.acme.Ledger</remote>
</session></enterprise-beans></ejb-jar>`;

describe("database collector inside the legacy inventory", () => {
  it("runs beside other collectors in auto mode", () => {
    const result = inventory([
      member("ledger/META-INF/ejb-jar.xml", EJB),
      member("db/pkg_ledger.pks", SPEC),
      member("db/pkg_ledger.pkb", BODY),
    ]);

    expect(result.collectors.map((run) => run.collector)).toEqual(["java-ee", "database"]);
    expect(result.collectors).toContainEqual(
      expect.objectContaining({ collector: "database", inputMembers: 2, observations: 2 }),
    );
    const artifacts = [...result.snapshot.artifacts].sort((a, b) => a.path.localeCompare(b.path));
    expect(artifacts.map((artifact) => [artifact.path, artifact.role])).toEqual([
      ["db/pkg_ledger.pkb", "schema"],
      ["db/pkg_ledger.pks", "schema"],
      ["ledger/META-INF/ejb-jar.xml", "deployment_descriptor"],
    ]);
    expect(artifacts[0]?.mediaType).toBe("application/sql");
    expect(result.candidates.map((candidate) => candidate.invocation.kind).sort()).toEqual([
      "remote_method",
      "stored_procedure",
      "stored_procedure",
    ]);
  });

  it("yields review-bound stored_procedure candidates with evidenced declared claims", () => {
    const result = inventory(
      [
        member("db/pkg_ledger.pks", SPEC),
        member("db/pkg_ledger.pkb", BODY),
        member("db/usp_PostEntry.sql", TSQL),
      ],
      "database",
    );

    expect(result.collectors).toEqual([
      { collector: "database", inputMembers: 3, observations: 3, diagnostics: 0 },
    ]);
    expect(result.candidates).toHaveLength(3);
    for (const candidate of result.candidates) {
      expect(candidate.invocation.kind).toBe("stored_procedure");
      expect(["triage", "review_required"]).toContain(candidate.disposition);
      expect(candidate.businessSemantics).toBe("unknown");
      expect(candidate.conflicts).toEqual([]);
      expect(
        candidate.claims.some((claim) =>
          ["idempotency", "business_operation", "business_effect"].includes(claim.dimension),
        ),
      ).toBe(false);
      for (const claim of candidate.claims) {
        for (const assertion of claim.assertions) expect(assertion.bases).toEqual(["declared"]);
      }
    }

    const postEntry = result.candidates.find(
      (candidate) =>
        candidate.invocation.kind === "stored_procedure" &&
        candidate.invocation.procedure === "PKG_LEDGER.POST_ENTRY",
    );
    expect(postEntry?.invocation).toEqual({
      kind: "stored_procedure",
      databaseRef: "LEDGER",
      procedure: "PKG_LEDGER.POST_ENTRY",
    });
    expect(postEntry?.coordinate).toMatchObject({
      platform: "plsql",
      module: "ledger.pkg_ledger",
      component: "post_entry",
    });
    const claimValue = (dimension: string) =>
      postEntry?.claims.find((claim) => claim.dimension === dimension)?.assertions[0]?.value;
    expect(claimValue("technical_name")).toBe("PKG_LEDGER.POST_ENTRY");
    expect(claimValue("binding_target")).toBe("LEDGER.PKG_LEDGER.POST_ENTRY");
    expect(claimValue("input_schema")).toBe(
      "(P_ACCOUNT_ID IN VARCHAR2, P_AMOUNT IN NUMBER, P_ENTRY_ID OUT NUMBER)",
    );
    expect(claimValue("output_schema")).toBe("(P_ENTRY_ID OUT NUMBER)");
    expect(claimValue("interaction_pattern")).toBe("request_reply");
    expect(claimValue("transaction_boundary")).toEqual(["commits_internally"]);
    expect(claimValue("error_semantics")).toEqual(["raise_application_error:-20001"]);
    // Specification and body both back the candidate.
    expect(postEntry?.evidenceIds).toHaveLength(2);
    const evidencePaths = result.snapshot.evidence
      .filter((record) => postEntry?.evidenceIds.includes(record.evidenceId))
      .map((record) => record.coordinate.path)
      .sort();
    expect(evidencePaths).toEqual(["db/pkg_ledger.pkb", "db/pkg_ledger.pks"]);

    const balance = result.candidates.find(
      (candidate) =>
        candidate.invocation.kind === "stored_procedure" &&
        candidate.invocation.procedure === "PKG_LEDGER.BALANCE_OF",
    );
    const balanceValue = (dimension: string) =>
      balance?.claims.find((claim) => claim.dimension === dimension)?.assertions[0]?.value;
    expect(balanceValue("output_schema")).toBe("RETURN NUMBER");
    expect(balanceValue("transaction_boundary")).toBeUndefined();

    const tsql = result.candidates.find(
      (candidate) =>
        candidate.invocation.kind === "stored_procedure" &&
        candidate.invocation.procedure === "usp_PostEntry",
    );
    expect(tsql?.invocation).toEqual({
      kind: "stored_procedure",
      databaseRef: "dbo",
      procedure: "usp_PostEntry",
    });
    expect(tsql?.coordinate).toMatchObject({ platform: "tsql", module: "dbo" });
    const tsqlValue = (dimension: string) =>
      tsql?.claims.find((claim) => claim.dimension === dimension)?.assertions[0]?.value;
    expect(tsqlValue("input_schema")).toBe(
      "(@AccountId IN INT, @Amount IN DECIMAL(18,2), @EntryId OUT BIGINT)",
    );
    expect(tsqlValue("output_schema")).toBe("(@EntryId OUT BIGINT)");
    expect(tsqlValue("transaction_boundary")).toEqual(["begins_transaction", "commits_internally"]);
    expect(tsqlValue("error_semantics")).toEqual(["raiserror:50001"]);
  });

  it("never claims an output schema for a T-SQL result set", () => {
    const result = inventory(
      [
        member(
          "db/usp_ListEntries.sql",
          `CREATE PROCEDURE dbo.usp_ListEntries @AccountId INT AS
BEGIN
  SELECT Id, Amount FROM dbo.Entries WHERE AccountId = @AccountId;
END`,
        ),
      ],
      "database",
    );

    expect(result.candidates).toHaveLength(1);
    const dimensions = result.candidates[0]?.claims.map((claim) => claim.dimension);
    expect(dimensions).toEqual(["binding_target", "input_schema", "technical_name"]);
    expect(result.snapshot.diagnostics).toEqual([
      expect.objectContaining({
        level: "info",
        code: "legacy/database/result_set_unproven",
        collectorId: "database",
      }),
    ]);
  });

  it("turns divergent signatures for one procedure into an explicit conflict", () => {
    const result = inventory(
      [
        member(
          "release-1/pkg_ledger.pks",
          `CREATE OR REPLACE PACKAGE ledger.pkg_ledger AS
  PROCEDURE post_entry(p_account_id IN VARCHAR2, p_amount IN NUMBER);
END pkg_ledger;`,
        ),
        member(
          "release-2/pkg_ledger.pks",
          `CREATE OR REPLACE PACKAGE ledger.pkg_ledger AS
  PROCEDURE post_entry(p_account_id IN VARCHAR2, p_amount IN NUMBER, p_memo IN VARCHAR2 DEFAULT NULL);
END pkg_ledger;`,
        ),
      ],
      "database",
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.disposition).toBe("triage");
    expect(result.candidates[0]?.conflicts).toHaveLength(1);
    expect(result.candidates[0]?.conflicts[0]?.dimension).toBe("input_schema");
    expect([...(result.candidates[0]?.conflicts[0]?.values ?? [])].sort()).toEqual([
      "(P_ACCOUNT_ID IN VARCHAR2, P_AMOUNT IN NUMBER)",
      "(P_ACCOUNT_ID IN VARCHAR2, P_AMOUNT IN NUMBER, P_MEMO IN VARCHAR2 DEFAULT)",
    ]);
    expect(result.snapshot.diagnostics).toContainEqual(
      expect.objectContaining({ code: "legacy/database/multiple_signatures" }),
    );
  });

  it("surfaces refusals and non-DDL scripts as collector diagnostics", () => {
    const result = inventory(
      [
        member("db/seed.sql", "INSERT INTO ledger.accounts VALUES (1);"),
        member(
          "db/users.sql",
          `CREATE USER svc IDENTIFIED BY "s3cret-value";
CREATE OR REPLACE PROCEDURE svc.noop AS BEGIN NULL; END;`,
        ),
      ],
      "database",
    );

    expect(result.candidates).toEqual([]);
    expect(result.snapshot.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "legacy/database/no_procedure_ddl",
      "legacy/database/secret_like_value",
    ]);
    expect(JSON.stringify(result)).not.toContain("s3cret-value");
  });

  it("is independent of member ordering", () => {
    const members = [
      member("db/pkg_ledger.pks", SPEC),
      member("db/pkg_ledger.pkb", BODY),
      member("db/usp_PostEntry.sql", TSQL),
    ];
    expect(inventory([...members].reverse())).toEqual(inventory(members));
  });
});
