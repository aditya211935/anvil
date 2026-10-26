-- Synthetic fixture: the same posting capability as T-SQL. The procedure
-- also selects a row back; DDL cannot prove that result set's shape, so the
-- inventory claims only the OUTPUT parameter.
CREATE OR ALTER PROCEDURE [dbo].[usp_PostEntry]
  @AccountId  INT,
  @Amount     DECIMAL(18,2),
  @Memo       NVARCHAR(200) = NULL,
  @EntryId    BIGINT OUTPUT
AS
BEGIN
  SET NOCOUNT ON;
  IF @Amount = 0
  BEGIN
    RAISERROR(50001, 16, 1);
    RETURN 1;
  END

  BEGIN TRANSACTION;
  INSERT INTO dbo.Entries (AccountId, Amount, Memo)
    VALUES (@AccountId, @Amount, @Memo);
  SET @EntryId = SCOPE_IDENTITY();
  COMMIT TRANSACTION;

  SELECT EntryId, AccountId, Amount FROM dbo.Entries WHERE EntryId = @EntryId;
END
GO
