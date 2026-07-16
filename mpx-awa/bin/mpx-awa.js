#!/usr/bin/env node
"use strict";

/**
 * mpx-awa — OpenClaw Agentic Web Actions (AWA) CLI
 *
 * Commands:
 *   init <domain>              Scaffold a new skill
 *   seed <domain>              Seed a skill to the GCS emulator
 *   list                       List all seeded skills in the bucket
 *   delete <domain>            Delete a skill from the bucket
 *   readme <domain>            Show a skill's README/help
 *   readme <domain> --set ...  Set/update a skill's README
 *   session start <domain>     Create a new session
 *   session list               List active sessions
 *   session get <id>           Get session status
 *   session action <id> <action> [params]
 *   session end <id>           End a session
 *   --help                     Show help
 *   --version                  Show version
 */

const CLI_NAME = "mpx-awa";
const CLI_VERSION = require("../package.json").version;

function printHelp() {
  console.log(`
${CLI_NAME} v${CLI_VERSION} — OpenClaw Agentic Web Actions SDK

  CLI for scaffolding, seeding, and testing AWA merchant skills.

USAGE

  Scaffolding:
    ${CLI_NAME} init <domain>              Create a new skill scaffold

  Skill management (requires GCS emulator at GCS_EMULATOR_URL):
    ${CLI_NAME} seed <domain>              Upload skill to GCS emulator
    ${CLI_NAME} list                       List all seeded skills
    ${CLI_NAME} delete <domain>            Delete a skill from the bucket
    ${CLI_NAME} readme <domain>            Show a skill's README
    ${CLI_NAME} readme <domain> --set ...  Set/update a skill's README

  Session management (requires worker at AWA_WORKER_URL, default http://localhost:9808):
    ${CLI_NAME} session start <domain>     Create a new session
    ${CLI_NAME} session list               List active sessions
    ${CLI_NAME} session get <id>           Get session status
    ${CLI_NAME} session action <id> <action> [params]  Dispatch action
    ${CLI_NAME} session end <id>           End a session

  General:
    ${CLI_NAME} --help                     Show this help
    ${CLI_NAME} --version                  Show version

EXAMPLES

  # Scaffold a skill
  ${CLI_NAME} init bestbuy.com

  # Seed to GCS emulator
  ${CLI_NAME} seed bestbuy.com

  # List all seeded skills
  ${CLI_NAME} list

  # Delete a skill from the bucket
  ${CLI_NAME} delete bestbuy.com

  # View a skill's README
  ${CLI_NAME} readme bestbuy.com

  # Set a skill's README
  ${CLI_NAME} readme bestbuy.com --set "Search and purchase products on BestBuy."

  # Start a session
  ${CLI_NAME} session start bestbuy.com

  # Dispatch actions
  ${CLI_NAME} session action sess_abc search '{"query":"laptop"}'
  ${CLI_NAME} session action sess_abc getProduct '{"sku":"123","targetUrl":"..."}'
  ${CLI_NAME} session end sess_abc

ENVIRONMENT

  AWA_WORKER_URL     Worker URL (default: http://localhost:9808)
  GCS_EMULATOR_URL   GCS emulator URL (default: http://localhost:4443)
  GCS_BUCKET         GCS bucket name (default: awa-skills-dev)
`);
}

function main() {
  const args = process.argv.slice(2);

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

  if (args[0] === "seed") {
    const domain = args[1];
    if (!domain) { console.error("Error: missing domain.\nUsage: mpx-awa seed <domain>"); process.exit(1); }
    require("../src/commands/seed")(domain);
    return;
  }

  if (args[0] === "list") {
    require("../src/commands/list")();
    return;
  }

  if (args[0] === "delete") {
    const domain = args[1];
    if (!domain) { console.error("Error: missing domain.\nUsage: mpx-awa delete <domain>"); process.exit(1); }
    require("../src/commands/delete")(domain);
    return;
  }

  if (args[0] === "readme") {
    const domain = args[1];
    if (!domain) { console.error("Error: missing domain.\nUsage: mpx-awa readme <domain> [--set <text>|--json]"); process.exit(1); }

    const setIdx = args.indexOf("--set");
    const jsonFlag = args.includes("--json");

    if (setIdx !== -1 && args[setIdx + 1]) {
      // Readme text is everything after --set
      const setText = args.slice(setIdx + 1).join(" ");
      require("../src/commands/readme")(domain, setText);
    } else if (jsonFlag) {
      require("../src/commands/readme")(domain, { json: true });
    } else {
      require("../src/commands/readme")(domain);
    }
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
