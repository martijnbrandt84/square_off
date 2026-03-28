# CLAUDE.md — Square Off

## Project overzicht

Multiplayer dots-and-boxes spel met NYC maffia-thema. Spelers trekken grenslijnen op een grid; wie alle vier zijden van een vakje sluit, claimt het. Doel: 3 van de 5 banken (🏦) claimen. Beschikbaar als 6×6 of 8×8, vs CPU of online multiplayer.

## Deploymentarchitectuur

**Split deployment — twee aparte services:**

- **Frontend**: Vercel, serveert `public/` als statische bestanden
- **Backend**: Railway, draait `server.js` (Express + Socket.io)

De frontend verbindt automatisch met de juiste backend:
```js
// public/game.js, bovenaan
const BACKEND = window.location.hostname === 'localhost' ? '' : 'https://squareoff-production.up.railway.app';
```

Na elke push naar `main` deployen beide automatisch. Verifieer de Railway-versie via:
```
GET https://squareoff-production.up.railway.app/version
```

Als Railway de nieuwe code niet oppikt, handmatig redeployen via het Railway dashboard.

## Ontwikkelomgeving

```bash
npm install
npm run dev   # nodemon op poort 3003
```

Open `http://localhost:3003`. Geen build stap nodig.

## Bestandsstructuur

| Bestand | Rol |
|---------|-----|
| `server.js` | Game state, socket events, bot AI, kamer beheer |
| `public/index.html` | Lobby: naamveld, bord/modus keuze, atmosferische canvas animatie |
| `public/game.html` | Spelscherm shell (HTML + modals) |
| `public/game.js` | Canvas rendering, input handling, socket client, SFX |
| `public/style.css` | Alle styling — geen framework |
| `vercel.json` | Vercel routes: `/` → `index.html`, `/room/*` → `game.html` |
| `railway.toml` | Railway build + start command |
| `nixpacks.toml` | Nixpacks: nodejs_20 |

## Game state (server)

Elke kamer heeft:
```js
{
  id, gridSize, size,           // bord configuratie
  grid,                         // array van cellen met {row, col, terrain, isKeyLocation, keyDef, special, owner}
  lines: { hLines, vLines },    // 2D arrays, null = leeg, playerId = geplaatst
  players, scores,
  turn, turnCount, status, vsComputer, winner,
  skipNext, pendingExtraMove, bombTarget, razziaPenalty,
}
```

`sanitizeRoom()` verwijdert interne velden voor de client.

## Specials mechanica

| Special | id | Effect |
|---------|-----|--------|
| 🚓 Razzia | `hitman` | `razziaPenalty = true` — cancelt de scoringsbonus van de speler die hem pakt |
| 💸 Steekpenning | `bribe` | `pendingExtraMove = playerId` — extra beurt bewaard tot hij niet meer scoort |
| 💣 Handgranaat | `bomb` | `bombTarget = playerId` — speler kiest doelwit; `applyBomb()` verwijdert 4 muren, ontklaimit adjacente cellen die hun 4e muur verliezen |

**Razzia let op:** De `razziaPenalty` vlag wordt gecheckt in `processMove` vóór de `scored` check — zo eindigt de beurt direct, ook als de speler een vakje heeft afgesloten.

**Bot bom-resolutie:** Wordt afgehandeld in `scheduleBotMove` (vóór de gewone zet), NIET in `processMove`. Dit voorkomt een loop waarbij de bot een lijn plaatst én direct de bom resolvt.

## Bot AI prioriteiten

1. Claim een bank (isKeyLocation)
2. Blokkeer tegenstander van een 3-zijdige bank
3. Claim elk vakje — gesorteerd op special (bribe/bomb +6, hitman −10)
4. Veilige zet (geen 3-zijdige vakjes weggeven)

`computeBotBombTarget` simuleert het bom-effect: score op basis van ontklaimde menselijke cellen (bank = 25pt, gewoon = 8pt) en verstoorde 3-zijdige cellen.

## Client-side animaties

Alle animaties draaien in de canvas render loop (`startPulse` / `requestAnimationFrame`):

| Array | Animatie | Duur |
|-------|----------|------|
| `claimedFlashes` | Flash op geclaimd vakje | 700ms |
| `bombFlashes` | Meerfasige explosie (6 fases) | 2000ms |
| `specialAnimations` | 🚓 razzia (auto + siren overlay) / 💸 steekpenning (vallend geld) | 2200ms |

`startPulse` blijft draaien zolang een van deze arrays niet leeg is.

## SFX (Web Audio API)

Lazy init (iOS-safe). Alle methodes controleren de `muted` vlag intern:
- `placeLine()`, `oppLine()`, `claimCell()`, `claimBank()` — standaard geluiden
- `razzia()` — drievoudige sirene sweep (950→500 Hz)
- `steekpenning()` — oplopende munttonen (2100–3700 Hz)
- `special()` — fallback voor bom
- `win()`, `lose()` — eindscherm
- `toggle()` — omschakelen, slaat op in `localStorage`

## localStorage

| Key | Inhoud |
|-----|--------|
| `squareoff_pid` | Unieke speler-ID (reconnect) |
| `squareoff_name` | Laatste naam |
| `squareoff_muted` | `'1'` = gedempt |
| `squareoff_stats` | `{wins, losses, streak}` |

## Bekende valkuilen

- **Railway deployt niet automatisch**: Na een push soms handmatig redeployen. Verifieer altijd via `/version`.
- **Emoji override**: De client gebruikt `SPECIALS_INFO[cell.special.id].emoji` — nooit `cell.special.emoji` van de server. Dit beschermt tegen legacy server-data met verkeerde emojis.
- **Bot bom loop**: Was een bug waarbij de bot in een eindeloze explosie-loop kon belanden. Opgelost door bom-resolutie uit `processMove` te halen en in `scheduleBotMove` te plaatsen.
- **Razzia skipNext bug**: `skipNext = playerId` werkte nooit (zelf-referentie in `advanceTurn`). Vervangen door `razziaPenalty` vlag.

## Commit conventies

Gebruik beschrijvende commit messages. Server versie ophogen in `SERVER_VERSION` bij elke significante serverwijziging (formaat: `'YYYY-MM-DD-vN'`).
