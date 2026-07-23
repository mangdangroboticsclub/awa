#!/usr/bin/env node
"use strict";

/**
 * mpx-awa — OpenClaw Agentic Web Actions (AWA) CLI
 *
 * Commands:
 *   init <domain>              Scaffold a new skill
 *   init <slug>@<domain>       Multiple skills for same domain
 *   signup                     Interactive registration with hidden password
 *   login <user> <pass>        Authenticate and store a JWT token
 *   logout                     Clear the stored JWT token
 *   publish <domain>           Publish a skill to the marketplace
 *   list                       List all marketplace skills
 *   versions <skill_id>        List versions of a skill
 *   readme <skill_id>          Show manifest JSON for a skill
 *   session start <domain>     Create a new session
 *   session list               List active sessions
 *   session get <id>           Get session status
 *   session action <id> <action> [params]
 *   session end <id>           End a session
 *   --help                     Show help
 *   --version                  Show version
 *
 * Gateway host (for login/publish):
 *   Set MPX_GATEWAY_URL env var, or pass --gateway <url> before the subcommand.
 *
 * Environment (.env) loading:
 *   CWD .env takes priority; falls back to .env inside the mpx-awa package.
 *   Neither file needs to exist — defaults are used when vars are unset.
 */

const path = require("path");

// Load .env files (don't override already-set env vars)
// Priority: CWD .env (user intent) → package .env (shipped default)
try {
  const dotenv = require("dotenv");

  // 1) Per-project .env in current working directory (highest priority)
  const cwdEnv = path.join(process.cwd(), ".env");
  dotenv.config({ path: cwdEnv, override: false });

  // 2) .env inside mpx-awa's own installation directory (fallback)
  const pkgEnv = path.resolve(__dirname, "..", ".env");
  dotenv.config({ path: pkgEnv, override: false });
} catch (_) {
  // dotenv not installed — env vars must be set in the shell
}

const CLI_NAME = "mpx-awa";
const CLI_VERSION = require("../package.json").version;

