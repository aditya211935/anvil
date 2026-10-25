export interface DatabaseArtifactInput {
  path: string;
  bytes: Uint8Array | string;
}

export interface DatabaseEvidenceCoordinate {
  origin: string;
  pointer?: string;
  span?: { start: number; end: number };
}

export type DatabaseArtifactRole =
  | "package_specification"
  | "package_body"
  | "standalone_ddl"
  | "sql_script";

export interface DatabaseArtifactEvidence {
  path: string;
  digest: string;
  bytes: number;
  mediaType: string;
  role: DatabaseArtifactRole;
}

/** SQL dialect family recognized by the lexical scanner. */
export type DatabaseDialect = "plsql" | "tsql";

export type DatabaseParameterMode = "in" | "out" | "inout";

export interface DatabaseParameter {
  name: string;
  mode: DatabaseParameterMode;
  /** Declared type text, upper-cased and whitespace-normalized; never resolved. */
  type: string;
  hasDefault: boolean;
}

/** Which declaration supplied the signature; a specification outranks a body. */
export type DatabaseSignatureSource = "package_specification" | "package_body" | "standalone";

/**
 * Facts declared literally in a subprogram body. Each one is present only when
 * the text contains the construct; absence proves nothing.
 */
export type DatabaseTransactionFact =
  | "autonomous"
  | "begins_transaction"
  | "commits_internally"
  | "rolls_back_internally";

export interface DatabaseObservation {
  id: string;
  kind: "stored_procedure" | "stored_function";
  /** Stable, case-folded coordinate: `<dialect>:<schema>:<package>:<name>`. */
  coordinate: string;
  dialect: DatabaseDialect;
  schema?: string;
  package?: string;
  name: string;
  parameters: DatabaseParameter[];
  returnType?: string;
  signatureSource: DatabaseSignatureSource;
  transaction: DatabaseTransactionFact[];
  /** Mechanical error facts such as `raise_application_error:-20001` or `throw:50001`. */
  errorFacts: string[];
  evidence: DatabaseEvidenceCoordinate[];
  confidence: "declared";
}

export interface DatabaseDiagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  coordinate?: DatabaseEvidenceCoordinate;
}

export interface DatabaseCollectorResult {
  collector: {
    kind: "database";
    schemaVersion: 1;
  };
  evidence: DatabaseArtifactEvidence[];
  observations: DatabaseObservation[];
  diagnostics: DatabaseDiagnostic[];
}
