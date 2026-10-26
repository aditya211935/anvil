import { describe, expect, it } from "vitest";
import { reconcileLegacyInventory, verifyLegacyInventory } from "../core/index.js";
import { collectLegacyInventory, type LegacySourceMember } from "../inventory.js";
import { legacyLogicalCapabilityId } from "./identity.js";
import { verifyLegacyProductInput } from "./input.js";
import {
  LEGACY_MERGE_DISAGREEMENT_CODE,
  LEGACY_MERGE_SOURCE_CODE,
  LegacyMergeError,
  mergeLegacyInventories,
} from "./merge.js";

const encoder = new TextEncoder();

function member(path: string, content: string): LegacySourceMember {
  return { path, bytes: encoder.encode(content) };
}

interface ExportOptions {
  environment: string;
  jndi: string;
  estateId?: string;
  estateName?: string;
  systemId?: string;
}

/** One Java EE export per environment; only the vendor binding differs. */
function javaExport(options: ExportOptions) {
  return collectLegacyInventory({
    estate: {
      id: options.estateId ?? "refunds",
      ...(options.estateName ? { name: options.estateName } : {}),
    },
    environment: options.environment,
    application: "refund-service",
    source: { kind: "deployed_configuration", systemId: options.systemId ?? "offline-export" },
    members: [
      member(
        "refunds/META-INF/ejb-jar.xml",
        `<ejb-jar><enterprise-beans><session>
          <ejb-name>RefundBean</ejb-name><remote>com.acme.Refunds</remote>
        </session></enterprise-beans></ejb-jar>`,
      ),
      member(
        "refunds/META-INF/weblogic-ejb-jar.xml",
        `<weblogic-ejb-jar><weblogic-enterprise-bean>
          <ejb-name>RefundBean</ejb-name><jndi-name>${options.jndi}</jndi-name>
        </weblogic-enterprise-bean></weblogic-ejb-jar>`,
      ),
    ],
  });
}

const prod = javaExport({ environment: "prod", jndi: "ejb/refunds-prod" });
const uat = javaExport({ environment: "uat", jndi: "ejb/refunds-uat" });

