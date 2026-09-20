# Architecture

How The Plant Exchange is put together, and why. For running and operating it, see [RUNBOOK.md](RUNBOOK.md).

The whole backend is one file, [`server.js`](../server.js), organised into labelled sections. The frontend is one file, [`public/index.html`](../public/index.html), with markup, styles, and a single `PlantExchangeApp` class inline. That is unusual, but it is deliberate and worth preserving until there is a reason to split it: the app is small enough that one file per tier keeps the whole system readable in two sittings.

## The shape of it

```
Browser (public/index.html)
   |
   |  POST /api/*            commands
   |  GET  /api/plants       queries (search -> Jev)
   |  GET  /events           Server-Sent Events stream
   v
Express routes (server.js:617)
   |
   v
PlantExchangeService (server.js:385)     <-- commands + queries
   |                       \
   |  append event          \  searchPlants -> Jev
   v                         \
EventStore (server.js:183)     -> api.typesafe.ai
   |  events.json (append-only)
   |
   |  events$ stream
   v
StateProjections (server.js:236)         <-- RxJS scan over events
   |  members$  plants$  messages$  (BehaviorSubjects)
   |
   +--> HTTP query responses
   +--> SSE broadcast to every connected browser (server.js:606)
```

## Event sourcing

Nothing mutates state directly. Every change is an immutable event appended to [`events.json`](../events.json), and all readable state is derived by replaying those events.

`EventStore` ([server.js:183](../server.js)) owns the log. `append()` pushes onto an in-memory array, persists the whole file, and emits on an RxJS `Subject`. `initialize()` loads the file at boot; `rebuildFromHistory()` ([server.js:313](../server.js)) replays it into the projections.

The event types are declared in `EventTypes` ([server.js:126](../server.js)):

| Event | Emitted by | Status |
| --- | --- | --- |
| `MEMBER_REGISTERED` | `registerMember()` | live |
| `PLANT_OFFERED` | `offerPlant()` | live |
| `PLANT_WANTED` | `requestPlant()` | live |
| `PLANT_REMOVED` | `removePlant()` | live |
| `MESSAGE_SENT` | `sendMessage()` | live |
| `MESSAGE_READ` | `markMessageAsRead()` | live |
| `TRADE_INITIATED` | nothing | **declared, never emitted** |
| `TRADE_COMPLETED` | nothing | **declared, never emitted** |

