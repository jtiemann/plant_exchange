// Regression tests for StateProjections.
//
// The bug these guard against: setupProjections() used scan() with its own
// accumulator seeded to an empty Map. Because events$ is a plain Subject and
// does not replay history, that accumulator stayed empty while
// rebuildFromHistory() populated the BehaviorSubject directly. The first
// appended event then emitted an accumulator holding only that event, wiping
// every historical record from the live projection until the next restart.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  EventStore,
  StateProjections,
  EventTypes,
  createEvent,
  createMember,
  createPlant,
  createMessage,
} = require('../server.js');

const MEMBER_A = 'member-aaaa';
const MEMBER_B = 'member-bbbb';

let storePath;

beforeEach(() => {
  storePath = path.join(
    os.tmpdir(),
    `plant-exchange-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`
  );
});

afterEach(() => {
  if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
});

// Writes `events` as the on-disk history, then returns a store and projections
// already rebuilt from it — the state of a freshly booted server.
async function bootWith(events) {
  fs.writeFileSync(storePath, JSON.stringify(events, null, 2));
  const eventStore = new EventStore(storePath);
  await eventStore.initialize();
  const projections = new StateProjections(eventStore);
  return { eventStore, projections };
}

const offer = (name, category, memberId) =>
  createEvent(
    EventTypes.PLANT_OFFERED,
    createPlant(name, `${name} description`, category, memberId, 'offer'),
    memberId
  );

describe('plants projection', () => {
  test('an appended event adds to history rather than replacing it', async () => {
    const history = [
      offer('Aloe', 'succulent', MEMBER_A),
      offer('Golden Pothos', 'houseplant', MEMBER_B),
    ];
    const { eventStore, projections } = await bootWith(history);

    expect(projections.plants$.value.size).toBe(2);

    await eventStore.append(offer('Basil', 'herb', MEMBER_A));

    // Before the fix this was 1: the scan accumulator started empty and its
    // first emission replaced the two rebuilt listings.
    expect(projections.plants$.value.size).toBe(3);

    const names = [...projections.plants$.value.values()].map(p => p.name).sort();
    expect(names).toEqual(['Aloe', 'Basil', 'Golden Pothos']);
  });

  test('historical listings survive many appends', async () => {
    const { eventStore, projections } = await bootWith([offer('Aloe', 'succulent', MEMBER_A)]);

    for (let i = 0; i < 10; i++) {
      await eventStore.append(offer(`Plant ${i}`, 'houseplant', MEMBER_B));
    }

    expect(projections.plants$.value.size).toBe(11);
    const names = [...projections.plants$.value.values()].map(p => p.name);
    expect(names).toContain('Aloe');
  });

  test('PLANT_REMOVED deletes a listing that came from history', async () => {
    const historical = offer('Aloe', 'succulent', MEMBER_A);
    const { eventStore, projections } = await bootWith([historical, offer('Mint', 'herb', MEMBER_B)]);

    expect(projections.plants$.value.size).toBe(2);

    await eventStore.append(
      createEvent(EventTypes.PLANT_REMOVED, { plantId: historical.payload.id }, MEMBER_A)
    );

    expect(projections.plants$.value.size).toBe(1);
    expect(projections.plants$.value.has(historical.payload.id)).toBe(false);
  });
});

describe('members projection', () => {
  test('an appended registration preserves existing members', async () => {
    const existing = createEvent(
      EventTypes.MEMBER_REGISTERED,
      createMember('Existing Member', 'existing@example.com', 'Somewhere'),
      MEMBER_A
    );
    const { eventStore, projections } = await bootWith([existing]);

    expect(projections.members$.value.size).toBe(1);

    await eventStore.append(
      createEvent(
        EventTypes.MEMBER_REGISTERED,
        createMember('New Member', 'new@example.com', 'Elsewhere'),
        MEMBER_B
      )
    );

    expect(projections.members$.value.size).toBe(2);
  });
});

describe('messages projection', () => {
  test('an appended message preserves existing messages', async () => {
    const existing = createEvent(
      EventTypes.MESSAGE_SENT,
      createMessage(MEMBER_A, [MEMBER_B], 'first'),
      MEMBER_A
    );
    const { eventStore, projections } = await bootWith([existing]);

    expect(projections.messages$.value.size).toBe(1);

    await eventStore.append(
      createEvent(EventTypes.MESSAGE_SENT, createMessage(MEMBER_B, [MEMBER_A], 'second'), MEMBER_B)
    );

    expect(projections.messages$.value.size).toBe(2);
  });

  test('MESSAGE_READ marks a message that came from history', async () => {
    const historical = createEvent(
      EventTypes.MESSAGE_SENT,
      createMessage(MEMBER_A, [MEMBER_B], 'read me'),
      MEMBER_A
    );
    const { eventStore, projections } = await bootWith([historical]);

    await eventStore.append(
      createEvent(
        EventTypes.MESSAGE_READ,
        { messageId: historical.payload.id, memberId: MEMBER_B },
        MEMBER_B
      )
    );

    // The message must still exist, and carry the reader.
    expect(projections.messages$.value.size).toBe(1);
    expect(projections.messages$.value.get(historical.payload.id).readBy).toContain(MEMBER_B);
  });
});
