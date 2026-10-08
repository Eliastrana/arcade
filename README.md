# Arcade

Small browser games served at arcade.eliastrana.no: an arena shooter, Skyhook and Brawl. Node.js server with WebSockets (`ws`), three.js in the browser.

```bash
npm ci
npm start        # http://localhost:3001
```

It runs on the trashcan as its own account (`_svc_arena`, port 3001) behind Caddy. See
[trashcan-dashboard](https://github.com/Eliastrana/trashcan-dashboard) for how it is set up and restored.