The two trade events are the gap in the domain. The app is described as a trading platform, but no code pairs an offer with a want or records that a trade happened. `message.tradeId` ([server.js:169](../server.js)) exists for the same unbuilt feature and is always `null`. See [Planned Jev work](#planned-jev-work).

### Consequences worth knowing

- **The event log is the database.** Deleting `events.json` resets the app. Backing it up is backing up everything.
- **The whole file is rewritten on every append** (`persist()`, [server.js:215](../server.js)). Fine at this size, a problem in the thousands.
- **Projections are in-memory only.** A restart replays the full log.
- **There is no schema migration.** `getMemberMessages()` ([server.js:500](../server.js)) carries a compatibility shim reading both `toId` and `toIds`, which is what schema drift looks like without migrations.

## Reactive projections

`StateProjections` ([server.js:236](../server.js)) turns the event stream into queryable state. Each projection is an RxJS `scan` over `events$` feeding a `BehaviorSubject`, so every projection holds a current value that new subscribers receive immediately.

State lives in `Map`s keyed by id, rebuilt functionally on each event rather than mutated. Ramda does the transformation work in the query methods.

The same `BehaviorSubject`s feed both HTTP responses and the SSE broadcast ([server.js:575](../server.js)), so a browser's live updates and its query results come from one source.

## Real-time delivery

`GET /events` ([server.js:619](../server.js)) holds an SSE connection open per browser. The server subscribes to each projection once and pushes to every client on change. The client's `EventSource` drives the "🟢 Connected" indicator.

SSE rather than WebSockets because traffic is one-directional: commands go over ordinary POSTs, and only state updates flow back.

## Semantic search

The most involved part of the system, and the only place an AI model is in the loop.

### The problem

Search was substring matching over name and description. `"aloe vera"` returned nothing for a listing named `Aloe`. `"something for a dark bathroom"` returned nothing for anything. The old client-side filter and server-side filter also checked different fields, so they could disagree.

### The design

Search is a **TypeSafe System One** call against **Jev**, which returns typed judgments and probabilities rather than generated text. Code owns the workflow; the model supplies only the semantic judgment.

One request per query carries **two questions over the same state** ([server.js:76](../server.js)):

1. **A `Choice` over listing IDs** — "Which listing best matches *<query>*?" Its probability distribution is the relevance score for every listing at once.
2. **A `Noul`** — "Does any listing plausibly match *<query>*?" A single probability that the catalogue answers the query at all.

Both questions see identical state and are evaluated in parallel, so the second is nearly free.

**Why both are necessary.** Choice probabilities always sum to 1, so *something* always ranks first even when nothing is relevant. Searching `"a used mountain bike"` still ranks a plant at 0.66 confidence. The Noul is independent of the options and collapses to 0.02, which is what actually suppresses the result. Neither question alone gives a usable search.

### Pipeline

```
criteria
   |
   v
Ramda filters type + category, sorts newest-first      <-- code owns deterministic rules
   |
   +-- no search term?  -> return shortlist
   +-- no API key?      -> substringSearch()
   +-- cache hit?       -> cached results
   |
   v
shortlist capped at 255 (Choice option limit)
   |
   v
one Jev request: Choice(listing ids) + Noul(exists)
   |
   +-- exists < 0.35  -> []
   |
   v
sort by probability, drop below 15% of the top hit
   |
   v
results, each carrying `relevance`
```

Hard filters run **before** the call, so the model only ever sees the shortlist. That keeps cost proportional to what is actually searchable and keeps deterministic rules in code where they belong.

### The two thresholds

Both are constants at [server.js:47-53](../server.js) and both were tuned against real data, not guessed.

**`EXISTS_THRESHOLD = 0.35`** — below this the catalogue is treated as having no answer. Measured separation was wide: irrelevant queries scored ~0.02, genuine matches 0.89–0.96.

**`RELEVANCE_FLOOR = 0.15`** — keep listings scoring at least 15% of the top hit. This one is subtle, and the first value chosen (0.01) was wrong.

Choice probabilities are *competitive*: they answer "which one is best", not "which are relevant". So the distribution shape differs by case:

| Situation | Distribution | Needed behaviour |
| --- | --- | --- |
| Two equally good matches | ~0.55 / 0.45 | keep both |
| One good, one irrelevant | ~0.91 / 0.09 | keep the first only |

A floor relative to the top hit handles both. At 0.15: the 0.45 tie survives, the 0.09 tail is cut. At 0.01 nothing is ever cut — which is exactly the bug that shipped first and showed up as `"dark bathroom"` returning a cannabis listing.

An absolute floor, or one relative to uniform (`1/N`), fails the tie case at small N. Re-tune by raising the floor if junk appears and lowering it if real matches get cut.

### Failure behaviour

Search degrades rather than breaking:

| Condition | Behaviour |
| --- | --- |
| No API key | `substringSearch()`, warning logged at startup |
| API error or timeout | error class + message logged, falls back to substring for that query |
| `exists` below threshold | empty result set, which is the correct answer |
| More than 255 listings | newest 255 ranked; two-pass window search is the fix |

### Caching

A bounded `Map` ([server.js:109](../server.js)) keyed on query plus the shortlist's listing IDs, so it invalidates automatically whenever the catalogue changes. Measured 697ms cold, 3ms warm. Oldest entry evicted at 200. In-memory, so a restart clears it.

### Why search is server-side

The API key must not reach the browser. That single constraint forced the client filter to be removed and `/api/plants?search=` to become the only search path. The client keeps substring matching purely as the instant pass while ranked results are in flight — 350ms debounce, plus a sequence counter so a slow response cannot overwrite a newer search.

## Planned Jev work

Search is the first of four judgments the codebase is shaped for. In rough order of value:

1. **Offer ↔ want matching.** The missing domain feature. Code generates candidate pairs, excluding same-member ones; one request carries a `Score` per open want, all over shared state. Make the Score's levels the three things code can do — ignore, suggest, notify both members — so there is no threshold to fit. A top-level result is what would finally emit `TRADE_INITIATED`.
2. **Category pre-fill.** `category` is a required dropdown and "cannabis" is currently filed under `other`. A `Choice` over the eight categories at submit time, gated on confidence: pre-select when confident, leave blank when not. A wrong guess costs one click.
3. **Message triage.** A `Noul` for "does this message propose, accept, or decline a trade?" populates the dead `tradeId` field; a `Score` on reply-urgency ranks notifications by substance instead of recency.
4. **Listing quality.** A spam/non-plant `Noul` riding along in the category request — same state, one extra question, effectively free.

## Known limitations

- **SSE staleness during search.** A new listing arriving while a search is displayed does not refresh the results until the user retypes. Clearing `state.searchResults` in the SSE handler fixes it but fires an API call on every broadcast, so the trade-off needs a deliberate decision.
- **No tests.** `jest` is a dependency and `npm test` is wired, but no test files exist.
- **No auth.** Member identity is a dropdown selection. Anyone can act as anyone.
- **Full-file rewrite per event**, as above.
- **Port and event store path are not configurable** by environment despite what older docs claimed. Both are default parameters in `server.js`.
