import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  deviceActionAuditSchema,
  type DeviceActionAudit,
  type DeviceControlAction,
} from "@device-robot/contracts";

type AuditRow = {
  id: string;
  serial: string;
  payload_json: string;
  success: number;
  message: string | null;
  started_at: string;
  finished_at: string;
};

export interface DeviceActionAuditStore {
  record(entry: Omit<DeviceActionAudit, "id">): DeviceActionAudit;
  list(serial: string, limit?: number): DeviceActionAudit[];
}

export class SqliteDeviceActionAuditStore implements DeviceActionAuditStore {
  readonly #sqlite: Database.Database;

  public constructor(sqlite: Database.Database) {
    this.#sqlite = sqlite;
  }

  public record(entry: Omit<DeviceActionAudit, "id">): DeviceActionAudit {
    const audit: DeviceActionAudit = { id: randomUUID(), ...entry };

    this.#sqlite
      .prepare(
        `
          INSERT INTO device_action_audits (
            id, serial, action_name, payload_json, success, message, started_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        audit.id,
        audit.serial,
        audit.action.action,
        JSON.stringify(audit.action),
        audit.success ? 1 : 0,
        audit.message ?? null,
        audit.startedAt,
        audit.finishedAt,
      );

    return audit;
  }

  public list(serial: string, limit = 20): DeviceActionAudit[] {
    const rows = this.#sqlite
      .prepare(
        `
          SELECT id, serial, payload_json, success, message, started_at, finished_at
          FROM device_action_audits
          WHERE serial = ?
          ORDER BY finished_at DESC
          LIMIT ?
        `,
      )
      .all(serial, Math.min(Math.max(limit, 1), 100)) as AuditRow[];

    return rows.flatMap((row) => {
      try {
        const action: unknown = JSON.parse(row.payload_json);
        const parsed = deviceActionAuditSchema.safeParse({
          id: row.id,
          serial: row.serial,
          action,
          success: row.success === 1,
          ...(row.message === null ? {} : { message: row.message }),
          startedAt: row.started_at,
          finishedAt: row.finished_at,
        });
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }
}

export function createFailedActionAudit(
  serial: string,
  action: DeviceControlAction,
  startedAt: string,
  message: string,
): Omit<DeviceActionAudit, "id"> {
  return {
    serial,
    action,
    success: false,
    message,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
