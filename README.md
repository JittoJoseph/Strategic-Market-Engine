# Strategic Market Engine

[![Backend Build](https://img.shields.io/badge/backend-build%20passing-brightgreen)](https://github.com/JittoJoseph/Strategic-Market-Engine/actions)
[![Frontend Build](https://img.shields.io/badge/frontend-build%20passing-brightgreen)](https://github.com/JittoJoseph/Strategic-Market-Engine/actions)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](https://github.com/JittoJoseph/Strategic-Market-Engine/actions)
[![Health Check](https://img.shields.io/badge/health-up-brightgreen)](https://penguinx.onrender.com/health)

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
