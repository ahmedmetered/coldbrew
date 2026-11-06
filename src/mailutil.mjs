// Mailbox helpers shared by reply tracking: provider presets, plain text out of HTML mail, a readable copy of a message.

export const PROVIDERS = {
  icloud:   { host: "imap.mail.me.com",        port: 993, secure: true,  domains: /(^|\.)(icloud|me|mac)\.com$/i,           help: "App-specific password: account.apple.com > Sign-In and Security > App-Specific Passwords" },
  gmail:    { host: "imap.gmail.com",          port: 993, secure: true,  domains: /^(gmail|googlemail)\.com$/i,             help: "Turn on 2-Step Verification, then create an App Password at myaccount.google.com/apppasswords (IMAP is always on)" },
  outlook:  { host: "outlook.office365.com",   port: 993, secure: true,  domains: /^(outlook|hotmail|live|msn)\./i,          help: "Work/school Microsoft 365 accounts with IMAP enabled work with a password. Personal Outlook.com/Hotmail accounts no longer allow password login over IMAP: use a forwarding rule into a Gmail/iCloud mailbox, or the custom provider with a local bridge" },
  yahoo:    { host: "imap.mail.yahoo.com",     port: 993, secure: true,  domains: /(^|\.)yahoo\./i,                         help: "Account security > Generate app password" },
  fastmail: { host: "imap.fastmail.com",       port: 993, secure: true,  domains: /(^|\.)fastmail\.(com|fm)$/i,             help: "Settings > Privacy & Security > Integrations > New app password (IMAP access)" },
  zoho:     { host: "imap.zoho.com",           port: 993, secure: true,  domains: /(^|\.)zoho\.(com|eu)$/i,                 help: "Enable IMAP in Zoho Mail settings and create an app-specific password" },
  gmx:      { host: "imap.gmx.com",            port: 993, secure: true,  domains: /(^|\.)(gmx|web)\.(com|de|net)$/i,        help: "Enable IMAP in GMX settings" },
  proton:   { host: "127.0.0.1",               port: 1143, secure: false, domains: /(^|\.)(proton\.me|protonmail\.com|pm\.me)$/i, help: "Needs the Proton Mail Bridge app running locally; use the Bridge username/password it shows" },
  custom:   { host: "",                        port: 993, secure: true,  domains: null,                                        help: "Set host (and port/secure) in mail-config.json" },
};
export function detectProvider(user = "") {
  const dom = (user.split("@")[1] || "").toLowerCase();
  for (const [name, p] of Object.entries(PROVIDERS)) if (p.domains && p.domains.test(dom)) return name;
  return "custom";
}


// LinkedIn and some ATS mails keep the actual message only in the HTML part, so read both
export const htmlToText = h => String(h || "").replace(/<(style|script|head)[\s\S]*?<\/(style|script|head)>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, " ").trim();
export const bodyOf = mail => ((mail.text || "").slice(0, 2500) + "\n" + htmlToText(mail.html).slice(0, 3500)).trim();

// readable copy of a mail for the tracker card: real message only, no links, tracking or footers
const htmlLines = h => String(h || "").replace(/<(style|script|head)[\s\S]*?<\/(style|script|head)>/gi, " ").replace(/<\s*(br|\/p|\/div|\/tr|\/h[1-6]|\/li)\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&middot;/g, "·").replace(/&ndash;|&mdash;/g, "-").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/[͏​-‏­⁠﻿]/g, "").replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const FOOTER = /(this email was intended for|you are receiving linkedin|learn why we included this|unsubscribe|annulla l'iscrizione|view in browser|se non vuoi più ricevere|©|linkedin corporation|top jobs looking for|jobs you may be interested|similar jobs|see more jobs|recommended for you)/i;
export function cleanBody(mail) {
  let s = mail.html ? htmlLines(mail.html) : String(mail.text || "");
  if (!mail.html || s.length < 40) s = String(mail.text || "");
  s = s.replace(/https?:\/\/\S+/g, "").replace(/\[\s*\]/g, "").replace(/ {2,}/g, " ");
  const cut = s.search(FOOTER); if (cut > 40) s = s.slice(0, cut);
  return s.split("\n").map(l => l.trim()).filter((l, i, a) => l || (a[i - 1] && a[i - 1] !== "")).join("\n").trim().slice(0, 1400);
}

