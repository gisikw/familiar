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
  // Restty can continue calling sendInput while its canvas is alive after the
  // old socket has been closed. Keep those keystrokes until the replacement
  // socket is connected instead of silently writing to the dead transport.
  const pendingInput = [];

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
        while (pendingInput.length && inner.isConnected()) {
          const data = pendingInput.shift();
          if (data !== undefined) inner.sendInput(data);
        }
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

  const recover = () => {
    if (!stopped && !connecting && !inner.isConnected()) {
      clearRetry();
      inner.destroy?.();
      inner = createTransport();
      open();
    }
  };
  const onFocus = () => recover();
  const onVisibility = () => {
    if (focusTarget?.document?.visibilityState === "visible") recover();
  };
  focusTarget?.addEventListener?.("focus", onFocus);
  focusTarget?.addEventListener?.("visibilitychange", onVisibility);
  focusTarget?.addEventListener?.("pageshow", recover);

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
    sendInput(data) {
      if (inner.isConnected()) return inner.sendInput(data);
      if (!stopped && !destroyed) {
        pendingInput.push(data);
        recover();
      }
      return false;
    },
    resize(cols, rows, meta) { return inner.resize(cols, rows, meta); },
    isConnected() { return inner.isConnected(); },
    destroy() {
      destroyed = true;
      stopped = true;
      connecting = false;
      clearRetry();
      focusTarget?.removeEventListener?.("focus", onFocus);
      focusTarget?.removeEventListener?.("visibilitychange", onVisibility);
      focusTarget?.removeEventListener?.("pageshow", recover);
      pendingInput.length = 0;
      return inner.destroy?.();
    },
  };
}
