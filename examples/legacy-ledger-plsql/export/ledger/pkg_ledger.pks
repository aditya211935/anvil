-- Synthetic fixture: public interface of a journal-posting package.
-- Nothing here is production code; the shapes are chosen to exercise
-- `anvil legacy inventory --collector database`.
CREATE OR REPLACE PACKAGE ledger.pkg_ledger AS

  -- Posts one journal entry and returns its surrogate key.
  PROCEDURE post_entry(
    p_account_id IN  VARCHAR2,
    p_amount     IN  NUMBER,
    p_memo       IN  VARCHAR2 DEFAULT NULL,
    p_entry_id   OUT NUMBER
  );

  -- Current balance for one account.
  FUNCTION balance_of(p_account_id IN VARCHAR2) RETURN NUMBER;

  -- Open entries as a cursor the caller must fetch and close.
  PROCEDURE open_entries(
    p_account_id IN  VARCHAR2,
    p_rows       OUT SYS_REFCURSOR
  );

  -- Audit touch that must survive the caller's rollback.
  PROCEDURE audit_touch(p_account_id IN VARCHAR2);

END pkg_ledger;
/
