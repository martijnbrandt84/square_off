# Square Off

Multiplayer dots-and-boxes spel met een NYC maffia-thema. Claim wijken, sluit vakjes in, en beheers drie van de vijf banken om de stad te domineren.

**Live:** [squareoff.vercel.app](https://squareoff.vercel.app) (frontend) + [Railway](https://squareoff-production.up.railway.app) (backend)

---

## Gameplay

- Spelers wisselen beurten af en trekken één grenslijn per beurt
- Sluit je alle vier zijden van een vakje in → het vakje is van jou + extra beurt
- Win door **3 van de 5 banken (🏦)** te claimen
- Beschikbaar als 6×6 of 8×8 bord, tegen CPU of online tegen een vriend

### Specials

| Emoji | Naam | Effect |
|-------|------|--------|
| 🚓 | Razzia | Jij slaat een beurt over |
| 💸 | Steekpenning | Jij speelt een extra beurt |
| 💣 | Handgranaat | Kies een vakje — alle grenzen eromheen worden verwijderd |

---

## Architectuur

```
├── server.js          # Express + Socket.io backend (Railway)
├── public/
│   ├── index.html     # Lobby + atmosferische canvas animatie
│   ├── game.html      # Spelscherm shell
│   ├── game.js        # Canvas rendering, socket client, game logic
│   └── style.css      # Styling
├── vercel.json        # Vercel static hosting config (frontend)
├── railway.toml       # Railway deployment config (backend)
└── nixpacks.toml      # Railway build config (Node 20)
```

### Split deployment

- **Frontend** (Vercel): `public/` — statische bestanden, geen build stap
- **Backend** (Railway): `server.js` — Socket.io server, game state, bot AI

De frontend detecteert automatisch of hij lokaal draait (`localhost`) en verbindt dan met de lokale server. In productie verbindt hij met de Railway URL hardcoded in `game.js`.

---

## Lokaal draaien

```bash
npm install
npm run dev     # nodemon — herstart automatisch bij wijzigingen
```

Open `http://localhost:3003`.

---

## Server API

### Socket events (client → server)

| Event | Payload | Beschrijving |
|-------|---------|--------------|
| `join-room` | `{roomId, playerName, gridSize, vsComputer, playerId}` | Kamer joinen of aanmaken |
| `place-line` | `{roomId, lineType, row, col}` | Lijn plaatsen |
| `bomb-cell` | `{roomId, row, col}` | Handgranaat doelwit kiezen |
| `request-rematch` | `{roomId}` | Herspelen aanvragen |

### Socket events (server → client)

| Event | Payload | Beschrijving |
|-------|---------|--------------|
| `room-update` | `room` | Volledige spelstaat na elke actie |
| `room-full` | — | Kamer is vol |
| `rematch-vote` | `{votes}` | Aantal herspeel-stemmen |

### HTTP endpoints

| Endpoint | Beschrijving |
|----------|--------------|
| `GET /version` | Serverversie + specials emojis (debug) |
| `POST /create-room` | Genereer een kamer-ID |

---

## Bot AI

De CPU-tegenstander (`computeBotMove`) werkt met prioriteiten:

1. **Claim een bank** — altijd de hoogste prioriteit
2. **Blokkeer tegenstander** van een bijna-voltooide bank (3-zijdig)
3. **Claim elk vakje** — sorteert op special: bribe/bomb (+6), hitman (−10)
4. **Veilige zet** — vermijdt het weggeven van 3-zijdige vakjes

De bom-AI (`computeBotBombTarget`) simuleert voor elk mogelijk doelwit hoeveel eigendom van de menselijke speler verloren gaat (ontklaimen van bank = 25pt, gewoon vakje = 8pt).

---

## localStorage keys

| Key | Inhoud |
|-----|--------|
| `squareoff_pid` | Unieke speler-ID (voor reconnect na verbindingsverlies) |
| `squareoff_name` | Laatste gebruikte naam |
| `squareoff_muted` | Geluid aan/uit (`'1'` = gedempt) |
| `squareoff_stats` | `{wins, losses, streak}` JSON |

---

## Deployment

**Railway** deployt automatisch bij elke push naar `main`. Verifieer via:

```
GET https://squareoff-production.up.railway.app/version
```

**Vercel** deployt ook automatisch bij push naar `main`.
