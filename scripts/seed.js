#!/usr/bin/env node
// Seeds the catalogue with a realistic set of plant listings.
//
//   npm start            # in another terminal - the server must be running
//   npm run seed
//   npm run seed -- --force     # seed again even if listings already exist
//
// Posts through the HTTP API rather than writing events.json directly, so every
// listing goes through the normal command path and emits a real PLANT_OFFERED
// event. Posts sequentially: EventStore.append() rewrites the whole file, so
// concurrent requests risk interleaved writes.
//
// Descriptions deliberately avoid restating each plant's own name where it reads
// naturally, so semantic search is exercised on meaning rather than keyword
// overlap. See docs/ARCHITECTURE.md#semantic-search.

const BASE = process.env.SEED_BASE_URL || 'http://localhost:3000';
const FORCE = process.argv.includes('--force');

// Fictional. Never commit real member details - this repository is public.
// Only used when the catalogue has no members yet.
const SEED_MEMBERS = [
  ['Avery Fern', 'avery.fern@example.invalid', 'Portland, OR', 'Propagates far more than she can keep.'],
  ['Kit Marlow', 'kit.marlow@example.invalid', 'Bristol, UK', 'Allotment grower, heavy on the herbs.'],
];
const PLANTS = [
  ['Monstera Deliciosa', 'houseplant', 'Four years old with deep splits in every leaf. Needs a moss pole and a bright corner.'],
  ['Golden Pothos', 'houseplant', 'Trails about two metres off a shelf. Nearly impossible to kill, fine in a dim hallway.'],
  ['Snake Plant', 'houseplant', 'Upright and architectural. Tolerates being forgotten for a month at a time.'],
  ['ZZ Plant', 'houseplant', 'Glossy dark leaves, stores water in the rhizome. Good for a north-facing room.'],
  ['Fiddle Leaf Fig', 'houseplant', 'About 1.5m tall. Dramatic but sulks if you move it around.'],
  ['Rubber Plant', 'houseplant', 'Burgundy foliage, thick waxy leaves. Growing faster than my ceiling allows.'],
  ['Spider Plant', 'houseplant', 'Covered in babies I keep having to remove. Takes any light, any neglect.'],
  ['Peace Lily', 'houseplant', 'Droops theatrically when thirsty, recovers within the hour. Flowers twice a year.'],
  ['Philodendron Brasil', 'houseplant', 'Variegated heart-shaped leaves on long vines. Very forgiving.'],
  ['Chinese Money Plant', 'houseplant', 'Round flat leaves on thin stems. Constantly throwing off pups.'],
  ['Calathea Orbifolia', 'houseplant', 'Silver-striped leaves that fold up at night. Wants humidity and filtered light.'],
  ['Bird of Paradise', 'houseplant', 'Large paddle leaves, needs a bright spot and plenty of room.'],
  ['Golden Pothos', 'houseplant', 'Rooted cuttings in water, ready to pot. Great starter for someone new to this.'],
  ['Snake Plant', 'houseplant', 'Compact variety, about 30cm. Thrives on being ignored in a bathroom.'],
  ['Monstera Deliciosa', 'houseplant', 'Small rooted cutting with two leaves. Will take a few years to get dramatic.'],

  ['Jade Plant', 'succulent', 'Thick woody trunk, about eight years old. Stores water in fleshy leaves.'],
  ['Echeveria', 'succulent', 'Tight blue-grey rosette that blushes pink in strong sun.'],
  ['String of Pearls', 'succulent', 'Cascading strands of bead-like leaves. Wants a sunny window and very little water.'],
  ['Aloe Vera', 'succulent', 'Medicinal variety, good for burns. Plenty of offsets around the base.'],
  ['Haworthia', 'succulent', 'Small translucent-tipped rosette. Handles lower light than most in this family.'],
  ['Christmas Cactus', 'succulent', 'Blooms reliably every December. Segmented trailing stems.'],
  ['Burros Tail', 'succulent', 'Heavy trailing stems packed with plump leaves. Handle gently, they drop easily.'],
  ['Echeveria', 'succulent', 'Several rooted offsets from the mother plant. Full sun, gritty soil.'],
  ['Jade Plant', 'succulent', 'Young cutting, already branching. Grows into a small tree over time.'],

  ['Basil', 'herb', 'Genovese type, grown from seed this spring. Pinch the tops and it bushes out.'],
  ['Rosemary', 'herb', 'Woody and established, survives frost outdoors here. Cuttings root easily.'],
  ['Mint', 'herb', 'Spreads aggressively, keep it in a pot or it takes the whole bed.'],
  ['Thyme', 'herb', 'Creeping variety, good between paving stones. Drought tolerant once established.'],
  ['Lemon Balm', 'herb', 'Citrus-scented leaves, makes a calming tea. Self-seeds everywhere.'],
  ['Sage', 'herb', 'Soft grey-green leaves. Perennial here, comes back stronger every year.'],
  ['Chives', 'herb', 'Clumping, with purple edible flowers in spring. Divide and share.'],
  ['Basil', 'herb', 'Thai variety, purple stems and an aniseed note. Needs warmth.'],
  ['Mint', 'herb', 'Chocolate mint, rooted runners ready to go. Same warning about spreading.'],

  ['Cherry Tomato', 'vegetable', 'Sungold seedlings, absurdly sweet. Needs staking and full sun.'],
  ['Padron Pepper', 'vegetable', 'Most are mild, roughly one in ten is not. Prolific in a warm spot.'],
  ['Rainbow Chard', 'vegetable', 'Stems in pink, yellow and orange. Cut and it keeps producing all season.'],
  ['Sugar Snap Pea', 'vegetable', 'Climbing variety, needs a trellis. Eat the whole pod raw.'],
  ['Courgette', 'vegetable', 'One plant will feed a street. You have been warned.'],
  ['Rocket', 'vegetable', 'Peppery salad leaf, ready in four weeks. Bolts in high summer.'],
  ['Cherry Tomato', 'vegetable', 'Black Cherry variety, deep purple fruit. Seedlings in small pots.'],

  ['Lavender', 'flower', 'English type, strongly scented. Bees cover it from June onwards.'],
  ['Dahlia', 'flower', 'Tubers of a deep red decorative form. Lift before the first hard frost.'],
  ['Cosmos', 'flower', 'Self-seeding annual, tall and airy. Flowers until the frost takes it.'],
  ['Sweet Pea', 'flower', 'Old-fashioned scented mix. Cut often and it keeps flowering.'],
  ['Lavender', 'flower', 'Rooted cuttings from a mature plant. Wants gritty soil and full sun.'],

  ['Japanese Maple', 'tree', 'Young grafted specimen, fine cut leaves turning scarlet in autumn.'],
  ['Olive Tree', 'tree', 'In a large pot, needs shelter over winter here. Silver foliage year round.'],
  ['Fig Tree', 'tree', 'Brown Turkey, fruits reliably against a south wall. Rooted sucker.'],

  ['Hydrangea', 'shrub', 'Mophead type, flower colour shifts with soil acidity. Large rooted cutting.'],
  ['Elderberry', 'shrub', 'Flowers for cordial in June, berries in September. Grows fast.'],

  ['Venus Flytrap', 'other', 'Bog plant, needs rainwater only and a cold winter rest. Catches its own food.'],
  ['Air Plant', 'other', 'No soil at all. Mist twice a week and mount it wherever you like.'],
];

