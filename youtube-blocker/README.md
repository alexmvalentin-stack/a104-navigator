# YouTube-blokering med QR-kode 📵

En lille app til forældre. Du har to QR-koder:

| QR-kode | Hvad sker der |
|---|---|
| ⛔ **Bloker YouTube** | YouTube holder op med at virke på børnenes iPhones (både appen og youtube.com) |
| ✅ **Åbn YouTube** | YouTube virker igen |

Scan koden med et hvilket som helst iPhone-kamera, så skifter det med det samme
på **alle** telefoner, der har profilen installeret. Du kan også bruge knapperne
på forældre-siden.

## Sådan virker det

iOS tillader ikke, at en almindelig app lukker andre apps. Til gengæld kan man
installere en **DNS-profil** på iPhonen. Denne app er en lille DNS-server
(DNS-over-HTTPS):

```
Barnets iPhone ──DNS-opslag──▶ denne server ──▶ Cloudflare (1.1.1.1)
                                    │
                    Er YouTube blokeret? → svar "findes ikke"
```

- Når YouTube er **blokeret**, svarer serveren, at YouTube-domænerne ikke findes
  (`youtube.com`, `googlevideo.com`, `ytimg.com`, `youtu.be`, `youtubekids.com` osv.).
- Alt andet internet virker som normalt.
- Det virker både på Wi-Fi og mobildata, også uden for hjemmet.
- Profilen installeres én gang. Derefter styres alt med QR-koderne.

## Krav

- En server, der **altid er tændt** og kan nås via **HTTPS med et gyldigt certifikat**
  (det kræver iPhone til DNS-over-HTTPS). Hvis serveren er nede, har børnenes
  telefoner ikke internet, så vælg et sted, der ikke går i dvale. Gratis-planer,
  der "sover", som Render free, duer ikke.
- Node.js 18 eller nyere, eller Docker. Der er ingen andre afhængigheder.

## Opsætning

### 1. Start serveren

**Med Node:**

```bash
cd youtube-blocker
ADMIN_PASSWORD=vælg-en-god-kode node server.js
```

**Med Docker:**

```bash
docker build -t youtube-blocker .
docker run -d --restart=always -p 8080:8080 -v ytblock-data:/data \
  -e ADMIN_PASSWORD=vælg-en-god-kode youtube-blocker
```

**Med Fly.io (eksempel på hosting, der altid kører):**

```bash
cd youtube-blocker
fly launch --no-deploy          # vælg en region tæt på, f.eks. arn (Stockholm)
fly volumes create data --size 1
# tilføj i fly.toml:
#   [mounts]
#     source = "data"
#     destination = "/data"
# og under [http_service]: auto_stop_machines = "off" og min_machines_running = 1
fly secrets set ADMIN_PASSWORD=vælg-en-god-kode
fly deploy
```

**Hjemme på en Raspberry Pi eller NAS:** kør Docker-kommandoen ovenfor, og sæt
[Caddy](https://caddyserver.com) foran. Caddy skaffer selv et HTTPS-certifikat:

```
youtube.mitdomæne.dk {
    reverse_proxy localhost:8080
}
```

### 2. Åbn forælder-siden

Gå til `https://din-server/`. Brugernavnet er ligegyldigt, og adgangskoden er
`ADMIN_PASSWORD`. Har du ikke sat den, står den genererede kode i serverens log
ved første start.

### 3. Installer profilen på hvert barns iPhone (kun én gang)

1. Scan **"Første gang"**-QR-koden på forælder-siden med **barnets** iPhone.
2. Tryk **Hent profil**, og vælg **Tillad**.
3. Åbn **Indstillinger → Profil hentet → Installer**, og skriv barnets kode.

### 4. Print QR-koderne

Tryk **Print QR-koder** på forælder-siden. Hæng "Bloker" op, hvor det passer, og
**gem "Åbn"-koden et sted, børnene ikke kan finde den**. Den, der scanner koden,
åbner for YouTube.

## Indstillinger (miljøvariabler)

| Variabel | Standard | Beskrivelse |
|---|---|---|
| `ADMIN_PASSWORD` | genereres | Adgangskode til forælder-siden |
| `PROFILE_REMOVAL_PASSWORD` | *(ingen)* | Hvis den er sat, skal der bruges en kode for at fjerne profilen fra iPhonen. **Anbefales.** Sættes før profilen installeres. |
| `PORT` | `8080` | Port |
| `DATA_DIR` | `./data` | Her gemmes tilstand og hemmelige links (`state.json`) |
| `PUBLIC_URL` | automatisk | F.eks. `https://youtube.mitdomæne.dk`, hvis links i QR-koderne bliver forkerte |
| `UPSTREAM_DOH` | `https://cloudflare-dns.com/dns-query` | Rigtig DNS-server. Tip: `https://family.cloudflare-dns.com/dns-query` filtrerer også voksenindhold |
| `START_BLOCKED` | `false` | Om YouTube skal være blokeret fra start |
| `BLOCKED_DOMAINS` | YouTube-listen | Kommasepareret liste, hvis du vil blokere noget andet (f.eks. TikTok) |
| `DNS_TOKEN`, `BLOCK_TOKEN`, `UNBLOCK_TOKEN` | genereres | De hemmelige dele af linkene. Sæt dem kun, hvis din server ikke har vedvarende disk, ellers ændres linkene ved genstart, og profilen skal installeres igen. |

Har du mistet "Åbn"-koden, eller har børnene fundet den? Slet `UNBLOCK_TOKEN`
fra `state.json`, eller sæt en ny værdi, og genstart. Så får du en ny kode, og
den gamle virker ikke længere.

## Godt at vide

- **Det kan tage op til ~1 minut**, før en ændring slår igennem. Kører YouTube-appen
  allerede, kan en video, der er i gang, fortsætte lidt. Luk appen helt (stryg den væk).
- **Profilen kan fjernes** under Indstillinger → Generelt → VPN og
  enhedsadministration. Brug `PROFILE_REMOVAL_PASSWORD` for at forhindre det.
- **VPN-apps og iCloud Privat videresendelse** kan omgå DNS-blokering. Slå
  Privat videresendelse fra på barnets iCloud, og brug Skærmtid →
  Indhold og anonymitet til at forhindre installation af nye apps (f.eks. VPN).
- QR-koderne er bare hemmelige links. Alle, der har linket, kan skifte tilstanden.

## Filer

- `server.js`: hele appen (DNS-server, forælder-side, QR-koder, iPhone-profil)
- `vendor/qrcode.js`: QR-generator (MIT)
- `Dockerfile`: til Docker og hosting
