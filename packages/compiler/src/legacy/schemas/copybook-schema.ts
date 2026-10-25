/**
 * Byte layout and JSON Schema projection for a parsed copybook. Field names
 * stay verbatim (wire fidelity), every field carries its COBOL declaration in
 * `x-anvil-cobol`, and nothing about business meaning is inferred.
 */
import type {
  CopybookDiagnostic,
  CopybookItem,
  CopybookLiteral,
  CopybookParseResult,
} from "./copybook-parse.js";

export type JsonSchema = Record<string, unknown>;

export interface PictureInfo {
  category: "numeric" | "alphanumeric" | "alphabetic" | "numeric_edited" | "alphanumeric_edited";
  /** Character positions occupied in DISPLAY usage. */
  positions: number;
  digits: number;
  integerDigits: number;
  fractionDigits: number;
  /** `P` scaling positions to the right of the digits (value = digits × 10^scaleFactor). */
  scaleFactor: number;
  signed: boolean;
}

interface Layout {
  offset: number;
  /** One occurrence. */
  byteLength: number;
  /** All occurrences. */
  totalByteLength: number;
  usage: string;
  picture?: PictureInfo;
  sign?: CopybookItem["sign"];
}

interface LayoutEntry {
  path: string;
  level: number;
  name: string;
  offset: number;
  byteLength: number;
  totalByteLength: number;
  usage: string;
  picture?: string;
  occurs?: number;
  redefines?: string;
}

const MAX_EXACT_DIGITS = 15;
const MAX_PICTURE_POSITIONS = 65_535;

export function projectCopybookSchema(
  parsed: CopybookParseResult,
  source: { path: string },
  diagnostics: CopybookDiagnostic[],
): JsonSchema | undefined {
  if (parsed.roots.length === 0) return undefined;
  const layouts = new Map<CopybookItem, Layout>();
  const entries: LayoutEntry[] = [];
  let syncSeen = false;
  const context = {
    layouts,
    diagnostics,
    noteSync: () => {
      if (syncSeen) return;
      syncSeen = true;
      diagnostics.push({
        level: "warning",
        code: "legacy/copybook/sync_alignment_not_applied",
        message:
          "SYNCHRONIZED items were laid out without implicit slack bytes; offsets after them may differ from the compiler's.",
      });
    },
  };
  for (const root of parsed.roots) layoutItem(root, 0, undefined, undefined, context);
  for (const root of parsed.roots) collectEntries(root, root.name, layouts, entries);

  const first = parsed.roots[0];
  if (!first) return undefined;
  const base: JsonSchema = { $schema: "http://json-schema.org/draft-07/schema#" };
  const sourceInfo = {
    path: source.path,
    format: parsed.format,
    lines: parsed.lines,
    items: parsed.itemCount,
  };
  if (parsed.roots.length === 1) {
    const schema = projectItem(first, layouts, true);
    const extension = schema["x-anvil-cobol"] as JsonSchema;
    return {
      ...base,
      title: first.name,
      ...schema,
      "x-anvil-cobol": { source: sourceInfo, ...extension, layout: entries },
    };
  }
  const properties: JsonSchema = {};
  const required: string[] = [];
  const records: JsonSchema[] = [];
  for (const root of parsed.roots) {
    if (root.filler) continue;
    properties[root.name] = projectItem(root, layouts, true);
    if (!root.redefines) required.push(root.name);
    records.push({
      name: root.name,
      level: root.level,
      byteLength: layouts.get(root)?.totalByteLength ?? 0,
      ...(root.redefines ? { redefines: root.redefines } : {}),
    });
  }
  return {
    ...base,
    title: first.name,
    type: "object",
    properties,
    required,
    additionalProperties: false,
    "x-anvil-cobol": { source: sourceInfo, records, layout: entries },
  };
}

interface LayoutContext {
  layouts: Map<CopybookItem, Layout>;
  diagnostics: CopybookDiagnostic[];
  noteSync: () => void;
}

