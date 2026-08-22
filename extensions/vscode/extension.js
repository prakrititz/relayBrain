const vscode = require("vscode");
const http = require("http");

function post(pathname, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {});
    const req = http.request(
      {
        host: "127.0.0.1",
        port: process.env.RELAY_PORT || 3001,
        path: pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
        timeout: 1500,
      },
      (res) => {
        res.resume();
        resolve();
      }
    );
    req.on("error", () => resolve());
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.write(data);
    req.end();
  });
}

function activate(context) {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) post("/api/ensure-workspace", { workspacePath: folder });

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const root = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath;
      if (!root) return;
      const file = vscode.workspace.asRelativePath(doc.uri).replace(/\\/g, "/");
      post("/api/claim", {
        agentId: `VS Code:${require("os").hostname()}:save`,
        file,
        workspaceId: root,
        mode: "write",
        ttl: 90000,
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("relay.openMissionControl", () => {
      vscode.env.openExternal(vscode.Uri.parse("http://localhost:3002"));
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
