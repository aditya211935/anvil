import { describe, expect, it } from "vitest";
import { collectMainframeLegacy } from "./collector.js";
import { parseJcl, resolveSymbols, splitOperands } from "./jcl.js";

const JOB = `//PAYROLL1 JOB (ACCT123),'NIGHTLY PAYROLL',CLASS=A,MSGCLASS=X,
//             NOTIFY=&SYSUID,REGION=0M
//*
//* Nightly payroll: extract, calculate, report
//*
//         JCLLIB ORDER=(PROD.PROCLIB,TEST.PROCLIB)
//         SET ENV=PROD
//JOBLIB   DD DSN=&ENV..LOADLIB,DISP=SHR
//EXTRACT  EXEC PGM=PAYEXTR,PARM='FULL,2024Q4'
//EMPMAST  DD DSN=PROD.PAYROLL.EMPMAST,DISP=SHR
//CUSTREC  DD DSN=PROD.COPYLIB(CUSTREC),DISP=SHR
//EXTRACT  DD DSN=&&EXTRACT,DISP=(NEW,PASS,DELETE),
//            UNIT=SYSDA,SPACE=(CYL,(10,5)),
//            DCB=(RECFM=FB,LRECL=200,BLKSIZE=0)
//SYSIN    DD *
SELECT ALL WHERE DEPT = 'FIN'
TOP-SECRET-DATA-LINE
/*
//SYSOUT   DD SYSOUT=*
//CALC     EXEC PGM=PAYCALC,COND=(4,LT,EXTRACT)
//EXTRACT  DD DSN=&&EXTRACT,DISP=(OLD,DELETE)
//RATES    DD DSN=PROD.PAYROLL.RATES,DISP=OLD
//         DD DSN=PROD.PAYROLL.RATES.OVERRIDE,DISP=SHR
//RESULTS  DD DSN=PROD.PAYROLL.RESULTS.G0001V00,
//            DISP=(NEW,CATLG,DELETE),UNIT=SYSDA,SPACE=(CYL,(50,10))
//         IF (CALC.RC > 4) THEN
//REPORT   EXEC PAYRPT,RPTCLASS=X
//RESULTS  DD DSN=PROD.PAYROLL.RESULTS.G0001V00,DISP=MOD
//         ENDIF
//
`;

const PROC = `//PAYRPT   PROC RPTCLASS=A
//RPT      EXEC PGM=PAYRPT01
//STEPLIB  DD DSN=PROD.LOADLIB,DISP=SHR
//REPORT   DD SYSOUT=&RPTCLASS
//ARCHIVE  DD DSN=PROD.PAYROLL.ARCHIVE,DISP=MOD
//         PEND
`;

const COPYBOOK = `       01  CUST-REC.
           05  CUST-ID        PIC 9(8).
           05  CUST-NAME      PIC X(30).
`;