function layoutItem(
  item: CopybookItem,
  offset: number,
  inheritedUsage: string | undefined,
  inheritedSign: CopybookItem["sign"] | undefined,
  context: LayoutContext,
): Layout {
  const usage = normalizeUsage(item.usage) ?? inheritedUsage;
  const sign = item.sign ?? inheritedSign;
  if (item.sync) context.noteSync();
  const occurrences = Math.max(1, item.occurs?.max ?? 1);
  if (item.children.length > 0) {
    let cursor = offset;
    let end = offset;
    const siblings = new Map<string, Layout>();
    for (const child of item.children) {
      let childOffset = cursor;
      if (child.redefines) {
        const target = siblings.get(child.redefines.toUpperCase());
        if (target) childOffset = target.offset;
        else {
          context.diagnostics.push({
            level: "error",
            code: "legacy/copybook/redefines_target_missing",
            message: `${child.name} REDEFINES ${child.redefines}, which is not a preceding sibling.`,
            line: child.line,
          });
        }
      }
      const childLayout = layoutItem(child, childOffset, usage, sign, context);
      siblings.set(child.name.toUpperCase(), childLayout);
      const childEnd = childOffset + childLayout.totalByteLength;
      if (!child.redefines) cursor = childEnd;
      end = Math.max(end, childEnd);
    }
    const byteLength = end - offset;
    const layout: Layout = {
      offset,
      byteLength,
      totalByteLength: byteLength * occurrences,
      usage: usage ?? "GROUP",
      sign,
    };
    context.layouts.set(item, layout);
    return layout;
  }
  const picture = item.picture
    ? analyzePicture(item.picture, item, context.diagnostics)
    : undefined;
  const effectiveUsage = usage ?? "DISPLAY";
  const byteLength = elementaryByteLength(picture, effectiveUsage, sign, item, context.diagnostics);
  const layout: Layout = {
    offset,
    byteLength,
    totalByteLength: byteLength * occurrences,
    usage: effectiveUsage,
    picture,
    sign,
  };
  context.layouts.set(item, layout);
  return layout;
}

function elementaryByteLength(
  picture: PictureInfo | undefined,
  usage: string,
  sign: CopybookItem["sign"] | undefined,
  item: CopybookItem,
  diagnostics: CopybookDiagnostic[],
): number {
  switch (usage) {
    case "COMP-1":
      return 4;
    case "COMP-2":
      return 8;
    case "POINTER":
    case "INDEX":
      return 4;
    default:
      break;
  }
  if (!picture) {
    if (item.level !== 88 && item.level !== 66) {
      diagnostics.push({
        level: "error",
        code: "legacy/copybook/elementary_without_picture",
        message: `${item.name} has neither subordinate items nor a PICTURE clause; its length is unknown.`,
        line: item.line,
      });
    }
    return 0;
  }
  if (picture.category !== "numeric") {
    const unit = usage === "NATIONAL" || usage === "DISPLAY-1" ? 2 : 1;
    return picture.positions * unit;
  }
  switch (usage) {
    case "COMP-3":
    case "PACKED-DECIMAL":
      return Math.ceil((picture.digits + 1) / 2);
    case "COMP":
    case "COMP-4":
    case "COMP-5":
    case "BINARY":
      return picture.digits <= 4 ? 2 : picture.digits <= 9 ? 4 : 8;
    default:
      return picture.digits + (picture.signed && sign?.separate ? 1 : 0);
  }
}

export function normalizeUsage(usage: string | undefined): string | undefined {
  if (!usage) return undefined;
  const upper = usage.toUpperCase();
  const map: Record<string, string> = {
    COMPUTATIONAL: "COMP",
    "COMPUTATIONAL-1": "COMP-1",
    "COMPUTATIONAL-2": "COMP-2",
    "COMPUTATIONAL-3": "COMP-3",
    "COMPUTATIONAL-4": "COMP-4",
    "COMPUTATIONAL-5": "COMP-5",
    BINARY: "COMP",
    "COMP-4": "COMP",
    "PACKED-DECIMAL": "COMP-3",
  };
  return map[upper] ?? upper;
}

