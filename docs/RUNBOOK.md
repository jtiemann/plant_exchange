# Runbook

Running, configuring, and troubleshooting The Plant Exchange. For how it works internally, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Quick reference

| | |
| --- | --- |
| Start | `npm start` |
| Dev (auto-reload) | `npm run dev` |
| URL | http://localhost:3000 |
| Port | 3000, **hardcoded** |
| Data | `./events.json` |
| Secrets | `./.env` (gitignored) |
| Node | 20 or newer |

## First run

```bash
npm install
cp .env.example .env
```

Then put your key after `TYPESAFE_API_KEY=` in `.env` and start it:

```bash
npm start
```

The key is optional. Without it the app runs fine and search falls back to substring matching.

### Healthy startup

```
◇ injected env (1) from .env
Loaded 8 events from storage
🌱 The Plant Exchange is running on http://localhost:3000
📊 Event Store contains 8 events
👥 Members: 2
🌿 Plants: 2
💬 Messages: 3
```

Check two things: `injected env (1)` means the key was read — `(0)` means it was not. And no `⚠️ TYPESAFE_API_KEY is not set` warning means Jev features are live.

In the browser, the top-right indicator should read **🟢 Connected**. If it does not, SSE failed and nothing will update live.

## Configuration

`TYPESAFE_API_KEY` is **the only environment variable the code reads.** Get one at [console.typesafe.ai](https://console.typesafe.ai).

Everything else is a default parameter in `server.js` and is not configurable without editing code:

| Setting | Value | Location |
| --- | --- | --- |
| Port | 3000 | `async start(port = 3000)` |
| Event store path | `./events.json` | `constructor(filePath = './events.json')` |
| `EXISTS_THRESHOLD` | 0.35 | [server.js:47](../server.js) |
| `RELEVANCE_FLOOR` | 0.15 | [server.js:53](../server.js) |
| `MAX_CHOICE_OPTIONS` | 255 | [server.js:43](../server.js) |
| `SEARCH_CACHE_MAX` | 200 | [server.js:109](../server.js) |

Older versions of the README documented `PORT`, `NODE_ENV`, and `EVENT_STORE_PATH`. **None of those are wired up.** Setting them does nothing.

### Key handling rules

- `.env` is gitignored. Keep it that way — **this repository is public.**
- The key is read only in `server.js` and never sent to the browser. That is why search is server-side.
- Never put the key in `.env.example`, a commit, a log line, or a URL parameter.
- Rotate in the TypeSafe console if it is ever exposed; there is nothing to change in code.

Verify before any commit that touches config:

```bash
git check-ignore -v .env
```

```bash
git diff --cached | grep -cE 'TYPESAFE_API_KEY=[^ #<`]{20,}'
```

The first must print a match. The second must print `0` — it looks for a
key-shaped value after the `=`, not the variable name, which these docs mention
many times legitimately.

## Seeding the catalogue

With the server running, in another terminal:

```bash
npm run seed
```

Posts 52 offer listings across 43 distinct names and all eight categories,
through the HTTP API so each one emits a real `PLANT_OFFERED` event. If the
catalogue has no members it registers two fictional ones first, so this works on
a fresh clone.

It refuses to run when listings already exist, since a second pass would
duplicate them. Override with `npm run seed -- --force`, or empty the store first
(see [Reset to empty](#reset-to-empty)). Point it elsewhere with `SEED_BASE_URL`.

## Running the tests

```bash
npm test
```

Six cases covering the state projections. They are regression tests for a bug
where appending an event discarded all state rebuilt from history, so a failure
here means the live projections have diverged from the event log again.

## Verifying search works

```bash
curl -s --get --data-urlencode "search=aloe vera" http://localhost:3000/api/plants
```

Expected behaviour against the seeded data:

| Query | Expected |
| --- | --- |
| `aloe vera` | Aloe, relevance ~1.00 |
| `something for a dark bathroom` | Aloe, relevance ~0.91 |
| `low light plant` | Aloe, relevance ~0.96 |
| `seedlings ready to plant now` | cannabis, relevance ~1.00 |
| `a used mountain bike` | `[]` |

A `relevance` field on each result means Jev ran. **No `relevance` field means you are getting substring matching** — check the key.

The bike query is the important one. If it returns a plant, the `exists` check is not working and every search will return noise.

## Troubleshooting

### Search returns results but no `relevance` field

Falling back to substring. Either the key is missing or the API call failed. Check startup output for the warning, and the server log for `Semantic search failed (...)`, which names the error class.

### `TYPESAFE_API_KEY is not set` despite a .env file

Confirm the file is named exactly `.env` in the project root and contains `TYPESAFE_API_KEY=` with no quotes and no spaces around the `=`. Check the loader's own output: `injected env (1)` versus `(0)`. Note that `.env` is only read at startup — restart after editing.

### `AuthenticationError` in the log

The key is present but rejected. Verify it in the TypeSafe console. Search keeps working via substring in the meantime.

### Irrelevant listings in results

`RELEVANCE_FLOOR` is too low for your catalogue. Raise it toward 0.25. If genuine matches start disappearing, you have gone too far — see the tuning discussion in [ARCHITECTURE.md](ARCHITECTURE.md#the-two-thresholds).

### Searches that should match return nothing

`EXISTS_THRESHOLD` is too high, or the listings genuinely lack the information. Log `response.answers.exists.noul` in `semanticSearch()` to see the raw value before changing the constant.

### Search feels slow

First call for a query is ~300–700ms. Repeats are ~3ms from cache. If everything is slow, the cache is being missed — the key includes listing IDs, so any change to the catalogue invalidates it by design.

### Results do not include a just-added listing

Known limitation. Search results do not refresh on SSE updates. Retype the query. See [ARCHITECTURE.md](ARCHITECTURE.md#known-limitations).

### Port 3000 already in use

The port is hardcoded, so free it rather than changing it.

Windows (PowerShell):

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

macOS / Linux:

```bash
lsof -ti:3000 | xargs kill -9
```

### Not Connected in the browser

SSE dropped. Reload the page. If it persists, confirm `GET /events` stays open rather than returning immediately, and check for a proxy buffering the response.

### App will not start after a crash

`events.json` may be truncated — the whole file is rewritten on every append, so a crash mid-write can corrupt it. Validate it:

```bash
node -e "JSON.parse(require('fs').readFileSync('events.json','utf8')); console.log('valid')"
```

If invalid, restore from backup or trim the trailing partial entry. There is no repair tooling.

## Data operations

### Back up

```bash
cp events.json "events.backup.$(date +%Y%m%d-%H%M%S).json"
```

`events.json` is the entire database. Nothing else needs backing up.

### Reset to empty

```bash
cp events.json events.backup.json && echo "[]" > events.json
```

Restart afterwards. **This erases every member, listing, and message.**

### Inspect the log

```bash
node -e "const e=require('./events.json'); const c={}; e.forEach(x=>c[x.type]=(c[x.type]||0)+1); console.log(e.length,'events',c)"
```

## Deploying

No deployment exists yet. Before one does, at minimum:

1. **Set the key as a real secret**, not a `.env` file on disk.
2. **Make the port configurable** — `start(process.env.PORT || 3000)` — since most hosts assign it.
3. **Move off the JSON event store.** Full-file rewrites and a local filesystem do not survive multiple instances or ephemeral disks.
4. **Add auth.** Member identity is currently a dropdown; anyone can act as anyone.
5. **Rate-limit `/api/plants`.** Each uncached search costs an API call, so an open search box is a spend vector.

The Dockerfile sketch in the README is a starting point and has never been built or run.

## Cost

Roughly 400 input and 57 output tokens per uncached search of two listings; input scales with catalogue size since every shortlisted listing goes into the state. Cached repeats cost nothing. Point 5 above matters for this reason.
