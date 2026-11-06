import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "coldbrew-"));
const { openDb } = await import("../src/db.mjs");
const { createApp } = await import("../src/server.mjs");

const SITE = `<html><head><title>Studio Rossi</title></head><body><h1>Studio odontoiatrico Rossi a Milano</h1><p>Urgenze anche la domenica mattina, chiamare il numero in basso.</p><a href="mailto:info@rossi.it">scrivici</a></body></html>`;
const siteFetch = async (url) => ({ ok: true, status: 200, url, headers: { get: () => "text/html" }, text: async () => (url.endsWith("robots.txt") ? "" : SITE) });
const osmFetch = async () => ({ ok: true, json: async () => ({ elements: [{ type: "node", id: 5, lat: 45.4, lon: 9.2, tags: { name: "Studio Bianchi", amenity: "dentist", website: "bianchi.it", "addr:city": "Milano" } }] }) });

function boot() {
  const db = openDb(":memory:"), server = http.createServer(createApp(db, { siteFetch, osmFetch }));
  return new Promise(r => server.listen(0, "127.0.0.1", () => {
    const base = `http://127.0.0.1:${server.address().port}`; let sid = "";
    const call = async (method, p, body, headers = {}) => {
      const res = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(sid ? { cookie: `sid=${sid}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get("set-cookie"); if (sc) { const m = sc.match(/sid=([^;]*)/); sid = m ? m[1] : ""; }
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json };
    };
    r({ db, call, close: () => server.close() });
  }));
}
const PERSONA = { sender: "Ahmed", product: "Mimo", optout: "Se preferisci non ricevere altri messaggi, basta dirmelo.", claims: "gestisce le prenotazioni di 12 cliniche" };
const CSV = "Nome,Categoria,Sito,Email,Telefono,Città\nStudio Rossi,Dentista,rossi.it,,02 123456,Milano\nStudio Verdi,Dentista,verdi.it,a@verdi.it,02 654321,Milano\nEsselunga,Supermercato,esselunga.it,,02 111111,Milano\n";

test("campaign, import, filters, enrichment, drafts, approval, do-not-contact, replies and the dashboard, end to end", async () => {
  const s = await boot();
  try {
    assert.equal((await s.call("GET", "/api/me")).status, 401);
    assert.equal((await s.call("POST", "/api/signup", { email: "a@example.com", password: "correct horse battery" })).status, 201);
    assert.equal((await s.call("POST", "/api/campaigns", { name: "" })).status, 400);
    const cid = (await s.call("POST", "/api/campaigns", { name: "Dentisti Milano", vertical: "dentisti", place: "Milano", language: "it", persona: PERSONA, filters: { keep: "dent", drop: "supermercato" } })).json.id;

    const imp = (await s.call("POST", `/api/campaigns/${cid}/import`, { csv: CSV })).json; assert.deepEqual([imp.parsed, imp.added, imp.filtered], [3, 2, 1]);
    const sweep = (await s.call("POST", `/api/campaigns/${cid}/sweep`, { category: "dentist", places: "Milano" })).json; assert.deepEqual([sweep.found, sweep.added], [1, 1]);
    assert.equal((await s.call("POST", `/api/campaigns/${cid}/sweep`, { category: "spaceship", places: "Milano" })).status, 400);

    const list = (await s.call("GET", "/api/prospects?sort=name")).json; assert.equal(list.total, 3); assert.ok(list.facets.source.length >= 2 && list.facets.city.length >= 1);
    assert.equal((await s.call("GET", "/api/prospects?hasEmail=1")).json.total, 1); assert.equal((await s.call("GET", "/api/prospects?q=verdi")).json.total, 1);
    assert.equal((await s.call("GET", "/api/prospects?source=osm")).json.total, 1); assert.equal((await s.call("GET", `/api/prospects?campaign=${cid + 1}`)).json.total, 0);
    const rossi = list.prospects.find(p => p.name === "Studio Rossi");

    const en = (await s.call("POST", `/api/prospects/${rossi.id}/enrich`)).json; assert.equal(en.ok, true); assert.ok(en.emails.includes("info@rossi.it"));
    const d1 = (await s.call("GET", `/api/prospects/${rossi.id}`)).json; assert.ok(d1.facts.some(f => /domenica/i.test(f.text))); assert.equal(d1.channel, "email");

    const sk = (await s.call("POST", "/api/drafts", { prospectId: rossi.id, step: 1, mode: "skeleton" })); assert.equal(sk.status, 201);
    const draft = (await s.call("GET", `/api/drafts/${sk.json.id}`)).json; assert.match(draft.body, /domenica/);
    assert.equal((await s.call("POST", "/api/drafts", { prospectId: rossi.id, step: 1, mode: "ai" })).status, 400, "no AI configured");
    const bad = await s.call("PATCH", `/api/drafts/${draft.id}`, { subject: "Quick Question!", body: "We offer a free tool!" }); assert.equal(bad.json.lint.ok, false);
    assert.equal((await s.call("POST", `/api/drafts/${draft.id}/approve`)).status, 422);
    const fixed = await s.call("PATCH", `/api/drafts/${draft.id}`, { subject: "urgenze della domenica", body: "Il vostro sito dice urgenze anche la domenica mattina, chiamare il numero in basso. Quel numero arriva a chi è di turno o direttamente a voi?\n\n" + PERSONA.optout });
    assert.equal(fixed.json.lint.ok, true, JSON.stringify(fixed.json.lint.issues));
    assert.equal((await s.call("POST", `/api/drafts/${draft.id}/approve`)).json.status, "approved");
    assert.equal((await s.call("GET", "/api/drafts")).json.drafts.length, 1);
    assert.equal((await s.call("POST", `/api/drafts/${draft.id}/sent`)).json.status, "sent");
    assert.equal((await s.call("GET", `/api/prospects/${rossi.id}`)).json.status, "Contacted");

    const rep = (await s.call("POST", `/api/prospects/${rossi.id}/reply`, { text: "Sì, volentieri, mi racconti di più." })).json; assert.equal(rep.outcome, "replied");
    const verdi = list.prospects.find(p => p.name === "Studio Verdi");
    assert.equal((await s.call("POST", `/api/prospects/${verdi.id}/dnc`, { reason: "asked by phone" })).status, 200);
    assert.equal((await s.call("POST", "/api/drafts", { prospectId: verdi.id, step: 1, mode: "skeleton" })).status, 409);
    assert.equal((await s.call("GET", "/api/prospects")).json.total, 2, "do-not-contact prospects are hidden by default");
    assert.equal((await s.call("GET", "/api/prospects?dnc=1")).json.total, 1);

    const ins = (await s.call("GET", "/api/insights?days=14")).json; assert.equal(ins.replied, 1); assert.equal(ins.replyRate, 100); assert.equal(ins.dnc, 1); assert.equal(ins.series.length, 14);
    assert.equal((await s.call("PUT", "/api/views", { views: { Interessati: { status: "Replied" } } })).status, 200); assert.deepEqual((await s.call("GET", "/api/views")).json.views.Interessati, { status: "Replied" });
    assert.equal((await s.call("POST", "/api/prospects/bulk", { ids: [rossi.id], action: "status", status: "Meeting" })).json.updated, 1);
    assert.equal((await s.call("POST", "/api/campaigns", { name: "x" }, { origin: "https://evil.example" })).status, 403);
    assert.ok(Object.keys((await s.call("GET", "/api/export")).json).includes("suppressions"));
  } finally { s.close(); }
});

test("mail settings are stored encrypted and never returned", async () => {
  const s = await boot();
  try {
    await s.call("POST", "/api/signup", { email: "a@example.com", password: "correct horse battery" });
    assert.equal((await s.call("PUT", "/api/mail", { user: "me@gmail.com" })).status, 400);
    const saved = await s.call("PUT", "/api/mail", { user: "me@gmail.com", password: "abcd efgh ijkl mnop" });
    assert.equal(saved.json.host, "imap.gmail.com"); assert.ok(!JSON.stringify(saved.json).includes("abcd")); assert.ok(!s.db.prepare("SELECT pass_enc FROM mail_accounts").get().pass_enc.includes("abcd"));
    assert.equal((await s.call("POST", "/api/mail/check", {})).status === 200, false);
  } finally { s.close(); }
});
