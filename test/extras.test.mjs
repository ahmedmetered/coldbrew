import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "coldbrew-x-"));
const { openDb } = await import("../src/db.mjs");
const { signup } = await import("../src/auth.mjs");
const core = await import("../src/core.mjs");
const { createApp } = await import("../src/server.mjs");
const ig = await import("../src/instagram.mjs");
const { buildDigest, runDigestIfDue, sendWebhook } = await import("../src/digest.mjs");
const { buildQueries, dockerArgs, dockerReady, createScraper } = await import("../src/scrape.mjs");

const PERSONA = { sender: "Ahmed", optout: "Se preferisci non ricevere altri messaggi, basta dirmelo.", requireOptout: false };
function world() {
  const db = openDb(":memory:"), uid = signup(db, "a@example.com", "correct horse battery"), cid = core.createCampaign(db, uid, { name: "C", language: "it", persona: PERSONA });
  core.addProspects(db, uid, cid, [{ name: "Studio Rossi", category: "Dentista", socials: { instagram: "https://instagram.com/studiorossi" }, emails: ["info@rossi.it"], website: "https://rossi.it", source: "osm", source_id: "n1" }, { name: "Studio Verdi", category: "Dentista", socials: { instagram: "https://www.instagram.com/Studio_Verdi/?hl=it" }, source: "osm", source_id: "n2" }], { applyFilter: false });
  return { db, uid, cid };
}
const FAKE_GRAPH = async url => {
  const u = String(url);
  const body = u.includes("/me/conversations") ? { data: [
    { id: "t1", updated_time: new Date().toISOString().replace("Z", "+0000"), participants: { data: [{ id: "1", username: "me_brand" }, { id: "2", username: "studiorossi" }] }, messages: { data: [
      { id: "m1", created_time: "2099-01-01T10:00:00+0000", from: { id: "1", username: "me_brand" }, message: "Ciao Studio Rossi" }, { id: "m2", created_time: "2099-01-01T11:00:00+0000", from: { id: "2", username: "studiorossi" }, message: "Sì volentieri, come funziona?" } ] } },
    { id: "t2", updated_time: new Date().toISOString().replace("Z", "+0000"), participants: { data: [{ id: "1", username: "me_brand" }, { id: "3", username: "studio_verdi" }] }, messages: { data: [{ id: "m3", created_time: "2099-01-01T12:00:00+0000", from: { id: "3", username: "studio_verdi" }, message: "Non scrivermi più." }] } },
    { id: "t3", updated_time: new Date().toISOString().replace("Z", "+0000"), participants: { data: [{ id: "1", username: "me_brand" }, { id: "9", username: "stranger" }] }, messages: { data: [{ id: "m4", created_time: "2099-01-01T12:00:00+0000", from: { id: "9", username: "stranger" }, message: "ciao" }] } } ] }
    : { user_id: "1", username: "me_brand" };
  return { ok: true, status: 200, json: async () => body };
};

test("Instagram: handles match with or without @ and URL, what you sent marks the draft sent, replies follow the rules", async () => {
  assert.equal(ig.normalizeHandle("https://www.instagram.com/Studio_Verdi/?hl=it"), "studio_verdi"); assert.equal(ig.normalizeHandle("@Acme"), "acme");
  const { db, uid } = world();
  const d = core.createDraft(db, uid, { prospectId: 1, step: 1, subject: "", body: "Il vostro sito dice urgenze anche la domenica. Come funziona per chi scrive fuori orario?" });
  db.prepare("UPDATE drafts SET status = 'approved' WHERE id = ?").run(d);
  const { threads } = await ig.fetchInstagram({ token: "t" }, { fetchImpl: FAKE_GRAPH }); assert.equal(threads.length, 3);
  const results = threads.map(t => ig.applyThread(db, uid, t));
  assert.deepEqual(results.map(r => r.matched), [true, true, false]);
  assert.equal(db.prepare("SELECT status FROM drafts WHERE id = ?").get(d).status, "sent");
  assert.equal(core.getProspect(db, uid, 1).status, "Replied"); assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE prospect_id = 1").get().n, 2, "your message and their reply");
  assert.equal(core.getProspect(db, uid, 2).dnc, true); assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE prospect_id = 2").get().n, 0, "the opt-out text is not stored");
  assert.deepEqual(threads.map(t => ig.applyThread(db, uid, t).replies), [0, 0, 0], "a second pass changes nothing");
  assert.deepEqual(await ig.checkInstagram(db, uid, {}), { configured: false });
});

