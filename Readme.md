# 🌱 The Plant Exchange

A modern, event-driven web application for plant enthusiasts to share, trade, and connect with each other. Built with cutting-edge functional programming principles, reactive streams, and event sourcing architecture.

## 🚀 Features

### Core Functionality
- **Member Registration**: Join the community with profile creation
- **Plant Listings**: Offer plants for trade or request specific plants
- **Real-time Messaging**: Communicate with other members to arrange trades
- **Live Updates**: Real-time UI updates using Server-Sent Events
- **Advanced Search**: Filter and search through available plants

### Technical Highlights
- **Event-Driven Architecture**: All state changes captured as immutable events
- **Reactive Streams**: Real-time data flow using RxJS observables
- **Event Sourcing**: Complete audit trail with JSON persistence
- **Functional Design**: Pure functions and immutable data structures using Ramda
- **Modern UI**: Responsive design with smooth animations and real-time updates
- **RESTful API**: Complete HTTP API for programmatic access

## 🛠 Technology Stack

### Backend
- **Node.js** with Express.js framework
- **RxJS** for reactive programming and stream management
- **Ramda** for functional programming utilities
- **Event Sourcing** with JSON file persistence
- **Server-Sent Events** for real-time client updates

### Frontend
- **Vanilla JavaScript** with modern ES6+ features
- **CSS Grid & Flexbox** for responsive layouts
- **Event Source API** for real-time updates
- **Progressive Web App** principles

## 📦 Installation

### Prerequisites
- Node.js 16.0.0 or higher
- npm or yarn package manager

### Quick Start

1. **Clone and Setup**
```bash
# Create project directory
mkdir plant-exchange
cd plant-exchange

# Save the server code as server.js
# Save the frontend code as public/index.html
# Save the package.json

# Install dependencies
npm install
```

2. **Project Structure**
```
plant-exchange/
├── server.js              # Main server application
├── package.json           # Dependencies and scripts
├── events.json            # Event store (auto-created)
├── public/
│   └── index.html         # Frontend application
└── README.md             # This file
```

3. **Start the Application**
```bash
# Development mode with auto-restart
npm run dev

# Production mode
npm start
```

4. **Access the Application**
Open your browser to `http://localhost:3000`

## 🏗 Architecture Overview

### Event-Driven Design
The application follows CQRS (Command Query Responsibility Segregation) and Event Sourcing patterns:

```
Commands → Events → State Projections → UI Updates
```

### Core Components

#### Event Store
- Persists all domain events to JSON file
- Provides event streaming capabilities
- Ensures complete audit trail

#### State Projections
- Reactive state management using RxJS
- Real-time updates from event streams
- Separate projections for different domain entities

#### Domain Services
- Pure business logic functions
- Command handlers for state mutations
- Query handlers for data retrieval

#### Web Layer
- RESTful API endpoints
- Server-Sent Events for real-time updates
- Modern HTML5 frontend

## 🔧 API Reference

### Members
- `POST /api/members` - Register new member
- `GET /api/members` - Get all members

### Plants
- `POST /api/plants/offer` - Offer a plant for trade
- `POST /api/plants/wanted` - Request a specific plant
- `GET /api/plants` - Search and filter plants
- `DELETE /api/plants/:id` - Remove a plant listing

### Messages
- `POST /api/messages` - Send a message
- `GET /api/messages/:memberId` - Get messages for member

### Real-time Updates
- `GET /events` - Server-Sent Events stream

### System Info
- `GET /api/stats` - Application statistics

## 🎯 Usage Examples

### Register a New Member
```javascript
const member = await fetch('/api/members', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Jane Doe',
    email: 'jane@example.com',
    location: 'Portland, OR',
    bio: 'Passionate about rare houseplants!'
  })
});
```

### Offer a Plant
```javascript
const plant = await fetch('/api/plants/offer', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    memberId: 'member-uuid',
    name: 'Monstera Deliciosa',
    category: 'houseplant',
    description: 'Healthy 2-year-old plant with fenestrations'
  })
});
```

### Real-time Event Listening
```javascript
const eventSource = new EventSource('/events');
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Real-time update:', data);
};
```

## 🧪 Event Types

The system recognizes these domain events:

- `MEMBER_REGISTERED` - New member joins
- `PLANT_OFFERED` - Plant available for trade
- `PLANT_WANTED` - Member requests specific plant
- `MESSAGE_SENT` - Communication between members
- `TRADE_INITIATED` - Trade process begins
- `TRADE_COMPLETED` - Successful plant exchange
- `PLANT_REMOVED` - Plant listing removed

## 🔄 Reactive Streams

The application uses RxJS for managing reactive data flow:

```javascript
// Example: Real-time plant updates
const plants$ = eventStore.getEventStream().pipe(
  filter(event => event.type === 'PLANT_OFFERED'),
  map(event => event.payload),
  scan((plants, newPlant) => [...plants, newPlant], [])
);
```

## 🎨 UI Features

- **Responsive Design**: Works on desktop, tablet, and mobile
- **Real-time Updates**: Live data without page refreshes
- **Smooth Animations**: CSS transitions and transforms
- **Connection Status**: Visual indicator for real-time connection
- **Search & Filter**: Advanced plant discovery
- **Modal Dialogs**: Intuitive user interactions

## 🧩 Functional Programming

The codebase extensively uses functional programming principles:

```javascript
// Example: Using Ramda for data transformations
const activeOffers = R.pipe(
  R.filter(plant => plant.type === 'offer'),
  R.filter(plant => plant.status === 'available'),
  R.sortBy(R.prop('createdAt')),
  R.reverse
)(plants);
```

## 🚦 Development Scripts

```bash
# Start development server with auto-reload
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Lint code
npm run lint

# Format code
npm run format
```

## 📊 Monitoring

The application provides built-in monitoring through:

- Event store metrics
- Real-time connection status
- Application statistics API
- Console logging for development

## 🔒 Security Considerations

For production deployment, consider adding:

- Authentication and authorization
- Input validation and sanitization
- Rate limiting
- HTTPS encryption
- Database persistence (PostgreSQL, MongoDB)
- User session management

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes following functional programming principles
4. Add tests for new functionality
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details

## 🌟 Future Enhancements

- **Image Upload**: Plant photos
- **Geolocation**: Distance-based matching
- **Rating System**: Member reputation
- **Advanced Search**: AI-powered plant matching
- **Mobile App**: React Native companion
- **Payment Integration**: Paid plant exchanges
- **Social Features**: Plant care communities

---

Built with ❤️ by the Plant Exchange Community

*Happy Growing! 🌱*