export function analyzePicture(
  picture: string,
  item: Pick<CopybookItem, "name" | "line">,
  diagnostics: CopybookDiagnostic[],
): PictureInfo | undefined {
  const symbols: string[] = [];
  const pattern = /(CR|DB|[A-Z9+\-*,./$])(?:\((\d+)\))?/gy;
  let cursor = 0;
  let total = 0;
  while (cursor < picture.length) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(picture);
    if (!match || match.index !== cursor) {
      diagnostics.push({
        level: "error",
        code: "legacy/copybook/invalid_picture",
        message: `${item.name}: PICTURE '${picture.slice(0, 40)}' is not understood.`,
        line: item.line,
      });
      return undefined;
    }
    const symbol = match[1] ?? "";
    const count = match[2] ? Number.parseInt(match[2], 10) : 1;
    total += count;
    if (total > MAX_PICTURE_POSITIONS) {
      diagnostics.push({
        level: "error",
        code: "legacy/copybook/picture_too_long",
        message: `${item.name}: PICTURE exceeds ${MAX_PICTURE_POSITIONS} positions.`,
        line: item.line,
      });
      return undefined;
    }
    for (let index = 0; index < count; index += 1) symbols.push(symbol);
    cursor += match[0].length;
  }
  const set = new Set(symbols);
  const has = (...candidates: string[]) => candidates.some((candidate) => set.has(candidate));
  const only = (...allowed: string[]) => symbols.every((symbol) => allowed.includes(symbol));
  const digits = symbols.filter((symbol) => symbol === "9").length;
  const signed = has("S");
  if (only("9", "S", "V", "P") && digits > 0) {
    const vIndex = symbols.indexOf("V");
    const pCount = symbols.filter((symbol) => symbol === "P").length;
    const firstP = symbols.indexOf("P");
    const firstDigit = symbols.indexOf("9");
    const pLeft = pCount > 0 && firstP < firstDigit;
    const digitsAfterV =
      vIndex === -1 ? 0 : symbols.slice(vIndex + 1).filter((symbol) => symbol === "9").length;
    const fractionDigits = digitsAfterV + (pLeft ? pCount : 0);
    return {
      category: "numeric",
      positions: digits,
      digits,
      integerDigits: digits - digitsAfterV,
      fractionDigits,
      scaleFactor: pLeft ? 0 : pCount,
      signed,
    };
  }
  const positions =
    symbols.filter((symbol) => !["S", "V", "P"].includes(symbol)).length +
    symbols.filter((symbol) => symbol === "CR" || symbol === "DB").length;
  if (only("A", "B")) {
    return {
      category: "alphabetic",
      positions,
      digits: 0,
      integerDigits: 0,
      fractionDigits: 0,
      scaleFactor: 0,
      signed: false,
    };
  }
  if (only("X", "A", "9", "B", "N") && has("X", "A", "N")) {
    return {
      category: "alphanumeric",
      positions,
      digits: 0,
      integerDigits: 0,
      fractionDigits: 0,
      scaleFactor: 0,
      signed: false,
    };
  }
  if (has("X", "A")) {
    return {
      category: "alphanumeric_edited",
      positions,
      digits: 0,
      integerDigits: 0,
      fractionDigits: 0,
      scaleFactor: 0,
      signed: false,
    };
  }
  if (has("9", "Z", "*", "$", "+", "-", "CR", "DB", ".", ",", "0", "/", "B", "E")) {
    return {
      category: "numeric_edited",
      positions,
      digits,
      integerDigits: digits,
      fractionDigits: 0,
      scaleFactor: 0,
      signed: has("+", "-", "CR", "DB"),
    };
  }
  diagnostics.push({
    level: "error",
    code: "legacy/copybook/invalid_picture",
    message: `${item.name}: PICTURE '${picture.slice(0, 40)}' is not understood.`,
    line: item.line,
  });
  return undefined;
}

function collectEntries(
  item: CopybookItem,
  path: string,
  layouts: ReadonlyMap<CopybookItem, Layout>,
  entries: LayoutEntry[],
): void {
  const layout = layouts.get(item);
  if (!layout) return;
  entries.push({
    path,
    level: item.level,
    name: item.name,
    offset: layout.offset,
    byteLength: layout.byteLength,
    totalByteLength: layout.totalByteLength,
    usage: layout.usage,
    ...(item.picture ? { picture: item.picture } : {}),
    ...(item.occurs ? { occurs: item.occurs.max } : {}),
    ...(item.redefines ? { redefines: item.redefines } : {}),
  });
  item.children.forEach((child, index) => {
    const segment = child.filler ? `FILLER#${index + 1}` : child.name;
    collectEntries(child, `${path}.${segment}`, layouts, entries);
  });
}

