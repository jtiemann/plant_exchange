// The Plant Exchange - Event-Driven Plant Trading Platform
// Modern architecture with RxJS, Ramda, Event Sourcing, and Reactive Streams

require('dotenv').config();

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const R = require('ramda');
const { Subject, BehaviorSubject, merge, fromEvent, timer } = require('rxjs');
const { map, filter, scan, distinctUntilChanged, shareReplay, tap } = require('rxjs/operators');
const { TypeSafeClient, choice, noul } = require('@typesafe-ai/sdk');

// =============================================================================
// CONFIGURATION
// =============================================================================

const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || '';

const hasTypeSafeKey = () => TYPESAFE_API_KEY.length > 0;

// Jev-backed features (semantic search, offer/want matching) need a TypeSafe key.
// Call this at the top of any code path that talks to the API, so a missing key
// surfaces as this message instead of an opaque 401 from the SDK.
const requireTypeSafeKey = () => {
  if (!hasTypeSafeKey()) {
    throw new Error(
      'TYPESAFE_API_KEY is not set. Copy .env.example to .env and add your key ' +
      'from https://console.typesafe.ai, then restart the server.'
    );
  }
  return TYPESAFE_API_KEY;
};

// =============================================================================
// SEMANTIC SEARCH (TypeSafe / Jev)
// =============================================================================

// A Choice question accepts at most 255 options. Past that we rank the newest
// 255 listings; splitting into a two-pass window search is the fix when the
// catalogue outgrows it.
const MAX_CHOICE_OPTIONS = 255;

// Tuned against the listings in events.json: irrelevant queries scored ~0.02,
// good matches 0.89-0.96. Re-tune these as the catalogue grows.
const EXISTS_THRESHOLD = 0.35;

// Choice probabilities are competitive - they answer "which one is best", not
// "which are relevant". Two equally good matches split ~0.55/0.45, while a
// good-vs-irrelevant pair goes ~0.91/0.09. A floor of 0.15 of the top hit keeps
// both halves of a genuine tie and still drops the tail.
const RELEVANCE_FLOOR = 0.15;

let typeSafeClient = null;
const getTypeSafeClient = () => {
  if (!typeSafeClient) {
    typeSafeClient = new TypeSafeClient({ apiKey: requireTypeSafeKey() });
  }
  return typeSafeClient;
};

const substringSearch = (plants, query) => {
  const text = query.toLowerCase();
  return plants.filter(plant =>
    plant.name.toLowerCase().includes(text) ||
    plant.description.toLowerCase().includes(text) ||
    plant.category.toLowerCase().includes(text)
  );
};

// One Jev request answers both questions over the same state. The Choice ranks
// every listing; the Noul says whether anything matches at all. Choice
// probabilities always sum to 1, so without the Noul a search for "mountain
// bike" would still return whichever plant is least irrelevant.
const semanticSearch = async (plants, query) => {
  const shortlist = plants.slice(0, MAX_CHOICE_OPTIONS);
  const ids = shortlist.map((_, i) => `P${String(i).padStart(3, '0')}`);
  const state = shortlist
    .map((plant, i) => `${ids[i]}| ${plant.name} (${plant.category}, ${plant.type}): ${plant.description}`)
    .join('\n');

  const response = await getTypeSafeClient().systemOne({
    state,
    questions: {
      where: choice(`Which listing best matches: "${query}"?`,
        Object.fromEntries(ids.map(id => [id, null]))),
      exists: noul(`Does any listing plausibly match: "${query}"?`, {
        true: 'At least one listing is a plausible match for what the searcher wants',
        false: 'No listing is relevant to this search'
      })
    }
  });

  if (response.answers.exists.noul < EXISTS_THRESHOLD) return [];

  const probabilities = response.answers.where.probabilities;
  const ranked = shortlist
    .map((plant, i) => ({ ...plant, relevance: probabilities[ids[i]] || 0 }))
    .sort((a, b) => b.relevance - a.relevance);

  // Relative floor, so the cutoff holds as probability mass spreads over a
  // larger catalogue.
  const best = ranked.length ? ranked[0].relevance : 0;
  return ranked.filter(plant => plant.relevance >= best * RELEVANCE_FLOOR);
};

// The same query over an unchanged catalogue is a free repeat.
const SEARCH_CACHE_MAX = 200;
const searchCache = new Map();

const cacheKey = (query, plants) => `${query}\u0000${plants.map(p => p.id).join(',')}`;

const cacheSearch = (key, results) => {
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    searchCache.delete(searchCache.keys().next().value);
  }
  searchCache.set(key, results);
  return results;
};

