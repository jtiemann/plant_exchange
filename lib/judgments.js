// =============================================================================
// JEV JUDGMENTS
// =============================================================================
//
// Every call to a System One model lives here. server.js owns the workflow and
// all deterministic rules; this module only turns state into typed judgments.
//
// Four judgments, each documented with the primitive it uses and why:
//
//   searchListings   Choice + Noul   rank listings against a plain-language query
//   matchListings    Score           pair a new listing against the opposite side
//   classifyListing  Choice + Noul   category at submit time, plus a spam check
//   triageMessage    Noul + Score    is this about a trade, and how urgent
//
// Each function returns plain data. Thresholds that turn a probability into an
// action are constants here, but the decision to act on them stays in server.js.

const { TypeSafeClient, choice, noul, score } = require('@typesafe-ai/sdk');

// A Choice question accepts at most 255 options.
const MAX_CHOICE_OPTIONS = 255;

// --- search -----------------------------------------------------------------
// Tuned against real listings: irrelevant queries scored ~0.02, good matches
// 0.89-0.96. Re-tune as the catalogue grows.
const EXISTS_THRESHOLD = 0.35;

// Choice probabilities are competitive - they answer "which one is best", not
// "which are relevant". Two equally good matches split ~0.55/0.45, while a
// good-vs-irrelevant pair goes ~0.91/0.09. A floor relative to the top hit keeps
// both halves of a genuine tie and still drops the tail.
const RELEVANCE_FLOOR = 0.15;

// --- classification ---------------------------------------------------------
// Below this the category guess is not confident enough to pre-select for the
// member; the dropdown is left blank instead.
const CATEGORY_CONFIDENCE = 0.6;
const SPAM_THRESHOLD = 0.7;

// --- triage -----------------------------------------------------------------
const TRADE_MESSAGE_THRESHOLD = 0.6;

// Below this the message could be about either of several trades, and linking
// the wrong one is worse than leaving tradeId null.
const LINK_CONFIDENCE = 0.5;

const PLANT_CATEGORIES = [
  'houseplant', 'succulent', 'herb', 'vegetable',
  'flower', 'tree', 'shrub', 'other',
];

// Score levels are the three things code can do with a candidate pair, so
// there is no separate threshold to fit: the level IS the action.
const MATCH_ACTIONS = ['ignore', 'suggest', 'notify'];

let client = null;
const getClient = apiKey => {
  if (!client) client = new TypeSafeClient({ apiKey });
  return client;
};

// Exposed for tests, which need each case to start from a clean client.
const resetClient = () => { client = null; };

const describe = plant =>
  `${plant.name} (${plant.category}): ${plant.description}`;

// --- 1. search --------------------------------------------------------------

const substringSearch = (plants, query) => {
  const text = query.toLowerCase();
  return plants.filter(plant =>
    plant.name.toLowerCase().includes(text) ||
    plant.description.toLowerCase().includes(text) ||
    plant.category.toLowerCase().includes(text)
  );
};

// One request answers both questions over the same state. The Choice ranks every
// listing; the Noul says whether anything matches at all. Choice probabilities
// always sum to 1, so without the Noul a search for "mountain bike" would still
// return whichever plant is least irrelevant.
const searchListings = async (apiKey, plants, query) => {
  const shortlist = plants.slice(0, MAX_CHOICE_OPTIONS);
  const ids = shortlist.map((_, i) => `P${String(i).padStart(3, '0')}`);
  const state = shortlist
    .map((plant, i) => `${ids[i]}| ${plant.name} (${plant.category}, ${plant.type}): ${plant.description}`)
    .join('\n');

  const response = await getClient(apiKey).systemOne({
    state,
    questions: {
      where: choice(`Which listing best matches: "${query}"?`,
        Object.fromEntries(ids.map(id => [id, null]))),
      exists: noul(`Does any listing plausibly match: "${query}"?`, {
        true: 'At least one listing is a plausible match for what the searcher wants',
        false: 'No listing is relevant to this search',
      }),
    },
  });

  if (response.answers.exists.noul < EXISTS_THRESHOLD) return [];

  const probabilities = response.answers.where.probabilities;
  const ranked = shortlist
    .map((plant, i) => ({ ...plant, relevance: probabilities[ids[i]] || 0 }))
    .sort((a, b) => b.relevance - a.relevance);

  const best = ranked.length ? ranked[0].relevance : 0;
  return ranked.filter(plant => plant.relevance >= best * RELEVANCE_FLOOR);
};

// --- 2. offer <-> want matching ---------------------------------------------

