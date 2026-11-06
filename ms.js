'use strict';
// Microsoft-login (OAuth 2.0 med PKCE) og Microsoft Graph – så web-appen kan vise projekter i OneDrive/Teams og
// gemme fotos og dokumenter direkte i projektets A104-mapper (»📥 Læg i mappe«). Appen er registreret til alle
// organisationer og private Microsoft-konti (tenant »common«); en organisation, der ikke lader brugerne godkende apps
// selv, skal godkende den én gang. Login-oplysningerne (tokens) gemmes i browseren på denne enhed og sendes kun til Microsoft.

const MS = (() => {
  const CLIENT_ID = '5457c050-b66e-4e6d-8303-c8ae2ced7473';
  const TENANT = 'common';
  const AUTHORITY = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
  const SCOPES = 'openid profile offline_access User.Read Files.ReadWrite.All';  // .All: også Teams-/SharePoint-mapper
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const KEY = 'a104-ms';             // ældre versioner: én konto
  const ACCOUNTS = 'a104-ms-konti';  // {current, list: {bruger: session}} – flere Microsoft-konti (skole, privat …)
  const FLOW_KEY = 'a104-ms-flow';

  const configured = !!CLIENT_ID && !CLIENT_ID.startsWith('__');
  const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');

  const load = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
  const save = (key, value) => {
    try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* privat vindue */ }
  };

  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

  function claims(idToken) {
    try {
      const part = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(part))));
    } catch { return {}; }
  }

  let saved = load(ACCOUNTS) || { current: '', list: {} };
  const legacy = load(KEY);
  if (legacy && !Object.keys(saved.list).length) {  // flyt den ene konto fra en ældre version over
    const k = (legacy.user || 'konto').toLowerCase();
    saved = { current: k, list: { [k]: legacy } };
    save(ACCOUNTS, saved);
    save(KEY, null);
  }
  let session = saved.list[saved.current] || null;
  const keyOf = (s) => (s.user || 'konto').toLowerCase();
  // læs listen igen før hver ændring, så en konto tilføjet i et andet vindue ikke overskrives
  const fresh = () => { const f = load(ACCOUNTS); if (f && f.list) saved = f; return saved; };
  const persist = () => {
    const current = saved.current;
    fresh();
    if (session) saved.list[keyOf(session)] = session;
    saved.current = current;
    save(ACCOUNTS, saved);
  };

  function keep(tokens) {
    const c = tokens.id_token ? claims(tokens.id_token) : {};
    const user = c.preferred_username || session?.user || '';
    const prev = saved.list[(user || 'konto').toLowerCase()] || null;
    session = {
      access: tokens.access_token,
      refresh: tokens.refresh_token || prev?.refresh,
      expires: Date.now() + (tokens.expires_in || 3600) * 1000,
      name: c.name || prev?.name || '',
      user,
      tenant: c.tid || prev?.tenant || '',
    };
    saved.current = keyOf(session);
    persist();
  }

  /** Skift til en anden af de tilføjede konti. */
  function use(key) {
    fresh();
    if (!saved.list[key]) return false;
    session = saved.list[key];
    saved.current = key;
    save(ACCOUNTS, saved);
    return true;
  }

  async function tokenRequest(params) {
    const body = new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPES, ...params });
    const res = await fetch(`${AUTHORITY}/token`, { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error_description || data.error || `HTTP ${res.status}`), { code: data.error });
    return data;
  }

  /** Send brugeren til Microsofts login. `returnHash` er siden, appen vender tilbage til. `add`: tilføj en konto mere
   *  (Microsoft viser kontovalget i stedet for at logge den nuværende ind igen). */
  async function login(returnHash = location.hash, { add = false } = {}) {
    const verifier = random(48);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const state = random(16);
    save(FLOW_KEY, { verifier, state, returnHash, at: Date.now() });
    const q = new URLSearchParams({
      client_id: CLIENT_ID, response_type: 'code', redirect_uri: redirectUri(), response_mode: 'query',
      scope: SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256',
    });
    if (session?.user && !add) q.set('login_hint', session.user); else q.set('prompt', 'select_account');
    location.assign(`${AUTHORITY}/authorize?${q}`);
  }

  /** Kaldes ved start: afslutter et login, hvis Microsoft lige har sendt brugeren tilbage (?code=…). */
  async function handleRedirect() {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return null;
    const flow = load(FLOW_KEY);
    save(FLOW_KEY, null);
    const back = (flow && flow.returnHash) || '#/project';
    history.replaceState(null, '', redirectUri() + back);
    if (q.has('error')) return { error: q.get('error_description') || q.get('error') };
    if (!flow || flow.state !== q.get('state')) return { error: 'Login kunne ikke gennemføres (udløbet). Prøv igen.' };
    try {
      keep(await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri(), code_verifier: flow.verifier }));
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  }

  async function token() {
    if (!session) throw Object.assign(new Error('Ikke logget ind'), { code: 'login_required' });
    if (session.access && session.expires - Date.now() > 120000) return session.access;
    if (!session.refresh) throw Object.assign(new Error('Login er udløbet'), { code: 'login_required' });
    try {
      keep(await tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refresh }));
    } catch (err) {
      if (err.code === 'invalid_grant' || err.code === 'interaction_required') {
        session = { ...session, access: null, refresh: null };
        persist();
        throw Object.assign(new Error('Login er udløbet – log ind igen'), { code: 'login_required' });
      }
      throw err;
    }
    return session.access;
  }

  /** Kald til Microsoft Graph. `path` er relativ (/me/…) eller en fuld @odata.nextLink. */
  async function request(method, path, { body, type } = {}, retry = true) {
    const headers = { Authorization: `Bearer ${await token()}` };
    if (type) headers['Content-Type'] = type;
    const res = await fetch(path.startsWith('https://') ? path : GRAPH + path, { method, headers, body });
    if (res.status === 401 && retry) { session.expires = 0; return request(method, path, { body, type }, false); }
    if (res.status === 429 || res.status === 503) {
      const wait = Math.min(Number(res.headers.get('Retry-After')) || 2, 20);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return request(method, path, { body, type }, retry);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = data.error?.code || '';
      const msg = res.status === 403 ? 'Ingen adgang – din organisation har måske ikke godkendt appen, eller du har ikke adgang til mappen.'
        : res.status === 404 ? 'Mappen findes ikke længere (eller er flyttet).' : (data.error?.message || `HTTP ${res.status}`);
      throw Object.assign(new Error(msg), { code, status: res.status });
    }
    return data;
  }

  const get = (path) => request('GET', path);

  /** Mappen bag et link fra SharePoint/OneDrive (fx projektmappens adresse fra QR-koden): {driveId, id, webUrl}. */
  async function resolve(webUrl) {
    const share = `u!${b64url(new TextEncoder().encode(webUrl.split('?')[0]))}`;
    const d = await get(`/shares/${share}/driveItem?$select=id,name,webUrl,parentReference`);
    return { driveId: d.parentReference.driveId, id: d.id, webUrl: d.webUrl };
  }

  /** Gem en fil i `folderId` (på `driveId`) under den relative sti `path` (»C05 Analyse/C05.06 Foto og video/navn.jpg«).
   *  Manglende mapper oprettes; findes navnet, får den nye fil et »(1)«-navn i stedet for at overskrive. */
  async function upload(driveId, folderId, path, file, progress) {
    const target = `/drives/${driveId}/items/${folderId}:/${path.split('/').map(encodeURIComponent).join('/')}:`;
    if (file.size <= 4 * 1024 * 1024) {
      return request('PUT', `${target}/content?@microsoft.graph.conflictBehavior=rename`, { body: file, type: file.type || 'application/octet-stream' });
    }
    const { uploadUrl } = await request('POST', `${target}/createUploadSession`,
      { body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }), type: 'application/json' });
    const CHUNK = 320 * 1024 * 12;  // skal gå op i 320 KiB
    let item = null;
    for (let at = 0; at < file.size; at += CHUNK) {
      const part = file.slice(at, at + CHUNK);
      const res = await fetch(uploadUrl, { method: 'PUT', body: part,
        headers: { 'Content-Range': `bytes ${at}-${at + part.size - 1}/${file.size}` } });
      if (!res.ok) throw Object.assign(new Error(`Upload fejlede (HTTP ${res.status})`), { status: res.status });
      if (res.status === 200 || res.status === 201) item = await res.json();
      if (progress) progress(Math.min(at + CHUNK, file.size), file.size);
    }
    return item;
  }

  /** Alle sider af en liste (value + @odata.nextLink). */
  async function all(path) {
    const out = [];
    let next = path;
    while (next) {
      const d = await get(next);
      out.push(...(d.value || []));
      next = d['@odata.nextLink'];
    }
    return out;
  }

  /** Log en konto ud (standard: den, der bruges nu). Er der flere, skiftes der til den næste. */
  function logout(key = saved.current) {
    fresh();
    delete saved.list[key];
    if (saved.current === key) saved.current = Object.keys(saved.list)[0] || '';
    session = saved.list[saved.current] || null;
    save(ACCOUNTS, saved);
  }

  /** Som resolve, men prøver alle tilføjede konti – den nuværende først. Returnerer også, hvilken konto der havde adgang. */
  async function resolveAny(webUrl) {
    const start = saved.current;
    let last = null;
    for (const k of [start, ...Object.keys(saved.list).filter((x) => x !== start)]) {
      if (!use(k)) continue;
      try { return { ...(await resolve(webUrl)), account: k }; } catch (err) {
        last = err;
        if (![401, 403, 404].includes(err.status) && err.code !== 'login_required') break;
      }
    }
    if (start) use(start);
    throw last || Object.assign(new Error('Ikke logget ind'), { code: 'login_required' });
  }

  return {
    configured,
    get signedIn() { return !!(session && (session.refresh || session.access)); },
    get account() { return session ? { key: keyOf(session), name: session.name, user: session.user } : null; },
    get accounts() {
      return Object.entries(fresh().list).map(([key, s]) => ({ key, name: s.name, user: s.user, active: key === saved.current,
        signedIn: !!(s.refresh || s.access) }));
    },
    has: (key) => !!fresh().list[key],
    login, handleRedirect, logout, use, get, all, resolve, resolveAny, upload,
  };
})();
