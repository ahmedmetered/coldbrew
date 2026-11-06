// Running the Google Maps scraper (gosom/google-maps-scraper) for you, in Docker, on your machine. Optional: needs Docker
// Desktop (or a Docker daemon) running. Its CSV is the richest source Coldbrew has (phone, website, reviews, emails).
// This only reads Google Maps listings the way a visitor would; keep the depth modest and use it for your own outreach.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { parseProspectCsv } from "./sources.mjs";
import { now } from "./db.mjs";
import * as core from "./core.mjs";

const IMAGE = "gosom/google-maps-scraper";

// one query per kind and place, like the sweep method in anydeals: many small queries beat one big one
export function buildQueries(kinds, places) {
  const list = v => (Array.isArray(v) ? v : String(v || "").split(/[\n,]/)).map(s => s.trim()).filter(Boolean);
  const out = new Set(); for (const k of list(kinds)) for (const p of list(places)) out.add(`${k} ${p}`);
  return [...out];
}
export function dockerArgs({ dir, depth = 5, lang = "it", email = false, concurrency = 2, name = "coldbrew-scrape" }) {
  const args = ["run", "--rm", "--name", name, "-v", `${dir}:/work`, IMAGE, "-input", "/work/queries.txt", "-results", "/work/results.csv", "-depth", String(Math.min(Math.max(Math.floor(depth) || 5, 1), 15)), "-lang", String(lang).slice(0, 5), "-c", String(concurrency), "-exit-on-inactivity", "3m"];
  if (email) args.push("-email");
  return args;
}
// is Docker there and awake?
export function dockerReady(spawnImpl = nodeSpawn) {
  return new Promise(resolve => {
    let done = false, err = "";
    const fin = v => { if (!done) { done = true; resolve(v); } };
    let p; try { p = spawnImpl("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: ["ignore", "pipe", "pipe"] }); } catch { return fin({ ok: false, reason: "Docker is not installed. Install Docker Desktop, or import the scraper's CSV instead." }); }
    p.stderr?.on("data", d => { err += d; }); p.on("error", () => fin({ ok: false, reason: "Docker is not installed. Install Docker Desktop, or import the scraper's CSV instead." }));
    p.on("close", code => fin(code === 0 ? { ok: true, reason: "" } : { ok: false, reason: /daemon|pipe|connect/i.test(err) ? "Docker is installed but not running. Start Docker Desktop and try again." : "Docker did not answer: " + err.trim().slice(0, 160) }));
    setTimeout(() => fin({ ok: false, reason: "Docker did not answer in time." }), 15000).unref?.();
  });
}

export function createScraper(db, { spawnImpl = nodeSpawn, dataDir = path.resolve("data/scrape") } = {}) {
  const jobs = new Map();
  const view = j => ({ id: j.id, campaignId: j.campaignId, status: j.status, queries: j.queries.length, startedAt: j.startedAt, finishedAt: j.finishedAt || null, log: j.log.slice(-12), result: j.result || null, error: j.error || null });
  async function start(userId, campaignId, { kinds, places, depth = 5, email = false }) {
    const c = core.getCampaign(db, userId, campaignId); if (!c) throw Object.assign(new Error("Campaign not found."), { status: 404 });
    const queries = buildQueries(kinds, places); if (!queries.length) throw Object.assign(new Error("Give at least one kind of business and one place."), { status: 400 });
    if (queries.length > 80) throw Object.assign(new Error("That is more than 80 queries. Split it into smaller runs."), { status: 400 });
    if ([...jobs.values()].some(j => j.status === "running")) throw Object.assign(new Error("A scraper run is already going."), { status: 409 });
    const ready = await dockerReady(spawnImpl); if (!ready.ok) throw Object.assign(new Error(ready.reason), { status: 400 });
    const id = crypto.randomBytes(4).toString("hex"), dir = path.resolve(dataDir, id); fs.mkdirSync(dir, { recursive: true }); // docker needs an absolute host path
    fs.writeFileSync(path.join(dir, "queries.txt"), queries.join("\n") + "\n"); fs.writeFileSync(path.join(dir, "results.csv"), "");
    const name = `coldbrew-scrape-${id}`, job = { id, userId, campaignId, status: "running", queries, startedAt: now(), log: [], name, dir };
    jobs.set(id, job);
    const p = spawnImpl("docker", dockerArgs({ dir, depth, lang: c.language === "en" ? "en" : "it", email, name }), { stdio: ["ignore", "pipe", "pipe"] });
    const keep = d => { // the scraper logs JSON lines; show a short human line instead
      for (const l of String(d).split(/\r?\n/)) {
        if (!l.trim()) continue; let s = l.trim();
        if (s[0] === "{") { try { const j = JSON.parse(s); s = j.message || (j.job ? "reading a listing..." : s); } catch { /* keep the raw line */ } }
        job.log.push(s.slice(0, 200));
      }
      if (job.log.length > 200) job.log.splice(0, 100);
    };
    p.stdout?.on("data", keep); p.stderr?.on("data", keep);
    p.on("error", e => { job.status = "error"; job.error = e.message; job.finishedAt = now(); });
    p.on("close", code => {
      if (job.status === "cancelled") { job.finishedAt = now(); return; }
      try {
        const text = fs.readFileSync(path.join(dir, "results.csv"), "utf8"), found = parseProspectCsv(text, "gosom");
        if (code !== 0 && !found.length) { job.status = "error"; job.error = `The scraper stopped with code ${code}. ${job.log.filter(l => !/^Run .docker run --help/.test(l)).slice(-2).join(" | ")}`.trim(); }
        else {
          const r = core.addProspects(db, userId, campaignId, found);
          db.prepare("INSERT INTO sweeps (campaign_id, source, query, found, added, at) VALUES (?, 'gmaps', ?, ?, ?, ?)").run(campaignId, `${queries.length} queries`, found.length, r.added, now());
          job.status = "done"; job.result = { found: found.length, ...r, csv: path.join(dir, "results.csv") };
        }
      } catch (e) { job.status = "error"; job.error = e.message; }
      job.finishedAt = now();
    });
    return view(job);
  }
  return {
    start, ready: () => dockerReady(spawnImpl), get: (userId, id) => { const j = jobs.get(id); return j && j.userId === userId ? view(j) : null; },
    latest: userId => { const j = [...jobs.values()].filter(x => x.userId === userId).pop(); return j ? view(j) : null; },
    cancel(userId, id) { const j = jobs.get(id); if (!j || j.userId !== userId || j.status !== "running") return false; j.status = "cancelled"; try { spawnImpl("docker", ["stop", j.name], { stdio: "ignore" }); } catch { /* already gone */ } return true; },
  };
}
