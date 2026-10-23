# Grandmaster Chess 3D

## Deploy on Render

1. Push this project to a GitHub, GitLab, or Bitbucket repository.
2. In Render, choose **New > Blueprint**, connect that repository, and deploy the `render.yaml` blueprint.
3. Wait for the service health check at `/healthz` to pass, then open the `onrender.com` URL shown in the Render dashboard.

The blueprint runs the Node web service with Render's assigned `PORT`, starts it with `npm start`, and uses a free instance by default. No separate static-site service is needed: the Node server serves the chess page and its multiplayer API.

### Profiles and multiplayer state

The default profile store is `data/profiles.json`. Free Render instances use an ephemeral filesystem, so profiles can be lost when an instance restarts or is redeployed. To keep profiles across restarts, attach a persistent disk to the web service in Render, mount it at `/var/data`, and set `CHESS_DATA_DIR=/var/data` in the service's environment. Persistent disks may incur charges; review Render's current pricing before adding one.

Active games, room codes, matchmaking queues, and event-stream connections are held in server memory. Keep the service at **one instance**: scaling to multiple instances will split this state between servers. Active games and rooms also end when the service restarts or deploys.

Computer play includes Easy, Medium, Hard, Expert, Immortal Expert, and Impossible. Expert through Impossible use the locally hosted Stockfish.js 19 lite engine; Impossible uses its maximum skill setting and a 12-second calculation per move. This is extremely strong, but no chess engine can guarantee it will never lose. Stockfish.js is distributed under GPL-3.0; its license is included at [vendor/stockfish/Copying.txt](./vendor/stockfish/Copying.txt). The engine source is available at [github.com/nmrugg/stockfish.js](https://github.com/nmrugg/stockfish.js).

Coach analysis runs locally in the player's browser. Online coach suggestions are submitted as ordinary moves and are still validated as legal by the server.
