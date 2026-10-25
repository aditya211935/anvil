000100*================================================================*
000200*  CUSTREC - synthetic customer master record (fixed length)     *
000300*================================================================*
000400 01  CUST-REC.
000500     05  CUST-ID             PIC 9(8).
000600     05  CUST-NAME           PIC X(30).
000700     05  CUST-STATUS         PIC X.
000800         88  CUST-ACTIVE     VALUE 'A'.
000900         88  CUST-CLOSED     VALUE 'C'.
001000     05  CUST-BALANCE        PIC S9(7)V99 COMP-3.
001100     05  CUST-CREDIT-LIMIT   PIC S9(9) COMP.
001200     05  CUST-OPEN-DATE.
001300         10  CUST-OPEN-YYYY  PIC 9(4).
001400         10  CUST-OPEN-MM    PIC 99.
001500         10  CUST-OPEN-DD    PIC 99.
001600     05  CUST-OPEN-DATE-X    REDEFINES CUST-OPEN-DATE PIC X(8).
001700     05  CUST-PHONES         OCCURS 3 TIMES.
001800         10  CUST-PHONE-TYPE PIC X(2).
001900         10  CUST-PHONE-NUM  PIC X(10).
002000     05  FILLER              PIC X(4).
002100     05  CUST-NOTE-COUNT     PIC 9(2).
002200     05  CUST-NOTES          OCCURS 0 TO 10 TIMES
002300                             DEPENDING ON CUST-NOTE-COUNT
002400                             PIC X(20).
002500 66  CUST-KEY RENAMES CUST-ID THRU CUST-NAME.