// =============================================================================
// DOMAIN MODELS & TYPES
// =============================================================================

const EventTypes = {
  MEMBER_REGISTERED: 'MEMBER_REGISTERED',
  PLANT_OFFERED: 'PLANT_OFFERED',
  PLANT_WANTED: 'PLANT_WANTED',
  MESSAGE_SENT: 'MESSAGE_SENT',
  MESSAGE_READ: 'MESSAGE_READ',
  TRADE_INITIATED: 'TRADE_INITIATED',
  TRADE_COMPLETED: 'TRADE_COMPLETED',
  PLANT_REMOVED: 'PLANT_REMOVED'
};

// Pure function factories for creating events
const createEvent = (type, payload, memberId = null) => ({
  id: uuidv4(),
  type,
  payload,
  memberId,
  timestamp: new Date().toISOString(),
  version: 1
});

const createMember = (name, email, location, bio = '') => ({
  id: uuidv4(),
  name,
  email,
  location,
  bio,
  joinedAt: new Date().toISOString(),
  reputation: 0
});

const createPlant = (name, description, category, memberId, type = 'offer') => ({
  id: uuidv4(),
  name,
  description,
  category,
  memberId,
  type, // 'offer' or 'wanted'
  status: 'available',
  createdAt: new Date().toISOString(),
  images: []
});

const createMessage = (fromId, toIds, content, tradeId = null) => ({
  id: uuidv4(),
  fromId,
  toIds: Array.isArray(toIds) ? toIds : [toIds], // Support multiple recipients
  content,
  tradeId,
  timestamp: new Date().toISOString(),
  readBy: [] // Track who has read the message
});

// =============================================================================
// EVENT STORE - Persistent Event Sourcing
// =============================================================================

class EventStore {
  constructor(filePath = './events.json') {
    this.filePath = filePath;
    this.events$ = new Subject();
    this.eventHistory = [];
  }

  async initialize() {
    try {
      const data = await fs.readFile(this.filePath, 'utf8');
      this.eventHistory = JSON.parse(data);
      console.log(`Loaded ${this.eventHistory.length} events from storage`);
    } catch (error) {
      console.log('No existing event store found, starting fresh');
      this.eventHistory = [];
    }
  }

  async append(event) {
    const eventWithMetadata = {
      ...event,
      sequenceNumber: this.eventHistory.length + 1
    };
    
    this.eventHistory.push(eventWithMetadata);
    this.events$.next(eventWithMetadata);
    
    // Persist to disk
    await this.persist();
    return eventWithMetadata;
  }

  async persist() {
    try {
      await fs.writeFile(this.filePath, JSON.stringify(this.eventHistory, null, 2));
    } catch (error) {
      console.error('Failed to persist events:', error);
    }
  }

  getEvents() {
    return [...this.eventHistory];
  }

  getEventStream() {
    return this.events$.asObservable();
  }
}

// =============================================================================
// STATE PROJECTIONS - Reactive State Management
// =============================================================================

class StateProjections {
  constructor(eventStore) {
    this.eventStore = eventStore;
    this.members$ = new BehaviorSubject(new Map());
    this.plants$ = new BehaviorSubject(new Map());
    this.messages$ = new BehaviorSubject(new Map());
    this.trades$ = new BehaviorSubject(new Map());
    
    this.setupProjections();
  }

  setupProjections() {
    const events$ = this.eventStore.getEventStream();

    // Members projection
    events$.pipe(
      filter(event => event.type === EventTypes.MEMBER_REGISTERED),
      scan((members, event) => {
        const newMembers = new Map(members);
        newMembers.set(event.payload.id, event.payload);
        return newMembers;
      }, new Map())
    ).subscribe(this.members$);

    // Plants projection
    events$.pipe(
      filter(event => [EventTypes.PLANT_OFFERED, EventTypes.PLANT_WANTED, EventTypes.PLANT_REMOVED].includes(event.type)),
      scan((plants, event) => {
        const newPlants = new Map(plants);
        
        switch (event.type) {
          case EventTypes.PLANT_OFFERED:
          case EventTypes.PLANT_WANTED:
            newPlants.set(event.payload.id, event.payload);
            break;
          case EventTypes.PLANT_REMOVED:
            newPlants.delete(event.payload.plantId);
            break;
        }
        
        return newPlants;
      }, new Map())
    ).subscribe(this.plants$);

    // Messages projection
    events$.pipe(
      filter(event => [EventTypes.MESSAGE_SENT, EventTypes.MESSAGE_READ].includes(event.type)),
      scan((messages, event) => {
        const newMessages = new Map(messages);
        
        switch (event.type) {
          case EventTypes.MESSAGE_SENT:
            newMessages.set(event.payload.id, event.payload);
            break;
          case EventTypes.MESSAGE_READ:
            const message = newMessages.get(event.payload.messageId);
            if (message) {
              const existingReadBy = message.readBy || [];
              if (!existingReadBy.includes(event.payload.memberId)) {
                const updatedMessage = {
                  ...message,
                  readBy: [...existingReadBy, event.payload.memberId]
                };
                newMessages.set(event.payload.messageId, updatedMessage);
              }
            }
            break;
        }
        
        return newMessages;
      }, new Map())
    ).subscribe(this.messages$);

    // Initialize from existing events
    this.rebuildFromHistory();
  }

