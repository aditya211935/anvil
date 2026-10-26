import type { DatabaseDialect, DatabaseParameter } from "./model.js";

/** One top-level DDL unit: the text between two unit boundaries. */
export interface SqlUnit {
  start: number;
  end: number;
  text: string;
}

/**
 * A quoted or bare SQL identifier. Bracketed and double-quoted spellings are
 * accepted in both dialects so a mixed export still segments predictably.
 */
const IDENTIFIER = String.raw`(?:"[^"\n]+"|\[[^\]\n]+\]|[A-Za-z_][\w$#]*)`;
export const QUALIFIED_NAME = String.raw`${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER}){0,2}`;

const UNIT_BOUNDARY = new RegExp(
  [
    String.raw`\bCREATE\s+(?:OR\s+(?:REPLACE|ALTER)\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:PACKAGE(?:\s+BODY)?|PROC(?:EDURE)?|FUNCTION|TRIGGER|TYPE(?:\s+BODY)?|VIEW)\b`,
    String.raw`^[ \t]*GO[ \t]*(?:\r?\n|$)`,
    String.raw`^[ \t]*/[ \t]*(?:\r?\n|$)`,
  ].join("|"),
  "gim",
);

/**
 * Segment scrubbed SQL into top-level units. A unit starts at a program-unit
 * `CREATE`, a T-SQL `GO` line, or a SQL*Plus `/` line and runs to the next
 * boundary. Table, index, and sequence DDL never starts a unit because T-SQL
 * bodies legitimately create temporary tables.
 */
export function splitUnits(text: string): SqlUnit[] {
  const starts = [0, ...[...text.matchAll(UNIT_BOUNDARY)].map((match) => match.index ?? 0)];
  const unique = [...new Set(starts)].sort((a, b) => a - b);
  const units: SqlUnit[] = [];
  for (let index = 0; index < unique.length; index += 1) {
    const start = unique[index] ?? 0;
    const end = unique[index + 1] ?? text.length;
    const slice = text.slice(start, end);
    if (slice.trim().length === 0) continue;
    units.push({ start, end, text: slice });
  }
  return units;
}

/** Index of the parenthesis matching the one at `open`, or -1 when unbalanced. */
export function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Split on commas that are not nested inside parentheses. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function normalizeIdentifier(raw: string, dialect: DatabaseDialect): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1).trim();
  return dialect === "plsql" ? trimmed.toUpperCase() : trimmed;
}

export function splitQualifiedName(raw: string, dialect: DatabaseDialect): string[] {
  const parts: string[] = [];
  const pattern = new RegExp(IDENTIFIER, "g");
  for (const match of raw.matchAll(pattern)) parts.push(normalizeIdentifier(match[0], dialect));
  return parts;
}

function normalizeType(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim()
    .toUpperCase();
}

/**
 * Parse one PL/SQL formal parameter: `name [IN | OUT | IN OUT] type [NOCOPY]
 * [DEFAULT expr | := expr]`.
 */
export function parsePlsqlParameter(raw: string): DatabaseParameter | undefined {
  const match =
    /^("[^"]+"|[A-Za-z_][\w$#]*)\s+(?:(IN\s+OUT|IN|OUT)\s+)?(?:NOCOPY\s+)?([\s\S]*)$/i.exec(
      raw.trim(),
    );
  if (!match) return undefined;
  const name = normalizeIdentifier(match[1] ?? "", "plsql");
  const modeText = (match[2] ?? "IN").replace(/\s+/g, " ").toUpperCase();
  const rest = (match[3] ?? "").trim();
  const defaultMatch = /^([\s\S]*?)\s*(?:\bDEFAULT\b|:=)\s*[\s\S]*$/i.exec(rest);
  const typeText = (defaultMatch ? defaultMatch[1] : rest) ?? "";
  const type = normalizeType(typeText.replace(/\s+NOCOPY\b/i, ""));
  if (!type) return undefined;
  return {
    name,
    mode: modeText === "IN OUT" ? "inout" : modeText === "OUT" ? "out" : "in",
    type,
    hasDefault: Boolean(defaultMatch),
  };
}

/**
 * Parse one T-SQL parameter: `@name [AS] type [= default] [OUT | OUTPUT]
 * [READONLY] [VARYING]`.
 */
export function parseTsqlParameter(raw: string): DatabaseParameter | undefined {
  const match = /^(@[\w$@#]+)\s+(?:AS\s+)?([\s\S]*)$/i.exec(raw.trim());
  if (!match) return undefined;
  const name = match[1] ?? "";
  let rest = (match[2] ?? "").trim();
  let isOutput = false;
  let hasDefault = false;
  let changed = true;
  while (changed) {
    changed = false;
    const trailing = /\s*\b(OUTPUT|OUT|READONLY|VARYING)\s*$/i.exec(rest);
    if (trailing) {
      if (/^OUT/i.test(trailing[1] ?? "")) isOutput = true;
      rest = rest.slice(0, trailing.index).trim();
      changed = true;
    }
  }
  const equals = topLevelIndexOf(rest, "=");
  if (equals >= 0) {
    hasDefault = true;
    rest = rest.slice(0, equals).trim();
  }
  const type = normalizeType(rest);
  if (!type) return undefined;
  return { name, mode: isOutput ? "out" : "in", type, hasDefault };
}

function topLevelIndexOf(text: string, needle: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === needle && depth === 0) return index;
  }
  return -1;
}

/** Canonical, order-preserving signature text used as the input_schema claim. */
export function canonicalParameters(parameters: readonly DatabaseParameter[]): string {
  return `(${parameters
    .map(
      (parameter) =>
        `${parameter.name} ${modeKeyword(parameter.mode)} ${parameter.type}${
          parameter.hasDefault ? " DEFAULT" : ""
        }`,
    )
    .join(", ")})`;
}

function modeKeyword(mode: DatabaseParameter["mode"]): string {
  return mode === "inout" ? "IN OUT" : mode.toUpperCase();
}
