# Renaiss Slab King

**English** · [한국어](./README.ko.md)

A real-time Sichuan-style (Shisen-Sho) card-matching puzzle — **full implementation of every feature required by the project docs (PRD · FEATURE_SPEC · TECH-SPEC)**.
It uses real Renaiss cards (Pokémon · One Piece) as tiles, pulls price and grade data from the **Renaiss OS Index**, and gets marketplace / pack (gacha) context from the **official `renaiss` CLI**.

> Planning and technical docs live in [`docs/`](./docs) (PRD · FEATURE_SPEC · TECH-SPEC · CTO-QNA).

## Quick start

```bash
npm install
npm run prefetch   # (optional) refresh the data snapshot. Skips to the bundled snapshot if not run
npm run dev        # game server (8787) + web (5173) together → http://localhost:5173
```

Production: `npm run build` → `npm start` (a single process serves dist/ static files + API + WebSocket at http://localhost:8787)

## Implemented features (FEATURE_SPEC F-01–F-16)

| Area | Details |
| --- | --- |
| Account (F-01) | Guest nickname login (demo scope). playerId persisted locally |
| Lobby (F-02/03) | Room creation (1–4 players · public/private · password), room list, join validation (capacity / in-progress / password), host succession, "play solo now" |
| Game settings (F-04/05/06) | Card set (Pokémon / One Piece / mixed), 5 map modes, 3 difficulties (varying number of card kinds), host-only change & start |
| Matching (F-07) | ≤2-turn path resolution (server-authoritative), connection-line effect, auto-reshuffle on deadlock, 5 non-rectangular masks |
| Map modes (F-08) | Normal · Rolling (rightward cycle every 3s) · UP (rows injected from bottom, rising, as lines clear) · Win (special pair → instant 1st place & immediate end) · Shanghai (2-layer stack) |
| Combo (F-09) | 2-second window; 5/15 combo → removes a designated card pair, 10/20 combo → removes all of one card |
| Items (F-10) | Search 3 · Shuffle 3 · Scissors 1 (path-agnostic forced removal, counts toward combo) |
| Ranking (F-11) | 10-second grace after 1st place is decided → rank by remaining tiles / score. Opponent-progress mini-view |
| Dex (F-12/13/14) | Same card seen 10× cumulatively → registered. Pokémon / One Piece tabs, completion rate, marketplace "view details", SBT (mock issuance) at 100% completion |
| Result (F-15) | Ranking table, score · time · XP, cards met today, grade distribution, top-priced card, marketplace/reward buttons, replay |
| Data policy (F-16) | No arbitrary generation of price/grade, "example data" label when missing, "Renaiss OS Index" attribution shown at all times |

## Architecture (TECH-SPEC §2)

```
src/  (React 18 + Vite)  ←WebSocket/REST→  server/ (Fastify + Socket.IO, server-authoritative)
        └────────────── shared/ (shared engine: resolution · board · modes · combo · score · protocol) ──────────────┘
```

- **Server-authoritative**: board generation (seed), match resolution, score, combo, items, and mode ticks are all computed on the server. The client sends intent only.
- **Same board in solo play**: one seed per match; everyone solves the same board independently and shares progress (TECH-SPEC §3.4).
- Rendering stays on React DOM (no PixiJS — a change from the doc assumption; performance is sufficient for the local demo).

```
shared/    protocol.ts (contract) · cards.ts · shisen.ts (BFS) · board.ts (masks · modes) · combo.ts · score.ts
server/    index.ts (REST · sockets) · rooms.ts (rooms) · match.ts (match authority) · dex.ts (Dex · SBT, persisted to .data/dex.json)
src/       net.ts (typed socket) · screens/ (Login · Lobby · Room · Game · Result · Dex)
scripts/   prefetch-*.mjs · test-*.ts
```

## Tests

```bash
npm test   # path resolution 6 · board 9 · mode/combo/mask 78 · sim 9 (auto-clear across all difficulties) · server e2e 59
```

The server e2e uses two real socket clients to verify the full path: room creation → join → start → auto-play → clear → grace → ranking & summary.

## Data pipeline

| Purpose | Source | Output | Notes |
| --- | --- | --- | --- |
| Card pool (puzzle tiles · Dex) | Renaiss OS Index `GET /v1/search` | `public/data/card-pool.json` | **includes images** (imageUrl) |
| Marketplace listings · packs | Official `npx renaiss` CLI | `public/data/market-snapshot.json` | CLI list has no images → context only |

- `npm run prefetch:pool` — handles the public tier's 60/min limit (1.2s throttle + 429 retry). Search terms are in `QUERIES` in `scripts/prefetch-pool.mjs`.
- `npm run prefetch:cli` — `renaiss marketplace` + `renaiss packs` snapshot.

## Attribution (required)

When displaying price/grade numbers, **"Renaiss OS Index" + a source link** is mandatory. Prices/grades must never be arbitrarily generated — only real API values are used. Missing cards get an "example data" label.

## Implementation assumptions vs. docs (unconfirmed → noted in code comments)

- UP trigger: interpreted as "rise when a full row is cleared" · combo reset: 0 on failure, 1 when the 2s window is exceeded
- Host leaves: succeeded by the next joiner · leaving mid-game: match continues, reconnection unsupported
- Card kinds per difficulty 6/16/30 · clear bonus 500 pts · XP = score/10 + 50 on clear
- SBT: mock issuance (not on-chain) — open questions in [`docs/CTO-QNA.md`](./docs/CTO-QNA.md)
