// Reading a business's OWN public website for ways to reach it and one thing worth mentioning.
// extractFromHtml is pure (tested with fixtures). enrichProspect does the fetching: at most three pages of the
// same site, robots.txt respected, an honest user agent, a size cap, and a timeout. Nothing that is not on the page is invented.
import { cleanEmail, normPhone, domainOf } from "./normalize.mjs";

const UA = "Coldbrew/0.1 (+https://github.com/ahmedmetered/coldbrew; reads a business's own public site once)";
const decode = s => String(s).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const text = html => decode(String(html).replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const GENERIC = /^(home|homepage|benvenut[oia]|welcome|menu|contatti|contact|chi siamo|about|accedi|login|cerca|search|home page)$/i;
const SOCIAL = { instagram: /instagram\.com\/([A-Za-z0-9._]{2,30})\/?(?:\?|$|")/i, facebook: /facebook\.com\/((?!sharer|share|tr\?|plugins|dialog)[A-Za-z0-9._\-/]{2,80})/i, linkedin: /linkedin\.com\/(company\/[A-Za-z0-9._\-%]+|in\/[A-Za-z0-9._\-%]+)/i, whatsapp: /(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?(\+?\d{8,15})/i };
const SKIP_IG = /^(p|reel|reels|explore|accounts|stories|tv|sharer)$/i;

export function extractFromHtml(html, pageUrl = "") {
  html = String(html || "");
  const body = text(html), out = { emails: [], phones: [], socials: {}, title: "", description: "", facts: [], signals: {} };
  out.title = text((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").slice(0, 160);
  out.description = text((html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i) || [])[1] || "").slice(0, 240);
  const emails = new Set();
  for (const m of html.matchAll(/mailto:([^"'?\s>]+)/gi)) { const e = cleanEmail(decodeURIComponent(m[1])); if (e) emails.add(e); }
  for (const m of body.matchAll(/[A-Za-z0-9._%+-]+\s?(?:@|\[at\]|\(at\))\s?[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) { const e = cleanEmail(m[0].replace(/\s?(\[at\]|\(at\))\s?/i, "@").replace(/\s/g, "")); if (e) emails.add(e); }
  out.emails = [...emails].slice(0, 5);
  const phones = new Set();
  for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) { const p = normPhone(decodeURIComponent(m[1])); if (p) phones.add(p); }
  for (const m of body.matchAll(/(?:\+|00)?\s?39[\s.-]?\d{2,4}[\s.-]?\d{5,8}\b|\b0\d{1,3}[\s./-]?\d{5,8}\b|\b3\d{2}[\s.-]?\d{6,7}\b/g)) { const p = normPhone(m[0]); if (p) phones.add(p); }
  out.phones = [...phones].slice(0, 4);
  for (const [k, re] of Object.entries(SOCIAL)) { const m = html.match(re); if (m && !(k === "instagram" && SKIP_IG.test(m[1]))) out.socials[k] = k === "whatsapp" ? m[1] : "https://" + m[0].replace(/["?]$/, "").replace(/^[^i-w]*/, ""); }
  // things worth mentioning: each is a phrase that appears on the page, kept with where it came from
  const add = (kind, t) => { t = t.replace(/\s+/g, " ").trim(); if (t.length >= 12 && t.length <= 200 && !GENERIC.test(t) && body.includes(t) && !out.facts.some(f => f.text === t)) out.facts.push({ kind, text: t, source_url: pageUrl }); };
  if (out.description) add("description", out.description);
  for (const m of html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)) { const h = text(m[1]); if (h && h.length >= 12) add("heading", h); if (out.facts.length >= 8) break; }
  const hours = body.match(/(?:orari(?:o)?(?: di apertura)?|opening hours|open(?:s)?)[:\s]+[^.]{8,90}\d[^.]{0,60}/i); if (hours) add("hours", hours[0]);
  const since = body.match(/(?:dal|fondat[oa] nel|since|established in|dal lontano)\s+(19|20)\d{2}[^.]{0,60}/i); if (since) add("history", since[0]);
  const urgent = body.match(/[^.]{0,60}(?:urgenz[ae]|emergenz[ae]|emergency|24\s?(?:ore|h|\/7)|pronto soccorso)[^.]{0,80}/i); if (urgent) add("emergency", urgent[0]);
  out.signals = { booking: /(prenota(?:zione)?(?: online)?|book(?:ing)? online|book an appointment|prenota un appuntamento|calendly|doctolib|miodottore|treatwell|fresha|opentable|thefork)/i.test(html), whatsapp: !!out.socials.whatsapp || /whatsapp/i.test(html),
    ecommerce: /(add to cart|aggiungi al carrello|woocommerce|shopify)/i.test(html), lang: (body.match(/\b(il|la|di|che|per|con|siamo|servizi)\b/gi) || []).length > (body.match(/\b(the|and|for|with|our|services)\b/gi) || []).length ? "it" : "en" };
  return out;
}

// robots.txt: honour Disallow rules for all agents on the paths we want
export function robotsAllows(robotsTxt, path) {
  let applies = false, disallow = [], allow = [];
  for (const line of String(robotsTxt || "").split(/\r?\n/)) {
    const [k, ...v] = line.split("#")[0].split(":"); const key = (k || "").trim().toLowerCase(), val = v.join(":").trim();
    if (key === "user-agent") applies = val === "*" || /coldbrew/i.test(val);
    else if (applies && key === "disallow" && val) disallow.push(val);
    else if (applies && key === "allow" && val) allow.push(val);
  }
  const hit = list => list.filter(p => path.startsWith(p.replace(/\*.*$/, ""))).sort((a, b) => b.length - a.length)[0];
  const d = hit(disallow), a = hit(allow);
  return !d || !!(a && a.length >= d.length);
}

async function get(url, fetchImpl, max = 600000) {
  const r = await fetchImpl(url, { headers: { "user-agent": UA, accept: "text/html,*/*" }, redirect: "follow", signal: AbortSignal.timeout(10000) });
  if (!r.ok) return { ok: false, status: r.status, html: "" };
  const ct = r.headers?.get?.("content-type") || "text/html";
  if (!/html|text/i.test(ct)) return { ok: false, status: 415, html: "" };
  return { ok: true, status: r.status, html: (await r.text()).slice(0, max), url: r.url || url };
}

export async function enrichProspect(p, fetchImpl = fetch) {
  const site = p.website ? (/^https?:\/\//i.test(p.website) ? p.website : "https://" + p.website) : "";
  if (!site) return { ok: false, reason: "no website known", emails: [], phones: [], socials: {}, facts: [], signals: {} };
  const origin = new URL(site).origin, found = { emails: [], phones: [], socials: {}, facts: [], signals: {}, pages: [] };
  let robots = ""; try { const r = await get(origin + "/robots.txt", fetchImpl, 50000); robots = r.html; } catch { /* no robots.txt */ }
  const queue = [site], seen = new Set();
  while (queue.length && found.pages.length < 3) {
    const url = queue.shift(); if (seen.has(url)) continue; seen.add(url);
    let path = "/"; try { path = new URL(url).pathname || "/"; } catch { continue; }
    if (!robotsAllows(robots, path)) continue;
    let page; try { page = await get(url, fetchImpl); } catch { continue; }
    if (!page.ok) continue;
    const x = extractFromHtml(page.html, page.url || url); found.pages.push(page.url || url);
    found.emails.push(...x.emails); found.phones.push(...x.phones); Object.assign(found.socials, x.socials); found.facts.push(...x.facts);
    found.signals = { ...found.signals, ...Object.fromEntries(Object.entries(x.signals).map(([k, v]) => [k, found.signals[k] || v])) };
    if (found.pages.length === 1) for (const m of page.html.matchAll(/href=["']([^"'#]+)["']/gi)) { // look for the contact page on the same site
      if (!/(contatt|contact|chi-siamo|about|dove-siamo|team)/i.test(m[1])) continue;
      try { const u = new URL(m[1], origin + "/"); if (u.origin === origin) queue.push(u.href); } catch { /* bad link */ }
    }
  }
  found.emails = [...new Set(found.emails)].slice(0, 5); found.phones = [...new Set(found.phones)].slice(0, 4);
  const seenText = new Set(); found.facts = found.facts.filter(f => !seenText.has(f.text) && seenText.add(f.text)).slice(0, 10);
  return { ok: found.pages.length > 0, reason: found.pages.length ? "" : "site could not be read", ...found, domain: domainOf(site) };
}
