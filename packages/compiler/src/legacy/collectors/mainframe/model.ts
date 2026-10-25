export interface MainframeArtifactInput {
  path: string;
  bytes: Uint8Array | string;
}

export interface MainframeEvidenceCoordinate {
  origin: string;
  pointer?: string;
  span?: { start: number; end: number };
}

export interface MainframeArtifactEvidence {
  path: string;
  digest: string;
  bytes: number;
  mediaType: string;
  role: "jcl_job" | "jcl_procedure" | "copybook" | "other";
}

/**
 * One DD statement (or one concatenated dataset under a DD name). The
 * direction is derived only from the declared DISP status; a dataset with no
 * DISP, a DUMMY, a SYSOUT, or an in-stream DD stays `unknown`.
 */
export interface MainframeDataset {
  ddName: string;
  dsn?: string;
  disposition?: string;
  direction: "input" | "output" | "unknown";
  /** True when the DD declares in-stream data (`DD *` / `DD DATA`); the data is never recorded. */
  inStream: boolean;
  /** Copybook member (by file name) whose name matches the referenced PDS member, when supplied. */
  copybookPath?: string;
  line: number;
}

export interface MainframeStep {
  ordinal: number;
  name: string;
  program?: string;
  procedure?: string;
  parm?: string;
  cond?: string;
  datasets: MainframeDataset[];
  line: number;
}

export interface MainframeObservation {
  id: string;
  kind: "job" | "procedure";
  coordinate: string;
  name: string;
  /** `jes`, the declared JCLLIB order, or `proclib` for procedure members. */
  schedulerRef: string;
  steps: MainframeStep[];
  /** Job- or procedure-level DD statements (JOBLIB, STEPLIB before the first step, ...). */
  libraryDatasets: MainframeDataset[];
  /** Same-member `SET` symbols, verbatim values. */
  symbols: Record<string, string>;
  includes: string[];
  /** Declared `IF ... THEN` relational expressions, verbatim. */
  conditions: string[];
  inStreamProcedure: boolean;
  evidence: MainframeEvidenceCoordinate[];
  confidence: "declared";
}

export interface MainframeDiagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  coordinate?: MainframeEvidenceCoordinate;
}

export interface MainframeCollectorResult {
  collector: {
    kind: "mainframe";
    schemaVersion: 1;
  };
  evidence: MainframeArtifactEvidence[];
  observations: MainframeObservation[];
  diagnostics: MainframeDiagnostic[];
}
