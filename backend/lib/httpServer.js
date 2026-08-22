/** Next's rewrite proxy reuses sockets; Node's 5s keep-alive closes them first → ECONNRESET. */
function hardenHttpServer(server) {
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 0;
  server.timeout = 0;
  server.on("error", (err) => {
    console.error("[relay-api]", err.message);
    process.exitCode = 1;
  });
  server.on("clientError", (err, socket) => {
    if (err?.code === "ECONNRESET" || !socket || socket.destroyed) return;
    try {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch {
      /* already closed */
    }
  });
  return server;
}

function apiErrorHandler(err, _req, res, _next) {
  console.error("[relay-api]", err);
  if (!res.headersSent) res.status(500).json({ error: String(err.message || err) });
}

module.exports = { hardenHttpServer, apiErrorHandler };
