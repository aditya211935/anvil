import { describe, expect, it } from "vitest";
import { convertCopybook } from "./copybook.js";
import { parseCopybook } from "./copybook-parse.js";

const FIXED = `000100 01  CUST-REC.
000200     05  CUST-ID             PIC 9(8).
000300     05  CUST-NAME           PIC X(30).
000400     05  CUST-STATUS         PIC X.
000500         88  CUST-ACTIVE     VALUE 'A'.
000600         88  CUST-CLOSED     VALUE 'C'.
000700     05  CUST-BALANCE        PIC S9(7)V99 COMP-3.
000800     05  CUST-CREDIT-LIMIT   PIC S9(9) COMP.
000900     05  CUST-OPEN-DATE.
001000         10  CUST-OPEN-YYYY  PIC 9(4).
001100         10  CUST-OPEN-MM    PIC 99.
001200         10  CUST-OPEN-DD    PIC 99.
001300     05  CUST-OPEN-DATE-X    REDEFINES CUST-OPEN-DATE PIC X(8).
001400     05  CUST-PHONES         OCCURS 3 TIMES.
001500         10  CUST-PHONE-TYPE PIC X(2).
001600         10  CUST-PHONE-NUM  PIC X(10).
001700     05  FILLER              PIC X(4).
001800     05  CUST-NOTE-COUNT     PIC 9(2).
001900     05  CUST-NOTES          OCCURS 0 TO 10 TIMES
002000                             DEPENDING ON CUST-NOTE-COUNT
002100                             PIC X(20).
002200     05  CUST-SIGNED-SEP     PIC S9(5) SIGN LEADING SEPARATE.
002300     05  CUST-RATE           PIC 9(3)V9(4).
002400     05  CUST-BIG-ID         PIC 9(18).
002500     05  CUST-TYPE           PIC X(2) VALUE 'RT'.
002600     05  CUST-COUNT          PIC 9(3) VALUE ZERO.
002700 66  CUST-KEY RENAMES CUST-ID THRU CUST-NAME.
`;

const FREE = `01 CUST-REC.
    05 CUST-ID PIC 9(8).
    05 CUST-NAME PIC X(30).
    05 CUST-STATUS PIC X.
        88 CUST-ACTIVE VALUE 'A'.
        88 CUST-CLOSED VALUE 'C'.
    05 CUST-BALANCE PIC S9(7)V99 COMP-3.
    05 CUST-CREDIT-LIMIT PIC S9(9) COMP.
    05 CUST-OPEN-DATE.
        10 CUST-OPEN-YYYY PIC 9(4).
        10 CUST-OPEN-MM PIC 99.
        10 CUST-OPEN-DD PIC 99.
    05 CUST-OPEN-DATE-X REDEFINES CUST-OPEN-DATE PIC X(8).
    05 CUST-PHONES OCCURS 3 TIMES.
        10 CUST-PHONE-TYPE PIC X(2).
        10 CUST-PHONE-NUM PIC X(10).
    05 FILLER PIC X(4).
    05 CUST-NOTE-COUNT PIC 9(2).
    05 CUST-NOTES OCCURS 0 TO 10 TIMES DEPENDING ON CUST-NOTE-COUNT PIC X(20).
    05 CUST-SIGNED-SEP PIC S9(5) SIGN LEADING SEPARATE.
    05 CUST-RATE PIC 9(3)V9(4).
    05 CUST-BIG-ID PIC 9(18).
    05 CUST-TYPE PIC X(2) VALUE 'RT'.
    05 CUST-COUNT PIC 9(3) VALUE ZERO.
66 CUST-KEY RENAMES CUST-ID THRU CUST-NAME.
`;

// biome-ignore lint/suspicious/noExplicitAny: test-only view of the projected JSON Schema
type Schema = Record<string, any>;

function property(schema: Schema | undefined, name: string): Schema {
  const value = (schema?.properties as Record<string, Schema> | undefined)?.[name];
  if (!value) throw new Error(`missing property ${name}`);
  return value;
}

