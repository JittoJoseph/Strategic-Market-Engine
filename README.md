# Strategic Market Engine

[![Live Demo](https://img.shields.io/badge/Live_Demo-strategic--market--engine.vercel.app-007acc)](https://strategic-market-engine.vercel.app/)

[![Backend Build](https://img.shields.io/github/checks-status/JittoJoseph/Strategic-Market-Engine/main?label=backend)](https://github.com/JittoJoseph/Strategic-Market-Engine/deployments)
[![Frontend Build](https://img.shields.io/github/checks-status/JittoJoseph/Strategic-Market-Engine/main?label=frontend)](https://github.com/JittoJoseph/Strategic-Market-Engine/deployments)
[![Health Check](https://img.shields.io/website?url=https://strategic-market-engine.onrender.com/ping&label=health)](https://strategic-market-engine.onrender.com/ping)

End-of-window micro-profit trading on BTC-correlated markets. Monitors BTC price movements and executes automated strategies on prediction markets.

## Architecture

- **Backend**: Node.js/TypeScript service with PostgreSQL database
- **Frontend**: Next.js dashboard with real-time WebSocket updates
- **Strategy**: End-of-window micro-profit trading on BTC-correlated markets

## Features

- Real-time BTC price monitoring via WebSocket connections
- Automated market scanning and opportunity detection
- Simulated trading execution with position management
- Live dashboard with portfolio tracking and P&L visualization

## Access

- Frontend: http://localhost:3000
- Backend API: http://localhost:4000
- Database Studio: `npm run db:studio`
