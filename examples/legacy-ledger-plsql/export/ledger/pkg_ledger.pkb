-- Synthetic fixture: body of pkg_ledger. The body is evidence for literal
-- transaction and error facts; signatures come from the specification.
CREATE OR REPLACE PACKAGE BODY ledger.pkg_ledger AS

  -- Private helper: not in the specification, so not a public capability.
  PROCEDURE assert_account(p_account_id IN VARCHAR2) IS
  BEGIN
    IF p_account_id IS NULL THEN
      RAISE_APPLICATION_ERROR(-20099, 'account id is required');
    END IF;
  END assert_account;

  PROCEDURE post_entry(
    p_account_id IN  VARCHAR2,
    p_amount     IN  NUMBER,
    p_memo       IN  VARCHAR2 DEFAULT NULL,
    p_entry_id   OUT NUMBER
  ) IS
  BEGIN
    assert_account(p_account_id);
    IF p_amount = 0 THEN
      RAISE_APPLICATION_ERROR(-20001, 'zero amount entries are not posted');
    END IF;
    INSERT INTO ledger.entries (account_id, amount, memo)
      VALUES (p_account_id, p_amount, p_memo)
      RETURNING entry_id INTO p_entry_id;
    COMMIT;
  END post_entry;

  FUNCTION balance_of(p_account_id IN VARCHAR2) RETURN NUMBER IS
    l_balance NUMBER;
  BEGIN
    SELECT SUM(amount) INTO l_balance
      FROM ledger.entries
     WHERE account_id = p_account_id;
    RETURN NVL(l_balance, 0);
  END balance_of;

  PROCEDURE open_entries(
    p_account_id IN  VARCHAR2,
    p_rows       OUT SYS_REFCURSOR
  ) IS
  BEGIN
    OPEN p_rows FOR
      SELECT entry_id, amount, memo
        FROM ledger.entries
       WHERE account_id = p_account_id;
  END open_entries;

  PROCEDURE audit_touch(p_account_id IN VARCHAR2) IS
    PRAGMA AUTONOMOUS_TRANSACTION;
  BEGIN
    INSERT INTO ledger.audit_log (account_id, touched_at)
      VALUES (p_account_id, SYSTIMESTAMP);
    COMMIT;
  END audit_touch;

END pkg_ledger;
/
