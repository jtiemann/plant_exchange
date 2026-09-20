// Tests for the parts of the Jev-backed features that are code rather than
// judgment: who may be paired with whom, how the trades projection accumulates,
// and the substring fallback that runs whenever the API is unavailable.
//
// The judgments themselves are not tested here - they cost a live API call and
// their output is probabilistic. What is pinned down is everything around them,
// which is where a regression would actually be silent.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  EventStore,
  StateProjections,
  EventTypes,
  createEvent,
  createPlant,
  createTrade,
  eligibleCounterparties,
} = require('../server.js');

const judgments = require('../lib/judgments');

const ALICE = 'member-alice';
const BOB = 'member-bob';

const plant = (name, type, memberId, overrides = {}) => ({
  ...createPlant(name, `${name} description`, 'houseplant', memberId, type),
  ...overrides,
});

describe('eligibleCounterparties', () => {
  const offer = plant('Pothos', 'offer', ALICE);

  test('pairs an offer only with wants from other members', () => {
    const catalogue = [
      offer,
      plant('Trailing plant', 'wanted', BOB),
      plant('Something else', 'wanted', ALICE),   // same member
      plant('Monstera', 'offer', BOB),            // same side
    ];

    const eligible = eligibleCounterparties(catalogue, offer);
    expect(eligible.map(p => p.name)).toEqual(['Trailing plant']);
  });

  test('pairs a want only with offers from other members', () => {
    const want = plant('Trailing plant', 'wanted', BOB);
    const catalogue = [want, offer, plant('Fern', 'wanted', ALICE)];

    const eligible = eligibleCounterparties(catalogue, want);
    expect(eligible.map(p => p.name)).toEqual(['Pothos']);
  });

  test('excludes listings that are no longer available', () => {
    const catalogue = [
      offer,
      plant('Taken', 'wanted', BOB, { status: 'traded' }),
      plant('Open', 'wanted', BOB),
    ];

    expect(eligibleCounterparties(catalogue, offer).map(p => p.name)).toEqual(['Open']);
  });

  test('never pairs a listing with itself', () => {
    expect(eligibleCounterparties([offer], offer)).toEqual([]);
  });

  test('returns nothing when only the member\'s own listings exist', () => {
    const catalogue = [offer, plant('Mine too', 'wanted', ALICE)];
    expect(eligibleCounterparties(catalogue, offer)).toEqual([]);
  });
});

describe('substring fallback', () => {
  const catalogue = [
    plant('Golden Pothos', 'offer', ALICE),
    plant('Aloe', 'offer', BOB),
  ];

  test('matches on name', () => {
    expect(judgments.substringSearch(catalogue, 'pothos').map(p => p.name)).toEqual(['Golden Pothos']);
  });

  test('matches on category', () => {
    expect(judgments.substringSearch(catalogue, 'houseplant')).toHaveLength(2);
  });

  test('is case insensitive', () => {
    expect(judgments.substringSearch(catalogue, 'ALOE').map(p => p.name)).toEqual(['Aloe']);
  });

  test('returns nothing rather than guessing', () => {
    expect(judgments.substringSearch(catalogue, 'mountain bike')).toEqual([]);
  });
});

describe('trades projection', () => {
  let storePath;

  beforeEach(() => {
    storePath = path.join(
      os.tmpdir(),
      `plant-exchange-trades-${process.pid}-${Math.random().toString(36).slice(2)}.json`
    );
  });

  afterEach(() => {
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  });

  async function bootWith(events) {
    fs.writeFileSync(storePath, JSON.stringify(events, null, 2));
    const eventStore = new EventStore(storePath);
    await eventStore.initialize();
    return { eventStore, projections: new StateProjections(eventStore) };
  }

  const tradeEvent = (action = 'notify') =>
    createEvent(
      EventTypes.TRADE_INITIATED,
      createTrade('offer-1', 'want-1', ALICE, BOB, action, 2, 1),
      ALICE
    );

  test('rebuilds from history', async () => {
    const { projections } = await bootWith([tradeEvent(), tradeEvent('suggest')]);
    expect(projections.trades$.value.size).toBe(2);
  });

  // Same failure mode the projections test guards: an appended event must add to
  // rebuilt history rather than replace it.
  test('an appended trade adds to history rather than replacing it', async () => {
    const { eventStore, projections } = await bootWith([tradeEvent(), tradeEvent('suggest')]);
    expect(projections.trades$.value.size).toBe(2);

    await eventStore.append(tradeEvent());

    expect(projections.trades$.value.size).toBe(3);
  });

  test('TRADE_COMPLETED settles a trade from history without removing it', async () => {
    const initiated = tradeEvent();
    const { eventStore, projections } = await bootWith([initiated]);

    await eventStore.append(
      createEvent(EventTypes.TRADE_COMPLETED, { tradeId: initiated.payload.id }, ALICE)
    );

    expect(projections.trades$.value.size).toBe(1);
    expect(projections.trades$.value.get(initiated.payload.id).status).toBe('completed');
  });

  test('a completion for an unknown trade is ignored rather than throwing', async () => {
    const { eventStore, projections } = await bootWith([tradeEvent()]);

    await expect(
      eventStore.append(createEvent(EventTypes.TRADE_COMPLETED, { tradeId: 'no-such-trade' }, ALICE))
    ).resolves.toBeDefined();

    expect(projections.trades$.value.size).toBe(1);
  });
});

describe('createTrade', () => {
  test('records both sides, the action, and a proposed status', () => {
    const trade = createTrade('offer-1', 'want-1', ALICE, BOB, 'notify', 1.8, 0.9);

    expect(trade).toMatchObject({
      offerId: 'offer-1',
      wantedId: 'want-1',
      offerMemberId: ALICE,
      wantedMemberId: BOB,
      action: 'notify',
      status: 'proposed',
    });
    expect(trade.id).toBeTruthy();
  });
});
