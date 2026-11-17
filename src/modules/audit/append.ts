import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { auditLog, type NewAuditLog } from "./schema";

/**
 * The deliberately tiny capability an audit writer needs. A Drizzle database
 * or transaction can both satisfy it, which lets money code append its audit
 * row on the exact same transaction that writes the ledger.
 */
export type AuditAppendExecutor = Pick<PostgresJsDatabase, "insert">;

export interface AuditAppender {
  append(executor: AuditAppendExecutor, event: NewAuditLog): Promise<void>;
}

export async function appendAuditLog(
  executor: AuditAppendExecutor,
  event: NewAuditLog,
): Promise<void> {
  await executor.insert(auditLog).values(event);
}

export const auditAppender: AuditAppender = {
  append: appendAuditLog,
};

