// Deciding which prospects are worth writing to: filter by category BEFORE ranking (otherwise raw review counts
// surface supermarkets and big chains), then score what is left. Pure functions.

const rx = (s) => { if (!s) return null; try { return new RegExp(String(s), "i"); } catch { return null; } };

// filters_json: { keep: "regex", drop: "regex", dropNames: "regex", needWebsite, needContact }
export function passesFilter(p, f = {}) {
  const keep = rx(f.keep), drop = rx(f.drop), dropNames = rx(f.dropNames), cat = `${p.category || ""} ${p.name || ""}`;
  if (drop && drop.test(p.category || "")) return { ok: false, why: "category dropped" };
  if (dropNames && dropNames.test(p.name || "")) return { ok: false, why: "name dropped" };
  if (keep && !keep.test(cat)) return { ok: false, why: "category not kept" };
  if (f.needWebsite && !p.website) return { ok: false, why: "no website" };
  if (f.needContact && !(p.emails?.length || p.phones?.length || Object.keys(p.socials || {}).length)) return { ok: false, why: "no way to reach them" };
  return { ok: true, why: "" };
}

export function channelFor(p) {
  if (p.emails?.length) return "email";
  if (p.socials?.instagram) return "instagram";
  if (p.socials?.whatsapp || p.phones?.length) return "phone";
  return "";
}

// 0-100. Reachability first (a great prospect you cannot reach is no prospect), then evidence of a real, active business,
// then what we know to write about, then the persona's own signals.
export function scoreProspect(p, ctx = {}) {
  let s = 20;
  if (p.emails?.length) s += 22; else if (p.socials?.instagram) s += 12; else if (p.phones?.length) s += 6;
  if (p.website) s += 8;
  if (p.reviews) s += Math.min(14, Math.round(Math.log10(1 + p.reviews) * 6));
  if (p.rating && p.rating >= 4.2) s += 4;
  s += Math.min(12, (ctx.facts || 0) * 4);
  const sig = ctx.signals || {}, icp = ctx.icp || {};
  if (icp.noBooking && p.website && sig.booking === false) s += 8;    // "no online booking" ICPs
  if (icp.hasBooking && sig.booking) s += 8;
  if (icp.activeSocial && p.socials?.instagram) s += 5;
  if (p.dnc) s = 0;
  return Math.max(0, Math.min(100, Math.round(s)));
}