async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) throw new Error((options.method || 'GET') + ' ' + path + ' -> HTTP ' + res.status);
  return res.json();
}

// Listings need a member to belong to. A fresh event store has none, so create
// them; an existing one keeps whoever is already registered.
async function ensureMembers() {
  const existing = await api('/api/members');
  if (existing.length) return existing;

  console.log('No members registered. Creating ' + SEED_MEMBERS.length + ' seed members.');
  for (const [name, email, location, bio] of SEED_MEMBERS) {
    await api('/api/members', { method: 'POST', body: { name, email, location, bio } });
  }
  return api('/api/members');
}

(async () => {
  let plants;
  try {
    plants = await api('/api/plants');
  } catch (error) {
    console.error('Cannot reach the server at ' + BASE + '. Start it with `npm start` first.');
    process.exit(1);
  }

  if (plants.length && !FORCE) {
    console.error('The catalogue already holds ' + plants.length + ' listing(s).');
    console.error('Seeding again would duplicate them. Re-run with --force to do it anyway,');
    console.error('or reset the event store first (see docs/RUNBOOK.md#reset-to-empty).');
    process.exit(1);
  }

  const members = await ensureMembers();
  console.log('Seeding ' + PLANTS.length + ' listings across ' + members.length + ' member(s)...');

  let posted = 0;
  const failures = [];
  for (let i = 0; i < PLANTS.length; i++) {
    const [name, category, description] = PLANTS[i];
    try {
      await api('/api/plants/offer', {
        method: 'POST',
        body: { memberId: members[i % members.length].id, name, category, description },
      });
      posted++;
    } catch (error) {
      failures.push(name + ': ' + error.message);
    }
  }

  const names = new Set(PLANTS.map(p => p[0]));
  const categories = {};
  PLANTS.forEach(p => { categories[p[1]] = (categories[p[1]] || 0) + 1; });

  console.log('');
  console.log('  posted         : ' + posted + '/' + PLANTS.length);
  console.log('  distinct names : ' + names.size);
  console.log('  by category    : ' + JSON.stringify(categories));

  if (failures.length) {
    console.error('');
    console.error('  FAILURES:');
    failures.forEach(f => console.error('    ' + f));
    process.exit(1);
  }

  console.log('');
  console.log('Done. Try a search that keyword matching would miss:');
  console.log('  curl -s --get --data-urlencode "search=carnivorous plant" ' + BASE + '/api/plants');
})();
