'use strict';
// A104 Navigator – web-app (PWA). Brugerfladen er skrevet her; al logik (søgning, dokumentfinder, BR18, AB 18 …)
// er A104 Navigators egen Python-kerne, der kører i worker.js med Pyodide.

const BUILD = '2.18.0-0925f9a716';
const VERSION = '2.18.0';

// =========================================================================== hjælpere
const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const isNarrow = () => matchMedia('(max-width: 900px)').matches;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

let toastTimer;
function toast(text, action) {
  const el = $('#toast');
  el.replaceChildren(h('span', {}, text));
  if (action) el.append(h('button', { type: 'button', onclick: () => { el.hidden = true; action.run(); } }, action.label));
  el.hidden = false;
  clearTimeout(toastTimer);
  if (!action) toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Kopieret: ${(label || text).slice(0, 80)}`);
  } catch {
    toast('Kunne ikke kopiere – markér teksten og kopiér selv.');
  }
}

// A104-koder sammenlignes uden foranstillede nuller: Y070 = Y70, c04.04 = C4.4 (som database.code_key)
const codeKey = (s) => (s || '').trim().toUpperCase().replace(/(^|[^0-9])0+(?=\d)/g, '$1');

// =========================================================================== lager
// Favoritter og indstillinger gemmes i browserens IndexedDB (kun på denne enhed).
const store = (() => {
  const memory = new Map();
  let dbp = null;
  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('a104-navigator', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  return {
    async get(key, fallback) {
      try {
        const db = await open();
        const value = await new Promise((resolve, reject) => {
          const req = db.transaction('kv').objectStore('kv').get(key);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        return value === undefined ? fallback : value;
      } catch {
        return memory.has(key) ? memory.get(key) : fallback;
      }
    },
    async set(key, value) {
      memory.set(key, value);
      try {
        const db = await open();
        await new Promise((resolve, reject) => {
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(value, key);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      } catch { /* privat vindue o.l. – værdien gælder kun i denne session */ }
    },
    async clear() {
      memory.clear();
      try {
        const db = await open();
        db.transaction('kv', 'readwrite').objectStore('kv').clear();
      } catch { /* intet at rydde */ }
    },
  };
})();

// =========================================================================== Python-kernen
const worker = new Worker('worker.js');
const pending = new Map();
let seq = 0;
worker.onmessage = ({ data }) => {
  if (data.progress) { $('#splash-text').textContent = data.progress; return; }
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  if (data.ok) p.resolve(data.result); else p.reject(new Error(data.error));
};
worker.onerror = (ev) => fail(`Python-kernen kunne ikke starte: ${ev.message || 'ukendt fejl'}`);

function api(fn, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, fn, args });
  });
}

// =========================================================================== tilstand
const prefs = { theme: 'system', projectId: '', includePid: false };
let meta = {};
let installPrompt = null;
const cache = {};

function applyTheme() {
  const root = document.documentElement;
  if (prefs.theme === 'system') root.removeAttribute('data-theme'); else root.dataset.theme = prefs.theme;
  const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('#theme-toggle').textContent = dark ? '☀️  Lys tilstand' : '🌙  Mørk tilstand';
  $('meta[name="theme-color"]').content = dark ? '#131519' : '#0F2C4C';
}

async function savePrefs() {
  await store.set('prefs', { ...prefs });
}

// =========================================================================== navigation
const NAV = [
  ['dashboard', '🏠', 'Dashboard'], ['project', '📂', 'Projekt'], ['finder', '🔎', 'Dokumentfinder'], ['tree', '🗂', 'Mappestruktur'],
  ['codes', '🏷', 'Koder'], ['learn', '📘', 'Lær A104'], ['label', 'REGLER OG AFTALER'],
  ['br18', '📗', 'BR18 2026'], ['law/ab18', '⚖', 'AB 18'], ['law/abr18', '⚖', 'ABR 18'], ['law/abt18', '⚖', 'ABT 18'],
  ['label', ''], ['favorites', '⭐', 'Favoritter'], ['settings', '⚙', 'Indstillinger'],
];
const TIPS = {
  'law/ab18': 'AB 18 – arbejder og leverancer (bygherre ↔ entreprenør)',
  'law/abr18': 'ABR 18 – rådgivning og bistand (bygherre ↔ rådgiver)',
  'law/abt18': 'ABT 18 – totalentreprise (bygherre ↔ totalentreprenør)',
  br18: 'Bygningsreglementet: krav, tabeller og vejledninger',
};

function buildNav() {
  const nav = $('#nav');
  for (const [path, icon, label] of NAV) {
    if (path === 'label') { nav.append(h('div', { class: 'nav-label' }, icon)); continue; }
    nav.append(h('a', { class: 'nav-btn', href: `#/${path}`, 'data-path': path, title: TIPS[path] },
      h('span', { class: 'ico', 'aria-hidden': 'true' }, icon), label));
  }
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  return { path: path || 'dashboard', params: new URLSearchParams(query || '') };
}

function navigate(path, params = {}, { replace = false } = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  const hash = `#/${path}${q ? `?${q}` : ''}`;
  if (location.hash === hash) return;
  if (replace) { history.replaceState(history.state, '', hash); render(); } else location.hash = hash;
}

let current = { path: null, page: null };
let savedScroll = null;

function render() {
  const { path, params } = parseHash();
  const factory = PAGES[path] || (path.startsWith('law/') ? (v, p) => new LawPage(v, p, path.slice(4)) : null);
  if (!factory) { navigate('dashboard', {}, { replace: true }); return; }
  for (const a of document.querySelectorAll('.nav-btn')) {
    a.toggleAttribute('aria-current', a.dataset.path === path);
    if (a.dataset.path === path) a.setAttribute('aria-current', 'page');
  }
  closeMenu();
  if (path !== 'search' && path !== 'finder') syncSearchBox('');
  if (current.path === path && current.page.update) { current.page.update(params); return; }
  view.replaceChildren();
  view.scrollTop = 0;
  savedScroll = null;
  current = { path, page: factory(view, params) };
}

window.addEventListener('hashchange', render);
window.addEventListener('popstate', () => {
  if (history.state && history.state.sheet) return;
  const open = document.querySelectorAll('.split.show-detail');
  open.forEach((s) => s.classList.remove('show-detail'));
  if (open.length && savedScroll != null) { view.scrollTop = savedScroll; savedScroll = null; }
});

function openMenu() { $('#app').classList.add('menu-open'); $('#scrim').hidden = false; }
function closeMenu() { $('#app').classList.remove('menu-open'); $('#scrim').hidden = true; }

// Links i HTML fra Python-kernen: folder:C04.04, doc:12, code:33, karea:K01, tree:C04, family:K, br18:82, law:12 …
const ENTITY_SCHEMES = { folder: 'folder', doc: 'document', ex: 'example', code: 'code', disc: 'discipline', karea: 'knowledge_area' };

