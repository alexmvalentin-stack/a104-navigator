# A104 Navigator – kort guide til Claude

Svar kort på dansk. Ingen lange opsummeringer, ingen gentagelse af kode, der ikke er ændret.

## Hvad repoet er
Statisk PWA (GitHub Pages). Ingen build, ingen tests, ingen npm. Python-kernen kører i browseren via Pyodide.
Commits hedder `Build <version>-<hash>` – filerne genereres et andet sted. Tag højde for, at næste build kan overskrive manuelle ændringer.

| Fil | Indhold |
|---|---|
| `app.js` (~2500 linjer) | Hele brugerfladen. Læs kun det relevante afsnit (se kort nedenfor). |
| `app.css` | Stilark. |
| `index.html` | Skal for appen. |
| `worker.js` | Starter Pyodide, pakker `core.zip` + `data.zip` ud, kalder `web_api.py`. |
| `sw.js` | Service worker / offline-cache (nøgle = `BUILD`). |
| `ms.js` | Microsoft/OneDrive-login. |
| `build.json` | Version og build-id. |
| `core.zip` | Python-kilde (`app/web_api.py`, `search_engine.py`, `settings.py`, `title_block.py`, vendored `rapidfuzz/`). |
| `data.zip` | SQLite-db + JSON for AB/ABR/ABT 18. |
| `jsqr.js`, `data/love/*.pdf`, `icons/` | Tredjepart/binært – åbn ikke. |

## Kort over `app.js` (linjenumre ca.)
hjælpere 8 · lager 61 · Python-kernen 113 · tilstand 134 · navigation 167 · byggeklodser 262 ·
Dashboard 420 · Søgning 488 · Dokumentfinder 564 · Mappestruktur 637 · Koder 735 · Lær A104 812 ·
BR18 1029 · AB 18 1193 · Projekt (OneDrive) 1285 · Scan fra pc 1318–2330 · Favoritter 2330 ·
Indstillinger 2369 · start 2467.
Find aktuelle linjer med: `grep -n "^// =====" app.js`

## Spar tokens
- Brug `grep -n` og læs derefter kun et udsnit (`sed -n 'A,Bp'` eller Read med offset/limit). Læs aldrig hele `app.js`.
- Åbn ikke `jsqr.js`, `*.zip`, `*.pdf` eller `.git/`. Python-filer: `unzip -p core.zip app/web_api.py | sed -n '1,80p'`.
- Ret med små Edit-kald; skriv ikke hele filer om.
- Versionsstrengen `BUILD`/`VERSION` står i `app.js`, `sw.js`, `worker.js` og `build.json` – ret dem samlet, hvis de skal ændres.
- Ingen subagenter, medmindre brugeren beder om det.
