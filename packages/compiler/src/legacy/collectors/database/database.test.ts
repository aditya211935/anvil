import { describe, expect, it } from "vitest";
import { collectDatabaseLegacy } from "./collector.js";
import { scrubSql } from "./safety.js";

const PACKAGE_SPEC = `CREATE OR REPLACE PACKAGE ledger.pkg_ledger AS
  -- Posts one journal entry. PROCEDURE commented_out(p IN NUMBER);
  PROCEDURE post_entry(
    p_account_id IN VARCHAR2,
    p_amount     IN NUMBER,
    p_memo       IN VARCHAR2 DEFAULT NULL,
    p_entry_id   OUT NUMBER
  );
  FUNCTION balance_of(p_account_id IN VARCHAR2) RETURN NUMBER;
  PROCEDURE open_entries(p_account_id IN VARCHAR2, p_rows OUT SYS_REFCURSOR);
  PROCEDURE audit_touch(p_account_id IN VARCHAR2);
END pkg_ledger;
/
`;

const PACKAGE_BODY = `CREATE OR REPLACE PACKAGE BODY ledger.pkg_ledger AS
  PROCEDURE assert_open(p_account_id IN VARCHAR2) IS
  BEGIN
    IF p_account_id IS NULL THEN
      RAISE_APPLICATION_ERROR(-20099, 'account required /* not a comment */ -- nor this');
    END IF;
  END assert_open;

  PROCEDURE post_entry(
    p_account_id IN VARCHAR2,
    p_amount     IN NUMBER,
    p_memo       IN VARCHAR2 DEFAULT NULL,
    p_entry_id   OUT NUMBER
  ) IS
  BEGIN
    assert_open(p_account_id);
    INSERT INTO ledger.entries(account_id, amount, memo)
      VALUES (p_account_id, p_amount, p_memo) RETURNING entry_id INTO p_entry_id;
    IF p_amount = 0 THEN
      RAISE_APPLICATION_ERROR(-20001, 'zero amount');
    END IF;
    COMMIT;
  END post_entry;

  FUNCTION balance_of(p_account_id IN VARCHAR2) RETURN NUMBER IS
    l_balance NUMBER;
  BEGIN
    SELECT SUM(amount) INTO l_balance FROM ledger.entries WHERE account_id = p_account_id;
    RETURN NVL(l_balance, 0);
  END balance_of;

  PROCEDURE open_entries(p_account_id IN VARCHAR2, p_rows OUT SYS_REFCURSOR) IS
  BEGIN
    OPEN p_rows FOR SELECT * FROM ledger.entries WHERE account_id = p_account_id;
  END open_entries;

  PROCEDURE audit_touch(p_account_id IN VARCHAR2) IS
    PRAGMA AUTONOMOUS_TRANSACTION;
  BEGIN
    INSERT INTO ledger.audit(account_id) VALUES (p_account_id);
    COMMIT;
  END audit_touch;
END pkg_ledger;
/
`;

const STANDALONE = `CREATE OR REPLACE PROCEDURE ledger.close_period(p_period IN VARCHAR2, p_closed IN OUT BOOLEAN) AS
BEGIN
  UPDATE ledger.periods SET closed = 'Y' WHERE period = p_period;
  p_closed := TRUE;
END close_period;
/
`;

const TSQL = `USE [LedgerDb]
GO
SET ANSI_NULLS ON
GO
CREATE OR ALTER PROCEDURE [dbo].[usp_PostEntry]
  @AccountId  INT,
  @Amount     DECIMAL(18,2),
  @Memo       NVARCHAR(200) = NULL,
  @EntryId    BIGINT OUTPUT
WITH EXECUTE AS CALLER
AS
BEGIN
  SET NOCOUNT ON;
  -- CREATE PROCEDURE dbo.commented_out AS SELECT 1;
  BEGIN TRANSACTION;
  INSERT INTO dbo.Entries(AccountId, Amount, Memo) VALUES (@AccountId, @Amount, @Memo);
  SET @EntryId = SCOPE_IDENTITY();
  IF @Amount = 0
  BEGIN
    RAISERROR(50001, 16, 1);
    ROLLBACK TRANSACTION;
    RETURN 1;
  END
  COMMIT TRANSACTION;
  SELECT @EntryId AS EntryId;
END
GO
`;