describe("mergeLegacyInventories", () => {
  it("merges two environments into one verified snapshot whose lineage marks the divergent binding", () => {
    const merged = mergeLegacyInventories([prod.snapshot, uat.snapshot]);

    expect(verifyLegacyInventory(merged.snapshot)).toEqual(merged.snapshot);
    expect(merged.snapshot.estate).toEqual({ id: "refunds" });
    expect(merged.candidates).toEqual(reconcileLegacyInventory(merged.snapshot));
    expect(() =>
      verifyLegacyProductInput({ snapshot: merged.snapshot, candidates: merged.candidates }),
    ).not.toThrow();

    // Each environment keeps its own occurrence; neither has an intra-coordinate conflict.
    expect(merged.candidates).toHaveLength(2);
    expect(merged.candidates.every((candidate) => candidate.conflicts.length === 0)).toBe(true);
    expect(new Set(merged.candidates.map((candidate) => candidate.coordinate.environment))).toEqual(
      new Set(["prod", "uat"]),
    );

    expect(merged.lineages).toHaveLength(1);
    const lineage = merged.lineages[0];
    for (const candidate of merged.candidates) {
      expect(lineage?.logicalCapabilityId).toBe(
        legacyLogicalCapabilityId(merged.snapshot.estate, candidate),
      );
    }
    expect(lineage?.agreement).toBe("divergent");
    expect(lineage?.divergentDimensions).toEqual(["binding_target"]);
    expect(lineage?.occurrences.map((occurrence) => occurrence.candidateId).sort()).toEqual(
      merged.candidates.map((candidate) => candidate.candidateId).sort(),
    );
    const binding = lineage?.dimensions.find((entry) => entry.dimension === "binding_target");
    expect(binding?.state).toBe("divergent");
    expect(binding?.values).toEqual(
      expect.arrayContaining(["ejb/refunds-prod", "ejb/refunds-uat"]),
    );
    expect(binding?.assertedBy).toHaveLength(2);
    const technical = lineage?.dimensions.find((entry) => entry.dimension === "technical_name");
    expect(technical?.state).toBe("consistent");

    const sources = merged.snapshot.diagnostics.filter(
      (diagnostic) => diagnostic.code === LEGACY_MERGE_SOURCE_CODE,
    );
    expect(sources).toHaveLength(2);
    expect(sources.map((diagnostic) => diagnostic.message).join("\n")).toContain(
      prod.snapshot.inventoryId,
    );
    expect(sources.map((diagnostic) => diagnostic.message).join("\n")).toContain(
      "uat/refund-service",
    );
    const warnings = merged.snapshot.diagnostics.filter(
      (diagnostic) => diagnostic.code === LEGACY_MERGE_DISAGREEMENT_CODE,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      level: "warning",
      message: expect.stringContaining("binding_target"),
    });
    expect(warnings[0]?.message).toContain(lineage?.logicalCapabilityId);

    expect(merged.sources.map((source) => source.inventoryId).sort()).toEqual(
      [prod.snapshot.inventoryId, uat.snapshot.inventoryId].sort(),
    );
    expect(merged.sources.find((source) => source.coordinates[0]?.environment === "uat")).toEqual(
      expect.objectContaining({ artifacts: 2, observations: 1 }),
    );
  });

  it("collapses identical records and keeps same-path artifacts whose bytes differ", () => {
    const merged = mergeLegacyInventories([prod.snapshot, uat.snapshot]);
    const ejbJar = merged.snapshot.artifacts.filter(
      (artifact) => artifact.path === "refunds/META-INF/ejb-jar.xml",
    );
    const vendor = merged.snapshot.artifacts.filter(
      (artifact) => artifact.path === "refunds/META-INF/weblogic-ejb-jar.xml",
    );
    expect(ejbJar).toHaveLength(1);
    expect(vendor).toHaveLength(2);
    expect(new Set(vendor.map((artifact) => artifact.digest)).size).toBe(2);
    expect(merged.snapshot.artifacts).toHaveLength(3);
    expect(merged.snapshot.observations).toHaveLength(2);
  });

  it("reports a consistent lineage and no warning when the environments agree", () => {
    const uatSame = javaExport({ environment: "uat", jndi: "ejb/refunds-prod" });
    const merged = mergeLegacyInventories([prod.snapshot, uatSame.snapshot]);
    expect(merged.candidates).toHaveLength(2);
    expect(merged.lineages).toHaveLength(1);
    expect(merged.lineages[0]?.agreement).toBe("consistent");
    expect(merged.lineages[0]?.divergentDimensions).toEqual([]);
    expect(
      merged.snapshot.diagnostics.some(
        (diagnostic) => diagnostic.code === LEGACY_MERGE_DISAGREEMENT_CODE,
      ),
    ).toBe(false);
  });

  it("is order-independent and idempotent", () => {
    const forward = mergeLegacyInventories([prod.snapshot, uat.snapshot]);
    const reverse = mergeLegacyInventories([uat.snapshot, prod.snapshot]);
    expect(reverse).toEqual(forward);

    const again = mergeLegacyInventories([forward.snapshot, forward.snapshot]);
    expect(again.snapshot).toEqual(forward.snapshot);
    expect(again.candidates).toEqual(forward.candidates);
    expect(again.lineages).toEqual(forward.lineages);

    const duplicated = mergeLegacyInventories([prod.snapshot, prod.snapshot, uat.snapshot]);
    expect(duplicated.snapshot).toEqual(forward.snapshot);
  });

  it("returns one input re-verified, with a single-occurrence lineage", () => {
    const single = mergeLegacyInventories([prod.snapshot]);
    expect(single.snapshot).toEqual(prod.snapshot);
    expect(single.candidates).toEqual(prod.candidates);
    expect(single.lineages).toHaveLength(1);
    expect(single.lineages[0]?.agreement).toBe("single_occurrence");
    expect(single.sources).toHaveLength(1);

    const renamed = mergeLegacyInventories([prod.snapshot], {
      estate: { id: "refunds", name: "Refunds estate" },
    });
    expect(renamed.snapshot.estate).toEqual({ id: "refunds", name: "Refunds estate" });
    expect(renamed.snapshot.inventoryId).not.toBe(prod.snapshot.inventoryId);
    expect(renamed.candidates).toEqual(prod.candidates);
  });

  it("refuses zero inputs and mismatched estates unless the merged estate is named", () => {
    expect(() => mergeLegacyInventories([])).toThrow(LegacyMergeError);
    expect(() => mergeLegacyInventories([])).toThrow(/zero/);

    const other = javaExport({
      environment: "uat",
      jndi: "ejb/refunds-uat",
      estateId: "refunds-uat",
    });
    let caught: unknown;
    try {
      mergeLegacyInventories([prod.snapshot, other.snapshot]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LegacyMergeError);
    expect((caught as LegacyMergeError).code).toBe("legacy/merge/estate_mismatch");
    expect((caught as LegacyMergeError).message).toContain("refunds-uat");

    const named = mergeLegacyInventories([prod.snapshot, other.snapshot], {
      estate: { id: "refunds-all" },
    });
    expect(named.snapshot.estate).toEqual({ id: "refunds-all" });
    expect(named.lineages).toHaveLength(1);
    expect(named.lineages[0]?.agreement).toBe("divergent");
    expect(verifyLegacyInventory(named.snapshot)).toEqual(named.snapshot);
  });

  it("rejects an input whose identity does not match its content", () => {
    const tampered = { ...prod.snapshot, inventoryId: `li_${"0".repeat(64)}` };
    expect(() => mergeLegacyInventories([tampered, uat.snapshot])).toThrow(/does not match/);
  });
});
