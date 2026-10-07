export function auditQuery(limit: number): string {
  return `SELECT * FROM audit_log JOIN users ON users.id = audit_log.actor LIMIT ${limit}`;
}
// Words in a comment do not count: update audit_log by hand.