view.addEventListener('click', (ev) => {
  const a = ev.target.closest('a[href]');
  if (!a || !view.contains(a)) return;
  const href = a.getAttribute('href');
  if (/^(https?:|mailto:)/i.test(href)) { a.target = '_blank'; a.rel = 'noopener'; return; }
  if (href.startsWith('#') || /\.pdf(#|$)/i.test(href)) return;
  ev.preventDefault();
  const owner = a.closest('.pane')?._owner;
  if (current.page?.onLink && current.page.onLink(href, owner)) return;
  defaultLink(href, owner);
});

function defaultLink(href, owner) {
  const i = href.indexOf(':');
  const scheme = href.slice(0, i);
  const key = decodeURIComponent(href.slice(i + 1));
  if (ENTITY_SCHEMES[scheme]) {
    const target = owner instanceof EntityDetail ? owner : current.page?.detail;
    if (target) target.show({ type: ENTITY_SCHEMES[scheme], key });
  } else if (scheme === 'tree') navigate('tree', { code: key });
  else if (scheme === 'family') navigate('codes', { family: key });
  else if (scheme === 'br18') navigate('br18', { p: key });
  else if (scheme === 'tab') navigate('br18', { tab: 'tables', t: key });
}

// =========================================================================== byggeklodser
function pageHead(title, subtitle) {
  return h('div', { class: 'page-head' }, h('h1', {}, title), subtitle ? h('p', {}, subtitle) : null);
}

function row({ code = '', title = '', sub = '', score = '', dim = false }, onclick) {
  return h('button', { type: 'button', class: `row${dim ? ' dim' : ''}${code ? '' : ' plain'}`, onclick, title: sub || title },
    code ? h('span', { class: 'r-code' }, code) : null, h('span', { class: 'r-title' }, title),
    h('span', { class: 'r-score' }, score), sub ? h('span', { class: 'r-sub' }, sub) : null);
}

/** Rul `el` til syne i sin egen rulleboks (pane) uden at rulle resten af siden – som scrollIntoView ville. */
function scrollWithin(el, where = 'start') {
  const box = el.closest('.pane-scroll');
  if (!box || isNarrow()) return;
  const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  if (where === 'nearest') {
    const bottom = top + el.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
  } else {
    box.scrollTop = where === 'center' ? top - box.clientHeight / 2 + el.offsetHeight / 2 : top - 8;
  }
}

function select(container, el) {
  container.querySelectorAll('[aria-selected="true"]').forEach((x) => x.removeAttribute('aria-selected'));
  if (el) el.setAttribute('aria-selected', 'true');
}

function listPane(extraClass = '') {
  const el = h('section', { class: `pane ${extraClass}` });
  const scroll = h('div', { class: 'pane-scroll' });
  el.append(scroll);
  return { el, scroll };
}

function option(value, label, selected) {
  return h('option', { value, selected: selected ? 'selected' : null }, label);
}

/** Læsevisning med værktøjslinje. På mobil vises den som en fuld side med »‹ Tilbage«. */
class Pane {
  constructor({ empty = '', prose = false } = {}) {
    this.el = h('section', { class: 'pane detail' });
    this.el._owner = this;
    this.bar = h('div', { class: 'pane-bar' },
      h('button', { type: 'button', class: 'btn flat back-btn', onclick: () => history.back() }, '‹ Tilbage'));
    this.tools = h('div', { class: 'toolbar' });
    this.bar.append(h('span', { class: 'spacer' }), this.tools);
    this.body = h('div', { class: 'pane-scroll' });
    this.doc = h('div', { class: `doc${prose ? ' prose' : ''}` });
    this.body.append(this.doc);
    this.el.append(this.bar, this.body);
    this.setEmpty(empty);
  }

  tool(label, onclick, title) {
    const b = h('button', { type: 'button', class: 'btn flat', onclick, title }, label);
    this.tools.append(b);
    return b;
  }

  setEmpty(text) {
    this.doc.innerHTML = `<p class="empty">${esc(text)}</p>`;
  }

  setHtml(html, anchor) {
    this.doc.innerHTML = html;
    this.body.scrollTop = 0;
    const target = anchor && this.doc.querySelector(`#${anchor}`);
    if (target) scrollWithin(target);
  }

  reveal() {
    const split = this.el.closest('.split');
    if (!split || !isNarrow()) return;
    if (!split.classList.contains('show-detail')) {
      savedScroll = view.scrollTop;
      split.classList.add('show-detail');
      history.pushState({ sheet: true }, '');
    }
    view.scrollTop = 0;
  }
}

/** Detaljevisning af mapper, dokumenter, koder … (HTML fra detail_renderer.py), med historik og favorit. */
class EntityDetail extends Pane {
  constructor({ empty = 'Vælg et element for at se detaljer.', tree = true } = {}) {
    super({ empty });
    this.history = [];
    this.ref = null;
    this.token = 0;
    this.prevBtn = this.tool('‹', () => this.goBack(), 'Forrige');
    this.favBtn = this.tool('☆ Favorit', () => this.toggleFavorite(), 'Gem som favorit');
    this.copyBtn = this.tool('⧉ Kopiér', () => this.copy(), 'Kopiér kode og navn');
    this.treeBtn = tree ? this.tool('🗂 Vis i mappestruktur', () => navigate('tree', { code: this.ref.key })) : null;
    this.updateTools();
  }

  async show(ref, { push = true, reveal = true } = {}) {
    const token = ++this.token;
    let d;
    try {
      d = await api('detail', ref.type, String(ref.key));
    } catch (err) {
      toast(`Fejl: ${err.message}`);
      return;
    }
    if (token !== this.token) return;
    if (push && this.ref && !(this.ref.type === ref.type && this.ref.key === ref.key)) this.history.push(this.ref);
    this.ref = ref;
    this.data = d;
    this.setHtml(d.html);
    this.updateTools();
    if (reveal) this.reveal();
  }

  clear(text) {
    this.ref = null;
    this.data = null;
    this.history = [];
    this.setEmpty(text || 'Vælg et element for at se detaljer.');
    this.updateTools();
  }

  goBack() {
    const ref = this.history.pop();
    if (ref) this.show(ref, { push: false, reveal: false });
  }

  updateTools() {
    const d = this.data;
    this.prevBtn.disabled = !this.history.length;
    this.favBtn.disabled = !d;
    this.copyBtn.disabled = !d;
    this.favBtn.textContent = d && d.fav ? '★ Favorit' : '☆ Favorit';
    this.favBtn.classList.toggle('on', !!(d && d.fav));
    if (this.treeBtn) this.treeBtn.hidden = !(d && d.folder) || current.path === 'tree';
  }

  async toggleFavorite() {
    if (!this.ref) return;
    const res = await api('toggle_favorite', this.ref.type, String(this.ref.key));
    await store.set('favorites', res.export);
    this.data.fav = res.fav;
    this.updateTools();
    toast(res.fav ? 'Gemt i Favoritter' : 'Fjernet fra Favoritter');
    window.dispatchEvent(new Event('favorites-changed'));
  }

  copy() {
    if (!this.data) return;
    const text = `${this.data.code} ${this.data.title}`.trim();
    copyText(text);
  }
}

// =========================================================================== Dashboard
class Dashboard {
  constructor(root) {
    this.root = h('div', { class: 'page' });
    root.append(this.root);
    this.build();
  }

  async build() {
    const d = cache.dashboard || (cache.dashboard = await api('dashboard'));
    const s = d.stats;
    const r = this.root;
    r.append(pageHead('Velkommen til A104 Navigator',
      'Dit opslagsværk til A104 Informationshåndtering – find placering, koder og filnavne, og lær systematikken bag.'));

    if (installPrompt || isIos()) r.append(installCard());

    r.append(h('div', { class: 'card card-row' },
      h('div', {}, h('h2', {}, '📘  Ny til A104?'),
        h('div', { class: 'muted' }, 'Lær tankegangen bag koder, filnavne, versioner og mappestruktur – med navnebygger og en lille test.')),
      h('a', { class: 'btn primary', href: '#/learn' }, 'Åbn Lær A104')));

    r.append(h('div', { class: 'section-title' }, 'Hurtigsøgning'));
    r.append(h('div', { class: 'quick-grid' }, d.quick.map((q) =>
      h('button', { type: 'button', class: 'quick', onclick: () => runGlobalSearch(q.query) }, `${q.emoji}  ${q.label}`))));

    r.append(h('div', { class: 'stats' },
      [['folders', 'Mapper'], ['documents', 'Dokumenttyper'], ['codes', 'Koder'], ['examples', 'Eksempler fra Excel']]
        .map(([k, label]) => h('div', { class: 'stat' }, h('b', {}, (s[k] || 0).toLocaleString('da-DK')), h('span', {}, label)))));

    r.append(h('div', {}, h('div', { class: 'section-title' }, 'Kodesystemet i A104'),
      h('div', { class: 'muted' }, 'Hvert metadata i A104 har et bogstav (præfiks). Klik for at se alle koder i familien.')));
    r.append(h('div', { class: 'chips' }, d.families.map((f) =>
      h('a', { class: 'chip', href: `#/codes?family=${encodeURIComponent(f.family)}`, title: f.description },
        `${f.family} · ${f.name} (${f.n})`))));

    r.append(h('div', { class: 'card' }, h('h2', {}, 'Sådan bruger du A104 Navigator'), h('div', {
      html: '• <b>Søg</b> øverst med almindeligt dansk: <i>brandstrategi</i>, <i>KS</i>, <i>referat</i>, <i>K01</i> eller <i>D2.A5</i>.<br>'
        + '• <b>Dokumentfinder</b>: skriv fx <i>»Jeg har lavet et referat fra projekteringsmøde«</i> og få placering, fase, fag og filnavn.<br>'
        + '• <b>Mappestruktur</b>: klik dig gennem A104 og læs formål, typiske dokumenter og eksempler.<br>'
        + '• <b>BR18 og AB 18</b>: søg i bygningsreglementet og aftalevilkårene – også uden internet.<br>'
        + '• <b>Genveje</b>: / eller Ctrl+K søg · Esc ryd søgning.',
    })));
  }
}

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone;

function installCard() {
  const card = h('div', { class: 'card card-row' });
  if (installPrompt) {
    card.append(h('div', {}, h('h2', {}, '📲  Installér A104 Navigator'),
      h('div', { class: 'muted' }, 'Få appen i Start-menuen, på skrivebordet eller hjemmeskærmen. Den virker også offline.')),
    h('button', { type: 'button', class: 'btn primary', onclick: promptInstall }, 'Installér'));
  } else {
    card.append(h('div', {}, h('h2', {}, '📲  Læg appen på hjemmeskærmen'),
      h('div', { class: 'muted', html: 'Tryk på <b>Del</b> i Safari og vælg <b>Føj til hjemmeskærm</b>. Så åbner A104 Navigator som en app og virker offline.' })));
  }
  return card;
}

async function promptInstall() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
}

// =========================================================================== Søgning
class SearchPage {
  constructor(root, params) {
    this.root = h('div', { class: 'page fill' });
    this.title = h('h1', {}, 'Søgeresultater');
    this.count = h('span', { class: 'muted' });
    this.chips = h('div', { class: 'chips' });
    this.bannerText = h('div');
    this.banner = h('div', { class: 'banner', hidden: true }, this.bannerText,
      h('button', { type: 'button', class: 'btn primary', onclick: () => navigate('finder', { q: this.query }) }, 'Åbn i dokumentfinder'));
    const list = listPane();
    this.list = list.scroll;
    this.detail = new EntityDetail({ empty: 'Vælg et resultat for at se detaljer.' });
    this.split = h('div', { class: 'split' }, list.el, this.detail.el);
    this.root.append(h('div', { class: 'page-head card-row' }, this.title, this.count), this.chips, this.banner, this.split);
    root.append(this.root);
    this.token = 0;
    this.update(params);
  }

  async update(params) {
    const q = (params.get('q') || '').trim();
    syncSearchBox(q);
    if (q === this.query) return;
    this.query = q;
    const token = ++this.token;
    const res = await api('search', q, prefs.projectId, prefs.includePid);
    if (token !== this.token) return;
    this.title.textContent = `Søgeresultater for »${q}«`;
    this.count.textContent = `${res.hits.length} resultater`;
    this.list.replaceChildren();
    if (!res.hits.length) {
      this.list.append(h('p', { class: 'empty' }, `Ingen resultater for »${q}«. Prøv et andet ord, en kode (fx K01) eller brug Dokumentfinderen.`));
      this.detail.clear('Vælg et resultat for at se detaljer.');
    }
    const ul = h('div', { class: 'list' });
    res.hits.forEach((hit, i) => {
      const el = row({ code: hit.code, title: `${hit.icon}  ${hit.title}`, sub: hit.subtitle, score: `${hit.score} %` }, () => {
        select(ul, el);
        this.detail.show(hit.ref);
      });
      ul.append(el);
      if (i === 0) { select(ul, el); this.detail.show(hit.ref, { push: false, reveal: false }); }
    });
    this.list.append(ul);
    const b = res.banner;
    this.banner.hidden = !b;
    if (b) {
      this.bannerText.innerHTML = `💡 <b>Foreslået placering:</b> ${esc(b.code)} ${esc(b.name)} <span class="muted">(${b.probability} %)</span>`
        + `<br><span class="muted">${esc(b.path)}</span>`;
    }
    this.chips.replaceChildren();
    const counts = await api('search_counts', q);
    if (token !== this.token) return;
    const parts = [];
    if (counts.br18.krav) parts.push(`${counts.br18.krav} krav`);
    if (counts.br18.guides) parts.push(`${counts.br18.guides} vejledninger`);
    if (parts.length) {
      this.chips.append(h('a', { class: 'chip', href: `#/br18?q=${encodeURIComponent(q)}` }, `📗 BR18: ${parts.join(' · ')} ›`));
    }
    for (const law of counts.laws) {
      if (law.n) this.chips.append(h('a', { class: 'chip', href: `#/law/${law.code}?q=${encodeURIComponent(q)}` }, `⚖ ${law.name}: ${law.n} § ›`));
    }
  }
}

function syncSearchBox(q) {
  const input = $('#global-search');
  if (document.activeElement !== input && input.value !== q) input.value = q;
}

function runGlobalSearch(q) {
  $('#global-search').value = q;
  navigate('search', { q });
}

// =========================================================================== Dokumentfinder
const FINDER_EXAMPLES = ['Brandstrategirapport', 'Hvor skal en kontrolplan ligge?', 'Jeg har lavet et referat fra projekteringsmøde',
  'Jeg har lavet en energirammeberegning', 'Brandtegning', 'Fagmodel for konstruktioner', 'Tilbudsliste til udbud', 'D&V-manual'];

class FinderPage {
  constructor(root, params) {
    this.root = h('div', { class: 'page fill' });
    this.input = h('input', { type: 'search', placeholder: 'Fx »Jeg har lavet et referat fra projekteringsmøde« eller »Brandstrategirapport«', 'aria-label': 'Beskriv dokumentet', enterkeyhint: 'go' });
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.go(this.input.value); });
    this.placement = h('div', { class: 'placement' });
    this.probText = h('div', { class: 'muted' });
    this.bar = h('i', { style: 'width:0' });
    this.filename = h('div', { class: 'filename' });
    this.card = h('div', { class: 'card result-card', hidden: true },
      h('div', {}, h('div', { class: 'muted' }, 'Foreslået placering'), this.placement),
      h('div', { class: 'prob' }, this.probText, h('div', { class: 'bar' }, this.bar)),
      h('div', { class: 'filename-row' }, h('span', { class: 'muted' }, 'Forslag til filnavn:'), this.filename,
        h('button', { type: 'button', class: 'btn', onclick: () => this.last?.filename && copyText(this.last.filename) }, '⧉ Kopiér filnavn')));
    this.explain = new Pane({ empty: 'Skriv en beskrivelse ovenfor, eller klik på et eksempel.' });
    this.explain.tools.append(h('span', { class: 'muted' }, 'Klassifikation'));
    this.detail = new EntityDetail({ empty: 'Her vises læringsmodulet for den foreslåede mappe.' });
    this.explain.el.classList.remove('detail');
    this.split = h('div', { class: 'split' }, this.explain.el, this.detail.el);
    this.root.append(
      pageHead('Dokumentfinder', 'Beskriv dit dokument med almindeligt dansk. A104 Navigator foreslår placering, fase, fagdisciplin, vidensområde og filnavn – helt offline.'),
      h('div', { class: 'toolbar' }, this.input, h('button', { type: 'button', class: 'btn primary', onclick: () => this.go(this.input.value) }, 'Analysér')),
      h('div', { class: 'chips' }, FINDER_EXAMPLES.map((t) => h('button', { type: 'button', class: 'chip', onclick: () => this.go(t) }, t))),
      this.card, this.split);
    root.append(this.root);
    this.update(params);
    if (!params.get('q') && !isNarrow()) this.input.focus();
  }

  go(text) {
    text = (text || '').trim();
    if (text) navigate('finder', { q: text }, { replace: true });
  }

  update(params) {
    const q = (params.get('q') || '').trim();
    if (q && q !== this.query) this.analyze(q);
  }

  async analyze(text) {
    this.query = text;
    this.input.value = text;
    const c = await api('classify', text, prefs.projectId, prefs.includePid);
    if (text !== this.query) return;
    this.last = c;
    this.card.hidden = false;
    if (c.best) {
      this.placement.textContent = `${c.best.code}  ${c.best.name}`;
      this.probText.textContent = `Sandsynlighed: ${c.probability} %`;
      this.bar.style.width = `${c.probability}%`;
      this.filename.textContent = c.filename;
      this.detail.show({ type: 'folder', key: c.best.code }, { push: false, reveal: false });
    } else {
      this.placement.textContent = 'Ingen sikker placering fundet';
      this.probText.textContent = '';
      this.bar.style.width = '0';
      this.filename.textContent = '–';
      this.detail.clear('Her vises læringsmodulet for den foreslåede mappe.');
    }
    this.explain.setHtml(c.html);
  }

  onLink(href, owner) {
    // Links i klassifikationen åbner i mappevisningen til højre
    if (owner === this.explain) { defaultLink(href, this.detail); return true; }
    return false;
  }
}

