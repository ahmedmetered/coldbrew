// Turning messy business records into comparable ones: names, phones, domains, and the key two records share when
// they are the same business. Pure functions.

const LEGAL = /\b(s\.?r\.?l\.?s?|s\.?p\.?a\.?|s\.?n\.?c\.?|s\.?a\.?s\.?|gmbh|ltd|llc|inc|co|sa|snc|sas|srl|spa)\b\.?/gi;
const NOISE = /\b(studio|dott|dr|dottor|dottoressa|prof|ambulatorio|centro|clinica|the|di|del|della|dei|de|e|and|&)\b/gi;

export const normName = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(LEGAL, " ").replace(NOISE, " ").replace(/[^a-z0-9]+/g, " ").trim();

// +39 011 123 4567, 0111234567, 011/1234567 all become the same digits, with the country code when it is obvious
export function normPhone(p, defaultCc = "39") {
  let d = String(p || "").replace(/[^\d+]/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = "+" + d.slice(2);
  if (!d.startsWith("+")) d = "+" + defaultCc + d; // Italian landlines keep their leading 0 in international form
  const digits = d.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? "+" + digits : "";
}

export function domainOf(url) {
  try { return new URL(/^https?:\/\//i.test(url) ? url : "http://" + url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}
const SHARED = /(facebook|instagram|linkedin|google|business\.site|wixsite|squarespace|wordpress|booking|tripadvisor|yelp|paginegialle|miodottore|doctolib|pagine|linktr\.ee|bio\.link)/i;

// two records are the same business when they share a source id, a phone, a website domain, or the same normalised name in the same place
export function dedupeKey(p) {
  if (p.source && p.source_id) return `${p.source}:${p.source_id}`;
  const phone = normPhone((p.phones || [])[0] || p.phone || "");
  if (phone) return `tel:${phone}`;
  const dom = domainOf(p.website || "");
  if (dom && !SHARED.test(dom)) return `web:${dom}`;
  return `name:${normName(p.name)}|${normName(p.city || p.address || "").slice(0, 24)}`;
}

// merge records found by different sources: keep the richest value of each field
export function mergeProspects(a, b) {
  const uniq = arr => [...new Set(arr.filter(Boolean))];
  return { ...b, ...a, name: a.name || b.name, category: a.category || b.category, address: a.address || b.address, city: a.city || b.city, lat: a.lat ?? b.lat, lon: a.lon ?? b.lon,
    website: a.website || b.website, emails: uniq([...(a.emails || []), ...(b.emails || [])]), phones: uniq([...(a.phones || []), ...(b.phones || [])].map(p => normPhone(p) || p)),
    socials: { ...(b.socials || {}), ...(a.socials || {}) }, rating: a.rating ?? b.rating, reviews: Math.max(a.reviews || 0, b.reviews || 0) || null };
}

const JUNK_MAIL = /(example\.|sentry|wixpress|@2x|\.png|\.jpg|\.gif|\.svg|\.webp|noreply|no-reply|donotreply|u003e|%20)/i;
export const cleanEmail = e => { e = String(e || "").trim().toLowerCase().replace(/^mailto:/, "").split("?")[0]; return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e) && !JUNK_MAIL.test(e) ? e : ""; };
