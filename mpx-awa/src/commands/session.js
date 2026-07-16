"use strict";

/**
 * mpx-awa session — Manage AWA sessions.
 *
 * Usage:
 *   mpx-awa session start <domain>     Create a new session
 *   mpx-awa session list                List active sessions
 *   mpx-awa session get <id>            Get session status
 *   mpx-awa session action <id> <action> [params_json]
 *   mpx-awa session end <id>            End a session
 */

const http = require("http");

const WORKER_URL = process.env.AWA_WORKER_URL || "http://localhost:9808";

module.exports = function session(args) {
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help") {
    printSessionHelp();
    return;
  }

  switch (subcommand) {
    case "start":
      return cmdStart(args[1]);
    case "list":
      return cmdList();
    case "get":
      return cmdGet(args[1]);
    case "action":
      return cmdAction(args[1], args[2], args[3]);
    case "end":
      return cmdEnd(args[1]);
    default:
      console.error(`Unknown session command: ${subcommand}`);
      printSessionHelp();
      process.exit(1);
  }
};

function printSessionHelp() {
  console.log(`
mpx-awa session — Manage AWA sessions

USAGE

  mpx-awa session start <domain>       Create a new session
  mpx-awa session list                  List active sessions (via health)
  mpx-awa session get <id>              Get session status
  mpx-awa session action <id> <action>  Dispatch an action
    [params_json]                         Optional JSON params string
  mpx-awa session end <id>              End a session

EXAMPLES

  mpx-awa session start bestbuy.com
  mpx-awa session get sess_abc123
  mpx-awa session action sess_abc123 search '{"query":"laptop"}'
  mpx-awa session end sess_abc123
`);
}

// ─── API helper ─────────────────────────────────────────────────────────────

function apiPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : "";
    const urlObj = new URL(WORKER_URL);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: 60000,
    };

    const req = http.request(options, (res) => {
      let respBody = "";
      res.on("data", (chunk) => (respBody += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(respBody));
        } catch {
          reject(new Error(`Invalid JSON: ${respBody.slice(0, 100)}`));
        }
      });
    });

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(WORKER_URL);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path,
      method: "GET",
      timeout: 10000,
    };

    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Invalid JSON: ${body.slice(0, 100)}`));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

// ─── Commands ───────────────────────────────────────────────────────────────

async function cmdStart(domain) {
  if (!domain) {
    console.error("Usage: mpx-awa session start <domain>");
    process.exit(1);
  }
  try {
    const result = await apiPost("/v1/awa/session/start", { domain });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function cmdList() {
  try {
    const result = await apiGet("/healthz");
    console.log(`Active sessions: ${result.activeSessions} / ${result.maxSessions}`);
    console.log(`Worker status:   ${result.status}`);
    console.log(`Chromium:        ${result.chromiumStatus}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function cmdGet(sessionId) {
  if (!sessionId) {
    console.error("Usage: mpx-awa session get <sessionId>");
    process.exit(1);
  }
  try {
    const result = await apiGet(`/v1/awa/session/${sessionId}`);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function cmdAction(sessionId, actionName, paramsJson) {
  if (!sessionId || !actionName) {
    console.error("Usage: mpx-awa session action <sessionId> <action> [params_json]");
    process.exit(1);
  }
  let params = {};
  if (paramsJson) {
    try {
      params = JSON.parse(paramsJson);
    } catch {
      console.error("Error: params_json must be valid JSON");
      process.exit(1);
    }
  }
  try {
    const result = await apiPost(`/v1/awa/session/${sessionId}/action`, {
      action: actionName,
      params,
    });
    if (result.status === "success") {
      console.log(JSON.stringify(result.data, null, 2));
    } else {
      console.log(`Status: ${result.status}`);
      if (result.errorDetails) {
        console.log(`Error:  ${result.errorDetails}`);
      }
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function cmdEnd(sessionId) {
  if (!sessionId) {
    console.error("Usage: mpx-awa session end <sessionId>");
    process.exit(1);
  }
  try {
    const result = await apiPost(`/v1/awa/session/${sessionId}/end`);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
