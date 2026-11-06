import test from "node:test";
import assert from "node:assert/strict";
import { normName, normPhone, domainOf, dedupeKey, mergeProspects, cleanEmail } from "../src/normalize.mjs";
import { buildOsmQuery, parseOsm, selectorsFor, parseProspectCsv } from "../src/sources.mjs";
import { extractFromHtml, robotsAllows, enrichProspect } from "../src/enrich.mjs";
import { passesFilter, channelFor, scoreProspect } from "../src/rank.mjs";

test("names, phones and domains normalise so duplicates meet", () => {
  assert.equal(normName("Studio Dentistico Dott. Rossi S.r.l."), "dentistico rossi");
  assert.equal(normPhone("011 123 4567"), "+390111234567"); assert.equal(normPhone("+39 011/1234567"), "+390111234567"); assert.equal(normPhone("0039 347 1234567"), "+393471234567"); assert.equal(normPhone("12"), "");
  assert.equal(domainOf("https://www.Rossi-Dental.it/contatti"), "rossi-dental.it");
  assert.equal(cleanEmail("MAILTO:Info@Rossi.it?subject=x"), "info@rossi.it"); assert.equal(cleanEmail("noreply@x.it"), ""); assert.equal(cleanEmail("logo@2x.png"), "");
});

test("dedupe key prefers source id, then phone, then own domain, never a shared platform", () => {
  assert.equal(dedupeKey({ source: "osm", source_id: "node/1", name: "A" }), "osm:node/1");
  assert.equal(dedupeKey({ name: "A", phones: ["011 123 4567"] }), "tel:+390111234567");
  assert.equal(dedupeKey({ name: "Rossi", website: "https://www.rossi.it/" }), "web:rossi.it");
  assert.match(dedupeKey({ name: "Rossi Dental", city: "Milano", website: "https://facebook.com/rossi" }), /^name:rossi dental\|milano/);
  const m = mergeProspects({ name: "Rossi", emails: ["a@r.it"], phones: ["011 123 4567"] }, { name: "Rossi", website: "https://r.it", emails: ["a@r.it", "b@r.it"], reviews: 40 });
  assert.deepEqual(m.emails, ["a@r.it", "b@r.it"]); assert.equal(m.website, "https://r.it"); assert.equal(m.reviews, 40); assert.equal(m.phones[0], "+390111234567");
});

test("OpenStreetMap: query per municipality, parse tags into prospects, unknown categories explained", () => {
  assert.match(buildOsmQuery("dentist", "Moncalieri"), /area\["name"="Moncalieri"\]\["boundary"="administrative"\]->\.a;\(nwr\["amenity"="dentist"\]\(area\.a\);\);out tags center;/);
  assert.deepEqual(selectorsFor("shop=bakery"), ["shop=bakery"]); assert.throws(() => selectorsFor("spaceship"), /Unknown category/);
  const out = parseOsm({ elements: [
    { type: "node", id: 1, lat: 45.07, lon: 7.68, tags: { name: "Studio Rossi", amenity: "dentist", phone: "+39 011 1234567; 347 1234567", email: "INFO@rossi.it", website: "rossi.it", "contact:instagram": "https://instagram.com/rossi", "addr:street": "Via Roma", "addr:housenumber": "1", "addr:city": "Torino" } },
    { type: "way", id: 2, center: { lat: 45.1, lon: 7.7 }, tags: { amenity: "dentist" } } ] }, "dentist");
  assert.equal(out.length, 1); const p = out[0];
  assert.deepEqual([p.name, p.source_id, p.emails, p.phones.length, p.address, p.lat], ["Studio Rossi", "node/1", ["info@rossi.it"], 2, "Via Roma 1, Torino", 45.07]);
  assert.equal(p.socials.instagram, "https://instagram.com/rossi");
});

test("CSV: generic columns and the Google Maps scraper's columns both import", () => {
  const gosom = 'title,category,address,website,phone,review_count,review_rating,latitude,longitude,place_id\n"Clinica Verdi, Milano",Dentista,"Via X 3, Milano",https://verdi.it,02 123456,120,4.6,45.46,9.19,ChIJabc\n';
  const [g] = parseProspectCsv(gosom); assert.deepEqual([g.name, g.reviews, g.rating, g.source, g.source_id, g.phones[0]], ["Clinica Verdi, Milano", 120, 4.6, "gmaps", "ChIJabc", "+3902123456"]);
  const [c] = parseProspectCsv("Nome,Email,Telefono,Sito,Città\nBar Sole,ciao@barsole.it,333 1234567,barsole.it,Milano\n"); assert.deepEqual([c.name, c.emails, c.city, c.website], ["Bar Sole", ["ciao@barsole.it"], "Milano", "barsole.it"]);
  assert.equal(parseProspectCsv("name\n\n").length, 0);
});

