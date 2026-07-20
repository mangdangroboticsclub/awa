"use strict";

/**
 * mpx-awa robot — Show robot info and assigned skills.
 *
 * Usage:
 *   mpx-awa robot <uuid>
 *
 * Fetches robot info and assigned skills from the gateway.
 */

const http = require("http");

const GATEWAY_URL = process.env.MPX_GATEWAY_URL || "http://localhost:8080";

module.exports = function robot(uuid, hostOpt) {
  const baseUrl = hostOpt || GATEWAY_URL;

  if (!uuid) {
    console.error("Error: missing robot UUID.\nUsage: mpx-awa robot <uuid>");
    process.exit(1);
  }

  const urlObj = new URL(baseUrl);
  const apiHost = urlObj.hostname;
  const apiPort = urlObj.port;

  // Fetch robot info
  const infoPath = `/v1/robots/${encodeURIComponent(uuid)}`;
  const skillsPath = `/v1/robots/${encodeURIComponent(uuid)}/skills`;

  gatewayGet(apiHost, apiPort, infoPath, (err, infoData) => {
    if (err) {
      console.error(`Error fetching robot: ${err.message}`);
      process.exit(1);
    }
    if (!infoData || infoData.error) {
      console.error(`Error: robot "${uuid}" not found on gateway`);
      process.exit(1);
    }

    console.log(`Robot: ${infoData.robot_uuid}`);
    console.log(`Created: ${infoData.created_at || "unknown"}`);
    if (infoData.last_seen_at) {
      console.log(`Last seen: ${infoData.last_seen_at}`);
    }
    console.log("");

    // Fetch assigned skills
    gatewayGet(apiHost, apiPort, skillsPath, (err2, skillsData) => {
      if (err2) {
        console.error(`Error fetching skills: ${err2.message}`);
        process.exit(1);
      }

      const skills = Array.isArray(skillsData) ? skillsData : [];
      if (skills.length === 0) {
        console.log("Assigned skills: (none)");
      } else {
        console.log(`Assigned skills (${skills.length}):`);
        for (const s of skills) {
          const version = s.current_version ? `v${s.current_version}` : "?";
          const title = s.title || s.skill_id;
          console.log(`  ${s.skill_id} (${version}) — ${title}`);
        }
      }
    });
  });
};

function gatewayGet(hostname, port, path, callback) {
  const options = {
    hostname,
    port,
    path,
    method: "GET",
    timeout: 10000,
  };
  const req = http.request(options, (res) => {
    let body = "";
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => {
      if (res.statusCode === 404) {
        return callback(null, { error: "not found" });
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return callback(new Error(`HTTP ${res.statusCode}`));
      }
      try {
        callback(null, JSON.parse(body));
      } catch {
        callback(new Error(`Invalid JSON: ${body.slice(0, 100)}`));
      }
    });
  });
  req.on("error", callback);
  req.end();
}
