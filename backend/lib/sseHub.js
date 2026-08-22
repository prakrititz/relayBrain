class SseHub {
  constructor() {
    this.clients = new Set();
  }

  subscribe(res, filter = {}) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const client = { res, filter };
    this.clients.add(client);
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, ts: Date.now() })}\n\n`);
    res.on("close", () => this.clients.delete(client));
    return client;
  }

  emit(event, payload) {
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) {
      const { workspaceId } = client.filter;
      if (
        event !== "notice" &&
        workspaceId &&
        payload.workspaceId &&
        payload.workspaceId !== workspaceId
      ) {
        continue;
      }
      try {
        client.res.write(data);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

module.exports = { SseHub };
