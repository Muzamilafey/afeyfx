import type { Request } from 'express';
import { AuditLogModel } from '../models/AuditLog';
import { logger, errorMessage } from '../utils/logger';

export interface AuditEntry {
  action: string;
  resource?: string;
  resourceId?: string;
  success?: boolean;
  details?: Record<string, unknown>;
}

/** Append-only audit logging. Never throws (audit failures are logged), never stores secrets. */
export async function audit(req: Request | null, entry: AuditEntry) {
  try {
    const details = entry.details ? JSON.parse(JSON.stringify(entry.details, (k, v) => (/(password|secret|token|apikey|api_key|code)/i.test(k) ? '[REDACTED]' : v))) : undefined;
    await AuditLogModel.create({
      user: req?.user?.id,
      userEmail: req?.user?.email,
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId,
      ip: req?.ip,
      userAgent: req?.get?.('user-agent'),
      success: entry.success ?? true,
      details,
    });
  } catch (err) {
    logger.error({ err: errorMessage(err), action: entry.action }, 'Audit log write failed');
  }
}