// Judges one new listing against every candidate on the opposite side. The
// caller supplies candidates already filtered (opposite type, different member),
// because who may trade with whom is a rule, not a judgment.
//
// All candidates share one request: the questions are independent, see the same
// state, and run in parallel, so asking about twenty candidates costs barely
// more than asking about one.
const matchListings = async (apiKey, listing, candidates) => {
  if (!candidates.length) return [];

  const shortlist = candidates.slice(0, MAX_CHOICE_OPTIONS);
  const ids = shortlist.map((_, i) => `C${String(i).padStart(3, '0')}`);

  const offered = listing.type === 'offer' ? listing : null;
  const state = {
    new_listing: {
      direction: listing.type === 'offer' ? 'a member is offering this plant' : 'a member is looking for this plant',
      detail: describe(listing),
    },
    candidates: Object.fromEntries(shortlist.map((c, i) => [ids[i], {
      direction: c.type === 'offer' ? 'this member is offering' : 'this member is looking for',
      detail: describe(c),
    }])),
  };

  const questions = Object.fromEntries(shortlist.map((_, i) => [ids[i],
    score(
      `Considering \`new_listing\` against \`candidates.${ids[i]}\`, how well do these two members' needs meet? One is offering a plant and the other is looking for one.`,
      [
        'Not a match: this is not the plant the other member is after, and nothing suggests they would want it',
        'Possible match: related or plausibly interesting, worth showing as a suggestion to browse',
        'Strong match: this is clearly the plant the other member asked for, worth notifying both of them',
      ]
    ),
  ]));

  const response = await getClient(apiKey).systemOne({ state, questions });

  return shortlist.map((candidate, i) => {
    const answer = response.answers[ids[i]];
    // The level IS the action, so round to it rather than fitting a threshold.
    const level = Math.max(0, Math.min(2, Math.round(answer.score)));
    return {
      candidate,
      action: MATCH_ACTIONS[level],
      score: answer.score,
      confidence: answer.confidence,
      offerId: offered ? listing.id : candidate.id,
      wantedId: offered ? candidate.id : listing.id,
    };
  }).filter(match => match.action !== 'ignore')
    .sort((a, b) => b.score - a.score);
};

// --- 3. category pre-fill, 4. listing quality -------------------------------

// Both questions ride in one request over the same state. The spam check is one
// extra question on state that is already being sent, so it is nearly free.
const classifyListing = async (apiKey, name, description) => {
  const response = await getClient(apiKey).systemOne({
    state: { listing: { name, description } },
    questions: {
      category: choice('Which category does `listing` belong to?',
        Object.fromEntries(PLANT_CATEGORIES.map(c => [c, null]))),
      spam: noul('Is `listing` spam, an advert, or not a real plant listing at all?', {
        true: 'This is spam, an advert for something else, or not about a plant',
        false: 'This is a genuine listing for a plant',
      }),
    },
  });

  const { choice: category, confidence } = response.answers.category;
  const spam = response.answers.spam.noul;

  return {
    category,
    confidence,
    // Code, not the model, decides whether the guess is good enough to pre-fill.
    suggest: confidence >= CATEGORY_CONFIDENCE,
    spam,
    likelySpam: spam >= SPAM_THRESHOLD,
  };
};

// --- 5. message triage ------------------------------------------------------

// Two independent judgments over one message. Noul for the yes/no (is this about
// a trade), Score for the spectrum (how much it needs a reply) - a Noul near 0.5
// would mean "equally likely yes or no", not "medium urgency", which is why
// urgency cannot be a Noul.
const triageMessage = async (apiKey, content, context = {}) => {
  const response = await getClient(apiKey).systemOne({
    state: { message: content, ...context },
    questions: {
      // The criteria define the answer, so they must cover every case the
      // instructions name. An earlier version asked about proposing but only
      // described arranging, and opening offers landed at ~0.5.
      trade: noul('Does `message` propose, accept, decline, or arrange a plant trade?', {
        true: 'The message proposes a trade, responds to one, or works out the details of a specific swap - including a first approach about a particular plant',
        false: 'The message is general conversation, a plant care question, or otherwise not about swapping a specific plant',
      }),
      urgency: score('How much does `message` need a reply from the recipient?', [
        'No reply needed: a remark, a thank-you, or a closing note',
        'Reply expected eventually: a general question or an opening to keep talking',
        'Reply needed soon: a direct question, a time-bound offer, or a pending arrangement',
      ]),
    },
  });

  return {
    tradeRelated: response.answers.trade.noul,
    isTradeMessage: response.answers.trade.noul >= TRADE_MESSAGE_THRESHOLD,
    urgency: response.answers.urgency.score,
    urgencyConfidence: response.answers.urgency.confidence,
  };
};

// Which open trade is this message about? Only worth asking once a Noul has
// said the message concerns a trade at all, and only when the member has open
// trades - the options depend on that answer, which is why this is a second
// request rather than another question in the first.
//
// Choice probabilities sum to 1, so a message about none of these would still
// pick one. The explicit none option is what lets code decline to link.
const NO_TRADE = 'none_of_these';

const linkMessageToTrade = async (apiKey, content, trades) => {
  if (!trades.length) return null;

  const shortlist = trades.slice(0, MAX_CHOICE_OPTIONS - 1);
  const options = Object.fromEntries(shortlist.map(t => [
    t.id,
    `${t.offerName} offered in exchange for a request for ${t.wantedName}`,
  ]));
  options[NO_TRADE] = 'The message does not concern any of these trades';

  const response = await getClient(apiKey).systemOne({
    state: { message: content },
    questions: {
      trade: choice('Which of these pending trades is `message` about?', options),
    },
  });

  const { choice: picked, confidence } = response.answers.trade;
  if (picked === NO_TRADE) return null;
  // A split distribution means it could be either trade; linking the wrong one
  // is worse than leaving it unlinked.
  if (confidence < LINK_CONFIDENCE) return null;
  return { tradeId: picked, confidence };
};

module.exports = {
  searchListings,
  linkMessageToTrade,
  substringSearch,
  matchListings,
  classifyListing,
  triageMessage,
  resetClient,
  PLANT_CATEGORIES,
  MATCH_ACTIONS,
  MAX_CHOICE_OPTIONS,
  EXISTS_THRESHOLD,
  RELEVANCE_FLOOR,
  CATEGORY_CONFIDENCE,
  SPAM_THRESHOLD,
  TRADE_MESSAGE_THRESHOLD,
  LINK_CONFIDENCE,
};
