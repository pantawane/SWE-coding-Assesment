# Switchboard

Switchboard is a shared inbox for the mock Pigeon messaging provider. Sign in with a test user to see incoming messages, claim conversations, reply, close and reopen threads, and share encrypted private notes.

## Run from a clean clone

You need Node.js 22, npm, and Docker with Compose. Run from the repository root.

```sh
npm run up
npm run scaffold:install
npm run doctor
```

Start the backend and web app in separate terminals.

```sh
npm run scaffold:server
npm run scaffold:web
```

Open [http://localhost:5173](http://localhost:5173) and sign in. Pick Asha or Ben for Acme, Chloe or Dev for Globex, or Eli to switch between both. Pigeon normally sends sample traffic automatically. Run `npm run inbound` to generate a message immediately or `npm run drizzle` to resume automatic traffic after a checker run. All providers and credentials in this setup are local simulations.

Defaults match `.env.example`, so you can run without an `.env` file. Copy the example to `.env` to change settings. If you change the frontend origin or app port, also adjust the Vite proxy and the mock IdP's registered callback as applicable.

## Run the checker

Stop the app server first. The checker starts its own processes and deletes application data in the MongoDB database it uses. Use only a disposable database. The level 4 checks are run by the assessors.

```sh
npm run check
npm run check -- --levels 5
npm run check:full
```

The full run writes `CHECK_REPORT.json`. It uses POSIX subprocess and process-group behavior. From Windows PowerShell, run it in an isolated Linux container after `npm run up`. The command below assumes the Compose project is named `starter`. Use your project's network name if it differs. This container runs fresh simulator processes and uses a separate MongoDB database.

```powershell
docker run --rm --network starter_default -v "${PWD}:/work" -v /work/scaffold/server/node_modules -w /work -e MONGO_URL=mongodb://mongo:27017/switchboard_check -e REDIS_URL=redis://redis:6379 node:22-alpine sh -c 'npm --prefix scaffold/server ci && (node harness/run-mocks.js & sleep 2; npm run check:full)'
```

Run `npm run down` when you are finished with the local services.

## Private notes

Open **Private notes** in a conversation. Generate a workspace key once and distribute it to workspace members on a trusted channel. Members paste the same key to unlock notes in the thread. Store a copy of the key in an appropriate shared password manager. See [PROTOCOL.md](PROTOCOL.md).
