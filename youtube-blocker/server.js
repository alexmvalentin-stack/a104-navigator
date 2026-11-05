'use strict';
/*
 * YouTube-blokering til børnenes iPhone – styret med QR-koder.
 *
 * Sådan virker det:
 *  - Serveren er en lille DNS-over-HTTPS (DoH) resolver.
 *  - Barnets iPhone får installeret en DNS-profil (.mobileconfig), så alle
 *    DNS-opslag (Wi-Fi og mobildata) går gennem denne server.
 *  - Når "blokeret" er slået til, svarer serveren "findes ikke" (NXDOMAIN) på
 *    alle YouTube-domæner. Så virker hverken YouTube-appen eller youtube.com.
 *  - Forældre-siden viser to QR-koder: én der blokerer og én der åbner igen.
 *    Scanner man en af dem med et iPhone-kamera, skiftes tilstanden med det samme.
 *
 * Ingen eksterne afhængigheder – kræver kun Node.js 18+.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const qrcode = require('./vendor/qrcode.js');

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const UPSTREAM_DOH = process.env.UPSTREAM_DOH || 'https://cloudflare-dns.com/dns-query';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const PROFILE_REMOVAL_PASSWORD = process.env.PROFILE_REMOVAL_PASSWORD || '';
// Hvor længe (sekunder) iPhonen må huske et YouTube-opslag. Kort = blokering slår hurtigt igennem.
const YOUTUBE_MAX_TTL = Number(process.env.YOUTUBE_MAX_TTL || 30);

// Alle domæner (inkl. underdomæner) som YouTube bruger.
const DEFAULT_BLOCKED_DOMAINS = [
  'youtube.com',
  'youtu.be',
  'yt.be',
  'youtube-nocookie.com',
  'youtubekids.com',
  'youtubeeducation.com',
  'googlevideo.com',
  'ytimg.com',
  'youtubei.googleapis.com',
  'youtube.googleapis.com',
  'yt3.ggpht.com',
  'yt4.ggpht.com',
  'youtubeembeddedplayer.googleapis.com',
  'youtube-ui.l.google.com',
  'wide-youtube.l.google.com',
];
const BLOCKED_DOMAINS = (process.env.BLOCKED_DOMAINS
  ? process.env.BLOCKED_DOMAINS.split(',')
  : DEFAULT_BLOCKED_DOMAINS
).map((d) => d.trim().toLowerCase().replace(/^\.+|\.+$/g, '')).filter(Boolean);

// ---------------------------------------------------------------------------
// Tilstand (gemmes i data/state.json)
// ---------------------------------------------------------------------------

function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function loadState() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    /* første start */
  }
  const generated = [];
  const pick = (envName, key, gen) => {
    if (process.env[envName]) return process.env[envName];
    if (saved[key]) return saved[key];
    generated.push(envName);
    return gen();
  };
  const state = {
    blocked: typeof saved.blocked === 'boolean' ? saved.blocked : process.env.START_BLOCKED === 'true',
    changedAt: saved.changedAt || null,
    changedBy: saved.changedBy || null,
    dnsToken: pick('DNS_TOKEN', 'dnsToken', () => randomToken(12)),
    blockToken: pick('BLOCK_TOKEN', 'blockToken', () => randomToken(12)),
    unblockToken: pick('UNBLOCK_TOKEN', 'unblockToken', () => randomToken(12)),
    adminPassword: pick('ADMIN_PASSWORD', 'adminPassword', () => randomToken(9)),
  };
  if (generated.length) {
    console.log('\n=== Nye hemmeligheder genereret og gemt i', STATE_FILE, '===');
    if (generated.includes('ADMIN_PASSWORD')) {
      console.log('Forælder-adgangskode (ADMIN_PASSWORD):', state.adminPassword);
    }
    console.log('Tip: sæt dem som miljøvariabler, hvis din server ikke har en vedvarende disk.\n');
  }
  return state;
}

const state = loadState();

function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (err) {
    console.error('Kunne ikke gemme tilstand:', err.message);
  }
}
saveState();

function setBlocked(blocked, by) {
  state.blocked = blocked;
  state.changedAt = new Date().toISOString();
  state.changedBy = by;
  saveState();
  console.log(`[${state.changedAt}] YouTube ${blocked ? 'BLOKERET' : 'ÅBNET'} (${by})`);
}