function printHelp() {
  console.log(`
${CLI_NAME} v${CLI_VERSION} — OpenClaw Agentic Web Actions SDK

  CLI for scaffolding, publishing, and testing AWA merchant skills.

USAGE

  Scaffolding:
    ${CLI_NAME} init <domain>                   Create a new skill scaffold
    ${CLI_NAME} init <slug>@<domain>            Multiple skills for same domain

  Marketplace discovery (requires MPX gateway):
    ${CLI_NAME} list                             List all marketplace skills
    ${CLI_NAME} robot <uuid>                     Show robot info and assigned skills
    ${CLI_NAME} versions <skill_id>              List versions of a skill
    ${CLI_NAME} readme <skill_id>                Show manifest JSON for a skill

  Authentication & publishing (requires MPX gateway):
    ${CLI_NAME} signup                           Register a new account
    ${CLI_NAME} login <username> <password>      Authenticate and store token
    ${CLI_NAME} logout                           Clear the stored token
    ${CLI_NAME} publish <domain>                 Publish skill to marketplace

  Session management (requires worker at AWA_WORKER_URL, default http://localhost:9808):
    ${CLI_NAME} session start <skill_id>         Create a new session
    ${CLI_NAME} session list                     List active sessions
    ${CLI_NAME} session get <id>                 Get session status
    ${CLI_NAME} session action <id> <action> [params]  Dispatch action
    ${CLI_NAME} session end <id>                 End a session

  General:
    ${CLI_NAME} --help                           Show this help
    ${CLI_NAME} --version                        Show version

EXAMPLES

  # Scaffold a skill
  ${CLI_NAME} init bestbuy.com
  ${CLI_NAME} init price-tracker@bestbuy.com    # second skill for same site

  # Login (stored token at ~/.mpx-awa-token)
  ${CLI_NAME} login haris_dev password123
  MPX_GATEWAY_URL=http://<gateway-host>:8080 ${CLI_NAME} login mangdang_dev pupper_secure

  # List and discover skills
  ${CLI_NAME} list
  ${CLI_NAME} versions haris_dev~my-scraper
  ${CLI_NAME} readme haris_dev~my-scraper
  ${CLI_NAME} readme haris_dev~my-scraper --version v1.0.0

  # Publish to the gateway
  ${CLI_NAME} publish bestbuy.com
  MPX_GATEWAY_URL=http://<gateway-host>:8080 ${CLI_NAME} publish amazon.com

  # Start a session against the worker
  ${CLI_NAME} session start haris_dev~amazon

  # Dispatch actions
  ${CLI_NAME} session action sess_abc search '{"query":"laptop"}'
  ${CLI_NAME} session action sess_abc getProduct '{"sku":"123","targetUrl":"..."}'
  ${CLI_NAME} session end sess_abc

ENVIRONMENT

${(() => {
  const gw = process.env.MPX_GATEWAY_URL;
  const wk = process.env.AWA_WORKER_URL;
  const gwLine = gw
    ? `  MPX_GATEWAY_URL    ${gw}`
    : `  MPX_GATEWAY_URL    (not set, default: http://localhost:8080)`;
  const wkLine = wk
    ? `  AWA_WORKER_URL     ${wk}`
    : `  AWA_WORKER_URL     (not set, default: http://localhost:9808)`;
  return `${gwLine}\n${wkLine}`;
})()}
`);
}

function main() {
  let args = process.argv.slice(2);
  let hostOpt = null;

  // Extract --gateway <url> if present (global before subcommand)
  const gwIdx = args.indexOf("--gateway");
  if (gwIdx !== -1 && args[gwIdx + 1]) {
    hostOpt = args[gwIdx + 1];
    args = args.filter((_, i) => i !== gwIdx && i !== gwIdx + 1);
  }

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  if (args[0] === "--version" || args[0] === "-v") {
    console.log(CLI_VERSION);
    process.exit(0);
  }

  if (args[0] === "init") {
    const domain = args[1];
    if (!domain) { console.error("Error: missing domain.\nUsage: mpx-awa init <domain>"); process.exit(1); }
    require("../src/commands/init")(domain);
    return;
  }

  if (args[0] === "signup") {
    require("../src/commands/signup")(hostOpt);
    return;
  }

  if (args[0] === "logout") {
    require("../src/commands/logout")();
    return;
  }

  if (args[0] === "login") {
    const username = args[1];
    const password = args[2];
    if (!username || !password) {
      console.error("Error: missing arguments.\nUsage: mpx-awa login <username> <password>");
      process.exit(1);
    }
    require("../src/commands/login")(username, password, hostOpt);
    return;
  }

  if (args[0] === "list") {
    require("../src/commands/list")(hostOpt);
    return;
  }

  if (args[0] === "versions") {
    const skillId = args[1];
    if (!skillId) {
      console.error("Error: missing skill_id.\nUsage: mpx-awa versions <skill_id>");
      process.exit(1);
    }
    require("../src/commands/versions")(skillId, hostOpt);
    return;
  }

  if (args[0] === "readme") {
    const skillId = args[1];
    if (!skillId) {
      console.error("Error: missing skill_id.\nUsage: mpx-awa readme <skill_id>");
      process.exit(1);
    }
    // Check for --json flag on this subcommand
    const jsonFlag = args.includes("--json");
    // Check for --version flag on this subcommand
    const versionIdx = args.indexOf("--version");
    const versionOpt = versionIdx !== -1 && args[versionIdx + 1] ? args[versionIdx + 1] : null;
    require("../src/commands/readme")(skillId, { host: hostOpt, json: jsonFlag, version: versionOpt });
    return;
  }

  if (args[0] === "robot") {
    const uuid = args[1];
    if (!uuid) {
      console.error("Error: missing robot UUID.\nUsage: mpx-awa robot <uuid>");
      process.exit(1);
    }
    require("../src/commands/robot")(uuid, hostOpt);
    return;
  }

  if (args[0] === "publish") {
    const domain = args[1];
    if (!domain) {
      console.error("Error: missing domain.\nUsage: mpx-awa publish <domain>");
      process.exit(1);
    }
    require("../src/commands/publish")(domain, hostOpt);
    return;
  }

  if (args[0] === "session") {
    require("../src/commands/session")(args.slice(1));
    return;
  }

  console.error(`Unknown command: ${args[0]}`);
  console.error(`Run "${CLI_NAME} --help" for usage.`);
  process.exit(1);
}

main();