describe("copybook to JSON Schema", () => {
  it("projects a realistic fixed-format record with verbatim names, offsets, and declarations", () => {
    const result = convertCopybook({ path: "copylib/CUSTREC.cpy", bytes: FIXED });
    const schema = result.schema as Schema;

    expect(result.diagnostics.filter((d) => d.level === "error")).toEqual([]);
    expect(result.itemCount).toBe(25);
    expect(result.source).toMatchObject({ path: "copylib/CUSTREC.cpy", format: "fixed" });
    expect(schema).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "CUST-REC",
      type: "object",
      additionalProperties: false,
    });
    expect(schema.required).toEqual([
      "CUST-ID",
      "CUST-NAME",
      "CUST-STATUS",
      "CUST-BALANCE",
      "CUST-CREDIT-LIMIT",
      "CUST-OPEN-DATE",
      "CUST-PHONES",
      "CUST-NOTE-COUNT",
      "CUST-NOTES",
      "CUST-SIGNED-SEP",
      "CUST-RATE",
      "CUST-BIG-ID",
      "CUST-TYPE",
      "CUST-COUNT",
    ]);
    expect(Object.keys(schema.properties)).toEqual(schema.required);
    expect(schema["x-anvil-cobol"]).toMatchObject({
      level: 1,
      name: "CUST-REC",
      byteLength: 334,
      offset: 0,
      source: { path: "copylib/CUSTREC.cpy", format: "fixed", items: 25 },
      renames: [{ name: "CUST-KEY", from: "CUST-ID", thru: "CUST-NAME", line: 27 }],
      fillers: [{ level: 5, offset: 92, byteLength: 4, declaration: "05 FILLER PIC X(4)" }],
    });

    expect(property(schema, "CUST-ID")).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 99999999,
      "x-anvil-cobol": {
        level: 5,
        offset: 0,
        byteLength: 8,
        picture: "9(8)",
        usage: "DISPLAY",
        digits: 8,
        scale: 0,
        signed: false,
        declaration: "05 CUST-ID PIC 9(8)",
        line: 2,
      },
    });
    expect(property(schema, "CUST-NAME")).toMatchObject({
      type: "string",
      maxLength: 30,
      "x-anvil-cobol": { offset: 8, byteLength: 30 },
    });
    expect(property(schema, "CUST-STATUS")).toMatchObject({
      type: "string",
      maxLength: 1,
      enum: ["A", "C"],
      "x-anvil-cobol": {
        offset: 38,
        conditions: [
          { name: "CUST-ACTIVE", values: [{ from: { kind: "string", value: "A" } }] },
          { name: "CUST-CLOSED", values: [{ from: { kind: "string", value: "C" } }] },
        ],
      },
    });
    expect(property(schema, "CUST-BALANCE")).toMatchObject({
      type: "number",
      multipleOf: 0.01,
      minimum: -9999999.99,
      maximum: 9999999.99,
      "x-anvil-cobol": {
        offset: 39,
        byteLength: 5,
        usage: "COMP-3",
        digits: 9,
        scale: 2,
        signed: true,
      },
    });
    expect(property(schema, "CUST-CREDIT-LIMIT")).toMatchObject({
      type: "integer",
      minimum: -999999999,
      maximum: 999999999,
      "x-anvil-cobol": { offset: 44, byteLength: 4, usage: "COMP" },
    });

    const openDate = property(schema, "CUST-OPEN-DATE");
    expect(openDate.oneOf).toHaveLength(2);
    expect(openDate.oneOf[0]).toMatchObject({
      title: "CUST-OPEN-DATE",
      type: "object",
      required: ["CUST-OPEN-YYYY", "CUST-OPEN-MM", "CUST-OPEN-DD"],
      "x-anvil-cobol": { offset: 48, byteLength: 8, usage: "GROUP" },
    });
    expect(openDate.oneOf[0].properties["CUST-OPEN-DD"]["x-anvil-cobol"]).toMatchObject({
      offset: 54,
      byteLength: 2,
    });
    expect(openDate.oneOf[1]).toMatchObject({
      title: "CUST-OPEN-DATE-X",
      type: "string",
      maxLength: 8,
      "x-anvil-cobol": { offset: 48, byteLength: 8, redefines: "CUST-OPEN-DATE" },
    });
    expect(schema["x-anvil-cobol"].redefines).toEqual([
      { name: "CUST-OPEN-DATE-X", redefines: "CUST-OPEN-DATE", offset: 48, byteLength: 8 },
    ]);

    expect(property(schema, "CUST-PHONES")).toMatchObject({
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        required: ["CUST-PHONE-TYPE", "CUST-PHONE-NUM"],
      },
      "x-anvil-cobol": {
        offset: 56,
        byteLength: 12,
        totalByteLength: 36,
        occurs: { min: 3, max: 3 },
      },
    });
    expect(property(schema, "CUST-NOTE-COUNT")["x-anvil-cobol"]).toMatchObject({ offset: 96 });
    expect(property(schema, "CUST-NOTES")).toMatchObject({
      type: "array",
      minItems: 0,
      maxItems: 10,
      items: { type: "string", maxLength: 20 },
      "x-anvil-cobol": {
        offset: 98,
        byteLength: 20,
        totalByteLength: 200,
        occurs: { min: 0, max: 10, dependingOn: "CUST-NOTE-COUNT" },
      },
    });
    expect(property(schema, "CUST-SIGNED-SEP")).toMatchObject({
      type: "integer",
      minimum: -99999,
      maximum: 99999,
      "x-anvil-cobol": {
        offset: 298,
        byteLength: 6,
        sign: { position: "LEADING", separate: true },
      },
    });
    expect(property(schema, "CUST-RATE")).toMatchObject({
      type: "number",
      multipleOf: 0.0001,
      minimum: 0,
      maximum: 999.9999,
      "x-anvil-cobol": { offset: 304, byteLength: 7 },
    });
    expect(property(schema, "CUST-BIG-ID")).toMatchObject({
      type: "string",
      pattern: "^[0-9]{1,18}$",
      "x-anvil-cobol": { offset: 311, byteLength: 18, digits: 18 },
    });
    expect(property(schema, "CUST-TYPE")).toMatchObject({
      default: "RT",
      "x-anvil-cobol": { offset: 329, value: { kind: "string", value: "RT" } },
    });
    const count = property(schema, "CUST-COUNT");
    expect(count.default).toBeUndefined();
    expect(count["x-anvil-cobol"].value).toEqual({ kind: "figurative", value: "ZERO" });

    const layout = schema["x-anvil-cobol"].layout as Schema[];
    expect(layout[0]).toMatchObject({ path: "CUST-REC", offset: 0, byteLength: 334 });
    expect(
      layout.find((entry) => entry.path === "CUST-REC.CUST-PHONES.CUST-PHONE-NUM"),
    ).toMatchObject({ offset: 58, byteLength: 10 });
    expect(layout.find((entry) => entry.path === "CUST-REC.FILLER#9")).toMatchObject({
      offset: 92,
      byteLength: 4,
    });
    expect(JSON.stringify(schema)).not.toMatch(/custId|cust_id/);
  });

  it("reads the same record in free format", () => {
    const fixed = convertCopybook({ path: "CUSTREC.cpy", bytes: FIXED });
    const free = convertCopybook({ path: "CUSTREC.cpy", bytes: FREE });
    expect(free.source.format).toBe("free");
    expect(fixed.source.format).toBe("fixed");
    const strip = (value: unknown): unknown =>
      JSON.parse(
        JSON.stringify(value, (key, inner) =>
          key === "line" || key === "source" || key === "declaration" ? undefined : inner,
        ),
      );
    expect(strip(free.schema)).toEqual(strip(fixed.schema));
    expect((free.schema as Schema)["x-anvil-cobol"].byteLength).toBe(334);
  });

  it("is deterministic", () => {
    const first = convertCopybook({ path: "CUSTREC.cpy", bytes: FIXED });
    const second = convertCopybook({ path: "CUSTREC.cpy", bytes: FIXED });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const changed = convertCopybook({
      path: "CUSTREC.cpy",
      bytes: FIXED.replace("X(30)", "X(31)"),
    });
    expect(changed.contentHash).not.toBe(first.contentHash);
  });

  it("reports COPY statements without following them", () => {
    const result = convertCopybook({
      path: "WRAP.cpy",
      bytes: `       01  WRAP-REC.\n           COPY CUSTREC.\n           05  WRAP-TAIL PIC X(2).\n`,
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "warning",
        code: "legacy/copybook/copy_not_followed",
        line: 2,
      }),
    );
    expect((result.schema as Schema)["x-anvil-cobol"].byteLength).toBe(2);
  });

  it("handles usage variants, P scaling, edited pictures, and multiple records", () => {
    const result = convertCopybook({
      path: "MIX.cpy",
      bytes: `       01  REC-A.
           05  A-BIN-SMALL  PIC 9(4) COMP-5.
           05  A-BIN-LARGE  PIC S9(18) BINARY.
           05  A-FLOAT      COMP-1.
           05  A-DOUBLE     COMP-2.
           05  A-SCALED     PIC 9(3)P(3).
           05  A-EDITED     PIC ZZ,ZZ9.99-.
           05  A-PACKED     PIC S9(5)V9(3) PACKED-DECIMAL.
           05  A-GROUP-COMP COMP-3.
               10  A-INHERIT PIC S9(3).
           05  A-BLANK      PIC 9(5) BLANK WHEN ZERO JUSTIFIED RIGHT.
       01  REC-B REDEFINES REC-A.
           05  B-RAW        PIC X(40).
       77  COUNTER         PIC 9(2) VALUE 7.
`,
    });
    const schema = result.schema as Schema;
    expect(result.diagnostics.filter((d) => d.level === "error")).toEqual([]);
    expect(schema.title).toBe("REC-A");
    expect(Object.keys(schema.properties)).toEqual(["REC-A", "REC-B", "COUNTER"]);
    expect(schema.required).toEqual(["REC-A", "COUNTER"]);
    expect(schema["x-anvil-cobol"].records).toEqual([
      { name: "REC-A", level: 1, byteLength: 47 },
      { name: "REC-B", level: 1, byteLength: 40, redefines: "REC-A" },
      { name: "COUNTER", level: 77, byteLength: 2 },
    ]);
    const recA = property(schema, "REC-A");
    expect(property(recA, "A-BIN-SMALL")["x-anvil-cobol"]).toMatchObject({
      byteLength: 2,
      usage: "COMP-5",
    });
    expect(property(recA, "A-BIN-LARGE")).toMatchObject({
      type: "string",
      pattern: "^-?[0-9]{1,18}$",
      "x-anvil-cobol": { byteLength: 8, usage: "COMP", offset: 2 },
    });
    expect(property(recA, "A-FLOAT")).toMatchObject({
      type: "number",
      "x-anvil-cobol": { byteLength: 4, usage: "COMP-1", offset: 10 },
    });
    expect(property(recA, "A-DOUBLE")["x-anvil-cobol"]).toMatchObject({
      byteLength: 8,
      offset: 14,
    });
    expect(property(recA, "A-SCALED")).toMatchObject({
      type: "integer",
      multipleOf: 1000,
      maximum: 999000,
      "x-anvil-cobol": { byteLength: 3, offset: 22, scalingPositions: 3 },
    });
    expect(property(recA, "A-EDITED")).toMatchObject({
      type: "string",
      maxLength: 10,
      "x-anvil-cobol": { byteLength: 10, offset: 25, category: "numeric_edited" },
    });
    expect(property(recA, "A-PACKED")).toMatchObject({
      type: "number",
      multipleOf: 0.001,
      "x-anvil-cobol": { byteLength: 5, offset: 35, usage: "COMP-3" },
    });
    expect(property(property(recA, "A-GROUP-COMP"), "A-INHERIT")["x-anvil-cobol"]).toMatchObject({
      byteLength: 2,
      usage: "COMP-3",
      offset: 40,
    });
    expect(property(recA, "A-BLANK")["x-anvil-cobol"]).toMatchObject({
      blankWhenZero: true,
      justified: true,
      offset: 42 - 5 + 5,
    });
    expect(property(schema, "COUNTER")).toMatchObject({ type: "integer", default: 7 });
  });

  it("refuses hostile input without throwing", () => {
    const empty = convertCopybook({ path: "EMPTY.cpy", bytes: "" });
    expect(empty.schema).toBeUndefined();
    expect(empty.diagnostics).toContainEqual(
      expect.objectContaining({ level: "error", code: "legacy/copybook/no_items" }),
    );

    const binary = convertCopybook({
      path: "BIN.cpy",
      bytes: new Uint8Array([0x00, 0xff, 0xfe, 0x01, 0x30]),
    });
    expect(binary.schema).toBeUndefined();
    expect(binary.diagnostics[0]?.code).toBe("legacy/copybook/non_utf8");

    const nul = convertCopybook({ path: "NUL.cpy", bytes: "01 REC.\0\n" });
    expect(nul.diagnostics[0]?.code).toBe("legacy/copybook/binary_content");

    const overflow = convertCopybook({
      path: "WIDE.cpy",
      bytes: `000100 01  WIDE-REC.${" ".repeat(60)}TRAILING-GARBAGE\n000200     05  W-A PIC X(3).\n`,
    });
    expect(overflow.diagnostics).toContainEqual(
      expect.objectContaining({ code: "legacy/copybook/column_overflow", level: "warning" }),
    );
    expect((overflow.schema as Schema)["x-anvil-cobol"].byteLength).toBe(3);

    const garbage = convertCopybook({
      path: "GARBAGE.cpy",
      bytes: "01 REC.\n   05 BAD PIC Q(4).\n   05 OK PIC X.\n   99 NOPE PIC X.\n   05 LONE.\n",
    });
    const codes = garbage.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("legacy/copybook/invalid_picture");
    expect(codes).toContain("legacy/copybook/invalid_level");
    expect(codes).toContain("legacy/copybook/elementary_without_picture");

    const oversized = convertCopybook({
      path: "BIG.cpy",
      bytes: new Uint8Array(4 * 1024 * 1024 + 1),
    });
    expect(oversized.diagnostics[0]?.code).toBe("legacy/copybook/oversized");
  });

  it("detects a sequence area and treats column-7 indicators as comments", () => {
    const parsed = parseCopybook(
      `000100*  Customer record\n000200 01  REC.\n000300     05  A  PIC X(2).\n000400-    'continued literal is tolerated'\n`,
    );
    expect(parsed.format).toBe("fixed");
    expect(parsed.roots[0]?.children[0]?.name).toBe("A");
  });
});