describe("mainframe legacy collector", () => {
  it("reads a JOB with continuation lines, a PROC call, DISP variants, COND, and in-stream data", () => {
    const result = collectMainframeLegacy([
      { path: "jcl/PAYROLL1.jcl", bytes: JOB },
      { path: "proclib/PAYRPT.proc", bytes: PROC },
      { path: "copylib/CUSTREC.cpy", bytes: COPYBOOK },
    ]);

    expect(result.collector).toEqual({ kind: "mainframe", schemaVersion: 1 });
    expect(result.evidence.map((evidence) => evidence.role)).toEqual([
      "copybook",
      "jcl_job",
      "jcl_procedure",
    ]);
    expect(result.observations).toHaveLength(2);

    const job = result.observations.find((observation) => observation.kind === "job");
    expect(job).toMatchObject({
      name: "PAYROLL1",
      schedulerRef: "jcllib:PROD.PROCLIB,TEST.PROCLIB",
      symbols: { ENV: "PROD" },
      conditions: ["(CALC.RC > 4)"],
      confidence: "declared",
    });
    expect(job?.libraryDatasets).toEqual([
      expect.objectContaining({ ddName: "JOBLIB", dsn: "PROD.LOADLIB", direction: "input" }),
    ]);
    expect(job?.steps.map((step) => [step.name, step.program ?? step.procedure])).toEqual([
      ["EXTRACT", "PAYEXTR"],
      ["CALC", "PAYCALC"],
      ["REPORT", "PAYRPT"],
    ]);
    const [extract, calc, report] = job?.steps ?? [];
    expect(extract?.parm).toBe("FULL,2024Q4");
    expect(extract?.datasets).toEqual([
      expect.objectContaining({
        ddName: "EMPMAST",
        dsn: "PROD.PAYROLL.EMPMAST",
        direction: "input",
      }),
      expect.objectContaining({
        ddName: "CUSTREC",
        dsn: "PROD.COPYLIB(CUSTREC)",
        copybookPath: "copylib/CUSTREC.cpy",
      }),
      expect.objectContaining({ ddName: "EXTRACT", dsn: "&&EXTRACT", direction: "output" }),
      expect.objectContaining({ ddName: "SYSIN", inStream: true, direction: "unknown" }),
      expect.objectContaining({ ddName: "SYSOUT", direction: "unknown" }),
    ]);
    expect(calc?.cond).toBe("(4,LT,EXTRACT)");
    expect(
      calc?.datasets.map((dataset) => [dataset.ddName, dataset.dsn, dataset.direction]),
    ).toEqual([
      ["EXTRACT", "&&EXTRACT", "input"],
      ["RATES", "PROD.PAYROLL.RATES", "input"],
      ["RATES", "PROD.PAYROLL.RATES.OVERRIDE", "input"],
      ["RESULTS", "PROD.PAYROLL.RESULTS.G0001V00", "output"],
    ]);
    expect(report?.procedure).toBe("PAYRPT");
    expect(report?.datasets[0]).toMatchObject({ disposition: "MOD", direction: "output" });

    const procedure = result.observations.find((observation) => observation.kind === "procedure");
    expect(procedure).toMatchObject({
      name: "PAYRPT",
      schedulerRef: "proclib",
      inStreamProcedure: false,
    });
    expect(procedure?.steps[0]?.program).toBe("PAYRPT01");
    expect(procedure?.steps[0]?.datasets.map((dataset) => dataset.ddName)).toEqual([
      "STEPLIB",
      "REPORT",
      "ARCHIVE",
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "mainframe/copybook_recorded",
    );
  });

  it("never records in-stream data content", () => {
    const result = collectMainframeLegacy([{ path: "jcl/PAYROLL1.jcl", bytes: JOB }]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("TOP-SECRET-DATA-LINE");
    expect(serialized).not.toContain("SELECT ALL");
    const parsed = parseJcl(JOB, "jcl/PAYROLL1.jcl");
    expect(parsed.inStreamRecords).toBe(2);
    expect(JSON.stringify(parsed)).not.toContain("TOP-SECRET");
  });

  it("refuses members that carry password operands", () => {
    const result = collectMainframeLegacy([
      {
        path: "jcl/FTPJOB.jcl",
        bytes: `//FTPJOB   JOB (ACCT),'FTP',CLASS=A,USER=OPER1,PASSWORD=HUNTER2\n//STEP1    EXEC PGM=FTP\n`,
      },
      {
        path: "jcl/OK.jcl",
        bytes: `//OKJOB    JOB (ACCT),'OK',CLASS=A\n//STEP1    EXEC PGM=IEFBR14\n`,
      },
    ]);
    expect(result.observations.map((observation) => observation.name)).toEqual(["OKJOB"]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "mainframe/secret_like_value",
        coordinate: { origin: "jcl/FTPJOB.jcl" },
      }),
    );
    expect(JSON.stringify(result)).not.toContain("HUNTER2");
  });

  it("records in-stream procedures, includes, implicit procedures, and unknown statements", () => {
    const result = collectMainframeLegacy([
      {
        path: "jcl/INSTREAM.jcl",
        bytes: `//INSTRM   JOB (ACCT),'IN-STREAM PROC'
//         INCLUDE MEMBER=STDLIBS
//CLEANUP  PROC
//DEL      EXEC PGM=IEFBR14
//GONE     DD DSN=PROD.TEMP.FILE,DISP=(MOD,DELETE,DELETE)
//         PEND
//RUN      EXEC CLEANUP
//         FROBNICATE X=1
`,
      },
      {
        path: "proclib/NOHDR.proc",
        bytes: `//STEP1    EXEC PGM=IDCAMS\n//SYSIN    DD DATA,DLM=@@\n//THIS IS DATA\n@@\n`,
      },
    ]);
    const names = result.observations.map(
      (observation) => `${observation.kind}:${observation.name}`,
    );
    expect(names).toEqual(["job:INSTRM", "procedure:CLEANUP", "procedure:NOHDR"]);
    const inStream = result.observations.find((observation) => observation.name === "CLEANUP");
    expect(inStream?.inStreamProcedure).toBe(true);
    expect(inStream?.steps[0]?.datasets[0]).toMatchObject({
      disposition: "MOD",
      direction: "output",
    });
    const job = result.observations.find((observation) => observation.name === "INSTRM");
    expect(job?.includes).toEqual(["STDLIBS"]);
    expect(job?.steps.map((step) => step.procedure)).toEqual(["CLEANUP"]);
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "mainframe/include_not_followed",
        "mainframe/unknown_statement",
        "mainframe/implicit_procedure",
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("THIS IS DATA");
  });

  it("is deterministic regardless of input order", () => {
    const inputs = [
      { path: "jcl/PAYROLL1.jcl", bytes: JOB },
      { path: "proclib/PAYRPT.proc", bytes: PROC },
      { path: "copylib/CUSTREC.cpy", bytes: COPYBOOK },
    ];
    const forward = collectMainframeLegacy(inputs);
    const reversed = collectMainframeLegacy([...inputs].reverse());
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it("reports members with no job, bounds columns, and refuses non-UTF-8 bytes", () => {
    const result = collectMainframeLegacy([
      { path: "jcl/EMPTY.jcl", bytes: "//* only a comment\n" },
      { path: "jcl/WIDE.jcl", bytes: `//WIDE     JOB (ACCT),'W'${" ".repeat(60)}00000010EXTRA\n` },
      { path: "jcl/EBCDIC.jcl", bytes: new Uint8Array([0xc1, 0xc2, 0xff, 0xfe]) },
    ]);
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("mainframe/no_discoverable_job");
    expect(codes).toContain("mainframe/column_overflow");
    expect(codes).toContain("mainframe/non_utf8_artifact");
    expect(result.observations.map((observation) => observation.name)).toEqual(["WIDE"]);
  });
});

describe("JCL operand helpers", () => {
  it("splits operands with nested parentheses and quoted commas", () => {
    const operands = splitOperands("PGM=X,PARM='A,B',COND=((4,LT,S1),EVEN),DISP=(NEW,CATLG)");
    expect(operands.keywords.get("PARM")).toBe("'A,B'");
    expect(operands.keywords.get("COND")).toBe("((4,LT,S1),EVEN)");
    expect(operands.keywords.get("DISP")).toBe("(NEW,CATLG)");
  });

  it("resolves only same-member SET symbols and keeps temporary names verbatim", () => {
    const symbols = new Map([["ENV", "PROD"]]);
    expect(resolveSymbols("&ENV..LOADLIB", symbols)).toBe("PROD.LOADLIB");
    expect(resolveSymbols("&&TEMP", symbols)).toBe("&&TEMP");
    expect(resolveSymbols("&SYSUID.X", symbols)).toBe("&SYSUID.X");
  });
});
