import { z } from "zod";
import { scaffoldDotnetRest } from "./dotnet-rest.js";
import { scaffoldJavaRest } from "./java-rest.js";
import type { ScaffoldResult, ScaffoldSourceMember } from "./model.js";
import { emitOpenApiDraft, type OpenApiDraft } from "./openapi-draft.js";

export const LegacyScaffoldLane = z.enum(["auto", "java", "dotnet"]);
export type LegacyScaffoldLane = z.infer<typeof LegacyScaffoldLane>;

export interface ScaffoldLegacyInput {
  title: string;
  version?: string;
  lane?: LegacyScaffoldLane;
  members: readonly ScaffoldSourceMember[];
}

export interface ScaffoldLegacyResult {
  draft: OpenApiDraft;
  lanes: { lane: Exclude<LegacyScaffoldLane, "auto">; result: ScaffoldResult }[];
}

const JAVA_MEMBER = /(?:\.java|web\.xml)$/i;
const DOTNET_MEMBER = /(?:\.cs|\.asmx|\.asmx\.cs)$/i;

/**
 * Run every applicable scaffold lane over one source set and lower the union
 * into a single OpenAPI draft. Lanes are selected by file extension only; a
 * lane that finds nothing contributes nothing, and a scaffold of zero
 * endpoints is a valid (empty) draft rather than an error — the draft records
 * why under `x-anvil-scaffold.diagnostics`.
 */
export function scaffoldLegacySource(input: ScaffoldLegacyInput): ScaffoldLegacyResult {
  const lane = LegacyScaffoldLane.parse(input.lane ?? "auto");
  const members = [...input.members].sort((left, right) => left.path.localeCompare(right.path));
  const lanes: ScaffoldLegacyResult["lanes"] = [];

  if (lane === "auto" || lane === "java") {
    const selected = members.filter((member) => JAVA_MEMBER.test(member.path));
    if (selected.length > 0) lanes.push({ lane: "java", result: scaffoldJavaRest(selected) });
  }
  if (lane === "auto" || lane === "dotnet") {
    const selected = members.filter((member) => DOTNET_MEMBER.test(member.path));
    if (selected.length > 0) lanes.push({ lane: "dotnet", result: scaffoldDotnetRest(selected) });
  }

  const merged: ScaffoldResult = {
    endpoints: lanes.flatMap(({ result }) => result.endpoints),
    diagnostics: lanes.flatMap(({ result }) => result.diagnostics),
    inputMembers: lanes.reduce((total, { result }) => total + result.inputMembers, 0),
  };
  if (lanes.length === 0) {
    merged.diagnostics.push({
      level: "warning",
      code: "legacy/scaffold/no_applicable_source",
      message: `No ${lane === "auto" ? "Java or .NET" : lane} source members were found.`,
    });
  }
  const draft = emitOpenApiDraft({
    title: input.title,
    ...(input.version ? { version: input.version } : {}),
    scaffold: merged,
  });
  return { draft, lanes };
}
