import { describe, expect, it } from "vitest";
import { collectLegacyInventory, type LegacySourceMember } from "./inventory.js";

const encoder = new TextEncoder();

function member(path: string, content: string): LegacySourceMember {
  return { path, bytes: encoder.encode(content) };
}

const JOB = `//PAYROLL1 JOB (ACCT123),'NIGHTLY PAYROLL',CLASS=A
//         JCLLIB ORDER=PROD.PROCLIB
//EXTRACT  EXEC PGM=PAYEXTR,PARM='FULL'
//EMPMAST  DD DSN=PROD.PAYROLL.EMPMAST,DISP=SHR
//CUSTREC  DD DSN=PROD.COPYLIB(CUSTREC),DISP=SHR
//SYSIN    DD *
SECRET IN-STREAM RECORD
/*
//CALC     EXEC PGM=PAYCALC,COND=(4,LT,EXTRACT)
//RESULTS  DD DSN=PROD.PAYROLL.RESULTS,DISP=(NEW,CATLG,DELETE)
//REPORT   EXEC PAYRPT
//
`;

const PROC = `//PAYRPT   PROC
//RPT      EXEC PGM=PAYRPT01
//ARCHIVE  DD DSN=PROD.PAYROLL.ARCHIVE,DISP=MOD
//         PEND
`;

const COPYBOOK = `       01  CUST-REC.\n           05  CUST-ID   PIC 9(8).\n`;

const EJB_JAR = `<ejb-jar><enterprise-beans><session>
  <ejb-name>RefundBean</ejb-name><remote>com.acme.Refunds</remote>
</session></enterprise-beans></ejb-jar>`;

function inventory(members: LegacySourceMember[], collector?: "auto" | "mainframe") {
  return collectLegacyInventory({
    estate: { id: "payroll-prod" },
    environment: "prod",
    application: "payroll",
    source: { kind: "source_repository", systemId: "git-payroll", revision: "abc123" },
    ...(collector ? { collector } : {}),
    members,
  });
}

describe("mainframe inventory lane", () => {
  it("yields batch_job candidates with declared claims and never asserts idempotency", () => {
    const result = inventory(
      [
        member("JCL/PAYROLL1.jcl", JOB),
        member("PROCLIB/PAYRPT.proc", PROC),
        member("COPYLIB/CUSTREC.cpy", COPYBOOK),
      ],
      "mainframe",
    );

    expect(result.collectors).toEqual([
      { collector: "mainframe", inputMembers: 3, observations: 2, diagnostics: 0 },
    ]);
    expect(
      result.snapshot.artifacts
        .map((artifact) => [artifact.path, artifact.role])
        .sort(([left], [right]) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual([
      ["COPYLIB/CUSTREC.cpy", "schema"],
      ["JCL/PAYROLL1.jcl", "runtime_configuration"],
      ["PROCLIB/PAYRPT.proc", "runtime_configuration"],
    ]);
    expect(result.candidates).toHaveLength(2);
    const job = result.candidates.find(
      (candidate) =>
        candidate.invocation.kind === "batch_job" && candidate.invocation.job === "PAYROLL1",
    );
    expect(job?.invocation).toEqual({
      kind: "batch_job",
      schedulerRef: "jcllib:PROD.PROCLIB",
      job: "PAYROLL1",
    });
    expect(job?.coordinate).toMatchObject({ platform: "zos-jcl", component: "PAYROLL1" });
    const claim = (dimension: string) =>
      job?.claims.find((candidate) => candidate.dimension === dimension);
    expect(claim("technical_name")?.assertions[0]).toMatchObject({
      value: "PAYROLL1",
      bases: ["declared"],
    });
    expect(claim("binding_target")?.assertions[0]?.value).toEqual([
      "001:EXTRACT:PGM=PAYEXTR",
      "002:CALC:PGM=PAYCALC",
      "003:REPORT:PROC=PAYRPT",
    ]);
    expect(claim("input_schema")?.assertions[0]?.value).toEqual([
      "copybook:COPYLIB/CUSTREC.cpy",
      "dsn:PROD.COPYLIB(CUSTREC)",
      "dsn:PROD.PAYROLL.EMPMAST",
    ]);
    expect(claim("output_schema")?.assertions[0]?.value).toEqual(["dsn:PROD.PAYROLL.RESULTS"]);
    expect(claim("interaction_pattern")?.assertions[0]?.value).toBe("batch");
    expect(claim("error_semantics")?.assertions[0]?.value).toEqual(["CALC COND=(4,LT,EXTRACT)"]);
    expect(claim("idempotency")).toBeUndefined();
    expect(job?.businessSemantics).toBe("unknown");
    expect(job?.disposition).toBe("triage");
    for (const candidate of result.candidates) {
      expect(["triage", "review_required"]).toContain(candidate.disposition);
    }

    const procedure = result.candidates.find(
      (candidate) =>
        candidate.invocation.kind === "batch_job" && candidate.invocation.job === "PAYRPT",
    );
    expect(procedure?.invocation).toEqual({
      kind: "batch_job",
      schedulerRef: "proclib",
      job: "PAYRPT",
    });
    expect(procedure?.coordinate.module).toBe("proclib");

    const copybookArtifact = result.snapshot.artifacts.find((artifact) =>
      artifact.path.endsWith(".cpy"),
    );
    expect(
      result.snapshot.evidence.some(
        (evidence) => evidence.artifactId === copybookArtifact?.artifactId,
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET IN-STREAM");
  });

  it("runs both the Java EE and mainframe lanes in auto mode", () => {
    const result = inventory([
      member("batch/PAYROLL1.jcl", JOB),
      member("refunds/META-INF/ejb-jar.xml", EJB_JAR),
    ]);
    expect(result.collectors.map((run) => run.collector)).toEqual(["java-ee", "mainframe"]);
    expect(result.candidates.map((candidate) => candidate.invocation.kind).sort()).toEqual([
      "batch_job",
      "remote_method",
    ]);
  });

  it("recognizes a JOB card in auto mode without a known extension and surfaces refusals", () => {
    const result = inventory([
      member("members/PAYROLL1", JOB),
      member(
        "members/FTPJOB.jcl",
        "//FTPJOB JOB (A),'X',USER=OPER,PASSWORD=SECRET1\n//S1 EXEC PGM=FTP\n",
      ),
    ]);
    expect(result.collectors[0]).toMatchObject({ collector: "mainframe", inputMembers: 2 });
    expect(result.candidates.map((candidate) => candidate.invocation)).toEqual([
      { kind: "batch_job", schedulerRef: "jcllib:PROD.PROCLIB", job: "PAYROLL1" },
    ]);
    expect(result.snapshot.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "legacy/mainframe/secret_like_value",
        collectorId: "mainframe",
      }),
    );
    expect(JSON.stringify(result)).not.toContain("SECRET1");
  });

  it("is deterministic across member order", () => {
    const members = [
      member("JCL/PAYROLL1.jcl", JOB),
      member("PROCLIB/PAYRPT.proc", PROC),
      member("COPYLIB/CUSTREC.cpy", COPYBOOK),
    ];
    const forward = inventory(members, "mainframe");
    const reversed = inventory([...members].reverse(), "mainframe");
    expect(reversed.snapshot.inventoryId).toBe(forward.snapshot.inventoryId);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });
});
