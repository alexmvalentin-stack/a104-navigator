// Kører A104 Navigators Python-kerne (web_api.py) i Pyodide – i baggrunden, så brugerfladen ikke fryser.
const BUILD = '2.22.0-77b64eb7ee';
const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.27.2/full/';

importScripts(PYODIDE_URL + 'pyodide.js');

let api = null;
let booting = null;

function progress(text) {
  postMessage({ progress: text });
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

async function boot() {
  progress('Starter Python…');
  const py = await loadPyodide({ indexURL: PYODIDE_URL });
  progress('Henter A104-data…');
  const [core, data] = await Promise.all([
    fetchBuffer(`core.zip?v=${BUILD}`),
    fetchBuffer(`data.zip?v=${BUILD}`),
    py.loadPackage('sqlite3'),
  ]);
  py.unpackArchive(core, 'zip', { extractDir: '/home/pyodide' });
  py.unpackArchive(data, 'zip', { extractDir: '/home/pyodide' });
  progress('Bygger søgeindeks…');
  py.runPython("import sys; sys.path.insert(0, '/home/pyodide/app')");
  api = py.pyimport('web_api');
}

onmessage = async ({ data }) => {
  const { id, fn, args } = data;
  try {
    if (!api) {
      booting = booting || boot();
      await booting;
    }
    const result = api.call(fn, JSON.stringify(args || []));
    postMessage({ id, ok: true, result: JSON.parse(result) });
  } catch (err) {
    postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
};