// =========================================================================== Mappestruktur
class TreePage {
  constructor(root, params) {
    this.root = h('div', { class: 'page fill' });
    this.filter = h('input', { type: 'search', placeholder: 'Filtrér mapper – fx møde, C10 eller tidsplan', 'aria-label': 'Filtrér mapper' });
    this.filter.addEventListener('input', debounce(() => this.applyFilter(), 120));
    const list = listPane();
    this.scroll = list.scroll;
    this.detail = new EntityDetail({ empty: 'Vælg en mappe i træet.' });
    this.split = h('div', { class: 'split' }, list.el, this.detail.el);
    this.root.append(
      pageHead('Mappestruktur', 'Hele A104-strukturen (indholdstyper). Klik på en mappe for at se formål, typiske dokumenter, eksempler og relaterede mapper.'),
      h('div', { class: 'toolbar' }, this.filter,
        h('button', { type: 'button', class: 'btn', onclick: () => this.foldAll(false) }, 'Fold ud'),
        h('button', { type: 'button', class: 'btn', onclick: () => this.foldAll(true) }, 'Fold sammen')),
      this.split);
    root.append(this.root);
    this.build(params);
  }

  async build(params) {
    const folders = cache.tree || (cache.tree = await api('tree'));
    this.items = new Map();
    const children = new Map();
    for (const f of folders) {
      const parent = f.parent && folders.some((x) => x.code === f.parent) ? f.parent : '';
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(f);
    }
    const total = (f) => f.count + (children.get(f.code) || []).reduce((n, c) => n + total(c), 0);
    const make = (f, top) => {
      const kids = children.get(f.code) || [];
      const n = total(f);
      const li = h('li', { class: `${top ? 'top ' : ''}${kids.length ? 'collapsed' : ''}` });
      const tw = h('button', { type: 'button', class: `tw${kids.length ? '' : ' leaf'}`, 'aria-label': 'Fold ud/sammen', onclick: () => li.classList.toggle('collapsed') }, '▸');
      const r = row({ code: f.code, title: `${top ? '📁 ' : ''}${f.name}`, score: n ? String(n) : '' }, () => this.open(f.code));
      r.title = f.purpose || f.name;
      li.append(h('div', { class: 'node' }, tw, r));
      if (kids.length) li.append(h('ul', {}, kids.map((k) => make(k, false))));
      this.items.set(f.code, { li, row: r, f, tw });
      return li;
    };
    this.tree = h('ul', { class: 'tree list' }, (children.get('') || []).map((f) => make(f, true)));
    this.scroll.replaceChildren(this.tree);
    this.syncToggles();
    this.update(params);
  }

  update(params) {
    const code = params.get('code');
    if (code && this.items?.has(code)) this.open(code, { scroll: true, reveal: false });
  }

  open(code, { scroll = false, reveal = true } = {}) {
    const item = this.items.get(code);
    if (!item) return;
    let li = item.li.parentElement?.closest('li');
    while (li) { li.classList.remove('collapsed'); li = li.parentElement?.closest('li'); }
    this.syncToggles();
    select(this.tree, item.row);
    if (scroll) scrollWithin(item.row, 'center');
    this.detail.show({ type: 'folder', key: code }, { reveal });
  }

  onLink(href) {
    if (href.startsWith('tree:')) { this.filter.value = ''; this.applyFilter(); this.open(href.slice(5), { scroll: true }); return true; }
    return false;
  }

  foldAll(collapse) {
    for (const { li, f } of this.items.values()) if (li.querySelector('ul')) li.classList.toggle('collapsed', collapse && !!f);
    this.syncToggles();
  }

  syncToggles() {
    for (const { li, tw } of this.items.values()) tw.textContent = li.classList.contains('collapsed') ? '▸' : '▾';
  }

  applyFilter() {
    const text = this.filter.value.trim().toLowerCase();
    const key = codeKey(text);
    for (const { li, f } of this.items.values()) {
      const match = !text || `${f.code} ${f.name}`.toLowerCase().includes(text) || codeKey(f.code).startsWith(key);
      li.hidden = !match;
    }
    if (text) {
      for (const { li } of this.items.values()) {
        if (li.hidden) continue;
        let p = li.parentElement?.closest('li');
        while (p) { p.hidden = false; p.classList.remove('collapsed'); p = p.parentElement?.closest('li'); }
      }
      // undermapper til et fundet hovedmappenavn vises også
      for (const { li } of this.items.values()) if (!li.hidden && li.classList.contains('top') && !li.querySelector('li:not([hidden])')) li.classList.add('collapsed');
    }
    this.syncToggles();
  }
}

// =========================================================================== Koder
class CodesPage {
  constructor(root, params) {
    this.root = h('div', { class: 'page fill' });
    this.family = params.get('family') || '';
    this.filter = h('input', { type: 'search', placeholder: 'Søg kode eller navn – fx K01, M06, Y70, brand', 'aria-label': 'Søg kode' });
    this.filter.addEventListener('input', debounce(() => this.apply(), 120));
    this.familySelect = h('select', { class: 'mobile-only', 'aria-label': 'Kodefamilie', onchange: () => this.setFamily(this.familySelect.value) });
    const side = listPane('side-list');
    this.sideList = h('div', { class: 'list' });
    side.scroll.append(this.sideList);
    const mid = listPane();
    this.tbody = h('tbody');
    this.table = h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Kode'), h('th', {}, 'Navn'), h('th', { class: 'cat' }, 'Kategori'))), this.tbody);
    mid.scroll.append(this.table);
    this.detail = new EntityDetail({ empty: 'Vælg en kode.' });
    this.split = h('div', { class: 'split three' }, side.el, mid.el, this.detail.el);
    this.root.append(
      pageHead('Koder', 'Slå koder op – fx K01, K08, M06, C04 eller D2.A5 – og se navn, beskrivelse, relationer og typiske anvendelser.'),
      h('div', { class: 'toolbar' }, this.familySelect, this.filter), this.split);
    root.append(this.root);
    this.tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      select(this.tbody, tr);
      this.detail.show(this.visible[Number(tr.dataset.i)].ref);
    });
    this.build();
  }

  async build() {
    this.data = cache.codes || (cache.codes = await api('codes'));
    const fams = [{ family: '', name: 'Alle koder', n: this.data.rows.length }, ...this.data.families];
    this.sideButtons = new Map();
    for (const f of fams) {
      const label = f.family ? `${f.family} · ${f.name} (${f.n})` : `Alle koder (${f.n})`;
      const b = row({ title: label, sub: '' }, () => this.setFamily(f.family));
      b.title = f.description || label;
      this.sideButtons.set(f.family, b);
      this.sideList.append(b);
      this.familySelect.append(option(f.family, label, f.family === this.family));
    }
    this.setFamily(this.family);
  }

  update(params) {
    this.filter.value = '';
    this.setFamily(params.get('family') || '');
  }

  setFamily(family) {
    this.family = family;
    if (!this.data) return;
    this.familySelect.value = family;
    const btn = this.sideButtons.get(family);
    select(this.sideList, btn);
    if (btn) scrollWithin(btn, 'nearest');
    this.apply();
  }

  apply() {
    const text = this.filter.value.trim().toLowerCase();
    const key = codeKey(text);
    this.visible = this.data.rows.filter((r) => {
      if (this.family && r.family !== this.family) return false;
      if (!text) return true;
      return r.keys.some((k) => k.startsWith(key)) || r.name.toLowerCase().includes(text) || r.description.toLowerCase().includes(text);
    });
    const html = this.visible.map((r, i) => `<tr data-i="${i}"><td class="c">${esc(r.code || '–')}</td><td>${esc(r.name)}</td><td class="cat muted">${esc(r.category)}</td></tr>`);
    this.tbody.innerHTML = html.join('') || '<tr><td colspan="3" class="empty">Ingen koder matcher.</td></tr>';
    if (this.visible.length) {
      select(this.tbody, this.tbody.firstElementChild);
      this.detail.show(this.visible[0].ref, { push: false, reveal: false });
    }
  }
}

// =========================================================================== Lær A104
class LearnPage {
  constructor(root, params) {
    this.root = h('div', { class: 'page fill' });
    this.chapterSelect = h('select', { class: 'mobile-only', 'aria-label': 'Kapitel', onchange: () => this.go(this.chapterSelect.value) });
    const side = listPane('side-list chapter-list');
    this.sideList = h('div', { class: 'list' });
    side.scroll.append(this.sideList);
    this.center = new Pane({ prose: true });
    this.center.el.classList.remove('detail');
    this.center.bar.hidden = true;
    this.nav = h('div', { class: 'toolbar', style: 'padding:0 22px 18px' });
    this.center.body.append(this.nav);
    this.detail = new EntityDetail({ empty: 'Klik på en kode i teksten for at se, hvad den betyder.' });
    this.split = h('div', { class: 'split three learn' }, side.el, this.center.el, this.detail.el);
    this.root.append(
      pageHead('Lær A104', 'Forstå tankegangen bag koderne, filnavnene og mappestrukturen. Klik på en kode i teksten for at se den.'),
      h('div', { class: 'toolbar mobile-only' }, this.chapterSelect), this.split);
    root.append(this.root);
    this.build(params);
  }

  async build(params) {
    this.chapters = cache.chapters || (cache.chapters = await api('learn_chapters'));
    this.buttons = new Map();
    for (const c of this.chapters) {
      const b = row({ title: c.title }, () => this.go(c.key));
      this.buttons.set(c.key, b);
      this.sideList.append(b);
      this.chapterSelect.append(option(c.key, c.title));
    }
    this.update(params);
  }

  go(key) {
    navigate('learn', { ch: key }, { replace: true });
  }

  update(params) {
    const key = params.get('ch') || this.chapters[0].key;
    if (key === this.key) return;
    this.key = key;
    this.chapterSelect.value = key;
    select(this.sideList, this.buttons.get(key));
    this.show(key);
  }

  async show(key) {
    const i = this.chapters.findIndex((c) => c.key === key);
    if (key === 'bygger') await this.showBuilder();
    else if (key === 'quiz') await this.showQuiz();
    else this.center.setHtml(await api('learn_chapter', key));
    if (this.key !== key) return;
    const prev = this.chapters[i - 1];
    const next = this.chapters[i + 1];
    this.nav.replaceChildren(
      prev ? h('button', { type: 'button', class: 'btn flat', onclick: () => this.go(prev.key) }, '‹ Forrige') : h('span'),
      h('span', { class: 'spacer', style: 'flex:1' }),
      next ? h('button', { type: 'button', class: 'btn primary', onclick: () => this.go(next.key) }, `${next.title} ›`) : null);
    this.center.body.scrollTop = 0;
    if (isNarrow()) view.scrollTop = 0;
  }

