"use strict";

/**
 * mpx-awa session — Manage AWA sessions.
 *
 * Usage:
 *   mpx-awa session start <skill_id> --robot <uuid>
 *   mpx-awa session list                List active sessions
 *   mpx-awa session get <id>            Get session status
 *   mpx-awa session action <id> <action> [params_json]
 *   mpx-awa session end <id>            End a session
 */

const http = require("http");

const WORKER_URL = process.env.AWA_WORKER_URL || "http://localhost:9808";
const GATEWAY_URL = process.env.GATEWAY_URL || process.env.MPX_GATEWAY_URL || "http://localhost:8080";

module.exports = function session(args) {
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help") {
    printSessionHelp();
    return;
  }

  switch (subcommand) {
    case "start": {
      const robotIdx = args.indexOf("--robot");
      const robotUuid = robotIdx !== -1 && args[robotIdx + 1] ? args[robotIdx + 1] : null;
      const skillId = args[1];
      return cmdStart(skillId, robotUuid);
    }
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

  mpx-awa session start <skill_id> --robot <uuid>       Create a new session
  mpx-awa session list                                   List active sessions
  mpx-awa session get <id>                               Get session status
  mpx-awa session action <id> <action> [params_json]     Dispatch an action
  mpx-awa session end <id>                               End a session

  --robot is required — verifies the skill is assigned to the robot.

EXAMPLES

  mpx-awa session start haris_dev~amazon --robot MPX-DOG-01
  mpx-awa session get sess_abc123
  mpx-awa session action sess_abc123 search '{"query":"laptop"}'
  mpx-awa session end sess_abc123
`);
}

function gatewayApiGet(path) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(GATEWAY_URL);
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
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Invalid JSON: ${body.slice(0, 100)}`)); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

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
        try { resolve(JSON.parse(respBody)); }
        catch { reject(new Error(`Invalid JSON: ${respBody.slice(0, 100)}`)); }
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
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Invalid JSON: ${body.slice(0, 100)}`)); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function cmdStart(skillId, robotUuid) {
  if (!skillId) {
    console.error("Usage: mpx-awa session start <skill_id> --robot <uuid>");
    process.exit(1);
  }
  if (!robotUuid) {
    console.error("Error: --robot <uuid> is required for session start");
    console.error("Usage: mpx-awa session start <skill_id> --robot <uuid>");
    process.exit(1);
  }
  try {
    const skill = await gatewayApiGet(`/v1/skills/${encodeURIComponent(skillId)}`);
    if (!skill || skill.error) {
      console.error(`Error: skill "${skillId}" not found on gateway`);
      process.exit(1);
    }
    const version = `v${skill.current_version}`;

    const robotSkills = await gatewayApiGet(`/v1/robots/${encodeURIComponent(robotUuid)}/skills`);
    if (!Array.isArray(robotSkills)) {
      console.error(`Error: robot "${robotUuid}" not found on gateway`);
      process.exit(1);
    }
    const assigned = robotSkills.find(s => s.skill_id === skillId);
    if (!assigned) {
      console.error(`Error: skill "${skillId}" is not assigned to robot "${robotUuid}"`);
      const ids = robotSkills.map(s => s.skill_id).join(", ");
      console.error(`Assigned skills: ${ids || "(none)"}`);
      process.exit(1);
    }
    console.error(`  ✓ Skill "${skillId}" verified for robot ${robotUuid}`);

    const result = await apiPost("/v1/awa/session/start", { skill_id: skillId, version, robot_uuid: robotUuid });
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
    try { params = JSON.parse(paramsJson); }
    catch { console.error("Error: params_json must be valid JSON"); process.exit(1); }
  }
  try {
    const result = await apiPost(`/v1/awa/session/${sessionId}/action`, { action: actionName, params });
    if (result.status === "success") {
      console.log(JSON.stringify(result.data, null, 2));
    } else {
      console.log(`Status: ${result.status}`);
      if (result.errorDetails) console.log(`Error:  ${result.errorDetails}`);
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
