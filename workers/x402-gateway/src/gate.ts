import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export class RequestGate extends DurableObject<Env> {
  async claim(expiresAt: number): Promise<boolean> {
    // The alarm may have been delayed. An expired claim can be replaced atomically.
    const claimed = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS claim (id INTEGER PRIMARY KEY, expires INTEGER NOT NULL)");
      const previous = sql.exec<{ expires: number }>("SELECT expires FROM claim WHERE id = 1").toArray()[0];
      if (previous && previous.expires >= Date.now()) return false;
      sql.exec("INSERT OR REPLACE INTO claim VALUES (1, ?)", expiresAt);
      return true;
    });
    if (claimed) await this.ctx.storage.setAlarm(expiresAt + 1000);
    return claimed;
  }

  async allow(limit: number): Promise<boolean> {
    const window = Math.floor(Date.now() / 60_000);
    const count = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS quota (window INTEGER PRIMARY KEY, count INTEGER NOT NULL)");
      sql.exec("DELETE FROM quota WHERE window < ?", window);
      return sql.exec<{ count: number }>(
        "INSERT INTO quota VALUES (?, 1) ON CONFLICT(window) DO UPDATE SET count = count + 1 RETURNING count", window,
      ).one().count;
    });
    if (count === 1) await this.ctx.storage.setAlarm((window + 2) * 60_000);
    return count <= limit;
  }

  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const names = new Set(sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).toArray().map((table) => table.name));
    const now = Date.now();
    const window = Math.floor(now / 60_000);
    let cleanup = 0;
    if (names.has("claim")) {
      const active = sql.exec<{ expires: number }>("SELECT expires FROM claim WHERE expires >= ?", now).toArray()[0];
      if (active) cleanup = active.expires + 1000;
    }
    if (names.has("quota")) {
      const active = sql.exec<{ window: number }>("SELECT window FROM quota WHERE window >= ?", window).toArray()[0];
      if (active) cleanup = Math.max(cleanup, (active.window + 2) * 60_000);
    }
    if (cleanup) await this.ctx.storage.setAlarm(cleanup);
    else await this.ctx.storage.deleteAll();
  }
}