  // ------------------------------------------------------------------ navnebygger
  async showBuilder() {
    const data = cache.builder || (cache.builder = await api('builder_data'));
    const PRESETS = { Dokument: ['I', 'C', 'K', 'Z', 'V'], Tegning: ['I', 'K', 'H', 'E', 'N', 'V'], 'Model (BIM)': ['I', 'A', 'F', 'K', 'Z', 'V'] };
    const DEFAULTS = { A: 'A4', C: 'C05.01', K: 'K01', M: null, F: 'F02', H: 'H1', E: 'E01' };
    const LABELS = { A: 'Fase (A)', C: 'Indholdstype / mappe (C)', K: 'Vidensområde (K)', M: 'Fagdisciplin (M)', F: 'Filtype (F)', H: 'Afbildningstype (H)', E: 'Etage (E)' };
    const NONE = '—';
    const result = h('div', { class: 'filename' });
    const explain = h('div', { style: 'margin-top:10px' });
    const project = h('input', { type: 'text', value: prefs.projectId, placeholder: 'fx G3 eller 2026-017' });
    const docName = h('input', { type: 'text', placeholder: 'fx Brandstrategi – kun når flere dokumenter har samme type' });
    const serial = h('select', {}, option('0', NONE), Array.from({ length: 99 }, (_, i) => option(String(i + 1), String(i + 1))));
    const revision = h('select', {}, option('-1', NONE), Array.from({ length: 100 }, (_, i) => option(String(i), String(i))));
    const version = h('select', {}, option('', NONE), Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)).map((c) => option(c, c)));
    const combos = {};
    const form = h('div', { class: 'form' }, h('label', {}, 'Projekt-ID (I)'), project);
    for (const letter of Object.keys(LABELS)) {
      const sel = h('select', {}, option('', NONE), (data.codes[letter] || []).map(([code, name]) => option(code, `${code}  ${name}`)));
      combos[letter] = sel;
      form.append(h('label', {}, LABELS[letter]), sel);
    }
    form.append(h('label', {}, 'Dokumentnavn (Z)'), docName, h('label', {}, 'Løbenummer (N)'), serial,
      h('label', {}, 'Versions-ID (V)'), h('div', { class: 'toolbar' }, h('span', { class: 'muted' }, 'Revision'), revision,
        h('span', { class: 'muted' }, 'Version'), version));

    const ALLOWED = /[^0-9A-Za-zÆØÅæøå_. -]/g;
    const CODE_CHARS = /[^0-9A-Za-z_.+-]/;
    const pad = (n) => String(n).padStart(2, '0');
    const nameOf = (sel) => sel.selectedOptions[0]?.textContent.split('  ').slice(1).join('  ') || '';

    const update = () => {
      const pos = [];
      const pid = project.value.trim();
      if (pid) pos.push([pid, 'Projekt-ID', 'projektets entydige ID']);
      for (const letter of ['A', 'C', 'K', 'M', 'F', 'H', 'E']) {
        const code = combos[letter].value;
        if (code) pos.push([code, data.families[letter] || letter, nameOf(combos[letter])]);
      }
      const z = docName.value.trim();
      if (z) pos.push([z, 'Dokumentnavn', 'beskriver indholdet med ord']);
      const n = Number(serial.value);
      if (n) pos.push([`N${pad(n)}`, 'Løbenummer', `nr. ${n}`]);
      const rev = Number(revision.value);
      const ver = version.value;
      if (rev >= 0 || ver) {
        const text = rev >= 0 && ver ? `revision ${rev}, intern version ${ver}` : rev >= 0 ? `revision ${rev} – officiel udgave` : `version ${ver} – før første revision`;
        pos.push([`V${rev >= 0 ? rev : ''}${ver}`, 'Versions-ID', text]);
      }
      result.textContent = pos.map((p) => p[0]).join('_');
      const warn = [];
      const ok = [];
      if (!pos.length) warn.push('Vælg mindst én position.');
      else if (pos.length > 5) warn.push(`${pos.length} positioner – A104 anbefaler højst 4–5. Fjern det, der allerede fremgår af mappen, tegningshovedet eller systemets tags.`);
      else ok.push(`${pos.length} positioner – fint kort navn.`);
      if (pid && CODE_CHARS.test(pid)) warn.push('Projekt-ID bør kun indeholde bogstaverne a-z, tal og . – ingen æ, ø, å eller mellemrum.');
      if (z && z.match(ALLOWED)) warn.push(`Dokumentnavnet indeholder tegn, der bør undgås: ${[...new Set(z.match(ALLOWED))].sort().join('')}`);
      if (z && z.includes(' ')) warn.push('Mellemrum i dokumentnavnet: skriv ordene sammen eller brug _ hvis projektet kræver streng A104.');
      if (combos.H.value && !combos.K.value) warn.push('En tegning bør have et vidensområde (K), så man kan se, hvilket fag den tilhører.');
      if (combos.F.value && combos.C.value) warn.push('Filtype (F) bruges til tegnings- og modelfiler – dokumenter klares normalt med indholdstypen (C).');
      explain.innerHTML = pos.map(([c, l, d]) => `<span class="mono"><b>${esc(c)}</b></span> &nbsp;=&nbsp; ${esc(l)}: ${esc(d)}`).join('<br>')
        + '<br><br>' + warn.map((w) => `<div class="status-warn">⚠ ${esc(w)}</div>`).join('')
        + ok.map((o) => `<div class="status-ok">✓ ${esc(o)}</div>`).join('');
    };

    const preset = (name) => {
      const used = PRESETS[name];
      for (const letter of Object.keys(combos)) {
        const sel = combos[letter];
        const want = used.includes(letter) ? DEFAULTS[letter] : null;
        sel.value = want || '';
        if (want && sel.value !== want) sel.selectedIndex = sel.options.length > 1 ? 1 : 0;
      }
      docName.value = used.includes('Z') ? ({ Dokument: 'Beregningsnotat', 'Model (BIM)': 'Bygningsmodel' }[name] || '') : '';
      serial.value = used.includes('N') ? '1' : '0';
      revision.value = '-1';
      version.value = used.includes('V') ? 'A' : '';
      update();
    };

    for (const el of [project, docName]) el.addEventListener('input', update);
    for (const el of [serial, revision, version, ...Object.values(combos)]) el.addEventListener('change', update);

    const wrap = h('div', { style: 'display:grid; gap:12px' },
      h('h1', {}, 'Navnebygger'),
      h('p', { class: 'muted' }, 'Vælg en skabelon, og udfyld de positioner du har brug for. Feltet med »—« bruges ikke. Navnet og reglerne opdateres med det samme.'),
      h('div', { class: 'chips' }, h('span', { class: 'muted' }, 'Skabelon:'),
        Object.keys(PRESETS).map((n) => h('button', { type: 'button', class: 'chip', onclick: () => preset(n) }, n))),
      h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Filnavn'),
        h('div', { class: 'filename-row', style: 'margin-top:4px' }, result,
          h('button', { type: 'button', class: 'btn primary', onclick: () => copyText(result.textContent) }, '⧉ Kopiér')), explain),
      h('div', { class: 'card' }, form));
    if (this.key !== 'bygger') return;
    this.center.doc.replaceChildren(wrap);
    preset('Dokument');
  }

  // ------------------------------------------------------------------------ quiz
  async showQuiz() {
    const questions = cache.quiz || (cache.quiz = await api('quiz'));
    const wrap = h('div', { style: 'display:grid; gap:12px' });
    let index = 0;
    let score = 0;
    const draw = () => {
      wrap.replaceChildren(h('h1', {}, 'Test dig selv'));
      const card = h('div', { class: 'card', style: 'display:grid; gap:6px' });
      if (index >= questions.length) {
        const total = questions.length;
        const verdict = score >= total - 1 ? 'Flot – du har styr på A104!'
          : score >= Math.floor(total / 2) ? 'Godt gået. Læs kapitlerne igen for dem, du missede.'
            : 'Prøv at læse kapitlerne igennem og tag testen igen.';
        wrap.append(h('p', { class: 'muted' }, 'Færdig'));
        card.append(h('h2', {}, `Du fik ${score} ud af ${total} rigtige. ${verdict}`),
          h('div', {}, h('button', { type: 'button', class: 'btn primary', onclick: () => { index = 0; score = 0; draw(); } }, 'Start forfra')));
        wrap.append(card);
        return;
      }
      const q = questions[index];
      wrap.append(h('p', { class: 'muted' }, `Spørgsmål ${index + 1} af ${questions.length} · ${score} rigtige indtil videre`));
      const name = `quiz-${index}`;
      const radios = q.options.map((opt, i) => {
        const input = h('input', { type: 'radio', name, value: String(i) });
        return { input, label: h('label', { class: 'quiz-opt' }, input, h('span', {}, opt)) };
      });
      const feedback = h('div');
      const answer = h('button', { type: 'button', class: 'btn primary' }, 'Svar');
      const next = h('button', { type: 'button', class: 'btn', disabled: true, onclick: () => { index += 1; draw(); } }, 'Næste ›');
      answer.addEventListener('click', () => {
        const chosen = radios.findIndex((r) => r.input.checked);
        if (chosen < 0) return;
        if (chosen === q.correct) {
          score += 1;
          feedback.innerHTML = `<b class="status-ok">✓ Rigtigt!</b><br>${esc(q.why)}`;
        } else {
          feedback.innerHTML = `<b class="status-warn">✗ Ikke helt.</b> Svaret er: <b>${esc(q.options[q.correct])}</b><br>${esc(q.why)}`;
        }
        radios.forEach((r) => { r.input.disabled = true; });
        answer.disabled = true;
        next.disabled = false;
        next.focus();
      });
      card.append(h('h2', {}, q.q), radios.map((r) => r.label), feedback, h('div', { class: 'toolbar' }, answer, next));
      wrap.append(card);
    };
    draw();
    if (this.key !== 'quiz') return;
    this.center.doc.replaceChildren(wrap);
  }

  onLink(href) {
    if (href.startsWith('family:')) { navigate('codes', { family: href.slice(7) }); return true; }
    return false;
  }
}

