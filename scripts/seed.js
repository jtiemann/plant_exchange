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

// Photo for each plant, from Wikimedia via the Wikipedia API. Keyed by name so
// duplicate listings of the same plant share one image, and a name with no
// entry simply falls back to the generated placeholder the card draws anyway.
//
// These are hotlinked. Fine for a local demo; a deployment should mirror them.
const IMAGES = {
  "Monstera Deliciosa": "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2e/Monstera_deliciosa2.jpg/500px-Monstera_deliciosa2.jpg",
  "Golden Pothos": "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/62/Money_Plant_%28Epipremnum_aureum%29_4.jpg/500px-Money_Plant_%28Epipremnum_aureum%29_4.jpg",
  "Snake Plant": "https://thumb.wikimedia.org/wikipedia/commons/thumb/f/fb/Snake_Plant_%28Sansevieria_trifasciata_%27Laurentii%27%29.jpg/500px-Snake_Plant_%28Sansevieria_trifasciata_%27Laurentii%27%29.jpg",
  "ZZ Plant": "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/cf/Zamioculcas_zamiifolia_1.jpg/500px-Zamioculcas_zamiifolia_1.jpg",
  "Fiddle Leaf Fig": "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/84/Starr_031108-0130_Ficus_lyrata.jpg/500px-Starr_031108-0130_Ficus_lyrata.jpg",
  "Rubber Plant": "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/16/Ficus_elastica_leaves_02.JPG/500px-Ficus_elastica_leaves_02.JPG",
  "Spider Plant": "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b1/Hierbabuena_0611_Revised.jpg/500px-Hierbabuena_0611_Revised.jpg",
  "Peace Lily": "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/bd/Spathiphyllum_cochlearispathum_RTBG.jpg/500px-Spathiphyllum_cochlearispathum_RTBG.jpg",
  "Philodendron Brasil": "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/bb/Philodendron_scandens_subsp_oxycardium2.jpg/500px-Philodendron_scandens_subsp_oxycardium2.jpg",
  "Chinese Money Plant": "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6d/Pilea_peperomioides_Chinese_money_plant.jpg/500px-Pilea_peperomioides_Chinese_money_plant.jpg",
  "Calathea Orbifolia": "https://thumb.wikimedia.org/wikipedia/commons/thumb/f/fa/Calathea_orbifolia_2.jpg/500px-Calathea_orbifolia_2.jpg",
  "Bird of Paradise": "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1c/Strelitzia_larger.jpg/500px-Strelitzia_larger.jpg",
  "Jade Plant": "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5a/Crassula_ovata_700.jpg/500px-Crassula_ovata_700.jpg",
  "Echeveria": "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/85/Echeveria_elegans_-_1.jpg/500px-Echeveria_elegans_-_1.jpg",
  "String of Pearls": "https://thumb.wikimedia.org/wikipedia/commons/thumb/f/fd/Senecio_rowleyanus_leaves.jpg/500px-Senecio_rowleyanus_leaves.jpg",
  "Rosemary": "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a3/Rosemary_in_bloom.JPG/500px-Rosemary_in_bloom.JPG",
  "Mint": "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4d/Mentha_spicata-IMG_6186.jpg/500px-Mentha_spicata-IMG_6186.jpg",
  "Thyme": "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ea/Thyme-Bundle.jpg/500px-Thyme-Bundle.jpg",
  "Lemon Balm": "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/70/Lemon_balm_plant.jpg/500px-Lemon_balm_plant.jpg",
  "Sage": "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5a/Salvia_officinalis0.jpg/500px-Salvia_officinalis0.jpg",
  "Chives": "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/49/Allium_schoenoprasum_-_Bombus_lapidarius_-_Tootsi.jpg/500px-Allium_schoenoprasum_-_Bombus_lapidarius_-_Tootsi.jpg",
  "Lemon Thyme": "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/29/Starr_070906-8846_Thymus_citriodorus.jpg/500px-Starr_070906-8846_Thymus_citriodorus.jpg",
  "Cherry Tomato": "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/10/Tomates_cerises_Luc_Viatour.jpg/500px-Tomates_cerises_Luc_Viatour.jpg",
  "Padron Pepper": "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/54/Pementos_de_Padron.jpg/500px-Pementos_de_Padron.jpg",
  "Rainbow Chard": "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/45/Chard_%28Beta_vulgaris_var_cicla%29.jpg/500px-Chard_%28Beta_vulgaris_var_cicla%29.jpg",
  "Dahlia": "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Dahlia_x_hybrida.jpg/500px-Dahlia_x_hybrida.jpg",
  "Cosmos": "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e0/Cosmos_bipinnatus%2C_a_wild_Cosmos_%289461227273%29.jpg/500px-Cosmos_bipinnatus%2C_a_wild_Cosmos_%289461227273%29.jpg",
  "Sweet Pea": "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d7/Sweet_Pea-7.jpg/500px-Sweet_Pea-7.jpg",
  "Japanese Maple": "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d6/Acer_palmatum0.jpg/500px-Acer_palmatum0.jpg",
  "Olive Tree": "https://upload.wikimedia.org/wikipedia/commons/8/84/Olivesfromjordan.jpg",
  "Fig Tree": "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2e/Ficus_carica_L%2C_1771.jpg/500px-Ficus_carica_L%2C_1771.jpg",
  "Hydrangea": "https://thumb.wikimedia.org/wikipedia/commons/thumb/f/fc/Hydrangea_arborescens_139866012.jpg/500px-Hydrangea_arborescens_139866012.jpg",
  "Elderberry": "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a9/Sambucus-berries.jpg/500px-Sambucus-berries.jpg",
  "Boxwood": "https://thumb.wikimedia.org/wikipedia/commons/thumb/f/fd/Buxus_sempervirens.jpg/500px-Buxus_sempervirens.jpg",
  "Venus Flytrap": "https://thumb.wikimedia.org/wikipedia/commons/thumb/3/37/Venus_Flytrap_showing_trigger_hairs.jpg/500px-Venus_Flytrap_showing_trigger_hairs.jpg",
  "Aloe Vera": "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4b/Aloe_vera_flower_inset.png/500px-Aloe_vera_flower_inset.png",
  "Haworthia": "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b9/Haworthia_cymbiformis_1.jpg/500px-Haworthia_cymbiformis_1.jpg",
  "Christmas Cactus": "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ef/Cactus_de_no%C3%ABl_rev.jpg/500px-Cactus_de_no%C3%ABl_rev.jpg",
  "Burros Tail": "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e5/Donkey%27s_tail_in_bloom_March_06.jpg/500px-Donkey%27s_tail_in_bloom_March_06.jpg",
  "Basil": "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/97/Ocimum_basilicum_8zz.jpg/500px-Ocimum_basilicum_8zz.jpg",
  "Sugar Snap Pea": "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8a/Sugar_Snap_Pea.JPG/500px-Sugar_Snap_Pea.JPG",
  "Courgette": "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/92/CSA-Striped-Zucchini.jpg/500px-CSA-Striped-Zucchini.jpg",
  "Rocket": "https://thumb.wikimedia.org/wikipedia/commons/thumb/3/3f/Eruca_vesicaria_BM010755249.jpg/500px-Eruca_vesicaria_BM010755249.jpg",
  "Lavender": "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7e/Single_lavender_flower02.jpg/500px-Single_lavender_flower02.jpg",
  "Air Plant": "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6a/Tillandsia_fasciculata.jpg/500px-Tillandsia_fasciculata.jpg",
  "Aloe": "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4c/Aloe_arborescens_on_Monte_Vumba_%284387600468%29.jpg/500px-Aloe_arborescens_on_Monte_Vumba_%284387600468%29.jpg",
  "cannabis": "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/79/Cannabis_sativa_Koehler_drawing.jpg/500px-Cannabis_sativa_Koehler_drawing.jpg",
  "Boston Fern": "https://thumb.wikimedia.org/wikipedia/commons/thumb/3/30/Boston_Fern_%282873392811%29.png/500px-Boston_Fern_%282873392811%29.png"
};

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
        body: {
          memberId: members[i % members.length].id,
          name,
          category,
          description,
          imageUrl: IMAGES[name] || '',
        },
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