const SITE = `<html><head><title>Studio Rossi | Odontoiatria a Torino</title><meta name="description" content="Studio odontoiatrico a Torino dal 1998, urgenze anche la domenica mattina."></head>
<body><h1>Studio odontoiatrico Rossi a Torino</h1><p>Orari: lun-ven 9-19, sabato 9-13. Urgenze anche la domenica mattina, chiamare il numero in basso.</p>
<a href="mailto:info@studiorossi.it">scrivici</a> <a href="tel:+390111234567">chiama</a><a href="https://www.instagram.com/studiorossi/">ig</a><a href="/contatti">Contatti</a><script>var e="x@y.it"</script></body></html>`;
test("a business's own page gives contacts and facts that are real phrases from the page", () => {
  const x = extractFromHtml(SITE, "https://studiorossi.it/");
  assert.deepEqual(x.emails, ["info@studiorossi.it"]); assert.equal(x.phones[0], "+390111234567"); assert.match(x.socials.instagram, /instagram\.com\/studiorossi/);
  assert.ok(x.facts.some(f => /urgenze anche la domenica/i.test(f.text))); assert.ok(x.facts.every(f => f.source_url === "https://studiorossi.it/"));
  assert.equal(x.signals.booking, false); assert.equal(x.signals.lang, "it");
});

test("robots.txt is honoured, and enrichment reads at most a few pages of the same site", async () => {
  assert.equal(robotsAllows("User-agent: *\nDisallow: /private\n", "/private/x"), false); assert.equal(robotsAllows("User-agent: *\nDisallow: /private\n", "/contatti"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /\nAllow: /contatti\n", "/contatti"), true);
  const calls = [];
  const f = async (url) => { calls.push(url); const html = url.endsWith("/robots.txt") ? "User-agent: *\nDisallow: /admin" : url.endsWith("/contatti") ? '<p>Scrivi a <a href="mailto:ciao@studiorossi.it">noi</a></p>' : SITE;
    return { ok: true, status: 200, url, headers: { get: () => "text/html" }, text: async () => html }; };
  const r = await enrichProspect({ website: "studiorossi.it" }, f);
  assert.equal(r.ok, true); assert.deepEqual(r.emails.sort(), ["ciao@studiorossi.it", "info@studiorossi.it"]); assert.ok(r.pages.length <= 3);
  assert.ok(calls.every(u => u.startsWith("https://studiorossi.it")), "never leaves the business's own site");
  assert.equal((await enrichProspect({ website: "" }, f)).ok, false);
});

test("filters run before ranking; ranking prefers people you can actually reach", () => {
  const f = { keep: "dent|odont", drop: "centro commerciale|supermercato" };
  assert.equal(passesFilter({ category: "Dentista", name: "A" }, f).ok, true); assert.equal(passesFilter({ category: "Supermercato", name: "Dental Mart" }, f).ok, false); assert.equal(passesFilter({ category: "Bar", name: "B" }, f).ok, false);
  assert.equal(passesFilter({ category: "Dentista", name: "A" }, { needWebsite: true }).why, "no website");
  const reach = scoreProspect({ emails: ["a@b.it"], website: "b.it", reviews: 100, rating: 4.5 }, { facts: 2 }), none = scoreProspect({ reviews: 100 }, {});
  assert.ok(reach > none + 25); assert.equal(scoreProspect({ dnc: 1, emails: ["a@b.it"] }), 0);
  assert.ok(scoreProspect({ website: "b.it", emails: ["a@b.it"] }, { signals: { booking: false }, icp: { noBooking: true } }) > scoreProspect({ website: "b.it", emails: ["a@b.it"] }, { signals: { booking: true }, icp: { noBooking: true } }));
  assert.equal(channelFor({ emails: ["a@b.it"] }), "email"); assert.equal(channelFor({ socials: { instagram: "x" } }), "instagram"); assert.equal(channelFor({}), "");
});
