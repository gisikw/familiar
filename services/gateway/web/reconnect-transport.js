const DEFAULT_RETRY_MS = 250;
const MAX_RETRY_MS = 5000;

// Add browser lifecycle recovery around Restty's WebSocket transport. The
// server owns WebSocket ping/pong heartbeats; this layer reconnects after a
// heartbeat closes a stale socket and probes immediately when a backgrounded
// tab regains focus.
export function createReconnectPtyTransport(createTransport, {
  focusTarget = globalThis.window,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
} = {}) {
  let inner = createTransport();
  let options = null;
  let retryTimer = null;
  let retryMs = DEFAULT_RETRY_MS;
  let connecting = false;
  let stopped = true;
  let destroyed = false;

  const clearRetry = () => {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  };

  const open = () => {
    if (!options || stopped || destroyed || connecting || inner.isConnected()) return;
    clearRetry();
    connecting = true;
    const userCallbacks = options.callbacks || {};
    const callbacks = {
      ...userCallbacks,
      onConnect: () => {
        connecting = false;
        retryMs = DEFAULT_RETRY_MS;
        userCallbacks.onConnect?.();
      },
      onDisconnect: () => {
        connecting = false;
        userCallbacks.onDisconnect?.();
        scheduleReconnect();
      },
    };
    inner.connect({ ...options, callbacks });
  };

  const scheduleReconnect = () => {
    if (!options || stopped || destroyed || retryTimer !== null) return;
    const delay = retryMs;
    retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
    retryTimer = setTimer(() => {
      retryTimer = null;
      // A fresh Restty transport avoids stale lifecycle state from a socket
      // whose close callback raced the reconnect timer.
      inner.destroy?.();
      inner = createTransport();
      open();
    }, delay);
  };

  const onFocus = () => {
    if (!stopped && !connecting && !inner.isConnected()) {
      clearRetry();
      inner.destroy?.();
      inner = createTransport();
      open();
    }
  };
  focusTarget?.addEventListener?.("focus", onFocus);

  return {
    connect(nextOptions) {
      options = nextOptions;
      stopped = false;
      retryMs = DEFAULT_RETRY_MS;
      open();
    },
    disconnect() {
      stopped = true;
      connecting = false;
      clearRetry();
      inner.disconnect();
    },
    sendInput(data) { return inner.sendInput(data); },
    resize(cols, rows, meta) { return inner.resize(cols, rows, meta); },
    isConnected() { return inner.isConnected(); },
    destroy() {
      destroyed = true;
      stopped = true;
      connecting = false;
      clearRetry();
      focusTarget?.removeEventListener?.("focus", onFocus);
      return inner.destroy?.();
    },
  };
}
