import { EMPTY_SCAFFOLD, type ScaffoldResult, type ScaffoldSourceMember } from "./model.js";

/**
 * Recover HTTP endpoints from Java source: JAX-RS (`@Path`, `@GET`, …),
 * Spring MVC (`@RequestMapping`, `@GetMapping`, …) and `web.xml` servlet
 * mappings. Reads source as inert text; never resolves types or runs code.
 */
export function scaffoldJavaRest(members: readonly ScaffoldSourceMember[]): ScaffoldResult {
  if (members.length === 0) return EMPTY_SCAFFOLD;
  return {
    endpoints: [],
    diagnostics: [
      {
        level: "warning",
        code: "legacy/scaffold/jaxrs/not_implemented",
        message: "Java REST scaffolding is not implemented in this build.",
      },
    ],
    inputMembers: 0,
  };
}
