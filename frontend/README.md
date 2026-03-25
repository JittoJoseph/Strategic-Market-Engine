# PenguinX Frontend

Real-time simulated copy trading dashboard for Polymarket. This frontend displays positions and trades simulated by the PenguinX backend service.

## Features

- 🐧 **Live Dashboard**: Real-time view of simulated trades and positions
- 📊 **Portfolio Overview**: Top gainers, losers, and most active positions
- 🔄 **WebSocket Updates**: Automatic refresh when new trades are detected
- 📱 **Responsive Design**: Works on desktop and mobile

## Prerequisites

- Node.js 18+
- PenguinX backend running on `http://localhost:3001`

## Getting Started

### 1. Install dependencies

```bash
cd penguinx-frontend
npm install
```

### 2. Configure environment variables

Copy the example environment file:

```bash
cp .env.local.example .env.local
```

Edit `.env.local` to point to your backend:

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
NEXT_PUBLIC_WS_BASE_URL=ws://localhost:3001
```

### 3. Start the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Environment Variables

| Variable                   | Description                | Default                 |
| -------------------------- | -------------------------- | ----------------------- |
| `NEXT_PUBLIC_API_BASE_URL` | Backend API base URL       | `http://localhost:3001` |
| `NEXT_PUBLIC_WS_BASE_URL`  | Backend WebSocket base URL | `ws://localhost:3001`   |

## API Integration

The frontend connects to the following backend endpoints:

| Endpoint                   | Method | Description                                                         |
| -------------------------- | ------ | ------------------------------------------------------------------- |
| `/health`                  | GET    | Health check                                                        |
| `/api/simulated/trades`    | GET    | List simulated trades (supports `status`, `limit`, `offset` params) |
| `/api/simulated/positions` | GET    | List aggregated open positions                                      |
| `/api/metrics`             | GET    | System metrics and poller status                                    |
| `/api/audit`               | GET    | Audit logs (supports `level`, `category`, `limit` params)           |
| `/ws/simulated`            | WS     | Real-time updates for trades and prices                             |

### WebSocket Events

| Event Type       | Description                          |
| ---------------- | ------------------------------------ |
| `connected`      | Confirmation of WebSocket connection |
| `newTrade`       | New simulated trade created          |
| `pollComplete`   | Poller completed a cycle             |
| `priceUpdate`    | Price update for an open position    |
| `positionClosed` | A position was closed                |

## Project Structure

```
penguinx-frontend/
├── src/
│   ├── app/
│   │   ├── globals.css      # Global styles and CSS variables
│   │   ├── layout.tsx       # Root layout
│   │   └── page.tsx         # Main page
│   ├── components/
│   │   ├── ui/              # Base UI components (button, input, card)
│   │   ├── change-badge.tsx # PnL change badge component
│   │   ├── dashboard-page.tsx # Main dashboard page
│   │   ├── direction-icon.tsx # Up/down/flat direction icon
│   │   ├── header.tsx       # App header with time and theme toggle
│   │   ├── overview-panels.tsx # Summary and top movers panels
│   │   ├── split-flap-text.tsx # Split-flap display animation
│   │   └── trades-table.tsx # Trades data table
│   └── lib/
│       ├── api-client.ts    # API client with retry logic
│       ├── hooks.ts         # React hooks for data fetching
│       ├── types.ts         # TypeScript type definitions
│       └── utils.ts         # Utility functions
├── .env.local.example       # Example environment variables
├── package.json
└── README.md
```

## Development

### Building for Production

```bash
npm run build
npm start
```

### Linting

```bash
npm run lint
```

## Integration Checklist

- [x] Health check endpoint
- [x] Trades listing with filtering
- [x] Positions aggregation
- [x] Real-time WebSocket updates
- [x] Metrics display
- [x] Responsive layout
- [x] Split-flap text animation
- [x] PnL change badges
- [x] External links to Polymarket

## Known Gaps

- No authentication (backend is read-only)
- No chart visualizations (could add historical PnL charts)
- No notification sounds for new trades

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Styling**: Tailwind CSS 4
- **State Management**: React hooks
- **Data Fetching**: Native fetch with retry logic
- **Real-time**: WebSocket
- **UI Components**: Custom components inspired by shadcn/ui
- **Table**: TanStack Table (React Table)
- **Animations**: Framer Motion
