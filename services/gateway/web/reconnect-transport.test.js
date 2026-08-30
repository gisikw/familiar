import test from "node:test";
import assert from "node:assert/strict";
import { createReconnectPtyTransport } from "./reconnect-transport.js";

function harness() {
  const transports = [];
  const timers = [];
  let focusListener;
  let visibilityListener;
  const focusTarget = {
    addEventListener(type, fn) {
      if (type === "focus") focusListener = fn;
      if (type === "visibilitychange") visibilityListener = fn;
    },
    removeEventListener(type, fn) {
      if (type === "focus" && focusListener === fn) focusListener = undefined;
      if (type === "visibilitychange" && visibilityListener === fn) visibilityListener = undefined;
    },
    document: { visibilityState: "hidden" },
  };
  const createTransport = () => {
    const transport = {
      connected: false,
      options: null,
      destroyed: false,
      sent: [],
      connect(options) { this.options = options; },
      disconnect() { this.connected = false; },
      sendInput(data) { if (this.connected) this.sent.push(data); return this.connected; },
      resize() { return this.connected; },
      isConnected() { return this.connected; },
      destroy() { this.destroyed = true; },
      opened() { this.connected = true; this.options.callbacks.onConnect?.(); },
      dropped() { this.connected = false; this.options.callbacks.onDisconnect?.(); },
    };
    transports.push(transport);
    return transport;
  };
  const transport = createReconnectPtyTransport(createTransport, {
    focusTarget,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
  });
  return { transport, transports, timers, focus: () => focusListener?.(), visible: () => { focusTarget.document.visibilityState = "visible"; visibilityListener?.(); } };
}

test("reconnects with backoff after a dropped WebSocket", () => {
  const h = harness();
  let disconnects = 0;
  h.transport.connect({ url: "ws://example/pty", callbacks: { onDisconnect: () => disconnects++ } });
  h.transports[0].opened();
  h.transports[0].dropped();

  assert.equal(disconnects, 1);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 250);
  h.timers[0].fn();
  assert.equal(h.transports.length, 2);
  assert.equal(h.transports[1].options.url, "ws://example/pty");
});

test("input during a dead socket is delivered after reconnect", () => {
  const h = harness();
  h.transport.connect({ url: "ws://example/pty", callbacks: {} });
  h.transports[0].opened();
  h.transports[0].dropped();
  assert.equal(h.transport.sendInput("k"), false);
  assert.equal(h.transports.length, 2);
  h.transports[1].opened();
  assert.deepEqual(h.transports[1].sent, ["k"]);
});

test("focus reconnects immediately and cancels a pending retry", () => {
  const h = harness();
  h.transport.connect({ url: "ws://example/pty", callbacks: {} });
  h.transports[0].opened();
  h.transports[0].dropped();
  h.focus();

  assert.equal(h.timers[0].cleared, true);
  assert.equal(h.transports.length, 2);
  assert.equal(h.transports[1].options.url, "ws://example/pty");
});

test("explicit disconnect and destroy suppress recovery", () => {
  const h = harness();
  h.transport.connect({ url: "ws://example/pty", callbacks: {} });
  h.transports[0].opened();
  h.transport.disconnect();
  h.focus();
  assert.equal(h.transports.length, 1);

  h.transport.destroy();
  h.focus();
  assert.equal(h.transports.length, 1);
});
