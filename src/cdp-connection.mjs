export class CdpConnection {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.eventListeners = new Map();
    this.ws = null;
  }

  async connect({ timeoutMs = 5000 } = {}) {
    if (this.ws?.readyState === WebSocket.OPEN) return this;

    const ws = new WebSocket(this.url);
    this.ws = ws;

    await withTimeout(
      new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", () => reject(new Error(`CDP websocket failed: ${this.url}`)), {
          once: true,
        });
      }),
      timeoutMs,
      `Timed out connecting to CDP websocket: ${this.url}`,
    );

    ws.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
    ws.addEventListener("close", () => {
      this.rejectPending(new Error(`CDP websocket closed: ${this.url}`));
    });
    ws.addEventListener("error", () => {
      this.rejectPending(new Error(`CDP websocket errored: ${this.url}`));
    });

    return this;
  }

  async send(method, params = {}, { timeoutMs = 10000 } = {}) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error(`CDP websocket is not open: ${this.url}`);
    }

    const id = this.nextId++;
    const payload = { id, method, params };

    const response = await withTimeout(
      new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.ws.send(JSON.stringify(payload));
      }),
      timeoutMs,
      `Timed out waiting for CDP method ${method}`,
    ).finally(() => {
      this.pending.delete(id);
    });

    if (response.error) {
      const message = response.error.message ?? JSON.stringify(response.error);
      throw new Error(`CDP ${method} failed: ${message}`);
    }

    return response.result ?? {};
  }

  waitForEvent(method, { timeoutMs = 10000, predicate = () => true } = {}) {
    return withTimeout(
      new Promise((resolve) => {
        const listener = (params) => {
          if (!predicate(params)) return;
          this.removeEventListener(method, listener);
          resolve(params);
        };
        this.addEventListener(method, listener);
      }),
      timeoutMs,
      `Timed out waiting for CDP event ${method}`,
    );
  }

  addEventListener(method, listener) {
    const listeners = this.eventListeners.get(method) ?? new Set();
    listeners.add(listener);
    this.eventListeners.set(method, listeners);
  }

  removeEventListener(method, listener) {
    this.eventListeners.get(method)?.delete(listener);
  }

  async close() {
    const ws = this.ws;
    this.ws = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;

    await new Promise((resolve) => {
      const done = () => resolve();
      ws.addEventListener("close", done, { once: true });
      setTimeout(done, 500).unref?.();
      ws.close();
    });
  }

  async handleMessage(data) {
    const text = await messageDataToText(data);
    const message = JSON.parse(text);

    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (pending) pending.resolve(message);
      return;
    }

    if (typeof message.method === "string") {
      for (const listener of this.eventListeners.get(message.method) ?? []) {
        listener(message.params ?? {});
      }
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function withTimeout(promise, timeoutMs, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

async function messageDataToText(data) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (typeof data?.text === "function") return await data.text();
  return String(data);
}
