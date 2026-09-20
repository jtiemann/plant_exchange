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
PlantExchangeService                     <-- commands + queries
   |                       \
   |  append event          \  all four judgments
   v                         \
EventStore                     lib/judgments.js -> api.typesafe.ai
   |  events.json (append-only)
   |
   |  events$ stream
   v
StateProjections (server.js:236)         <-- derived from events$
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
| `TRADE_INITIATED` | `matchNewListing()` | live |
| `TRADE_COMPLETED` | nothing | **declared, never emitted** |

Pairing is live: `matchNewListing()` runs whenever a listing is created and emits `TRADE_INITIATED` for every candidate worth surfacing. `message.tradeId` is populated by [message triage](#message-triage) when a message is about a specific trade. `TRADE_COMPLETED` is still never emitted - nothing yet marks a trade as done, which is the remaining gap in the domain.

### Consequences worth knowing

- **The event log is the database.** Deleting `events.json` resets the app. Backing it up is backing up everything.
- **The whole file is rewritten on every append** (`persist()`, [server.js:215](../server.js)). Fine at this size, a problem in the thousands.
- **Projections are in-memory only.** A restart replays the full log.
- **There is no schema migration.** `getMemberMessages()` ([server.js:500](../server.js)) carries a compatibility shim reading both `toId` and `toIds`, which is what schema drift looks like without migrations.

## Reactive projections

`StateProjections` ([server.js:236](../server.js)) turns the event stream into queryable state. Each projection is an RxJS `scan` over `events$` feeding a `BehaviorSubject`, so every projection holds a current value that new subscribers receive immediately.

State lives in `Map`s keyed by id, rebuilt functionally on each event rather than mutated. Ramda does the transformation work in the query methods.

**Invariant:** each projection derives the next state from its `BehaviorSubject`'s current value, never from a private accumulator. The event stream is a plain `Subject` and does not replay history, so an independently seeded accumulator starts empty, and its first emission would overwrite everything `rebuildFromHistory()` loaded — silently discarding all past state until the next restart, and broadcasting the emptied projection to every connected browser over SSE. That was a real bug, fixed in 4101649; `__tests__/projections.test.js` guards all three projections against its return.

The same `BehaviorSubject`s feed both HTTP responses and the SSE broadcast ([server.js:575](../server.js)), so a browser's live updates and its query results come from one source.

## Real-time delivery

`GET /events` ([server.js:619](../server.js)) holds an SSE connection open per browser. The server subscribes to each projection once and pushes to every client on change. The client's `EventSource` drives the "🟢 Connected" indicator.

SSE rather than WebSockets because traffic is one-directional: commands go over ordinary POSTs, and only state updates flow back.

## Jev judgments

Every call to a System One model lives in [`lib/judgments.js`](../lib/judgments.js).
That module only turns state into typed answers; `server.js` owns the workflow and
every deterministic rule. The split exists so the whole AI surface is readable in
one file and the rules around it stay testable without touching the API.

| Judgment | Primitives | Runs when |
| --- | --- | --- |
| `searchListings` | Choice + Noul | a search query arrives |
| `matchListings` | Score per candidate | a listing is created |
| `classifyListing` | Choice + Noul | the member stops typing a description |
| `triageMessage` | Noul + Score | a message is sent |
| `linkMessageToTrade` | Choice | triage says a message concerns a trade |

All of them degrade the same way: without a key or on an API error the feature
quietly reverts to its pre-Jev behaviour, and nothing a member does is ever lost
because a model call failed.

### Semantic search

The most involved of the five.

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

## Offer and want matching

The feature the domain was shaped for and never had. When a listing is created,
`matchNewListing()` builds the candidate list in code - `eligibleCounterparties()`
keeps only the opposite side, other members, still available - and sends one
request carrying a **Score per candidate**, all over shared state. Twenty
candidates cost barely more than one, because the questions are independent and
run in parallel.

The Score levels are the three things code can do with a pair, so there is no
threshold to fit: the level **is** the action.

| Level | Meaning | What code does |
| --- | --- | --- |
| 0 | not a match | drop it |
| 1 | possible | emit `TRADE_INITIATED` with `action: suggest` |
| 2 | strong | emit `TRADE_INITIATED` with `action: notify` |

Observed on real listings: a want for *"something that dangles down from a high
shelf and tolerates a dim room"* scored Golden Pothos at 2.00 (*"trails two metres
off a shelf... fine in a dim hallway"*), Burros Tail at 0.86, and String of Pearls
at 0.66 - demoted because it *"wants a sunny window"*, contradicting the request.
The other 24 offers scored 0 and never reached the member.

Matching runs **after** the HTTP response, so creating a listing stays fast and a
matching failure can never cost a member their listing. The resulting trades reach
the browser over SSE.

## Category pre-fill and spam

Category was a required dropdown of eight options. A **Choice** over those options
now runs as the member stops typing the description, and a **Noul** rides along in
the same request asking whether the listing is spam at all - one extra question on
state already being sent, so effectively free.

Code, not the model, decides whether to act: the dropdown is pre-filled only above
`CATEGORY_CONFIDENCE`, and never overwrites a choice the member already made. A
wrong guess costs one click.

## Message triage

Two judgments over every outgoing message. A **Noul** for whether it concerns a
trade, and a **Score** for how much it needs a reply. Urgency has to be a Score:
a Noul near 0.5 means "equally likely yes or no", not "medium urgency".

Unread messages are ranked by urgency, falling back to recency for messages that
predate triage. Measured on real messages: *"I need to cancel our trade tomorrow"*
scored 2.00, a general question 1.48, and *"thanks, it worked!"* 0.00.

When the Noul says a message is about a trade, a **second request** asks which one,
as a Choice over that member's open trades plus an explicit none option. It is a
second request rather than another question in the first because the options
depend on the earlier answer. Linking below `LINK_CONFIDENCE` is declined, since
attaching a message to the wrong trade is worse than leaving `tradeId` null.

## Still unbuilt

All four judgments the codebase was shaped for are live. What the domain still
lacks is the other half of a trade:

- **Nothing settles a trade.** `TRADE_COMPLETED` remains declared and never
  emitted. A trade stays `proposed` forever; there is no way for either member to
  accept, decline, or mark one done, so the projection only ever grows.
- **Matches are not acted on.** A `notify` match is surfaced in the UI but nobody
  is actually notified - there is no per-member alert, only the shared panel.
- **`reputation` is always 0.** It is set on every member at registration and
  never changes. Completed trades are the obvious thing to derive it from, once
  trades can complete.
- **Matching is one-directional in practice.** It runs when a listing is created,
  so a listing posted before its counterpart never gets re-matched. A periodic or
  on-demand sweep would fix it.

## Known limitations

- **SSE staleness during search.** A new listing arriving while a search is displayed does not refresh the results until the user retypes. Clearing `state.searchResults` in the SSE handler fixes it but fires an API call on every broadcast, so the trade-off needs a deliberate decision.
- **Thin test coverage.** 20 cases across two files cover the projections and the rules around matching. The judgments themselves are not tested - they cost a live API call and return probabilities. Run with `npm test`.
- **No auth.** Member identity is a dropdown selection. Anyone can act as anyone.
- **Full-file rewrite per event**, as above.
- **The event store path is not configurable** by environment; it is a default parameter resolved against the process working directory. `PORT` now works.
