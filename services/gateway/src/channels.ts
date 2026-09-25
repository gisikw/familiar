import { randomUUID } from "node:crypto";
import type http from "node:http";
import { AudioCache } from "./audio.ts";
import { StreamHub } from "./hub.ts";
import { Ingress } from "./ingress.ts";
import { RelayBus } from "./relay.ts";
import type { IngestEnvelope, SessionIdentity } from "./protocol.ts";

export type SessionRole = "primary" | "fork";

export class Channel {
  readonly hub = new StreamHub();
  readonly relay: RelayBus;
  readonly ingress: Ingress;
  readonly audio: AudioCache;
  startedAt = new Date().toISOString();
  lastEventAt = this.startedAt;

  constructor(
    public id: string,
    public role: SessionRole,
    public parentSessionId?: string,
    onRelayChange?: (attached: boolean) => void,
  ) {
    this.relay = new RelayBus(onRelayChange);
    this.ingress = new Ingress(this.relay);
    this.audio = new AudioCache(this.hub);
  }

  update(identity: SessionIdentity) {
    this.role = identity.role;
    this.parentSessionId = identity.parentSessionId;
  }

  apply(env: IngestEnvelope) {
    this.lastEventAt = new Date().toISOString();
    switch (env.kind) {
      case "session": this.hub.newSession(); return;
      case "lock": this.hub.lockInflight(); return;
      case "revise": this.hub.revise(env.event); return;
      case "publish": {
        const event = env.event;
        if (event.event === "segment") {
          const synth = this.hub.anyAudioListener();
          this.audio.register(event.message_id, event.index, event.text, synth);
          this.hub.publish({ ...event, synthesizing: synth });
        } else this.hub.publish(event);
      }
    }
  }

  close() {
    this.hub.close();
    this.relay.close();
  }
}

/** Session-addressed runtime state. A provisional channel preserves the old
 * startup behavior for clients that connect before the primary Pi announces
 * itself; the first primary registration adopts it in place. */
export class ChannelRegistry {
  readonly channels = new Map<string, Channel>();
  private primaryId: string | undefined;
  private provisionalId: string | undefined;
  private expiry = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private retentionMs = 10 * 60_000) {}

  primary(): Channel {
    if (this.primaryId) {
      const existing = this.channels.get(this.primaryId);
      if (existing) return existing;
    }
    const id = randomUUID();
    const channel = this.make(id, "primary");
    this.primaryId = id;
    this.provisionalId = id;
    return channel;
  }

  get(sessionId: string | null | undefined): Channel | undefined {
    return sessionId ? this.channels.get(sessionId) : this.primary();
  }

  register(identity: SessionIdentity): Channel {
    return this.upsert(identity, true);
  }

  private upsert(identity: SessionIdentity, activeRegistration: boolean): Channel {
    let channel = this.channels.get(identity.sessionId);
    if (!channel && identity.role === "primary" && this.provisionalId) {
      channel = this.channels.get(this.provisionalId);
      if (channel) {
        this.channels.delete(this.provisionalId);
        this.cancelExpiry(this.provisionalId);
        channel.id = identity.sessionId;
        channel.startedAt = new Date().toISOString();
        channel.lastEventAt = channel.startedAt;
        this.channels.set(identity.sessionId, channel);
      }
      this.provisionalId = undefined;
    }
    if (!channel) channel = this.make(identity.sessionId, identity.role, identity.parentSessionId);
    channel.update(identity);
    if (activeRegistration) this.cancelExpiry(identity.sessionId);
    if (identity.role === "primary") this.primaryId = identity.sessionId;
    return channel;
  }

  ingest(env: IngestEnvelope): Channel {
    return this.upsert(env, false);
  }

  private make(id: string, role: SessionRole, parentSessionId?: string) {
    const channel = new Channel(id, role, parentSessionId, (attached) => {
      if (this.channels.get(channel.id) !== channel) return;
      if (attached) this.cancelExpiry(channel.id);
      else this.scheduleExpiry(channel.id);
    });
    this.channels.set(id, channel);
    return channel;
  }

  private scheduleExpiry(id: string) {
    this.cancelExpiry(id);
    const timer = setTimeout(() => {
      const channel = this.channels.get(id);
      if (!channel || channel.relay.hasSubscriber()) return;
      this.channels.delete(id);
      this.expiry.delete(id);
      channel.close();
      if (this.primaryId === id) this.primaryId = undefined;
    }, this.retentionMs);
    timer.unref?.();
    this.expiry.set(id, timer);
  }

  private cancelExpiry(id: string) {
    const timer = this.expiry.get(id);
    if (timer) clearTimeout(timer);
    this.expiry.delete(id);
  }

  close() {
    for (const timer of this.expiry.values()) clearTimeout(timer);
    this.expiry.clear();
    for (const channel of this.channels.values()) channel.close();
    this.channels.clear();
  }
}

export function attachRelay(channel: Channel, req: http.IncomingMessage, res: http.ServerResponse) {
  channel.relay.attach(req, res);
}