  rebuildFromHistory() {
    const events = this.eventStore.getEvents();
    
    // Rebuild members
    const members = R.pipe(
      R.filter(event => event.type === EventTypes.MEMBER_REGISTERED),
      R.map(event => [event.payload.id, event.payload]),
      R.fromPairs
    )(events);
    this.members$.next(new Map(Object.entries(members)));

    // Rebuild plants
    const plants = R.pipe(
      R.filter(event => [EventTypes.PLANT_OFFERED, EventTypes.PLANT_WANTED].includes(event.type)),
      R.map(event => [event.payload.id, event.payload]),
      R.fromPairs
    )(events);
    
    // Remove deleted plants
    const removedPlants = R.pipe(
      R.filter(event => event.type === EventTypes.PLANT_REMOVED),
      R.map(event => event.payload.plantId)
    )(events);
    
    const activePlants = R.omit(removedPlants, plants);
    this.plants$.next(new Map(Object.entries(activePlants)));

    // Rebuild messages
    const messages = R.pipe(
      R.filter(event => event.type === EventTypes.MESSAGE_SENT),
      R.map(event => [event.payload.id, event.payload]),
      R.fromPairs
    )(events);
    
    // Apply message read events
    const readEvents = R.filter(event => event.type === EventTypes.MESSAGE_READ, events);
    const updatedMessages = R.map(message => {
      const messageReadEvents = R.filter(event => event.payload.messageId === message.id, readEvents);
      const readBy = R.map(event => event.payload.memberId, messageReadEvents);
      const existingReadBy = message.readBy || [];
      return { ...message, readBy: R.uniq([...existingReadBy, ...readBy]) };
    }, messages);
    
    this.messages$.next(new Map(Object.entries(updatedMessages)));
  }

  // Reactive getters
  getMembers() {
    return this.members$.asObservable();
  }

  getPlants() {
    return this.plants$.asObservable();
  }

  getMessages() {
    return this.messages$.asObservable();
  }

  getCurrentState() {
    return {
      members: Array.from(this.members$.value.values()),
      plants: Array.from(this.plants$.value.values()),
      messages: Array.from(this.messages$.value.values())
    };
  }
}

// =============================================================================
// COMMAND HANDLERS - Business Logic Layer
// =============================================================================

class PlantExchangeService {
  constructor(eventStore, projections) {
    this.eventStore = eventStore;
    this.projections = projections;
  }

  async registerMember(memberData) {
    const member = createMember(
      memberData.name,
      memberData.email,
      memberData.location,
      memberData.bio
    );

    const event = createEvent(EventTypes.MEMBER_REGISTERED, member);
    return await this.eventStore.append(event);
  }

  async offerPlant(plantData, memberId) {
    const plant = createPlant(
      plantData.name,
      plantData.description,
      plantData.category,
      memberId,
      'offer'
    );

    const event = createEvent(EventTypes.PLANT_OFFERED, plant, memberId);
    return await this.eventStore.append(event);
  }

  async requestPlant(plantData, memberId) {
    const plant = createPlant(
      plantData.name,
      plantData.description,
      plantData.category,
      memberId,
      'wanted'
    );

    const event = createEvent(EventTypes.PLANT_WANTED, plant, memberId);
    return await this.eventStore.append(event);
  }

  async sendMessage(messageData) {
    // Support both old (toId) and new (toIds) formats for compatibility
    let toIds;
    if (messageData.toIds) {
      toIds = Array.isArray(messageData.toIds) ? messageData.toIds : [messageData.toIds];
    } else if (messageData.toId) {
      toIds = [messageData.toId];
    } else {
      throw new Error('No recipients specified');
    }

    const message = createMessage(
      messageData.fromId,
      toIds,
      messageData.content,
      messageData.tradeId
    );

    const event = createEvent(EventTypes.MESSAGE_SENT, message, messageData.fromId);
    return await this.eventStore.append(event);
  }

