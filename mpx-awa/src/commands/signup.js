"use strict";

/**
 * mpx-awa signup — Register a new developer account.
 *
 * Usage:
 *   mpx-awa signup
 *
 * Interactive prompts — username and hidden password input.
 * Then automatically logs in with the new credentials.
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const TOKEN_FILE = path.join(os.homedir(), ".mpx-awa-token");

function getGatewayUrl(hostOpt) {
  return hostOpt || process.env.MPX_GATEWAY_URL || "http://localhost:8080";
}

/**
 * Prompt with hidden input (no echo).
 * Uses stty to toggle echo on Unix.
 */
function promptHidden(question) {
  if (!process.stdin.isTTY) {
    return Promise.resolve("");
  }
  const { execSync } = require("child_process");
  return new Promise((resolve) => {
    // Disable echo
    try { execSync("stty -echo", { stdio: "ignore" }); } catch {}

    process.stdout.write(`  ${question}: `);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,  // don't do any readline terminal processing
    });

    rl.on("line", (answer) => {
      // Re-enable echo
      try { execSync("stty echo", { stdio: "ignore" }); } catch {}
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

function apiPost(url, jsonBody) {
  const urlObj = new URL(url);
  const body = JSON.stringify(jsonBody);
  const mod = urlObj.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 15000,
    };

    const req = mod.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: { raw: data } });
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    req.write(body);
    req.end();
  });
}

function prompt(question, defaultValue) {
  if (!process.stdin.isTTY) {
    return Promise.resolve(defaultValue || "");
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    const hint = defaultValue ? ` (${defaultValue})` : "";
    rl.question(`  ${question}${hint}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

module.exports = async function signup(hostOpt) {
  const gatewayUrl = getGatewayUrl(hostOpt);
  const signupUrl = `${gatewayUrl.replace(/\/+$/, "")}/v1/auth/signup`;

  console.log(`\n  📝 Create a new developer account on ${gatewayUrl}\n`);

  const username = await prompt("Username");
  if (!username) {
    console.error("  ✗ Username is required.");
    process.exit(1);
  }
  if (username.length < 3) {
    console.error("  ✗ Username must be at least 3 characters.");
    process.exit(1);
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_-]+$/.test(username)) {
    console.error("  ✗ Username must start with a letter and contain only letters, numbers, underscores, and hyphens.");
    process.exit(1);
  }

  const password = await promptHidden("Password");
  if (!password) {
    console.error("  ✗ Password is required.");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("  ✗ Password must be at least 8 characters.");
    process.exit(1);
  }

  const confirm = await promptHidden("Confirm password");
  if (password !== confirm) {
    console.error("  ✗ Passwords do not match.");
    process.exit(1);
  }

  console.log(`\n  Registering "${username}"...`);

  const res = await apiPost(signupUrl, { username, password });

  if (res.status === 201) {
    console.log(`  ✅ Account created!`);

    // Auto-login
    const loginUrl = `${gatewayUrl.replace(/\/+$/, "")}/v1/auth/login`;
    const loginRes = await apiPost(loginUrl, { username, password });

    if (loginRes.status === 200 && loginRes.body.token) {
      fs.writeFileSync(TOKEN_FILE, loginRes.body.token, "utf-8");
      fs.chmodSync(TOKEN_FILE, 0o600);
      console.log(`  🔑 Logged in automatically. Token stored at ${TOKEN_FILE}`);
    } else {
      const msg = loginRes.body.error || `HTTP ${loginRes.status}`;
      console.log(`  ⚠️  Account created but auto-login failed: ${msg}`);
      console.log("     Run 'mpx-awa login' to authenticate.");
    }
  } else {
    const msg = res.body.error || `HTTP ${res.status}`;
    console.error(`  ✗ Signup failed: ${msg}`);
    process.exit(1);
  }
};
