# Arcade

Slagbrødrene (a Smash-style brawler for 2–4 players) at arcade.eliastrana.no: opening the site goes straight into the game.
Node.js server with WebSockets (`ws`), three.js in the browser. The older Arena and Skyhook games are still in the repo at
`/arena.html` and `/skyhook.html`, but nothing links to them.

```bash
npm ci
npm start        # http://localhost:3001
```

It runs on the trashcan as its own account (`_svc_arena`, port 3001) behind Caddy. See
[trashcan-dashboard](https://github.com/Eliastrana/trashcan-dashboard) for how it is set up and restored.
