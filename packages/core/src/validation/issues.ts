export type IssueSeverity = 'error' | 'warning';

export type IssueCode =
  | 'not_an_object'
  | 'missing_version'
  | 'invalid_version'
  | 'unsupported_major_version'
  | 'requires_upgrade'
  | 'newer_minor_version'
  | 'schema'
  | 'invalid_timestamp'
  | 'unknown_item_type'
  | 'duplicate_id'
  | 'unknown_conversation'
  | 'unknown_turn'
  | 'turn_not_in_conversation'
  | 'turn_without_conversation'
  | 'span_without_turn'
  | 'invalid_span'
  | 'duplicate_turn_index'
  | 'timestamp_order'
  | 'source_mismatch';

export type IssuePath = ReadonlyArray<string | number>;

export interface ValidationIssue {
  code: IssueCode;
  severity: IssueSeverity;
  message: string;
  /** JSON path into the document, e.g. ["items", 3, "provenance", "turn_id"]. */
  path: IssuePath;
}

export function formatPath(path: IssuePath): string {
  if (path.length === 0) return '$';
  return (
    '$' +
    path
      .map((p) => (typeof p === 'number' ? `[${p}]` : /^[A-Za-z_][A-Za-z0-9_]*$/.test(p) ? `.${p}` : `[${JSON.stringify(p)}]`))
      .join('')
  );
}

export function formatIssue(issue: ValidationIssue): string {
  return `${issue.severity.toUpperCase()} ${issue.code} at ${formatPath(issue.path)}: ${issue.message}`;
}