function projectItem(
  item: CopybookItem,
  layouts: ReadonlyMap<CopybookItem, Layout>,
  isRoot: boolean,
): JsonSchema {
  const layout = layouts.get(item);
  const extension = cobolExtension(item, layout);
  let schema: JsonSchema;
  if (item.children.length > 0) {
    schema = projectGroup(item, layouts, extension);
  } else {
    schema = { ...projectElementary(item, layout), "x-anvil-cobol": extension };
  }
  if (item.occurs && !isRoot) {
    const { "x-anvil-cobol": inner, ...items } = schema;
    const occursExtension = {
      ...(inner as JsonSchema),
      occurs: {
        min: item.occurs.min,
        max: item.occurs.max,
        ...(item.occurs.dependingOn ? { dependingOn: item.occurs.dependingOn } : {}),
        ...(item.occurs.indexedBy ? { indexedBy: item.occurs.indexedBy } : {}),
        ...(item.occurs.keys ? { keys: item.occurs.keys } : {}),
      },
      ...(layout ? { totalByteLength: layout.totalByteLength } : {}),
    };
    return {
      type: "array",
      items,
      minItems: item.occurs.dependingOn ? item.occurs.min : item.occurs.max,
      maxItems: item.occurs.max,
      "x-anvil-cobol": occursExtension,
    };
  }
  return schema;
}

function projectGroup(
  item: CopybookItem,
  layouts: ReadonlyMap<CopybookItem, Layout>,
  extension: JsonSchema,
): JsonSchema {
  const properties: JsonSchema = {};
  const required: string[] = [];
  const redefines: JsonSchema[] = [];
  const fillers: JsonSchema[] = [];
  for (const child of item.children) {
    const childLayout = layouts.get(child);
    if (child.filler) {
      fillers.push({
        level: child.level,
        offset: childLayout?.offset ?? 0,
        byteLength: childLayout?.totalByteLength ?? 0,
        declaration: child.declaration,
        line: child.line,
      });
      continue;
    }
    const childSchema = projectItem(child, layouts, false);
    if (child.redefines) {
      const base = properties[child.redefines];
      redefines.push({
        name: child.name,
        redefines: child.redefines,
        offset: childLayout?.offset ?? 0,
        byteLength: childLayout?.totalByteLength ?? 0,
      });
      if (base && typeof base === "object") {
        const baseSchema = base as JsonSchema;
        const alternatives = Array.isArray(baseSchema.oneOf)
          ? (baseSchema.oneOf as JsonSchema[])
          : [{ title: child.redefines, ...baseSchema }];
        properties[child.redefines] = {
          oneOf: [...alternatives, { title: child.name, ...childSchema }],
        };
        continue;
      }
    }
    properties[child.name] = childSchema;
    if (!child.redefines) required.push(child.name);
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
    "x-anvil-cobol": {
      ...extension,
      ...(redefines.length > 0 ? { redefines } : {}),
      ...(fillers.length > 0 ? { fillers } : {}),
    },
  };
}

function projectElementary(item: CopybookItem, layout: Layout | undefined): JsonSchema {
  const picture = layout?.picture;
  const usage = layout?.usage ?? "DISPLAY";
  let schema: JsonSchema;
  if (usage === "COMP-1" || usage === "COMP-2") schema = { type: "number" };
  else if (usage === "POINTER" || usage === "INDEX") schema = { type: "integer" };
  else if (!picture) schema = {};
  else if (picture.category === "numeric") schema = numericSchema(picture);
  else schema = { type: "string", maxLength: picture.positions };

  const literalValue = literalFor(item.value, schema);
  if (literalValue !== undefined) schema.default = literalValue;
  const enumValues = conditionEnum(item, schema);
  if (enumValues) schema.enum = enumValues;
  return schema;
}

