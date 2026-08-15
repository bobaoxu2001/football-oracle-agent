export type AuditSeverity = "warning" | "fail";
export type AuditStatus = "pass" | "warning" | "fail";

export interface AuditIssue {
  code: string;
  severity: AuditSeverity;
  message: string;
  subject?: string;
}

export interface AuditReport {
  subject: string;
  status: AuditStatus;
  issues: AuditIssue[];
  recommendedFixes: string[];
}