// ---------------------------------------------------------------------------
// DNS (wire format, RFC 1035) – kun det der skal til
// ---------------------------------------------------------------------------

function readName(buf, offset) {
  const labels = [];
  let next = -1;
  let pos = offset;
  for (let hops = 0; hops < 128; hops++) {
    if (pos >= buf.length) throw new Error('name out of bounds');
    const len = buf[pos];
    if (len === 0) {
      if (next < 0) next = pos + 1;
      return { name: labels.join('.').toLowerCase(), next };
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('bad pointer');
      if (next < 0) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    if (pos + 1 + len > buf.length) throw new Error('label out of bounds');
    labels.push(buf.toString('latin1', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  throw new Error('too many labels');
}

function parseQuestion(msg) {
  if (msg.length < 12) throw new Error('short message');
  if (msg.readUInt16BE(4) < 1) throw new Error('no question');
  const { name, next } = readName(msg, 12);
  if (next + 4 > msg.length) throw new Error('truncated question');
  return { name, type: msg.readUInt16BE(next), end: next + 4 };
}

function isBlockedName(name) {
  return BLOCKED_DOMAINS.some((d) => name === d || name.endsWith('.' + d));
}

// Svar "domænet findes ikke" (NXDOMAIN) på et forespørgsel.
function nxdomain(query, questionEnd) {
  const out = Buffer.alloc(questionEnd);
  query.copy(out, 0, 0, questionEnd);
  const qFlags = query.readUInt16BE(2);
  const opcode = qFlags & 0x7800;
  const rd = qFlags & 0x0100;
  out.writeUInt16BE(0x8000 | opcode | rd | 0x0080 | 3, 2); // QR, RA, RCODE=3
  out.writeUInt16BE(1, 4); // QDCOUNT
  out.writeUInt16BE(0, 6); // ANCOUNT
  out.writeUInt16BE(0, 8); // NSCOUNT
  out.writeUInt16BE(0, 10); // ARCOUNT
  return out;
}

// Begræns TTL i et svar, så iPhonen ikke husker YouTube-adresser længe.
function clampTtl(resp, maxTtl) {
  try {
    const qd = resp.readUInt16BE(4);
    const rrCount = resp.readUInt16BE(6) + resp.readUInt16BE(8) + resp.readUInt16BE(10);
    let pos = 12;
    for (let i = 0; i < qd; i++) pos = readName(resp, pos).next + 4;
    for (let i = 0; i < rrCount; i++) {
      pos = readName(resp, pos).next;
      const type = resp.readUInt16BE(pos);
      if (type !== 41 && resp.readUInt32BE(pos + 4) > maxTtl) resp.writeUInt32BE(maxTtl, pos + 4); // 41 = OPT
      pos += 10 + resp.readUInt16BE(pos + 8);
    }
  } catch {
    /* ufuldstændigt svar – send det uændret */
  }
  return resp;
}

class BadQuery extends Error {}

async function resolve(query) {
  let q;
  try {
    q = parseQuestion(query);
  } catch (err) {
    throw new BadQuery(err.message);
  }
  if (isBlockedName(q.name)) {
    if (state.blocked) return { body: nxdomain(query, q.end), maxAge: 0 };
  }
  const res = await fetch(UPSTREAM_DOH, {
    method: 'POST',
    headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' },
    body: query,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error('upstream ' + res.status);
  const body = Buffer.from(await res.arrayBuffer());
  if (isBlockedName(q.name)) return { body: clampTtl(body, YOUTUBE_MAX_TTL), maxAge: 0 };
  return { body, maxAge: 0 };
}

// ---------------------------------------------------------------------------
// HTTP-hjælpere
// ---------------------------------------------------------------------------

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extra,
  });
  res.end(body);
}

function isParent(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const password = decoded.slice(decoded.indexOf(':') + 1);
  return safeEqual(password, state.adminPassword);
}

function requireParent(req, res) {
  if (isParent(req)) return true;
  send(res, 401, page('Log ind', '<p>Skriv forælder-adgangskoden (brugernavn er ligegyldigt).</p>'), undefined, {
    'www-authenticate': 'Basic realm="YouTube-blokering", charset="UTF-8"',
  });
  return false;
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function deterministicUuid(seed) {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--text:#16181d;--muted:#5d6470;--line:#e3e6eb;--red:#d92d20;--red-bg:#fdecea;--green:#12805c;--green-bg:#e7f6ef}
@media (prefers-color-scheme:dark){:root{--bg:#111317;--card:#1b1e24;--text:#eef0f3;--muted:#a1a8b3;--line:#2c3038;--red:#ff6b5e;--red-bg:#3a1d1b;--green:#4cd39b;--green-bg:#15302a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.6rem;margin:0 0 4px}
h2{font-size:1.15rem;margin:0 0 8px}
p{margin:0 0 12px}
.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-top:16px}
.status{display:flex;align-items:center;gap:14px;font-size:1.25rem;font-weight:600}
.dot{width:18px;height:18px;border-radius:50%;flex:none}
.on .dot{background:var(--red)} .off .dot{background:var(--green)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-top:16px}
.qr{text-align:center;border-radius:16px;padding:20px;border:2px solid}
.qr.block{border-color:var(--red);background:var(--red-bg)} .qr.open{border-color:var(--green);background:var(--green-bg)}
.qr svg{width:100%;max-width:240px;height:auto;border-radius:8px;display:block;margin:12px auto}
.qr h2{font-size:1.3rem}
.block h2{color:var(--red)} .open h2{color:var(--green)}
button,.btn{display:inline-block;font:inherit;font-weight:600;border:0;border-radius:10px;padding:12px 18px;cursor:pointer;text-decoration:none;color:#fff}
.btn-red{background:var(--red)} .btn-green{background:var(--green)} .btn-gray{background:#5d6470}
.row{display:flex;flex-wrap:wrap;gap:10px}
.big{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px 16px}
.big .icon{font-size:72px;line-height:1}
.big h1{font-size:2rem;margin:12px 0}
ol{padding-left:20px;margin:0} li{margin:6px 0}
code{background:var(--bg);padding:1px 6px;border-radius:6px;word-break:break-all}
.setup svg{width:180px;height:auto;border-radius:8px}
@media print{body{background:#fff;color:#000}.noprint{display:none!important}.card{border:0}.qr{break-inside:avoid}}
`;

function page(title, body, opts = {}) {
  return `<!doctype html><html lang="da"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
${opts.themeColor ? `<meta name="theme-color" content="${opts.themeColor}">` : ''}
<title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

function fmtTime(iso) {
  if (!iso) return 'aldrig';
  return new Date(iso).toLocaleString('da-DK', { timeZone: process.env.TZ || 'Europe/Copenhagen' });
}

function statusHtml() {
  return `<div class="status ${state.blocked ? 'on' : 'off'}" id="status"><span class="dot"></span>
<span>${state.blocked ? 'YouTube er BLOKERET' : 'YouTube er ÅBEN'}</span></div>
<p class="muted" id="changed">Sidst ændret: ${esc(fmtTime(state.changedAt))}${state.changedBy ? ' (' + esc(state.changedBy) + ')' : ''}</p>`;
}

function dashboard(req) {
  const base = baseUrl(req);
  const blockUrl = `${base}/b/${state.blockToken}`;
  const openUrl = `${base}/u/${state.unblockToken}`;
  const setupUrl = `${base}/setup/${state.dnsToken}`;
  return page(
    'YouTube-blokering',
    `<main>
<h1>YouTube-blokering</h1>
<p class="muted">Scan en QR-kode med et iPhone-kamera for at skifte. Det virker med det samme på alle børnenes telefoner.</p>
<div class="card">${statusHtml()}
<form method="post" action="/api/set" class="row noprint">
<button class="btn-red" name="blocked" value="1">Bloker nu</button>
<button class="btn-green" name="blocked" value="0">Åbn nu</button>
<button type="button" class="btn-gray" onclick="print()">Print QR-koder</button>
</form></div>
<div class="grid">
<div class="qr block"><h2>⛔ Bloker YouTube</h2>${qrSvg(blockUrl)}<p class="muted">Scan for at lukke for YouTube</p></div>
<div class="qr open"><h2>✅ Åbn YouTube</h2>${qrSvg(openUrl)}<p class="muted">Scan for at åbne for YouTube igen</p></div>
</div>
<div class="card setup noprint">
<h2>Første gang: installer på barnets iPhone</h2>
<div class="row" style="align-items:flex-start;gap:20px">
${qrSvg(setupUrl)}
<ol style="flex:1;min-width:220px">
<li>Scan denne QR-kode med <b>barnets</b> iPhone (åbn i Safari).</li>
<li>Tryk <b>Hent profil</b> og vælg <b>Tillad</b>.</li>
<li>Gå til <b>Indstillinger → Profil hentet</b> og tryk <b>Installer</b> (kræver barnets kode).</li>
<li>Færdig. Gentag på hver telefon.</li>
</ol></div>
<p class="muted" style="margin-top:12px">Gem ikke ”Åbn”-koden, hvor børnene kan finde den – alle der scanner den, kan åbne for YouTube.</p>
</div>
</main>
<script>
setInterval(async()=>{try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)return;const s=await r.json();
const el=document.getElementById('status');el.className='status '+(s.blocked?'on':'off');
el.lastElementChild.textContent=s.blocked?'YouTube er BLOKERET':'YouTube er ÅBEN';
document.getElementById('changed').textContent='Sidst ændret: '+s.changedAtText+(s.changedBy?' ('+s.changedBy+')':'');}catch(e){}},4000);
</script>`,
  );
}

function resultPage(blocked) {
  return page(
    blocked ? 'YouTube blokeret' : 'YouTube åbnet',
    `<div class="big ${blocked ? 'on' : 'off'}">
<div class="icon">${blocked ? '⛔' : '✅'}</div>
<h1 style="color:var(--${blocked ? 'red' : 'green'})">${blocked ? 'YouTube er blokeret' : 'YouTube er åbent igen'}</h1>
<p class="muted">${blocked
      ? 'Det kan tage op til et minut. Luk YouTube-appen helt, hvis den stadig kører.'
      : 'Det kan tage op til et minut, før YouTube virker igen.'}</p>
</div>`,
    { themeColor: blocked ? '#d92d20' : '#12805c' },
  );
}

function setupPage() {
  return page(
    'Installer YouTube-blokering',
    `<main>
<h1>Installer YouTube-blokering</h1>
<div class="card">
<p>Denne iPhone får en DNS-profil, så forældrene kan slå YouTube til og fra.</p>
<p><a class="btn btn-red" href="/profile/${esc(state.dnsToken)}.mobileconfig">Hent profil</a></p>
<ol>
<li>Tryk <b>Tillad</b>, når Safari spørger.</li>
<li>Åbn <b>Indstillinger</b>. Øverst står <b>Profil hentet</b> – tryk på den.</li>
<li>Tryk <b>Installer</b> (øverst til højre), skriv telefonens kode og tryk <b>Installer</b> igen.</li>
</ol>
<p class="muted" style="margin-top:12px">Kan du ikke se ”Profil hentet”? Gå til Indstillinger → Generelt → VPN og enhedsadministration.</p>
</div></main>`,
  );
}

function mobileconfig(req) {
  const dohUrl = `${baseUrl(req)}/dns-query/${state.dnsToken}`;
  const x = (s) => esc(s);
  const removal = PROFILE_REMOVAL_PASSWORD
    ? `
    <dict>
      <key>PayloadType</key><string>com.apple.profileRemovalPassword</string>
      <key>PayloadIdentifier</key><string>dk.familie.youtubeblock.removalpassword</string>
      <key>PayloadUUID</key><string>${deterministicUuid('rm' + state.dnsToken)}</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadDisplayName</key><string>Adgangskode til fjernelse</string>
      <key>RemovalPassword</key><string>${x(PROFILE_REMOVAL_PASSWORD)}</string>
    </dict>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key><string>com.apple.dnsSettings.managed</string>
      <key>PayloadIdentifier</key><string>dk.familie.youtubeblock.dns</string>
      <key>PayloadUUID</key><string>${deterministicUuid('dns' + state.dnsToken)}</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadDisplayName</key><string>YouTube-blokering (DNS)</string>
      <key>DNSSettings</key>
      <dict>
        <key>DNSProtocol</key><string>HTTPS</string>
        <key>ServerURL</key><string>${x(dohUrl)}</string>
      </dict>
    </dict>${removal}
  </array>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadIdentifier</key><string>dk.familie.youtubeblock</string>
  <key>PayloadUUID</key><string>${deterministicUuid('profile' + state.dnsToken)}</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadDisplayName</key><string>YouTube-blokering</string>
  <key>PayloadDescription</key><string>Gør det muligt for forældre at slå YouTube til og fra med en QR-kode.</string>
  <key>PayloadOrganization</key><string>Familien</string>
  <key>PayloadRemovalDisallowed</key><false/>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handleDoh(req, res, url) {
  let query;
  if (req.method === 'GET') {
    const param = url.searchParams.get('dns');
    if (!param) return send(res, 400, 'missing dns parameter', 'text/plain');
    query = Buffer.from(param, 'base64url');
  } else if (req.method === 'POST') {
    query = await readBody(req, 4096);
  } else {
    return send(res, 405, 'method not allowed', 'text/plain');
  }
  try {
    const { body, maxAge } = await resolve(query);
    res.writeHead(200, { 'content-type': 'application/dns-message', 'cache-control': `max-age=${maxAge}` });
    res.end(body);
  } catch (err) {
    if (!(err instanceof BadQuery)) console.error('DNS-fejl:', err.message);
    send(res, err instanceof BadQuery ? 400 : 502, err instanceof BadQuery ? 'bad query' : 'upstream error', 'text/plain');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    // DNS-over-HTTPS: /dns-query/<dnsToken>
    if (parts[0] === 'dns-query' && parts.length === 2 && safeEqual(parts[1], state.dnsToken)) {
      return await handleDoh(req, res, url);
    }
    // QR: bloker
    if (parts[0] === 'b' && parts.length === 2 && safeEqual(parts[1], state.blockToken)) {
      if (!state.blocked) setBlocked(true, 'QR-kode');
      return send(res, 200, resultPage(true));
    }
    // QR: åbn
    if (parts[0] === 'u' && parts.length === 2 && safeEqual(parts[1], state.unblockToken)) {
      if (state.blocked) setBlocked(false, 'QR-kode');
      return send(res, 200, resultPage(false));
    }
    // Installation på barnets telefon
    if (parts[0] === 'setup' && parts.length === 2 && safeEqual(parts[1], state.dnsToken)) {
      return send(res, 200, setupPage());
    }
    if (parts[0] === 'profile' && parts.length === 2 && safeEqual(parts[1], state.dnsToken + '.mobileconfig')) {
      return send(res, 200, mobileconfig(req), 'application/x-apple-aspen-config', {
        'content-disposition': 'attachment; filename="youtube-blokering.mobileconfig"',
      });
    }
    if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');

    // Forælder-sider (adgangskode)
    if (url.pathname === '/' && req.method === 'GET') {
      if (!requireParent(req, res)) return;
      return send(res, 200, dashboard(req));
    }
    if (url.pathname === '/api/status' && req.method === 'GET') {
      if (!requireParent(req, res)) return;
      return send(res, 200, JSON.stringify({
        blocked: state.blocked,
        changedAt: state.changedAt,
        changedAtText: fmtTime(state.changedAt),
        changedBy: state.changedBy,
      }), 'application/json');
    }
    if (url.pathname === '/api/set' && req.method === 'POST') {
      if (!requireParent(req, res)) return;
      const form = new URLSearchParams((await readBody(req)).toString('utf8'));
      const blocked = form.get('blocked') === '1';
      if (blocked !== state.blocked) setBlocked(blocked, 'forælder-siden');
      res.writeHead(303, { location: '/', 'cache-control': 'no-store' });
      return res.end();
    }
    send(res, 404, page('Ikke fundet', '<main><h1>Ikke fundet</h1></main>'));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'Serverfejl', 'text/plain');
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`YouTube-blokering kører på port ${PORT}. YouTube er ${state.blocked ? 'BLOKERET' : 'ÅBEN'}.`);
    console.log(`Blokerede domæner: ${BLOCKED_DOMAINS.join(', ')}`);
  });
}

module.exports = { server, parseQuestion, isBlockedName, nxdomain, clampTtl, state };