function numericSchema(picture: PictureInfo): JsonSchema {
  const { digits, integerDigits, fractionDigits, scaleFactor, signed } = picture;
  if (digits + scaleFactor > MAX_EXACT_DIGITS) {
    const sign = signed ? "-?" : "";
    const pattern =
      fractionDigits > 0
        ? `^${sign}[0-9]{0,${integerDigits}}(\\.[0-9]{1,${fractionDigits}})?$`
        : `^${sign}[0-9]{1,${digits}}${scaleFactor > 0 ? `0{${scaleFactor}}` : ""}$`;
    return { type: "string", pattern };
  }
  if (fractionDigits === 0) {
    const magnitude = (10 ** digits - 1) * 10 ** scaleFactor;
    return {
      type: "integer",
      minimum: signed ? -magnitude : 0,
      maximum: magnitude,
      ...(scaleFactor > 0 ? { multipleOf: 10 ** scaleFactor } : {}),
    };
  }
  const magnitude = Number(
    `${"9".repeat(Math.max(0, integerDigits)) || "0"}.${"9".repeat(fractionDigits)}`,
  );
  return {
    type: "number",
    multipleOf: Number(`1e-${fractionDigits}`),
    minimum: signed ? -magnitude : 0,
    maximum: magnitude,
  };
}

function literalFor(
  literal: CopybookLiteral | undefined,
  schema: JsonSchema,
): string | number | undefined {
  if (!literal) return undefined;
  if (literal.kind === "string") {
    return schema.type === "integer" || schema.type === "number"
      ? Number.isFinite(Number(literal.value))
        ? Number(literal.value)
        : undefined
      : literal.value;
  }
  if (literal.kind === "number") {
    return schema.type === "string" ? literal.text : literal.value;
  }
  return undefined;
}

function conditionEnum(item: CopybookItem, schema: JsonSchema): (string | number)[] | undefined {
  if (item.conditions.length === 0) return undefined;
  const values: (string | number)[] = [];
  for (const condition of item.conditions) {
    for (const value of condition.conditionValues ?? []) {
      if (value.thru) return undefined;
      const literal = literalFor(value.from, schema);
      if (literal === undefined) return undefined;
      values.push(literal);
    }
  }
  if (values.length === 0) return undefined;
  return [...new Set(values)];
}

function cobolExtension(item: CopybookItem, layout: Layout | undefined): JsonSchema {
  const extension: JsonSchema = {
    level: item.level,
    name: item.name,
    declaration: item.declaration,
    line: item.line,
    ...(layout ? { offset: layout.offset, byteLength: layout.byteLength } : {}),
    usage: layout?.usage ?? "DISPLAY",
  };
  if (item.picture) extension.picture = item.picture;
  const picture = layout?.picture;
  if (picture) {
    extension.category = picture.category;
    if (picture.category === "numeric") {
      extension.digits = picture.digits;
      extension.scale = picture.fractionDigits;
      extension.precision = picture.digits;
      extension.signed = picture.signed;
      if (picture.scaleFactor > 0) extension.scalingPositions = picture.scaleFactor;
    }
  }
  if (item.redefines) extension.redefines = item.redefines;
  if (item.sign) extension.sign = item.sign;
  if (item.justified) extension.justified = true;
  if (item.blankWhenZero) extension.blankWhenZero = true;
  if (item.sync) extension.sync = true;
  if (item.external) extension.external = true;
  if (item.global) extension.global = true;
  if (item.value) extension.value = describeLiteral(item.value);
  if (item.conditions.length > 0) {
    extension.conditions = item.conditions.map((condition) => ({
      name: condition.name,
      values: (condition.conditionValues ?? []).map((value) => ({
        from: describeLiteral(value.from),
        ...(value.thru ? { thru: describeLiteral(value.thru) } : {}),
      })),
      declaration: condition.declaration,
      line: condition.line,
    }));
  }
  if (item.renamed.length > 0) {
    extension.renames = item.renamed.map((renamed) => ({
      name: renamed.name,
      from: renamed.renames?.from,
      ...(renamed.renames?.thru ? { thru: renamed.renames.thru } : {}),
      declaration: renamed.declaration,
      line: renamed.line,
    }));
  }
  return extension;
}

function describeLiteral(literal: CopybookLiteral): JsonSchema {
  switch (literal.kind) {
    case "string":
      return { kind: "string", value: literal.value };
    case "number":
      return { kind: "number", value: literal.value, text: literal.text };
    case "hex":
      return { kind: "hex", text: literal.text };
    default:
      return { kind: "figurative", value: literal.value };
  }
}