  async markMessageAsRead(messageId, memberId) {
    const event = createEvent(
      EventTypes.MESSAGE_READ,
      { messageId, memberId },
      memberId
    );
    return await this.eventStore.append(event);
  }

  async removePlant(plantId, memberId) {
    const event = createEvent(
      EventTypes.PLANT_REMOVED,
      { plantId },
      memberId
    );
    return await this.eventStore.append(event);
  }

  // Query methods using functional composition
  // Query methods using functional composition
  async searchPlants(criteria) {
    const currentPlants = Array.from(this.projections.plants$.value.values());

    // Code owns the deterministic filters. The model only ever sees the shortlist.
    const shortlist = R.pipe(
      R.filter(plant => {
        if (criteria.type && plant.type !== criteria.type) return false;
        if (criteria.category && plant.category !== criteria.category) return false;
        return true;
      }),
      R.sortBy(R.prop('createdAt')),
      R.reverse
    )(currentPlants);

    if (!criteria.search) return shortlist;
    if (!hasTypeSafeKey()) return substringSearch(shortlist, criteria.search);

    const key = cacheKey(criteria.search, shortlist);
    if (searchCache.has(key)) return searchCache.get(key);

    try {
      return cacheSearch(key, await semanticSearch(shortlist, criteria.search));
    } catch (error) {
      console.error(`Semantic search failed (${error.constructor.name}): ${error.message}`);
      console.error('   Falling back to substring matching for this query.');
      return substringSearch(shortlist, criteria.search);
    }
  }

  getMemberMessages(memberId) {
    const currentMessages = Array.from(this.projections.messages$.value.values());
    
    return R.pipe(
      R.filter(message => {
        // Handle both old format (toId) and new format (toIds)
        const recipients = message.toIds || (message.toId ? [message.toId] : []);
        return message.fromId === memberId || recipients.includes(memberId);
      }),
      R.sortBy(R.prop('timestamp')),
      R.reverse
    )(currentMessages);
  }

  getUnreadMessageCount(memberId) {
    const currentMessages = Array.from(this.projections.messages$.value.values());
    
    return R.pipe(
      R.filter(message => {
        // Handle both old format (toId) and new format (toIds)
        const recipients = message.toIds || (message.toId ? [message.toId] : []);
        const readBy = message.readBy || [];
        return recipients.includes(memberId) && !readBy.includes(memberId);
      }),
      R.length
    )(currentMessages);
  }

  getUnreadMessagesForMember(memberId) {
    const currentMessages = Array.from(this.projections.messages$.value.values());
    
    return R.pipe(
      R.filter(message => {
        // Handle both old format (toId) and new format (toIds)
        const recipients = message.toIds || (message.toId ? [message.toId] : []);
        const readBy = message.readBy || [];
        return recipients.includes(memberId) && !readBy.includes(memberId);
      }),
      R.sortBy(R.prop('timestamp')),
      R.reverse
    )(currentMessages);
  }
}

// =============================================================================
// WEB SERVER & API LAYER
// =============================================================================

class PlantExchangeServer {
  constructor() {
    this.app = express();
    this.eventStore = new EventStore();
    this.projections = new StateProjections(this.eventStore);
    this.service = new PlantExchangeService(this.eventStore, this.projections);
    this.sseClients = new Set();
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupSSE();
  }

