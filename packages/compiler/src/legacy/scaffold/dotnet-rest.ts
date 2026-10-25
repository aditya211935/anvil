import { EMPTY_SCAFFOLD, type ScaffoldResult, type ScaffoldSourceMember } from "./model.js";

/**
 * Recover HTTP endpoints from .NET source: ASP.NET Web API / ASP.NET Core
 * attribute routing (`[Route]`, `[HttpGet]`, …) and ASMX `[WebMethod]`.
 * Reads source as inert text; never loads an assembly or runs code.
 */
export function scaffoldDotnetRest(members: readonly ScaffoldSourceMember[]): ScaffoldResult {
  if (members.length === 0) return EMPTY_SCAFFOLD;
  return {
    endpoints: [],
    diagnostics: [
      {
        level: "warning",
        code: "legacy/scaffold/aspnet_core/not_implemented",
        message: ".NET REST scaffolding is not implemented in this build.",
      },
    ],
    inputMembers: 0,
  };
}