test("Instagram through the API: nothing runs until a token is saved, the token is checked and never returned", async () => {
  const db = openDb(":memory:"), server = http.createServer(createApp(db, { igFetch: FAKE_GRAPH }));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = "";
  const call = async (method, p, body) => { const res = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(sid ? { cookie: `sid=${sid}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const sc = res.headers.get("set-cookie"); if (sc) sid = sc.match(/sid=([^;]*)/)?.[1] || ""; return { status: res.status, json: await res.json().catch(() => null) }; };
  try {
    await call("POST", "/api/signup", { email: "a@example.com", password: "correct horse battery" });
    assert.equal((await call("GET", "/api/instagram")).json.configured, false); assert.equal((await call("POST", "/api/instagram/check", {})).status, 400);
    assert.equal((await call("PUT", "/api/instagram", {})).status, 400);
    const saved = await call("PUT", "/api/instagram", { token: "IGAAsecrettokenvalue" }); assert.equal(saved.json.username, "me_brand");
    assert.ok(!JSON.stringify((await call("GET", "/api/instagram")).json).includes("secrettoken")); assert.ok(!db.prepare("SELECT token_enc FROM social_accounts").get().token_enc.includes("secrettoken"));
    const cid = (await call("POST", "/api/campaigns", { name: "C", language: "it" })).json.id;
    await call("POST", `/api/campaigns/${cid}/import`, { prospects: [{ name: "Studio Rossi", category: "Dentista", socials: { instagram: "https://instagram.com/studiorossi" }, source: "csv", source_id: "1" }], applyFilter: false });
    const chk = await call("POST", "/api/instagram/check", { days: 36500 }); assert.deepEqual([chk.json.threads, chk.json.unmatched, chk.json.replies], [3, 2, 1]);
    assert.equal((await call("DELETE", "/api/instagram")).status, 200); assert.equal((await call("GET", "/api/instagram")).json.configured, false);
  } finally { server.close(); }
});

test("digest: counts and names only, once a day after the chosen hour, pushed only when there is something to say", async () => {
  const { db, uid } = world();
  assert.equal(buildDigest(db, uid).empty, true);
  const d = core.createDraft(db, uid, { prospectId: 1, step: 1, subject: "x", body: "y" }); void d;
  db.prepare("INSERT INTO messages (prospect_id, ext_id, dir, platform, text, ts, intent) VALUES (1, 'm', 'in', 'email', 'secret body text', ?, 'interested')").run(new Date().toISOString());
  const dg = buildDigest(db, uid); assert.equal(dg.empty, false); assert.match(dg.text, /1 new reply: Studio Rossi/); assert.match(dg.text, /1 draft waits/); assert.ok(!dg.text.includes("secret body text"), "no message text in a digest");
  db.prepare("INSERT INTO settings (user_id, k, v) VALUES (?, 'digest_webhook', 'https://ntfy.sh/t'), (?, 'digest_hour', '8')").run(uid, uid);
  const sent = []; const hook = async (u, o) => { sent.push(o.body); return { ok: true }; };
  assert.equal(await runDigestIfDue(db, uid, { at: new Date("2026-11-06T07:00:00"), fetchImpl: hook }), null, "before the hour");
  assert.ok(await runDigestIfDue(db, uid, { at: new Date("2026-11-06T09:00:00"), fetchImpl: hook })); assert.equal(sent.length, 1);
  assert.equal(await runDigestIfDue(db, uid, { at: new Date("2026-11-06T18:00:00"), fetchImpl: hook }), null, "only once a day");
  const f = []; const any = async (u, o) => { f.push({ host: u.hostname, ...o }); return { ok: true }; };
  await sendWebhook("https://discord.com/api/webhooks/1/x", "T", "body", any); await sendWebhook("https://hooks.slack.com/services/a", "T", "body", any); assert.match(JSON.parse(f[0].body).content, /T/); assert.match(JSON.parse(f[1].body).text, /T/);
  await assert.rejects(() => sendWebhook("javascript:alert(1)", "T", "b", any), /http/);
});

// a fake "docker": answers `docker version`, and for `docker run` writes the scraper's CSV into the mounted folder
function fakeDocker({ available = true, csv = "", code = 0 } = {}) {
  const calls = [];
  const spawnImpl = (cmd, args) => {
    calls.push(args); const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    setTimeout(() => {
      if (args[0] === "version") { if (!available) p.stderr.emit("data", "error during connect: daemon is not running"); p.emit("close", available ? 0 : 1); return; }
      if (args[0] === "run") { const v = args[args.indexOf("-v") + 1], dir = v.slice(0, v.lastIndexOf(":/work")); fs.writeFileSync(path.join(dir, "results.csv"), csv); p.stdout.emit("data", "scraping...\n"); p.emit("close", code); return; }
      p.emit("close", 0);
    }, 5);
    return p;
  };
  return { spawnImpl, calls };
}

test("the scraper: queries per kind and place, the docker command, and a full run that imports the CSV", async () => {
  assert.deepEqual(buildQueries("dentista, odontoiatra", "Milano\nMonza"), ["dentista Milano", "dentista Monza", "odontoiatra Milano", "odontoiatra Monza"]);
  const a = dockerArgs({ dir: "C:\\x\\job", depth: 99, lang: "it", email: true, name: "n" }); assert.ok(a.includes("-email") && a.includes("-v") && a[a.indexOf("-depth") + 1] === "15" && a.includes("gosom/google-maps-scraper"));
  assert.equal((await dockerReady(fakeDocker({ available: false }).spawnImpl)).ok, false); assert.match((await dockerReady(fakeDocker({ available: false }).spawnImpl)).reason, /not running/); assert.equal((await dockerReady(fakeDocker().spawnImpl)).ok, true);
  const { db, uid, cid } = world();
  const csv = "title,category,address,website,phone,review_count,review_rating,latitude,longitude,cid,emails\nStudio Neri,Dentista,Via A 1 Milano,https://neri.it,02 111222,50,4.5,45.4,9.2,111,info@neri.it\nSupermercato X,Supermercato,Via B,,02 333444,10,4.0,45.4,9.2,222,\n";
  const f = fakeDocker({ csv }), sc = createScraper(db, { spawnImpl: f.spawnImpl, dataDir: path.relative(process.cwd(), path.join(os.tmpdir(), "cb-scrape-test")) }); // a relative folder must still reach docker as an absolute path (a real run failed on this)
  core.createCampaign(db, uid, { name: "Filtered", language: "it", filters: { keep: "dent" } }); const fid = 2;
  const job = await sc.start(uid, fid, { kinds: "dentista", places: "Milano", depth: 3, email: true }); assert.equal(job.status, "running");
  await assert.rejects(() => sc.start(uid, fid, { kinds: "x", places: "y" }), /already going/);
  for (let i = 0; i < 40 && sc.get(uid, job.id).status === "running"; i++) await new Promise(r => setTimeout(r, 20));
  const done = sc.get(uid, job.id); assert.equal(done.status, "done"); assert.deepEqual([done.result.found, done.result.added, done.result.filtered], [2, 1, 1]);
  assert.equal(db.prepare("SELECT website FROM prospects WHERE campaign_id = ?").get(fid).website, "https://neri.it"); assert.equal(db.prepare("SELECT source FROM sweeps WHERE campaign_id = ?").get(fid).source, "gmaps");
  const run = f.calls.find(a => a[0] === "run"), mounted = run[run.indexOf("-v") + 1];
  assert.ok(path.isAbsolute(mounted.slice(0, mounted.lastIndexOf(":/work"))), "docker needs an absolute host path: " + mounted);
  assert.equal(sc.get(uid + 99, job.id), null, "another account cannot see it");
  const none = createScraper(db, { spawnImpl: fakeDocker({ available: false }).spawnImpl, dataDir: path.join(os.tmpdir(), "cb-scrape-test") });
  await assert.rejects(() => none.start(uid, cid, { kinds: "x", places: "y" }), /not running|not installed/);
  await assert.rejects(() => sc.start(uid, cid, { kinds: "", places: "" }), /at least one/);
});