  setupMiddleware() {
    this.app.use(express.json());
    this.app.use(express.static('public'));
    
    // CORS for development
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      next();
    });
  }

  setupSSE() {
    // Subscribe to all events and broadcast to SSE clients
    this.eventStore.getEventStream().subscribe(event => {
      this.broadcastToSSEClients({
        type: 'event',
        data: event
      });
    });

    // Broadcast state changes
    this.projections.getMembers().subscribe(members => {
      this.broadcastToSSEClients({
        type: 'members_updated',
        data: Array.from(members.values())
      });
    });

    this.projections.getPlants().subscribe(plants => {
      this.broadcastToSSEClients({
        type: 'plants_updated',
        data: Array.from(plants.values())
      });
    });

    this.projections.getMessages().subscribe(messages => {
      this.broadcastToSSEClients({
        type: 'messages_updated',
        data: Array.from(messages.values())
      });
    });
  }

  broadcastToSSEClients(data) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    this.sseClients.forEach(client => {
      try {
        client.write(message);
      } catch (error) {
        this.sseClients.delete(client);
      }
    });
  }

  setupRoutes() {
    // SSE endpoint for real-time updates
    this.app.get('/events', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      this.sseClients.add(res);

      // Send initial state
      const state = this.projections.getCurrentState();
      res.write(`data: ${JSON.stringify({ type: 'initial_state', data: state })}\n\n`);

      // Clean up on disconnect
      req.on('close', () => {
        this.sseClients.delete(res);
      });
    });

    // Member management
    this.app.post('/api/members', async (req, res) => {
      try {
        const event = await this.service.registerMember(req.body);
        res.json({ success: true, event });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    this.app.get('/api/members', (req, res) => {
      const members = Array.from(this.projections.members$.value.values());
      res.json(members);
    });

    // Plant management
    this.app.post('/api/plants/offer', async (req, res) => {
      try {
        const { memberId, ...plantData } = req.body;
        const event = await this.service.offerPlant(plantData, memberId);
        res.json({ success: true, event });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    this.app.post('/api/plants/wanted', async (req, res) => {
      try {
        const { memberId, ...plantData } = req.body;
        const event = await this.service.requestPlant(plantData, memberId);
        res.json({ success: true, event });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    this.app.get('/api/plants', async (req, res) => {
      try {
        const results = await this.service.searchPlants(req.query);
        res.json(results);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.delete('/api/plants/:plantId', async (req, res) => {
      try {
        const { plantId } = req.params;
        const { memberId } = req.body;
        const event = await this.service.removePlant(plantId, memberId);
        res.json({ success: true, event });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // Messaging
    this.app.post('/api/messages', async (req, res) => {
      try {
        const event = await this.service.sendMessage(req.body);
        res.json({ success: true, event });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    this.app.post('/api/messages/:messageId/read', async (req, res) => {
      try {
        const { messageId } = req.params;
        const { memberId } = req.body;
        const event = await this.service.markMessageAsRead(messageId, memberId);
        res.json({ success: true, event });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    this.app.get('/api/messages/:memberId', (req, res) => {
      const messages = this.service.getMemberMessages(req.params.memberId);
      res.json(messages);
    });

    this.app.get('/api/messages/:memberId/unread', (req, res) => {
      const unreadMessages = this.service.getUnreadMessagesForMember(req.params.memberId);
      const unreadCount = this.service.getUnreadMessageCount(req.params.memberId);
      res.json({ 
        messages: unreadMessages, 
        count: unreadCount 
      });
    });

    this.app.get('/api/notifications/:memberId', (req, res) => {
      const unreadCount = this.service.getUnreadMessageCount(req.params.memberId);
      res.json({ unreadMessages: unreadCount });
    });

    // System info
    this.app.get('/api/stats', (req, res) => {
      const state = this.projections.getCurrentState();
      res.json({
        totalMembers: state.members.length,
        totalPlants: state.plants.length,
        plantsOffered: state.plants.filter(p => p.type === 'offer').length,
        plantsWanted: state.plants.filter(p => p.type === 'wanted').length,
        totalMessages: state.messages.length,
        totalEvents: this.eventStore.getEvents().length
      });
    });

    // Serve the main application
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
  }

  async start(port = 3000) {
    await this.eventStore.initialize();
    
    // Ensure projections are rebuilt from existing events
    this.projections.rebuildFromHistory();
    
    if (!hasTypeSafeKey()) {
      console.warn('⚠️  TYPESAFE_API_KEY is not set - Jev-backed features are disabled.');
      console.warn('   Copy .env.example to .env and add your key to enable them.');
    }

    this.app.listen(port, () => {
      console.log(`🌱 The Plant Exchange is running on http://localhost:${port}`);
      console.log(`📊 Event Store contains ${this.eventStore.getEvents().length} events`);
      
      // Log current state for debugging
      const state = this.projections.getCurrentState();
      console.log(`👥 Members: ${state.members.length}`);
      console.log(`🌿 Plants: ${state.plants.length}`);
      console.log(`💬 Messages: ${state.messages.length}`);
    });
  }
}

// =============================================================================
// APPLICATION BOOTSTRAP
// =============================================================================

if (require.main === module) {
  const server = new PlantExchangeServer();
  server.start().catch(console.error);
}

module.exports = {
  PlantExchangeServer,
  PlantExchangeService,
  EventStore,
  StateProjections,
  EventTypes,
  createEvent,
  createMember,
  createPlant,
  createMessage,
  hasTypeSafeKey,
  requireTypeSafeKey
};