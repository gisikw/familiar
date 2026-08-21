import type http from "http";
import { debugLog } from "./debug.ts";
import type { RelayCommand } from "./protocol.ts";

/* --- Relay: server → extension command bus (SSE) --------------------------
 *
 * The extension owns the pi API (sendUserMessage / ctx.abort). The server
 * cannot call it directly, so ingress commands (submit / cancel) are pushed
 * down a single SSE stream the extension subscribes to on /relay. There is
 * normally exactly one subscriber (the pi process); if none is attached the
 * command is dropped (the agent isn't running — nothing to steer).
 */

export class RelayBus {
  private clients = new Set<http.ServerResponse>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  attach(req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(":relay\n\n");
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        for (const c of this.clients) c.write(":hb\n\n");
      }, 25_000);
    }
  }

  hasSubscriber(): boolean {
    return this.clients.size > 0;
  }

  send(cmd: RelayCommand): boolean {
    if (this.clients.size === 0) {
      debugLog("relay", { dropped: cmd });
      return false;
    }
    const line = `data: ${JSON.stringify(cmd)}\n\n`;
    for (const c of this.clients) c.write(line);
    return true;
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const c of this.clients) c.end();
    this.clients.clear();
  }
}
