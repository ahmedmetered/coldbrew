// Where prospects come from: OpenStreetMap (no key, no Docker), the Google Maps scraper's CSV (gosom, run by the user),
// and any CSV. Every source returns the same shape:
//   { name, category, address, city, lat, lon, website, emails[], phones[], socials{}, source, source_id, rating, reviews }
// Parsing is pure and tested with fixtures; only fetchOsm touches the network.
import { cleanEmail, normPhone } from "./normalize.mjs";

// ---------- OpenStreetMap ----------
// friendly names -> Overpass selectors. Anything of the form key=value is also accepted as is.
export const OSM_CATEGORIES = {
  dentist: ['amenity=dentist'], doctor: ['amenity=doctors'], veterinary: ['amenity=veterinary'], pharmacy: ['amenity=pharmacy'], physiotherapist: ['healthcare=physiotherapist'],
  restaurant: ['amenity=restaurant'], cafe: ['amenity=cafe'], bar: ['amenity=bar', 'amenity=pub'], bakery: ['shop=bakery'], hotel: ['tourism=hotel', 'tourism=guest_house'],
  hairdresser: ['shop=hairdresser'], beauty: ['shop=beauty'], gym: ['leisure=fitness_centre'], florist: ['shop=florist'], optician: ['shop=optician'],
  car_repair: ['shop=car_repair'], driving_school: ['amenity=driving_school'], language_school: ['amenity=language_school'], school: ['amenity=school'],
  lawyer: ['office=lawyer'], accountant: ['office=accountant'], estate_agent: ['office=estate_agent'], architect: ['office=architect'], insurance: ['office=insurance'],
  bookshop: ['shop=books'], clothes: ['shop=clothes'], jewelry: ['shop=jewelry'], supermarket: ['shop=supermarket'],
};
const esc = s => String(s).replace(/["\\]/g, "");
export function selectorsFor(category) {
  const key = String(category || "").trim().toLowerCase();
  if (OSM_CATEGORIES[key]) return OSM_CATEGORIES[key];
  if (/^[a-z_:]+=[a-z_:]+$/.test(key)) return [key];
  throw new Error(`Unknown category "${category}". Use one of: ${Object.keys(OSM_CATEGORIES).join(", ")}, or key=value such as shop=bakery.`);
}
// one query per municipality: small queries cover a metro area far better than one big one
export function buildOsmQuery(category, place) {
  const sel = selectorsFor(category).map(s => { const [k, v] = s.split("="); return `nwr["${k}"="${v}"](area.a);`; }).join("");
  return `[out:json][timeout:60];area["name"="${esc(place)}"]["boundary"="administrative"]->.a;(${sel});out tags center;`;
}
export function parseOsm(raw, categoryLabel = "") {
  return (raw.elements || []).filter(e => e.tags && e.tags.name).map(e => {
    const t = e.tags, addr = [[t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" "), t["addr:postcode"], t["addr:city"]].filter(Boolean).join(", ");
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    const phones = [t.phone, t["contact:phone"], t.mobile, t["contact:mobile"]].filter(Boolean).flatMap(v => v.split(/[;,]/)).map(p => normPhone(p)).filter(Boolean);
    const emails = [t.email, t["contact:email"]].filter(Boolean).flatMap(v => v.split(/[;,]/)).map(cleanEmail).filter(Boolean);
    const socials = {}; for (const k of ["instagram", "facebook", "linkedin", "whatsapp", "twitter"]) { const v = t["contact:" + k] || t[k]; if (v) socials[k] = v; }
    return { name: t.name, category: categoryLabel || t.amenity || t.shop || t.office || t.healthcare || t.leisure || t.tourism || "", address: addr, city: t["addr:city"] || "", lat, lon,
      website: t.website || t["contact:website"] || t.url || "", emails: [...new Set(emails)], phones: [...new Set(phones)], socials, source: "osm", source_id: `${e.type}/${e.id}`, rating: null, reviews: null,
      hours: t.opening_hours || "" };
  });
}
const MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
export async function fetchOsm(category, place, fetchImpl = fetch) {
  const q = buildOsmQuery(category, place); let last;
  for (const url of MIRRORS) {
    try {
      const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "Coldbrew/0.1 (+https://github.com/ahmedmetered/coldbrew)" }, body: "data=" + encodeURIComponent(q), signal: AbortSignal.timeout(75000) });
      if (!r.ok) throw new Error(`Overpass answered ${r.status}`);
      return parseOsm(await r.json(), String(category).toLowerCase());
    } catch (e) { last = e; }
  }
  throw new Error(`OpenStreetMap is not answering right now (${last?.message}). Try again in a minute.`);
}

// ---------- CSV (generic, and the Google Maps scraper's output) ----------
export function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some(x => x !== "")) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some(x => x !== "")) rows.push(row);
  const head = (rows.shift() || []).map(h => h.trim().toLowerCase().replace(/^\ufeff/, ""));
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}
const pick = (r, ...keys) => { for (const k of keys) if (r[k]) return r[k]; return ""; };
export function rowToProspect(r, source = "csv") {
  const name = pick(r, "name", "title", "nome", "ragione sociale", "business", "company", "azienda");
  if (!name) return null;
  const emails = pick(r, "email", "emails", "e-mail", "mail", "pec").split(/[;,|\s]+/).map(cleanEmail).filter(Boolean);
  const phones = pick(r, "phone", "phones", "telefono", "tel", "phone number", "cellulare").split(/[;|]+/).map(p => normPhone(p)).filter(Boolean);
  const socials = {}; for (const k of ["instagram", "facebook", "linkedin", "whatsapp"]) if (r[k]) socials[k] = r[k];
  const num = v => { const n = parseFloat(String(v).replace(",", ".")); return Number.isFinite(n) ? n : null; };
  const placeId = pick(r, "place_id", "cid", "data_id", "id");
  return { name, category: pick(r, "category", "categories", "categoria", "type"), address: pick(r, "address", "indirizzo", "full_address"), city: pick(r, "city", "città", "citta", "municipality", "comune"),
    lat: num(pick(r, "latitude", "lat")), lon: num(pick(r, "longitude", "lon", "lng")), website: pick(r, "website", "web", "sito", "url", "site"),
    emails: [...new Set(emails)], phones: [...new Set(phones)], socials, source: source === "gosom" || placeId ? (placeId ? "gmaps" : source) : source, source_id: placeId ? String(placeId) : "",
    rating: num(pick(r, "review_rating", "rating", "stars")), reviews: (n => (n == null ? null : Math.round(n)))(num(pick(r, "review_count", "reviews", "user_ratings_total"))) };
}
export const parseProspectCsv = (text, source = "csv") => parseCsv(text).map(r => rowToProspect(r, source)).filter(Boolean);