// =========================================================================== BR18
class BR18Page {
  constructor(root, params) {
    this.root = h('div', { class: 'page fill' });
    this.subtitle = h('p', {}, 'Indlæser bygningsreglementet…');
    this.q = h('input', { type: 'search', placeholder: '🔍  Søg i BR18 – fx flugtvej, brandkam, U-værdi ydervæg, dagslys, § 82 eller 82 stk. 2', 'aria-label': 'Søg i BR18' });
    this.q.addEventListener('input', debounce(() => this.run(), 250));
    this.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.run(); });
    this.kap = h('select', { 'aria-label': 'Kapitel', onchange: () => this.run() }, option('', 'Alle kapitler'));
    this.dom = h('select', { 'aria-label': 'Emne', onchange: () => this.run() }, option('', 'Alle emner'));
    this.rep = h('input', { type: 'checkbox', onchange: () => this.run() });
    this.info = h('div', { class: 'info' });
    this.tabBtns = {};
    this.tabs = {};
    const tabbar = h('div', { class: 'tabs', role: 'tablist' });
    for (const [key, label] of [['krav', '📜 Krav'], ['tables', '📊 Tabeller'], ['guides', '📘 Vejledninger']]) {
      const b = h('button', { type: 'button', class: 'tab', role: 'tab', onclick: () => this.setTab(key) }, label);
      this.tabBtns[key] = b;
      tabbar.append(b);
      const list = listPane();
      const pane = new Pane({ empty: key === 'krav' ? 'Vælg en paragraf.' : key === 'tables' ? 'Vælg en tabel.' : 'Vælg en vejledning.' });
      pane.tool('⧉ Kopiér henvisning', () => pane.cur && copyText(pane.cur.ref));
      if (key !== 'guides') pane.tool('⧉ Kopiér tekst', () => pane.cur && copyText(pane.cur.text, pane.cur.ref));
      if (key !== 'tables') pane.tool('🌐 Åbn kilden', () => pane.cur?.url && window.open(pane.cur.url, '_blank', 'noopener'));
      const split = h('div', { class: 'split', hidden: true }, list.el, pane.el);
      this.tabs[key] = { list: list.scroll, pane, split, label };
    }
    this.foot = h('p', { class: 'muted', style: 'margin:0; font-size:13px' },
      'Kontrollér altid mod gældende udgave på bygningsreglementet.dk før brug i projektering – programmet godkender intet.');
    const head = pageHead('BR18 2026 – Bygningsreglementet');
    head.append(this.subtitle);
    this.root.append(head,
      h('div', { class: 'toolbar' }, this.q, this.kap, this.dom, h('label', { class: 'check' }, this.rep, 'Vis ophævede')),
      this.info, tabbar, ...Object.values(this.tabs).map((t) => t.split), this.foot);
    root.append(this.root);
    this.token = 0;
    this.init(params);
  }

  async init(params) {
    const m = cache.br18 || (cache.br18 = await api('br18_meta'));
    if (m.error) { this.subtitle.textContent = m.error; return; }
    this.subtitle.textContent = m.subtitle;
    m.chapters.forEach(([k, l]) => this.kap.append(option(k, l)));
    m.domains.forEach(([k, l]) => this.dom.append(option(k, l)));
    this.ready = true;
    this.setTab(params.get('tab') || 'krav');
    await this.update(params, true);
  }

  async update(params, first = false) {
    if (!this.ready) return;
    const q = params.get('q');
    if (q != null && (first || q !== this.q.value)) { this.q.value = q; await this.run(); } else if (first) await this.run();
    const p = params.get('p');
    const t = params.get('t');
    if (p) { this.setTab('krav'); this.showParagraph(Number(p), Number(params.get('stk') || 0)); }
    if (t) { this.setTab('tables'); this.showTable(t); }
  }

  setTab(key) {
    this.tab = key;
    for (const [k, t] of Object.entries(this.tabs)) {
      t.split.hidden = k !== key;
      this.tabBtns[k].setAttribute('aria-selected', String(k === key));
    }
  }

  async run() {
    const token = ++this.token;
    const query = this.q.value.trim();
    const res = await api('br18_search', query, this.kap.value, this.dom.value, this.rep.checked);
    if (token !== this.token) return;
    this.query = query;
    this.info.innerHTML = res.info;
    // krav
    const krav = this.tabs.krav;
    krav.list.replaceChildren();
    const ul = h('div', { class: 'list' });
    let first = null;
    const item = (it) => {
      const el = row({ code: it.ref, title: it.text, dim: it.repealed }, () => { select(ul, el); this.showParagraph(it.p, it.stk, true); });
      if (!first) first = [el, it];
      return el;
    };
    if (res.groups) {
      for (const g of res.groups) {
        ul.append(h('details', { class: 'group', open: res.groups.length <= 3 ? 'open' : null }, h('summary', {}, g.label), g.items.map(item)));
      }
    } else {
      res.items.forEach((it) => ul.append(item(it)));
      if (!res.items.length) ul.append(h('p', { class: 'empty' }, 'Ingen krav fundet.'));
    }
    krav.list.append(ul);
    if (res.items && first) { select(ul, first[0]); this.showParagraph(first[1].p, first[1].stk); }
    this.tabBtns.krav.textContent = `📜 Krav (${res.items ? res.items.length : res.groups.reduce((n, g) => n + g.items.length, 0)})`;
    // tabeller
    const tabs = this.tabs.tables;
    const tl = h('div', { class: 'list' });
    res.tables.forEach((t, i) => {
      const el = row({ title: t.title, sub: t.label }, () => { select(tl, el); this.showTable(t.id, true); });
      el.dataset.id = t.id;
      tl.append(el);
      if (i === 0 && query) { select(tl, el); this.showTable(t.id); }
    });
    if (!res.tables.length) tl.append(h('p', { class: 'empty' }, 'Ingen tabeller.'));
    tabs.list.replaceChildren(tl);
    this.tabBtns.tables.textContent = `📊 Tabeller (${res.tables.length})`;
    // vejledninger
    const guides = this.tabs.guides;
    const gl = h('div', { class: 'list' });
    res.guides.forEach((g, i) => {
      const el = row({ code: g.kap, title: g.label }, () => { select(gl, el); this.showGuide(g.id, true); });
      gl.append(el);
      if (i === 0 && query) { select(gl, el); this.showGuide(g.id); }
    });
    if (!res.guides.length) gl.append(h('p', { class: 'empty' }, 'Ingen vejledninger fundet.'));
    guides.list.replaceChildren(gl);
    this.tabBtns.guides.textContent = `📘 Vejledninger (${res.guides.length})`;
  }

  async showParagraph(number, stk = 0, reveal = false) {
    const d = await api('br18_paragraph', number, stk, this.q.value);
    if (!d) return;
    const pane = this.tabs.krav.pane;
    pane.cur = d;
    pane.setHtml(d.html, stk ? `stk${stk}` : null);
    if (reveal) pane.reveal();
  }

  async showTable(id, reveal = false) {
    const d = await api('br18_table', id, this.q.value);
    if (!d) return;
    const pane = this.tabs.tables.pane;
    pane.cur = d;
    pane.setHtml(d.html);
    if (reveal) pane.reveal();
  }

  async showGuide(id, reveal = false) {
    const d = await api('br18_guide', id, this.q.value);
    if (!d) return;
    const pane = this.tabs.guides.pane;
    pane.cur = d;
    pane.setHtml(d.html);
    const hit = pane.doc.querySelector('mark');
    if (hit) scrollWithin(hit, 'center');
    if (reveal) pane.reveal();
  }

  onLink(href) {
    if (href.startsWith('br18:')) { this.setTab('krav'); this.showParagraph(Number(href.slice(5)), 0, true); return true; }
    if (href.startsWith('tab:')) {
      const id = decodeURIComponent(href.slice(4));
      this.setTab('tables');
      const el = this.tabs.tables.list.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (el) { select(this.tabs.tables.list, el); scrollWithin(el, 'nearest'); }
      this.showTable(id, true);
      return true;
    }
    return false;
  }
}

// =========================================================================== AB 18 · ABR 18 · ABT 18
class LawPage {
  constructor(root, params, code) {
    this.code = code;
    this.root = h('div', { class: 'page fill' });
    this.title = h('h1', {}, code.toUpperCase());
    this.subtitle = h('p', {});
    this.q = h('input', { type: 'search', 'aria-label': 'Søg i aftalevilkårene' });
    this.q.addEventListener('input', debounce(() => this.run(), 250));
    this.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.run(); });
    this.section = h('select', { 'aria-label': 'Afsnit', onchange: () => this.run() }, option('', 'Alle afsnit'));
    this.info = h('div', { class: 'info' });
    const list = listPane();
    this.list = list.scroll;
    this.pane = new Pane({ empty: 'Vælg en paragraf.' });
    this.pane.tool('⧉ Kopiér henvisning', () => this.cur && copyText(this.cur.ref));
    this.pane.tool('⧉ Kopiér tekst', () => this.cur && copyText(this.cur.text, this.cur.ref));
    this.pdfBtn = this.pane.tool('📄 Åbn PDF', () => this.openPdf());
    this.pane.tool('🌐 Retsinformation', () => this.meta?.url && window.open(this.meta.url, '_blank', 'noopener'));
    this.split = h('div', { class: 'split' }, list.el, this.pane.el);
    this.foot = h('p', { class: 'muted', style: 'margin:0; font-size:13px' });
    this.root.append(h('div', { class: 'page-head' }, this.title, this.subtitle),
      h('div', { class: 'toolbar' }, this.q, this.section), this.info, this.split, this.foot);
    root.append(this.root);
    this.token = 0;
    this.init(params);
  }

  async init(params) {
    const key = `law-${this.code}`;
    const m = cache[key] || (cache[key] = await api('law_meta', this.code));
    if (m.error) { this.subtitle.textContent = m.error; return; }
    this.meta = m;
    this.title.textContent = m.title;
    this.subtitle.textContent = m.subtitle;
    this.foot.textContent = m.foot;
    this.q.placeholder = `🔍  Søg i ${m.name} – fx mangler, dagbod, sikkerhedsstillelse, § 12 eller 48 stk. 2`;
    m.sections.forEach(([k, l]) => this.section.append(option(k, l)));
    this.pdfBtn.disabled = !m.pdf;
    this.ready = true;
    this.q.value = params.get('q') || '';
    await this.run();
  }

  update(params) {
    if (!this.ready) return;
    const q = params.get('q') || '';
    if (q !== this.q.value) { this.q.value = q; this.run(); }
  }

  async run() {
    const token = ++this.token;
    const res = await api('law_search', this.code, this.q.value, this.section.value);
    if (token !== this.token) return;
    this.info.innerHTML = res.info;
    const ul = h('div', { class: 'list' });
    let first = null;
    const item = (it) => {
      const el = row({ code: it.ref, title: it.text }, () => { select(ul, el); this.show(it.key, it.stk, true); });
      if (!first) first = [el, it];
      return el;
    };
    if (res.groups) {
      for (const g of res.groups) ul.append(h('div', { class: 'group-label' }, g.label), g.items.map(item));
    } else {
      res.items.forEach((it) => ul.append(item(it)));
      if (!res.items.length) ul.append(h('p', { class: 'empty' }, 'Ingen paragraffer fundet.'));
    }
    this.list.replaceChildren(ul);
    if (first) { select(ul, first[0]); this.show(first[1].key, first[1].stk); }
  }

  async show(key, stk = 0, reveal = false) {
    const d = await api('law_paragraph', this.code, key, stk, this.q.value);
    if (!d) return;
    this.cur = d;
    this.pane.setHtml(d.html, stk > 1 ? `stk${stk}` : null);
    this.pdfBtn.textContent = `📄 Åbn PDF på side ${d.page}`;
    if (reveal) this.pane.reveal();
  }

  openPdf() {
    if (!this.meta?.pdf) return;
    window.open(`${this.meta.pdf}#page=${this.cur ? this.cur.page : 1}`, '_blank', 'noopener');
  }

  onLink(href) {
    if (href.startsWith('law:')) { this.show(href.slice(4), 0, true); return true; }
    return false;
  }
}

