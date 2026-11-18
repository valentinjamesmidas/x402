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
    await this.ctx.storage.deleteAll();
  }
}
