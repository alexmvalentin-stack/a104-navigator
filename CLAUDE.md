# A104 Navigator – build-output (PWA)

Dette repo er **genereret build-output** (GitHub Pages). Commits hedder `Build <version>-<hash>`.
Kildekoden ligger andre steder – ret kun her, hvis opgaven udtrykkeligt handler om disse filer.

## Spar tokens
- Læs **aldrig** hele `app.js` (≈2.600 linjer). Find sektionen med
  `grep -n "// =====" app.js` og læs kun dét linjeinterval (`Read` med offset/limit).
- Rør ikke `jsqr.js` (vendoret QR-bibliotek), `icons/`, `data/love/*.pdf`, `core.zip`, `data.zip`.
- Zip-filer: brug `unzip -l` for at se indhold; pak kun den enkelte fil ud til scratchpad, og grep i den.
- Ingen test/byg-trin i repoet – brug ikke tid på at lede efter dem.
- Svar kort; vis ikke hele filer eller lange diffs i chatten.

## Kort over filerne
| Fil | Indhold |
|---|---|
| `index.html`, `app.css` | Skal + styling |
| `app.js` | UI. Sektioner: hjælpere, lager, Python-kernen, navigation, Dashboard, Søgning, Dokumentfinder, Mappestruktur, Koder, Lær A104, BR18, AB 18, Projekt (OneDrive), Scan fra pc, Favoritter, Indstillinger, start |
| `worker.js` | Starter Pyodide og kalder `app/web_api.py` fra `core.zip` |
| `sw.js` | Service worker / offline-cache (PRECACHE-liste med BUILD-version) |
| `ms.js` | Microsoft/OneDrive-login |
| `core.zip` | Python-kerne: `app/web_api.py` (API til UI), `search_engine.py`, `knowledge_base.py`, `br18.py`, `laws.py`, `project_manager.py` m.fl. |
| `data.zip` | Data: `database/molio_navigator.db`, BR18-json/jsonl, AB18/ABR18/ABT18-json |
| `build.json` | Version + Pyodide-version |

BUILD-strengen står i `app.js`, `worker.js`, `sw.js` og `build.json` – hold dem ens ved ændringer.