// =========================================================================== Projekt (OneDrive)
// Projektmappen læses med Microsoft Graph (kun læseadgang). A104-koder og navngivning tjekkes af Python-kernen
// (project_manager.py – den samme kode som i Windows-programmet). Seneste indlæsning gemmes, så den kan ses offline.
const SCAN_LIMIT = 8000;
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('da-DK', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const fmtSize = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`);

async function scanDrive(driveId, itemId, onProgress) {
  const sel = '$select=id,name,folder,size,lastModifiedDateTime,webUrl,lastModifiedBy&$top=999';
  const items = [];
  let level = [{ id: itemId, path: '' }];
  let read = 0;
  while (level.length && items.length < SCAN_LIMIT) {
    const next = [];
    for (let i = 0; i < level.length; i += 6) {
      const chunk = level.slice(i, i + 6);
      const lists = await Promise.all(chunk.map((f) => MS.all(`/drives/${driveId}/items/${f.id}/children?${sel}`)));
      lists.forEach((kids, j) => {
        for (const k of kids) {
          const path = chunk[j].path ? `${chunk[j].path}/${k.name}` : k.name;
          items.push({ id: k.id, name: k.name, path, folder: !!k.folder, size: k.size || 0, modified: k.lastModifiedDateTime,
            url: k.webUrl, by: k.lastModifiedBy?.user?.displayName || '' });
          if (k.folder && k.folder.childCount !== 0) next.push({ id: k.id, path });
        }
      });
      read += chunk.length;
      onProgress(read, items.length);
    }
    level = next;
  }
  return { items, truncated: items.length >= SCAN_LIMIT };
}

// =========================================================================== 📷 Scan fra pc (beta)
// Windows-programmets »📱 Mobil (beta)« viser en QR-kode, der skifter: »A104:<id>:<nr>/<antal>/<længde>:<data>«.
// Data er zlib-komprimeret JSON i base45 (se app/phone_export.py). Telefonen samler koderne – intet går over nettet.
const BASE45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function fromBase45(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 3) {
    const c = BASE45.indexOf(text[i]);
    const d = BASE45.indexOf(text[i + 1]);
    if (c < 0 || d < 0) throw new Error('QR-koden kunne ikke læses – prøv igen.');
    if (i + 2 < text.length) {
      const n = c + d * 45 + BASE45.indexOf(text[i + 2]) * 2025;
      out.push(n >> 8, n & 255);
    } else out.push(c + d * 45);
  }
  return new Uint8Array(out);
}

async function inflate(bytes) {
  if (!('DecompressionStream' in window)) throw new Error('Telefonens browser er for gammel (kræver iOS 16.4 eller nyere Chrome).');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Response(stream).text();
}

let jsqrLoading = null;
function loadJsQR() {
  if (!jsqrLoading) {
    jsqrLoading = new Promise((resolve, reject) => {
      const s = h('script', { src: 'jsqr.js' });
      s.onload = () => resolve(window.jsQR);
      s.onerror = () => { jsqrLoading = null; reject(new Error('QR-læseren kunne ikke hentes.')); };
      document.head.append(s);
    });
  }
  return jsqrLoading;
}

/** Åbner kameraet og samler den skiftende QR-kode. Giver teksten (base45) eller fejler med {cancelled}. */
function scanFrames() {
  return new Promise((resolve, reject) => {
    const video = h('video', { playsinline: true, muted: true, autoplay: true });
    const fill = h('span');
    const status = h('p', {}, 'Starter kameraet…');
    const cancel = h('button', { type: 'button', class: 'btn' }, 'Annullér');
    const overlay = h('div', { class: 'scan', role: 'dialog', 'aria-label': 'Scan fra pc' },
      h('div', { class: 'scan-box' }, h('h2', {}, '📷 Scan fra pc ', h('span', { class: 'beta' }, 'BETA')), video,
        h('div', { class: 'scan-bar' }, fill), status,
        h('p', { class: 'muted' }, 'Tryk »📱 Mobil (beta)« i Windows-programmet, når projektet er åbent, og hold telefonen mod den store QR-kode.'),
        cancel));
    document.body.append(overlay);
    let stream = null;
    let stopped = false;
    const stop = () => { stopped = true; stream?.getTracks().forEach((t) => t.stop()); overlay.remove(); };
    cancel.addEventListener('click', () => { stop(); reject(Object.assign(new Error('Annulleret'), { cancelled: true })); });

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false,
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } });
      } catch {
        stop();
        reject(new Error('Appen fik ikke lov til at bruge kameraet. Giv adgang til kameraet og prøv igen.'));
        return;
      }
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      let detect = null;
      if ('BarcodeDetector' in window) {
        try {
          const bd = new BarcodeDetector({ formats: ['qr_code'] });
          detect = async () => (await bd.detect(video)).map((b) => b.rawValue);
        } catch { detect = null; }
      }
      if (!detect) {
        let jsQR;
        try { jsQR = await loadJsQR(); } catch (err) { stop(); reject(err); return; }
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        detect = async () => {
          const w = video.videoWidth;
          const ht = video.videoHeight;
          if (!w) return [];
          const scale = Math.min(1, 1000 / Math.max(w, ht));
          canvas.width = Math.round(w * scale);
          canvas.height = Math.round(ht * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          return r ? [r.data] : [];
        };
      }
      status.textContent = 'Hold telefonen mod QR-koden på pc’en.';
      const parts = new Map();
      let sid = null;
      let total = 0;
      const tick = async () => {
        if (stopped) return;
        try {
          for (const text of await detect()) {
            const m = /^A104:([0-9A-Z]{4}):(\d+)\/(\d+)\/(\d+):([\s\S]*)$/.exec(text);
            if (!m) {
              if (/^https?:/i.test(text)) status.textContent = 'Det er koden til appen – scan den store kode, der skifter.';
              continue;
            }
            if (sid !== m[1]) { sid = m[1]; parts.clear(); total = Number(m[3]); }
            parts.set(Number(m[2]), m[5].padEnd(Number(m[4]), ' '));
            fill.style.width = `${Math.round((parts.size / total) * 100)}%`;
            status.textContent = `Modtaget ${parts.size} af ${total} koder…`;
            if (parts.size === total) {
              stop();
              resolve(Array.from({ length: total }, (_, i) => parts.get(i + 1)).join(''));
              return;
            }
          }
        } catch { /* et enkelt billede, der ikke kunne læses */ }
        setTimeout(tick, 50);
      };
      tick();
    })();
  });
}

/** Den komprimerede form fra QR-koden -> samme form som projektfilen (OneDrive\A104 Navigator\<projekt>.json). */
async function snapshotFromQr(text) {
  const data = JSON.parse(await inflate(fromBase45(text)));
  const dirs = ['', ...data.d];
  const base = (data.u || '').replace(/\/$/, '');
  const urlFor = (path, file) => (base ? `${base}/${path.split('/').map(encodeURIComponent).join('/')}${file ? '?web=1' : ''}` : '');
  const items = data.d.map((p) => ({ path: p, folder: true, url: urlFor(p, false) }));
  for (const [dir, name, size, minutes, by] of data.f) {
    const path = dirs[dir] ? `${dirs[dir]}/${name}` : name;
    items.push({ path, folder: false, size, modified: new Date(minutes * 60000).toISOString(), url: urlFor(path, true), by: by || '' });
  }
  return { format: 'a104-projekt', project: { name: data.n, project_id: data.p, where: data.w, url: data.u }, created: data.c,
    truncated: data.t, items };
}

class ProjectPage {
  constructor(root, params) {
    this.root = h('div', { class: 'page' });
    root.append(this.root);
    this.init(params);
  }

  async init(params) {
    this.state = await store.get('projects', { list: [], current: '' });
    this.project = this.state.list.find((p) => p.id === this.state.current) || null;
    if (this.project) this.openProject(); else this.showStart();
    if (params?.get('scan')) this.update(params);
  }

  /** Startside: åbn projektfilen fra Windows-programmet (virker altid) eller log ind med Microsoft (kræver IT). */
  showStart(note) {
    this.reset();
    const recent = this.state.list.filter((p) => p.id !== this.project?.id);
    this.root.append(pageHead('Projekt', 'Se dit projekt fra OneDrive/Teams med A104-koder og tjek af filnavne – også på telefonen.'),
      h('div', { class: 'settings' },
        h('div', { class: 'card' }, h('h2', {}, 'Overfør fra pc ', h('span', { class: 'beta' }, 'BETA')),
          note ? h('p', { class: 'warn-text' }, note) : null,
          h('ol', { class: 'steps' },
            h('li', {}, 'Åbn projektet i A104 Navigator på pc’en (Windows-programmet), og tryk ', h('b', {}, '📱 Mobil (beta)'), '.'),
            h('li', {}, 'Tryk herunder, og hold telefonen mod QR-koden på pc’en, til der står ', h('i', {}, 'Gemt'), '.')),
          h('button', { type: 'button', class: 'btn primary', onclick: () => this.scan() }, '📷 Scan fra pc'),
          h('p', { class: 'muted' }, 'Kun mappe- og filnavne overføres – intet filindhold, intet login, intet internet.')),
        h('div', { class: 'card' }, h('h2', {}, 'Åbn projekt fra OneDrive'),
          h('ol', { class: 'steps' },
            h('li', {}, 'Åbn projektet i A104 Navigator på pc’en (Windows-programmet). Det gemmer projektet i din OneDrive i mappen ', h('b', {}, 'A104 Navigator'), '.'),
            h('li', {}, 'Tryk herunder, vælg OneDrive, og vælg projektets fil (fx ', h('i', {}, 'BKN-MIL-F26-2H-G1.json'), ').')),
          h('button', { type: 'button', class: 'btn', onclick: () => this.pickFile() }, '📂 Vælg projektfil'),
          h('p', { class: 'muted' }, 'Filen indeholder kun mappe- og filnavne – intet filindhold. Filerne åbnes i OneDrive/Teams med dit almindelige Microsoft-login.')),
        recent.length ? h('div', { class: 'card' }, h('h2', {}, 'Tidligere projekter'), h('div', { class: 'list' },
          recent.map((p) => row({ title: `📁 ${p.name}`, sub: p.where }, () => this.choose(p, false))))) : null,
        MS.configured ? h('div', { class: 'card' }, h('h2', {}, 'Direkte fra OneDrive'),
          h('p', { class: 'muted' }, 'Log ind med din skolekonto og vælg mappen – altid opdateret.'),
          h('button', { type: 'button', class: 'btn', onclick: () => (MS.signedIn ? this.showPicker() : this.showLogin()) },
            MS.signedIn ? 'Vælg mappe i OneDrive' : 'Log ind med Microsoft')) : null));
  }

  pickFile() {
    const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    input.addEventListener('change', () => { if (input.files[0]) this.importFile(input.files[0]); input.remove(); });
    document.body.append(input);
    input.click();
  }

  async importFile(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch { data = null; }
    if (!data || data.format !== 'a104-projekt' || !Array.isArray(data.items)) {
      toast('Det er ikke en A104-projektfil. Vælg filen i mappen »A104 Navigator« i din OneDrive.');
      return;
    }
    await this.saveSnapshot(data, file.name.replace(/\.json$/i, ''));
  }

  async scan() {
    try {
      await this.saveSnapshot(await snapshotFromQr(await scanFrames()), 'Projekt');
    } catch (err) {
      if (!err.cancelled) toast(err.message);
    }
  }

  async saveSnapshot(data, fallbackName) {
    const pr = data.project || {};
    const name = pr.name || fallbackName;
    const p = { id: `file:${name}`, source: 'file', name, where: pr.where || '', url: pr.url || '', projectId: pr.project_id || '' };
    const items = data.items.map((i) => ({ id: i.path, name: i.path.split('/').pop(), path: i.path, folder: !!i.folder, size: i.size || 0,
      modified: i.modified || '', url: i.url || '', by: i.by || '' }));
    await store.set(`project-scan:${p.id}`, { at: data.created || new Date().toISOString(), truncated: !!data.truncated, items, file: true });
    await this.choose(p, false);
    toast(`Gemt på telefonen: ${name}`);
  }

  update(params) {
    if (!params.get('scan')) return;
    navigate('project', {}, { replace: true }); // QR-koden til appen (#/project?scan=1) starter scanneren
    this.scan();
  }

  reset(fill = false) {
    this.root.className = `page${fill ? ' fill' : ''}`;
    this.root.replaceChildren();
  }

  showMessage(text) {
    this.reset();
    this.root.append(pageHead('Projekt'), h('div', { class: 'card' }, h('p', {}, text)));
  }

  failed(err, retry) {
    if (err.code === 'login_required') return this.showLogin(err.message);
    if (err.status === 403) return this.showStart('Microsoft-login er ikke godkendt af din skole endnu – åbn projektfilen i stedet.');
    toast(err.message);
    if (retry) retry();
  }

  showLogin(note) {
    this.reset();
    this.root.append(pageHead('Projekt', 'Se dit projekt fra OneDrive med A104-koder og tjek af filnavne – også på telefonen.'),
      h('div', { class: 'settings' },
        h('div', { class: 'card' }, h('h2', {}, 'Log ind med Microsoft'),
          note ? h('p', { class: 'warn-text' }, note) : null,
          h('p', { class: 'muted' }, 'Brug din skole- eller arbejdskonto. Appen kan kun læse filerne i din egen OneDrive; den ændrer intet. '
            + 'Login gemmes i browseren på denne enhed.'),
          h('button', { type: 'button', class: 'btn primary', onclick: () => MS.login('#/project') }, 'Log ind med Microsoft'),
          ' ', h('button', { type: 'button', class: 'btn', onclick: () => this.showStart() }, 'Åbn projektfil i stedet'))));
  }

  saveState() { return store.set('projects', this.state); }

  // ------------------------------------------------------------- vælg projektmappe
  async showPicker() {
    this.reset();
    this.root.append(pageHead('Vælg projektmappe'), h('p', { class: 'empty' }, 'Henter din OneDrive…'));
    try {
      const d = await MS.get('/me/drive/root?$select=id,webUrl,parentReference');
      this.browse({ driveId: d.parentReference.driveId, itemId: d.id, name: 'OneDrive', url: d.webUrl }, []);
    } catch (err) {
      if (err.code === 'login_required') return this.showLogin(err.message);
      this.showMessage(`Kunne ikke åbne din OneDrive: ${err.message}`);
    }
  }

  /** Mappebrowser: vis undermapperne og lad brugeren vælge den mappe, der er projektet. */
  async browse(folder, crumbs) {
    this.reset();
    const list = h('div', { class: 'list' }, h('p', { class: 'muted' }, 'Henter mapper…'));
    const trail = [...crumbs, folder];
    const nav = h('div', { class: 'crumbs' }, trail.map((c, i) => h('button', { type: 'button', class: 'btn flat',
      disabled: i === trail.length - 1 ? 'disabled' : null, onclick: () => this.browse(c, trail.slice(0, i)) }, i ? c.name : '☁ OneDrive')));
    const acc = MS.account || {};
    const recent = this.state.list.filter((p) => p.id !== this.project?.id);
    this.root.append(pageHead('Vælg projektmappe', 'Gå ned til den mappe, der er dit projekt (fx den med C01, C02 …), og tryk »Vælg«.'),
      nav,
      crumbs.length ? h('div', { class: 'toolbar' }, h('button', { type: 'button', class: 'btn primary', onclick: () => this.choose({
        id: `${folder.driveId}!${folder.itemId}`, driveId: folder.driveId, itemId: folder.itemId, name: folder.name, url: folder.url,
        where: trail.slice(0, -1).map((c, i) => (i ? c.name : 'OneDrive')).join(' › ') }) }, `✓ Vælg »${folder.name}«`)) : null,
      h('div', { class: 'settings' },
        h('div', { class: 'card' }, list),
        recent.length ? h('div', { class: 'card' }, h('h2', {}, 'Tidligere projekter'), h('div', { class: 'list' },
          recent.map((p) => row({ title: `📁 ${p.name}`, sub: p.where }, () => this.choose(p))))) : null,
        h('div', { class: 'card' }, h('h2', {}, 'Konto'),
          h('p', { class: 'muted' }, `Logget ind som ${acc.name || ''} ${acc.user ? `(${acc.user})` : ''}`),
          h('button', { type: 'button', class: 'btn', onclick: () => this.logout() }, 'Log ud'))));
    try {
      const kids = await MS.all(`/drives/${folder.driveId}/items/${folder.itemId}/children?$select=id,name,folder,webUrl&$top=999`);
      const subs = kids.filter((k) => k.folder).sort((a, b) => a.name.localeCompare(b.name, 'da', { numeric: true }));
      const files = kids.length - subs.length;
      list.replaceChildren(...subs.map((k) => row({ title: `📁 ${k.name}`, score: k.folder.childCount ? String(k.folder.childCount) : '' },
        () => this.browse({ driveId: folder.driveId, itemId: k.id, name: k.name, url: k.webUrl }, trail))),
      files ? h('p', { class: 'muted' }, `${files} filer i mappen`) : null,
      !kids.length ? h('p', { class: 'muted' }, 'Mappen er tom.') : null);
    } catch (err) { this.failed(err); }
  }

  async choose(p, refresh = true) {
    this.state.list = [p, ...this.state.list.filter((x) => x.id !== p.id)].slice(0, 8);
    this.state.current = p.id;
    await this.saveState();
    this.project = p;
    this.scan = null;
    this.openProject(refresh && p.source !== 'file');
  }

  async logout() {
    MS.logout();
    toast('Logget ud');
    this.showStart();
  }

  // --------------------------------------------------------------------- projektet
  async openProject(refresh = false) {
    const p = this.project;
    this.reset(true);
    this.summary = h('p', {}, '');
    this.filter = h('input', { type: 'search', placeholder: 'Søg efter fil – fx referat eller C05', 'aria-label': 'Søg i projektet' });
    this.filter.addEventListener('input', debounce(() => this.showFolder(this.folder), 150));
    this.onlyIssues = h('input', { type: 'checkbox' });
    this.onlyIssues.addEventListener('change', () => this.showFolder(this.folder));
    this.refreshBtn = p.source === 'file'
      ? h('button', { type: 'button', class: 'btn', onclick: () => this.scan(), title: 'Scan QR-koden fra »📱 Mobil (beta)« på pc’en igen' }, '📷 Opdatér (scan)')
      : h('button', { type: 'button', class: 'btn', onclick: () => this.load(true) }, '⟳ Opdater');
    const list = listPane();
    this.scroll = list.scroll;
    this.detail = new Pane({ empty: 'Vælg en mappe.' });
    this.detail.tool('Åbn i OneDrive', () => {
      const url = this.folderUrl();
      if (url) window.open(url, '_blank', 'noopener'); else toast('Projektet ligger kun på pc’en – det er ikke i OneDrive/Teams.');
    }, 'Åbn mappen i OneDrive/Teams');
    this.split = h('div', { class: 'split' }, list.el, this.detail.el);
    this.root.append(
      h('div', { class: 'page-head' }, h('h1', {}, `📁 ${p.name}`), this.summary),
      h('div', { class: 'toolbar' }, this.filter, h('label', { class: 'check' }, this.onlyIssues, 'Kun filer med bemærkninger'),
        this.refreshBtn, h('button', { type: 'button', class: 'btn', onclick: () => this.showStart() }, 'Skift projekt')),
      this.split);
    this.scroll.append(h('p', { class: 'empty' }, 'Henter projektet…'));
    const cached = refresh ? null : await store.get(`project-scan:${p.id}`, null);
    if (cached) { this.apply(cached); if (p.source !== 'file' && navigator.onLine && MS.signedIn) this.load(false); } else if (p.source === 'file') this.showStart('Projektfilen er ikke gemt på denne enhed – vælg den igen.'); else this.load(true);
  }

  async load(visible) {
    const p = this.project;
    if (!MS.signedIn) { if (!this.scan) this.showLogin('Log ind for at hente projektet.'); else toast('Log ind for at opdatere projektet.'); return; }
    this.refreshBtn.disabled = true;
    const old = this.refreshBtn.textContent;
    try {
      const res = await scanDrive(p.driveId, p.itemId, (folders, files) => {
        this.refreshBtn.textContent = `Læser… ${folders} mapper`;
        if (visible && !this.scan) this.scroll.replaceChildren(h('p', { class: 'empty' }, `Læser projektet… ${folders} mapper, ${files} elementer`));
      });
      const scan = { at: new Date().toISOString(), truncated: res.truncated, items: res.items };
      await store.set(`project-scan:${p.id}`, scan);
      if (this.project === p && this.root.isConnected) this.apply(scan);
    } catch (err) {
      if (err.code === 'login_required' && !this.scan) return this.showLogin(err.message);
      toast(`Kunne ikke hente projektet: ${err.message}`);
      if (!this.scan) this.scroll.replaceChildren(h('p', { class: 'empty' }, err.message));
    } finally {
      this.refreshBtn.disabled = false;
      this.refreshBtn.textContent = old;
    }
  }

  async apply(scan) {
    const status = await api('project_scan', scan.items.map((i) => [i.id, i.path, i.folder, i.size, i.modified]));
    this.scan = scan;
    this.status = status;
    const s = status.summary;
    const when = fmtDate(scan.at);
    this.summary.innerHTML = `${esc(this.project.where || '')}${this.project.where ? ' · ' : ''}<b>${s.files}</b> filer i ${s.folders} mapper · `
      + `<span class="ok-text">✓ ${s.ok} følger A104</span> · <span class="warn-text">⚠ ${s.issues} med bemærkninger</span>`
      + `<br><span class="muted">${scan.file ? 'Gemt fra Windows-programmet' : 'Hentet'} ${esc(when)}${scan.truncated ? ` · kun de første ${SCAN_LIMIT} elementer` : ''}</span>`;
    this.buildTree();
    const keep = this.folder != null && (this.folder === '' || status.folders[this.folder]) ? this.folder : '';
    this.showFolder(keep, { reveal: false });
  }

  buildTree() {
    const items = this.scan.items;
    this.files = items.filter((i) => !i.folder && this.status.files[i.id]);
    this.byParent = new Map();
    for (const f of this.files) {
      const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      if (!this.byParent.has(parent)) this.byParent.set(parent, []);
      this.byParent.get(parent).push(f);
    }
    const folders = items.filter((i) => i.folder && this.status.folders[i.path]);
    this.folderItems = new Map(folders.map((f) => [f.path, f]));
    const kids = new Map();
    for (const f of folders) {
      const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      if (!kids.has(parent)) kids.set(parent, []);
      kids.get(parent).push(f);
    }
    const sortName = (a, b) => a.name.localeCompare(b.name, 'da', { numeric: true });
    const counts = (path) => {
      const own = this.byParent.get(path) || [];
      let n = own.length;
      let bad = own.filter((f) => !this.status.files[f.id][0]).length;
      for (const k of kids.get(path) || []) { const c = counts(k.path); n += c[0]; bad += c[1]; }
      return [n, bad];
    };
    this.rows = new Map();
    const make = (f, depth) => {
      const st = f ? this.status.folders[f.path] : null;
      const path = f ? f.path : '';
      const sub = (kids.get(path) || []).sort(sortName);
      const [n, bad] = counts(path);
      const li = h('li', { class: `${depth === 0 ? 'top ' : ''}${sub.length && depth >= 1 ? 'collapsed' : ''}` });
      const tw = h('button', { type: 'button', class: `tw${sub.length ? '' : ' leaf'}`, 'aria-label': 'Fold ud/sammen',
        onclick: () => { li.classList.toggle('collapsed'); tw.textContent = li.classList.contains('collapsed') ? '▸' : '▾'; } },
      li.classList.contains('collapsed') ? '▸' : '▾');
      const name = f ? f.name.replace(/^([CDP]\d{1,2}(?:\.[A-Z]?\d{1,2})?)\s+/i, '') : this.project.name;
      const r = row({ code: st?.own ? st.code : '', title: f ? `📁 ${name}` : `📂 ${name}`, score: n ? `${bad ? '⚠ ' : ''}${n}` : '' }, () => this.showFolder(path));
      r.title = st?.code ? `${st.code} ${st.a104}${bad ? ` – ${bad} filer med bemærkninger` : ''}` : (f ? 'Ikke en A104-mappe' : 'Projektmappen');
      li.append(h('div', { class: 'node' }, tw, r));
      if (sub.length) li.append(h('ul', {}, sub.map((k) => make(k, depth + 1))));
      this.rows.set(path, { li, row: r });
      return li;
    };
    this.tree = h('ul', { class: 'tree list' }, make(null, 0));
    this.scroll.replaceChildren(this.tree);
  }

  folderUrl() {
    if (this.folder && this.folderItems?.get(this.folder)) return this.folderItems.get(this.folder).url;
    return this.project.url;
  }

  fileRow(f, showPath) {
    const [ok, message] = this.status.files[f.id];
    const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    const sub = [showPath ? (parent || this.project.name) : '', ok ? '' : message, fmtDate(f.modified) + (f.by ? ` · ${f.by}` : '')].filter(Boolean).join(' · ');
    const r = row({ code: ok ? '✓' : '⚠', title: f.name, sub }, () => this.showFile(f));
    r.querySelector('.r-code').classList.add(ok ? 'ok-text' : 'warn-text');
    return r;
  }

  showFolder(path, { reveal = true } = {}) {
    if (!this.scan) return;
    this.folder = path ?? '';
    const text = this.filter.value.trim().toLowerCase();
    const issues = this.onlyIssues.checked;
    const d = this.detail;
    d.doc.replaceChildren();
    d.body.scrollTop = 0;
    if (text || issues) {
      const key = codeKey(text);
      const hits = this.files.filter((f) => (!issues || !this.status.files[f.id][0])
        && (!text || f.path.toLowerCase().includes(text) || (key && codeKey(f.name).startsWith(key))));
      d.doc.append(h('h1', {}, text ? `Filer med »${this.filter.value.trim()}«` : 'Filer med bemærkninger'),
        h('p', { class: 'muted' }, `${hits.length} filer i hele projektet${hits.length > 300 ? ' – de første 300 vises' : ''}`),
        h('div', { class: 'list' }, hits.slice(0, 300).map((f) => this.fileRow(f, true))));
      select(this.tree, null);
      if (reveal && isNarrow()) d.reveal();
      return;
    }
    const st = this.status.folders[this.folder];
    const item = this.rows.get(this.folder);
    if (item) {
      let li = item.li.parentElement?.closest('li');
      while (li) { li.classList.remove('collapsed'); li.querySelector(':scope > .node .tw').textContent = '▾'; li = li.parentElement?.closest('li'); }
      select(this.tree, item.row);
      scrollWithin(item.row, 'nearest');
    }
    const files = (this.byParent.get(this.folder) || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'da', { numeric: true }));
    const name = this.folder ? this.folder.split('/').pop() : this.project.name;
    d.doc.append(h('p', { class: 'muted' }, this.folder ? `${this.project.name} › ${this.folder.split('/').join(' › ')}` : this.project.where || ''),
      h('h1', {}, name));
    if (st?.code) {
      d.doc.append(h('p', {}, st.own ? 'A104-mappe ' : 'Ligger i A104-mappen ',
        h('a', { href: `tree:${st.code}` }, `${st.code} ${st.a104}`)));
    } else if (this.folder) {
      d.doc.append(h('p', { class: 'warn-text' }, 'Ikke en A104-mappe – filerne ligger uden for A104-strukturen.'));
    }
    d.doc.append(files.length ? h('div', { class: 'list' }, files.map((f) => this.fileRow(f, false)))
      : h('p', { class: 'muted' }, 'Ingen filer direkte i mappen.'));
    if (reveal) d.reveal();
  }

  async showFile(f) {
    const d = this.detail;
    const [ok, message, code] = this.status.files[f.id];
    const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    const suggestion = h('div', {}, h('p', { class: 'muted' }, 'Finder forslag…'));
    d.doc.replaceChildren(
      h('p', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); this.showFolder(parent, { reveal: false }); } }, `‹ ${parent ? parent.split('/').pop() : this.project.name}`)),
      h('h1', { class: 'break' }, f.name),
      h('p', { class: ok ? 'ok-text' : 'warn-text' }, `${ok ? '✓' : '⚠'} ${message}`),
      h('p', { class: 'muted' }, [`Ændret ${fmtDate(f.modified)}`, f.by ? `af ${f.by}` : '', fmtSize(f.size)].filter(Boolean).join(' · ')),
      h('div', { class: 'toolbar' }, f.url ? h('a', { class: 'btn primary', href: f.url, target: '_blank', rel: 'noopener' }, 'Åbn fil')
        : h('span', { class: 'muted' }, 'Filen ligger kun på pc’en – den er ikke i OneDrive/Teams.')),
      suggestion);
    d.body.scrollTop = 0;
    d.reveal();
    try {
      const s = await api('project_file', f.name, code || '', this.project.projectId || prefs.projectId || '');
      if (!s.code) { suggestion.replaceChildren(h('p', { class: 'muted' }, s.reason || '')); return; }
      const same = s.name === f.name && s.code === code;
      suggestion.replaceChildren(h('div', { class: 'card' },
        h('h2', {}, same ? 'A104' : 'Forslag'),
        h('p', {}, 'Mappe: ', h('a', { href: `tree:${s.code}` }, `${s.code} ${s.folder}`), s.probability < 100 ? h('span', { class: 'muted' }, ` (${s.probability} %)`) : null),
        s.path ? h('p', { class: 'muted' }, s.path) : null,
        same ? null : h('p', {}, 'Filnavn: ', h('code', { class: 'break' }, s.name), ' ',
          h('button', { type: 'button', class: 'btn flat', onclick: () => copyText(s.name) }, '⧉ Kopiér')),
        h('p', { class: 'muted' }, s.reason)));
    } catch (err) {
      suggestion.replaceChildren(h('p', { class: 'muted' }, `Intet forslag: ${err.message}`));
    }
  }
}

// =========================================================================== Favoritter
class FavoritesPage {
  constructor(root) {
    this.root = h('div', { class: 'page fill' });
    const list = listPane();
    this.list = list.scroll;
    this.detail = new EntityDetail({ empty: 'Vælg en favorit.' });
    this.split = h('div', { class: 'split' }, list.el, this.detail.el);
    this.root.append(pageHead('Favoritter', 'Ofte brugte mapper, dokumenter og koder. Tryk ☆ Favorit i en detaljevisning for at gemme her. Favoritterne gemmes på denne enhed.'), this.split);
    root.append(this.root);
    this.onChange = () => this.refresh();
    window.addEventListener('favorites-changed', this.onChange);
    this.refresh();
  }

  async refresh() {
    if (!this.root.isConnected && current.page !== this) { window.removeEventListener('favorites-changed', this.onChange); return; }
    const favs = await api('favorites');
    const ul = h('div', { class: 'list' });
    favs.forEach((f, i) => {
      const el = row({ code: f.icon, title: f.label, sub: f.missing ? 'Findes ikke længere i datagrundlaget' : f.kind, dim: f.missing },
        () => { if (f.missing) return; select(ul, el); this.detail.show({ type: f.type, key: f.key }); });
      const remove = h('button', { type: 'button', class: 'btn flat', title: 'Fjern fra favoritter', onclick: async (e) => {
        e.stopPropagation();
        const exp = await api('remove_favorite', f.id);
        await store.set('favorites', exp);
        this.refresh();
      } }, '✕');
      ul.append(h('div', { style: 'display:flex; align-items:center' }, el, remove));
      if (i === 0 && !f.missing && !this.detail.ref) { select(ul, el); this.detail.show({ type: f.type, key: f.key }, { push: false, reveal: false }); }
    });
    if (!favs.length) {
      ul.append(h('p', { class: 'empty' }, 'Ingen favoritter endnu.'));
      this.detail.clear('Vælg en favorit.');
    }
    this.list.replaceChildren(ul);
  }
}

// =========================================================================== Indstillinger
class SettingsPage {
  constructor(root) {
    this.root = h('div', { class: 'page' });
    root.append(this.root);
    this.build();
  }

  async build() {
    const r = this.root;
    const d = cache.dashboard || (cache.dashboard = await api('dashboard'));
    r.append(pageHead('Indstillinger'));
    const wrap = h('div', { class: 'settings' });
    r.append(wrap);

    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Tema' });
    for (const [key, label] of [['system', 'Følg systemet'], ['light', 'Lys'], ['dark', 'Mørk']]) {
      seg.append(h('button', { type: 'button', 'aria-pressed': String(prefs.theme === key), onclick: async (e) => {
        prefs.theme = key;
        seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
        applyTheme();
        await savePrefs();
      } }, label));
    }
    wrap.append(h('div', { class: 'card' }, h('h2', {}, 'Udseende'), seg));

    const pid = h('input', { type: 'text', value: prefs.projectId, placeholder: 'fx G3 eller 2026-017' });
    const inc = h('input', { type: 'checkbox', checked: prefs.includePid ? 'checked' : null });
    const savePid = async () => { prefs.projectId = pid.value.trim(); prefs.includePid = inc.checked; await savePrefs(); toast('Gemt'); };
    pid.addEventListener('change', savePid);
    inc.addEventListener('change', savePid);
    wrap.append(h('div', { class: 'card' }, h('h2', {}, 'Filnavne'),
      h('div', { class: 'muted' }, 'Bruges af Dokumentfinderen og navnebyggeren.'),
      h('div', { class: 'field' }, h('label', {}, 'Projekt-ID'), pid),
      h('label', { class: 'check', style: 'margin-top:10px' }, inc, 'Sæt projekt-ID foran model- og dokumentfilnavne')));

    const offline = h('div', { class: 'muted' }, 'Tjekker…');
    const app = h('div', { class: 'card' }, h('h2', {}, 'App og offline'), offline);
    if (installPrompt) app.append(h('div', { style: 'margin-top:10px' }, h('button', { type: 'button', class: 'btn primary', onclick: promptInstall }, '📲 Installér A104 Navigator')));
    wrap.append(app);
    offlineStatus().then((t) => { offline.textContent = t; });

    const s = d.stats;
    const imported = meta.imported ? new Date(meta.imported).toLocaleDateString('da-DK') : '–';
    wrap.append(h('div', { class: 'card' }, h('h2', {}, 'Datagrundlag'),
      h('div', { html: `<b>Molio A104 – samlet standard</b> (${esc(meta.excel || '')})<br>`
        + `<span class="muted">${s.folders} mapper · ${s.documents} dokumenttyper · ${s.codes} koder · ${s.examples} eksempler · indlæst ${esc(imported)}</span><br>`
        + '<span class="muted">BR18 2026 fra bygningsreglementet.dk og AB 18 / ABR 18 / ABT 18 fra Retsinformation følger med.</span>' })));

    wrap.append(h('div', { class: 'card' }, h('h2', {}, 'Om A104 Navigator'),
      h('div', { html: `Version ${esc(VERSION)} (web) · build <span class="mono">${esc(BUILD)}</span><br>${esc(meta.copyright || '')}<br>`
        + '<span class="muted">Al søgning og analyse sker på din enhed. Under Projekt læser appen dine mapper i OneDrive direkte hos Microsoft '
        + '(kun læseadgang). Filhåndtering (lægge filer ind, omdøbe) findes i Windows-programmet.</span>' }),
      h('div', { style: 'margin-top:12px' }, h('button', { type: 'button', class: 'btn', onclick: async () => {
        if (!confirm('Slet favoritter og indstillinger på denne enhed?')) return;
        await store.clear();
        location.reload();
      } }, 'Nulstil favoritter og indstillinger'))));
  }
}

async function offlineStatus() {
  if (!('serviceWorker' in navigator)) return 'Browseren understøtter ikke offline-brug.';
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg || !reg.active) return 'Appen gøres klar til offline-brug…';
  let text = '✓ Klar til offline-brug – appen virker uden internet.';
  try {
    if (navigator.storage?.persisted && await navigator.storage.persisted()) text += ' Data er gemt permanent på enheden.';
  } catch { /* ukendt */ }
  return text;
}

const PAGES = {
  dashboard: (v) => new Dashboard(v),
  project: (v, p) => new ProjectPage(v, p),
  search: (v, p) => new SearchPage(v, p),
  finder: (v, p) => new FinderPage(v, p),
  tree: (v, p) => new TreePage(v, p),
  codes: (v, p) => new CodesPage(v, p),
  learn: (v, p) => new LearnPage(v, p),
  br18: (v, p) => new BR18Page(v, p),
  favorites: (v) => new FavoritesPage(v),
  settings: (v) => new SettingsPage(v),
};

// =========================================================================== start
function fail(message) {
  const splash = $('#splash');
  splash.hidden = false;
  splash.classList.add('error');
  $('#splash-text').textContent = message;
}

function wireTopbar() {
  const input = $('#global-search');
  const go = () => {
    const q = input.value.trim();
    if (q) navigate('search', { q }, { replace: current.path === 'search' });
    else if (current.path === 'search') navigate('dashboard');
  };
  input.addEventListener('input', debounce(go, 250));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { go(); if (isNarrow()) input.blur(); }
    if (e.key === 'Escape') { input.value = ''; go(); }
  });
  $('#where-btn').addEventListener('click', () => navigate('finder', { q: input.value.trim() }));
  $('#menu-btn').addEventListener('click', openMenu);
  $('#scrim').addEventListener('click', closeMenu);
  $('#theme-toggle').addEventListener('click', async () => {
    const dark = document.documentElement.dataset.theme === 'dark'
      || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    prefs.theme = dark ? 'light' : 'dark';
    applyTheme();
    await savePrefs();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (sw) => {
      if (!navigator.serviceWorker.controller) return; // første installation – intet at opdatere
      toast('Der er en ny version af A104 Navigator.', { label: 'Genindlæs', run: () => sw.postMessage('skipWaiting') });
    };
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => { if (sw.state === 'installed') offer(sw); });
    });
  }).catch(() => { /* offline-brug er ikke muligt – appen virker stadig online */ });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});

async function start() {
  Object.assign(prefs, await store.get('prefs', {}));
  applyTheme();
  buildNav();
  wireTopbar();
  $('#version').textContent = `Version ${VERSION} · web · offline`;
  registerServiceWorker();
  const signIn = MS.configured ? MS.handleRedirect() : Promise.resolve(null);
  try {
    const favorites = await store.get('favorites', []);
    meta = await api('init', favorites);
  } catch (err) {
    fail(`A104 Navigator kunne ikke starte: ${err.message}`);
    return;
  }
  const signedIn = await signIn;
  if (signedIn?.error) toast(`Login mislykkedes: ${signedIn.error}`);
  else if (signedIn?.ok) toast(`Logget ind som ${MS.account?.name || ''}`);
  $('#splash').hidden = true;
  $('#app').hidden = false;
  render();
  try { navigator.storage?.persist?.(); } catch { /* valgfrit */ }
  setTimeout(() => api('warm_up').catch(() => {}), 1500);
}

start();
