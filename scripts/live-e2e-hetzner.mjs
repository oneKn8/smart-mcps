#!/usr/bin/env node
// Live end-to-end proof for hetzner-smart: provision the cheapest x86 shared
// server, wait for it to reach `running` with a public IPv4, then delete it and
// wait for the delete action to settle. The server is torn down in a `finally`
// block so a real (billed) resource is never leaked, even if an assertion fails.
//
// Requires a Read & Write HETZNER_API_TOKEN (env or ~/.config/smart-mcps/.env)
// and a built package (`npm run build --workspace hetzner-smart`).
//
//   node scripts/live-e2e-hetzner.mjs            # create -> verify -> destroy
//   HETZNER_E2E_LOCATION=fsn1 node scripts/live-e2e-hetzner.mjs
//
// Exit 0 = full cycle verified. Non-zero = a step failed (details on stderr).

import { HetznerClient } from "../packages/hetzner-smart/dist/client.js";

const LOCATION = process.env.HETZNER_E2E_LOCATION ?? "nbg1";
const IMAGE = process.env.HETZNER_E2E_IMAGE ?? "ubuntu-24.04";
const NAME = `hetzner-smart-e2e-${Math.floor(Date.now() / 1000)}`;

function log(step, msg) {
  process.stdout.write(`[e2e] ${step}: ${msg}\n`);
}

function toNum(v) {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

// Cheapest non-deprecated x86 shared-vCPU type available in LOCATION, by monthly net.
async function cheapestType(client) {
  const types = await client.getAllPages("/server_types", "server_types");
  let best = null;
  for (const t of types) {
    if (t?.deprecated) continue;
    if (t?.architecture && t.architecture !== "x86") continue;
    if (t?.cpu_type && t.cpu_type !== "shared") continue;
    const row = Array.isArray(t?.prices)
      ? t.prices.find((p) => p?.location === LOCATION)
      : undefined;
    const monthly = toNum(row?.price_monthly?.net);
    if (monthly == null) continue;
    if (!best || monthly < best.monthly) best = { name: t.name, monthly };
  }
  if (!best) throw new Error(`no x86 shared server type priced in location ${LOCATION}`);
  return best;
}

async function main() {
  const client = new HetznerClient(); // throws AuthError if token missing

  const pick = await cheapestType(client);
  log("plan", `cheapest x86 shared in ${LOCATION}: ${pick.name} (EUR ${pick.monthly.toFixed(2)}/mo) image=${IMAGE}`);

  let serverId = null;
  try {
    const created = await client.createServer({
      name: NAME,
      server_type: pick.name,
      image: IMAGE,
      location: LOCATION,
      start_after_create: true,
      public_net: { enable_ipv4: true, enable_ipv6: true },
    });
    const server = created?.server;
    serverId = server?.id ?? null;
    if (!serverId) throw new Error("createServer returned no server id");
    log("create", `server ${serverId} (${NAME}) requested`);

    const createAction = client.extractAction(created);
    if (createAction) {
      log("create", `waiting on action ${createAction.id} (${createAction.command})...`);
      await client.waitForAction(createAction.id, { timeoutMs: 180000 });
    }

    // Poll the server itself until it is running with a public IPv4.
    let running = null;
    for (let i = 0; i < 30; i++) {
      const s = await client.getServer(serverId);
      const ipv4 = s?.public_net?.ipv4?.ip ?? null;
      if (s?.status === "running" && ipv4) {
        running = { status: s.status, ipv4 };
        break;
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
    if (!running) throw new Error(`server ${serverId} never reached running with an IPv4`);
    log("verify", `server ${serverId} is ${running.status} at ${running.ipv4} — PASS`);
  } finally {
    if (serverId) {
      try {
        const del = await client.deleteServer(serverId);
        const delAction = client.extractAction(del);
        if (delAction) await client.waitForAction(delAction.id, { timeoutMs: 120000 });
        log("cleanup", `server ${serverId} deleted`);
      } catch (err) {
        process.stderr.write(
          `[e2e] cleanup FAILED for server ${serverId} — DELETE IT MANUALLY in the Hetzner console: ${String(err)}\n`,
        );
        throw err;
      }
    }
  }

  log("done", "live create -> verify -> destroy cycle complete");
}

main().catch((err) => {
  process.stderr.write(`[e2e] FAILED: ${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