describe("database legacy collector", () => {
  it("reads PL/SQL signatures from the package specification and body facts from the body", () => {
    const result = collectDatabaseLegacy([
      { path: "ledger/pkg_ledger.pks", bytes: PACKAGE_SPEC },
      { path: "ledger/pkg_ledger.pkb", bytes: PACKAGE_BODY },
    ]);

    expect(result.collector).toEqual({ kind: "database", schemaVersion: 1 });
    expect(result.evidence.map((item) => [item.path, item.role])).toEqual([
      ["ledger/pkg_ledger.pkb", "package_body"],
      ["ledger/pkg_ledger.pks", "package_specification"],
    ]);
    expect(result.observations.map((observation) => observation.name)).toEqual([
      "AUDIT_TOUCH",
      "BALANCE_OF",
      "OPEN_ENTRIES",
      "POST_ENTRY",
    ]);
    expect(
      result.observations.every((item) => item.signatureSource === "package_specification"),
    ).toBe(true);

    const postEntry = result.observations.find((item) => item.name === "POST_ENTRY");
    expect(postEntry).toMatchObject({
      kind: "stored_procedure",
      coordinate: "plsql:LEDGER:PKG_LEDGER:POST_ENTRY",
      schema: "LEDGER",
      package: "PKG_LEDGER",
      parameters: [
        { name: "P_ACCOUNT_ID", mode: "in", type: "VARCHAR2", hasDefault: false },
        { name: "P_AMOUNT", mode: "in", type: "NUMBER", hasDefault: false },
        { name: "P_MEMO", mode: "in", type: "VARCHAR2", hasDefault: true },
        { name: "P_ENTRY_ID", mode: "out", type: "NUMBER", hasDefault: false },
      ],
      transaction: ["commits_internally"],
      errorFacts: ["raise_application_error:-20001"],
      confidence: "declared",
    });
    expect(postEntry?.evidence.map((item) => item.pointer)).toEqual([
      "package_body:LEDGER.PKG_LEDGER/POST_ENTRY",
      "package_specification:LEDGER.PKG_LEDGER/POST_ENTRY",
    ]);

    const audit = result.observations.find((item) => item.name === "AUDIT_TOUCH");
    expect(audit?.transaction).toEqual(["autonomous", "commits_internally"]);
    expect(audit?.errorFacts).toEqual([]);

    const balance = result.observations.find((item) => item.name === "BALANCE_OF");
    expect(balance).toMatchObject({ kind: "stored_function", returnType: "NUMBER" });
    expect(balance?.transaction).toEqual([]);

    const cursor = result.observations.find((item) => item.name === "OPEN_ENTRIES");
    expect(cursor?.parameters[1]).toEqual({
      name: "P_ROWS",
      mode: "out",
      type: "SYS_REFCURSOR",
      hasDefault: false,
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("reads a standalone PL/SQL procedure and warns when only a package body is supplied", () => {
    const result = collectDatabaseLegacy([
      { path: "close_period.prc", bytes: STANDALONE },
      { path: "pkg_ledger.pkb", bytes: PACKAGE_BODY },
    ]);

    const standalone = result.observations.find((item) => item.name === "CLOSE_PERIOD");
    expect(standalone).toMatchObject({
      coordinate: "plsql:LEDGER:-:CLOSE_PERIOD",
      signatureSource: "standalone",
      parameters: [
        { name: "P_PERIOD", mode: "in", type: "VARCHAR2", hasDefault: false },
        { name: "P_CLOSED", mode: "inout", type: "BOOLEAN", hasDefault: false },
      ],
      transaction: [],
    });
    expect(standalone?.evidence[0]?.pointer).toBe("standalone:LEDGER.CLOSE_PERIOD");

    const bodyOnly = result.observations.filter((item) => item.package === "PKG_LEDGER");
    expect(bodyOnly.map((item) => item.name)).toEqual([
      "ASSERT_OPEN",
      "AUDIT_TOUCH",
      "BALANCE_OF",
      "OPEN_ENTRIES",
      "POST_ENTRY",
    ]);
    expect(bodyOnly.every((item) => item.signatureSource === "package_body")).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "warning",
        code: "database/package_body_without_specification",
        coordinate: { origin: "pkg_ledger.pkb" },
      }),
    );
  });

  it("reads T-SQL OUTPUT parameters, transaction keywords, and RAISERROR codes", () => {
    const result = collectDatabaseLegacy([{ path: "dbo/usp_PostEntry.sql", bytes: TSQL }]);

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      kind: "stored_procedure",
      dialect: "tsql",
      coordinate: "tsql:dbo:-:USP_POSTENTRY",
      schema: "dbo",
      name: "usp_PostEntry",
      parameters: [
        { name: "@AccountId", mode: "in", type: "INT", hasDefault: false },
        { name: "@Amount", mode: "in", type: "DECIMAL(18,2)", hasDefault: false },
        { name: "@Memo", mode: "in", type: "NVARCHAR(200)", hasDefault: true },
        { name: "@EntryId", mode: "out", type: "BIGINT", hasDefault: false },
      ],
      transaction: ["begins_transaction", "commits_internally", "rolls_back_internally"],
      errorFacts: ["raiserror:50001"],
    });
    expect(result.observations[0]?.evidence[0]?.pointer).toBe("procedure:dbo.usp_PostEntry");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ level: "info", code: "database/result_set_unproven" }),
    ]);
  });

  it("recognizes THROW and message-only RAISERROR without inventing a result set", () => {
    const result = collectDatabaseLegacy([
      {
        path: "throw.sql",
        bytes: `CREATE PROCEDURE dbo.usp_Guard @Id INT AS
BEGIN
  IF @Id IS NULL THROW 51000, 'id required', 1;
  RAISERROR('soft failure', 10, 1);
  UPDATE dbo.Guard SET touched = 1 WHERE Id = @Id;
END`,
      },
    ]);

    expect(result.observations[0]).toMatchObject({
      dialect: "tsql",
      errorFacts: ["raiserror:message", "throw:51000"],
      transaction: [],
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("records T-SQL functions as evidence without projecting a contract", () => {
    const result = collectDatabaseLegacy([
      {
        path: "fn.sql",
        bytes: `CREATE FUNCTION dbo.fn_Balance(@AccountId INT) RETURNS DECIMAL(18,2)
AS
BEGIN
  RETURN (SELECT SUM(Amount) FROM dbo.Entries WHERE AccountId = @AccountId);
END
GO`,
      },
    ]);

    expect(result.observations).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ level: "info", code: "database/tsql_function_unsupported" }),
    ]);
  });

  it("strips comments and string literals before scanning", () => {
    const text = `a 'it''s' -- tail\n/* block\nmore */ b N'x'`;
    const inert = scrubSql(text);
    expect(inert).toHaveLength(text.length);
    expect(inert).not.toMatch(/it|tail|block|more|x'/);
    expect(inert).toMatch(/^a '\s+'\s+\n\s+\n\s+b\s+'\s'$/);
    const scrubbed = scrubSql(`x := 'quoted -- not a comment'; -- real comment\ny`);
    expect(scrubbed).toMatch(/^x := '\s+';\s+\ny$/);

    const result = collectDatabaseLegacy([
      {
        path: "spec.pks",
        bytes: `CREATE OR REPLACE PACKAGE app AS
  /* PROCEDURE in_block_comment(p IN NUMBER); */
  -- PROCEDURE in_line_comment(p IN NUMBER);
  PROCEDURE real_one(p_sql IN VARCHAR2 DEFAULT 'PROCEDURE in_literal(x IN NUMBER); COMMIT;');
END app;`,
      },
    ]);
    expect(result.observations.map((item) => item.name)).toEqual(["REAL_ONE"]);
    expect(result.observations[0]?.transaction).toEqual([]);
    expect(result.observations[0]?.parameters[0]?.hasDefault).toBe(true);
  });

  it("refuses members that carry credentials", () => {
    const result = collectDatabaseLegacy([
      {
        path: "setup.sql",
        bytes: `CREATE USER ledger IDENTIFIED BY "Tr0ub4dor&3";
CREATE OR REPLACE PROCEDURE ledger.noop AS BEGIN NULL; END;`,
      },
      {
        path: "login.sql",
        bytes: `CREATE LOGIN svc WITH PASSWORD = 'hunter2';
CREATE PROCEDURE dbo.noop AS BEGIN SET NOCOUNT ON; END`,
      },
      {
        path: "placeholder.sql",
        bytes: `CREATE USER ledger IDENTIFIED BY \${LEDGER_PASSWORD};
CREATE OR REPLACE PROCEDURE ledger.noop AS BEGIN NULL; END;`,
      },
    ]);

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: "error",
        code: "database/secret_like_value",
        coordinate: { origin: "login.sql" },
      }),
      expect.objectContaining({
        level: "error",
        code: "database/secret_like_value",
        coordinate: { origin: "setup.sql" },
      }),
    ]);
    expect(result.observations.map((item) => item.evidence[0]?.origin)).toEqual([
      "placeholder.sql",
    ]);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("Tr0ub4dor");
  });

  it("refuses oversized members and records scripts without procedure DDL", () => {
    const result = collectDatabaseLegacy([
      { path: "huge.sql", bytes: new Uint8Array(4 * 1024 * 1024 + 1) },
      { path: "seed.sql", bytes: "INSERT INTO ledger.accounts(id) VALUES (1);\nCOMMIT;\n" },
      { path: "bad.sql", bytes: new Uint8Array([0xff, 0xfe, 0x00, 0xc3]) },
    ]);

    expect(result.observations).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "database/non_utf8_artifact", level: "error" }),
      expect.objectContaining({ code: "database/oversized_artifact", level: "error" }),
      expect.objectContaining({
        code: "database/no_procedure_ddl",
        level: "info",
        coordinate: { origin: "seed.sql" },
      }),
    ]);
    expect(result.evidence.map((item) => item.path)).toEqual(["seed.sql"]);
  });

  it("retains overloaded and divergent signatures instead of choosing one", () => {
    const result = collectDatabaseLegacy([
      {
        path: "a/pkg.pks",
        bytes: `CREATE OR REPLACE PACKAGE pkg AS
  PROCEDURE post(p_id IN NUMBER);
  PROCEDURE post(p_id IN NUMBER, p_note IN VARCHAR2);
END pkg;`,
      },
    ]);

    expect(result.observations).toHaveLength(2);
    expect(new Set(result.observations.map((item) => item.coordinate))).toEqual(
      new Set(["plsql:unknown-schema:PKG:POST"]),
    );
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ level: "info", code: "database/multiple_signatures" }),
    ]);
  });

  it("is deterministic regardless of input order", () => {
    const spec = { path: "ledger/pkg_ledger.pks", bytes: PACKAGE_SPEC };
    const body = { path: "ledger/pkg_ledger.pkb", bytes: PACKAGE_BODY };
    const standalone = { path: "close_period.prc", bytes: STANDALONE };
    const tsql = { path: "dbo/usp_PostEntry.sql", bytes: TSQL };
    const seed = { path: "seed.sql", bytes: "INSERT INTO t VALUES (1);" };
    const inputs = [spec, body, standalone, tsql, seed];
    const forward = collectDatabaseLegacy(inputs);
    const shuffled = collectDatabaseLegacy([tsql, body, seed, spec, standalone]);
    const reversed = collectDatabaseLegacy([...inputs].reverse());

    expect(shuffled).toEqual(forward);
    expect(reversed).toEqual(forward);
    expect(forward.observations).toHaveLength(6);
  });
});
