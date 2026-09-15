# Strategic Market Engine

[![Live Demo](https://img.shields.io/badge/Live_Demo-strategic--market--engine.vercel.app-007acc)](https://strategic-market-engine.vercel.app/)

[![Backend Build](https://img.shields.io/github/checks-status/JittoJoseph/Strategic-Market-Engine/main?label=backend)](https://github.com/JittoJoseph/Strategic-Market-Engine/deployments)
[![Frontend Build](https://img.shields.io/github/checks-status/JittoJoseph/Strategic-Market-Engine/main?label=frontend)](https://github.com/JittoJoseph/Strategic-Market-Engine/deployments)
[![Health Check](https://img.shields.io/website?url=https://market-api.jittojoseph.xyz/ping&label=health)](https://market-api.jittojoseph.xyz/ping)

A paper-trading simulator for Polymarket's BTC 15-minute Up/Down markets. It
watches the trade tape of live markets, follows bursts of large taker flow, and
buys behind them as a taker while the price still leaves real upside. Fills are
simulated against the real order book.

No real money is traded.

## The strategy

These markets resolve on the **Chainlink BTC/USD 60-second TWAP**: `Up` wins
when the TWAP at window close is at or above the TWAP at window open.

The engine holds no view on where BTC is going and does not price the market
itself. Every forecast-driven approach tried here lost to the book: makers on
these markets run on faster feeds, price the TWAP roll-off correctly, and are
right whenever they disagree with a model. What the model cannot see, the tape
can. A single large taker print carries no information — on four days of
prints the side of a lone sweep resolved *against* it two times in three. Two or
more large prints on the same side inside three seconds is a different signal:
somebody is leaning in, and that side resolved their way well above what the
price implied, especially where the price was still 0.15–0.50.

That is the whole trade. Watch the tape; when a burst forms on a side the book
still prices as uncertain, buy that side at the ask the book shows after the
burst.

## How it works

Markets are discovered by deterministic slug (`btc-updown-15m-<windowStart>`)
and subscribed to over the CLOB WebSocket, which delivers the book and every
fill. Two RTDS feeds are consumed: the `crypto_prices_twap_sixty` series that
settlement runs on, and the unsmoothed `crypto_prices_chainlink` series that
drives it.

**Burst.** A taker fill of at least `flowMinPrintShares` shares is a large
print. A taker buying a token is flow toward that outcome; a taker selling it
is flow toward the other. `flowMinPrints` large prints toward the same
outcome inside `flowBurstMs` form a burst, and the burst is scored the moment
it completes.

**Entry.** Between 120 and 10 seconds before close, buy the burst side if its
executable ask sits within `[0.15, 0.50]`. One trade per window. Bursts with
real upside happen almost only in the 60–120 s zone; later the book has already
priced the side, and above 0.50 the burst side resolved at or below the implied
rate in every period replayed.

**Veto.** The settlement forecast — the expected closing TWAP given spot and
the stretch about to roll out of the average — never opens a trade. It vetoes
one: a burst against a side the forecast is at least `vetoSdMultiple`
standard deviations sure of is not followed.

**Platform status.** No entry unless status.polymarket.com reads UP. During
incidents and maintenance (HASISSUES, UNDERMAINTENANCE) BTC Up/Down flow dries
up and what the book shows stops meaning anything; an earlier edge in this
project came entirely from windows inside declared incidents. The page is polled
every 30 s, and a page that has not been read for 90 s counts as not UP. Open
positions keep their stop and still settle.

**Exit.** The stop arms when the executable bid falls to 65% of the entry price
and fires once the bid has stayed at or below that level for `stopConfirmMs`
(20 s); a bid back above the level resets the clock. In the final two minutes
these books routinely wick through that level and recover: replayed over five
days, an immediate stop fired on 81% of trades and sold 37 of 69 eventual
winners. A dip that has not held by the window end never fires, so the latest
entries effectively ride to resolution. Otherwise the position rides to oracle
resolution. The stop is always on and cannot be disabled. The trigger only
decides *when* to sell: the order is matched against whatever the bid side
actually holds, walked to the bottom of the book with no limit, so a collapsed
book produces a near-total loss. A book too thin to absorb the whole position
leaves a remainder, which stays open with the trigger re-armed.

**Execution.** Simulated FAK taker orders walk the real book level by level, so
fills reflect actual depth, partial fills, slippage and fees. Orders are held
for Polymarket's 50 ms taker delay and matched against the book as it stands
after the hold. The taker fee is Polymarket's published crypto schedule,
`shares × 0.07 × p × (1−p)`.

The strategy constants live in one place, `STRATEGY` in
[`backend/src/types/index.ts`](backend/src/types/index.ts). They are calibration
results, not deployment settings; the environment carries only credentials, the
server port and the starting capital.

## What to expect, and what would falsify it

On the four days of tape the rule was calibrated against, the base definition
(two prints of fifty shares inside three seconds) fired about fourteen times a
day at prices under 0.70 and was right 57% of the time at a mean entry of 0.48
— roughly twenty points above what the price implied in the cheap zone. That is
the evidence, and it is thin: the edge weakens when the burst window is widened
to five seconds, and it is negative above 0.70. The live run is the test. If a
week of trades shows the burst side resolving at or below the entry price's
implied rate, the signal is noise and this strategy should be retired, not
tuned.

A five-day replay (480 windows, 9–14 September) of the original rule reproduced
the live account's loss and located it: entries at 0.50–0.70 lost in both halves
of the sample, and an unconfirmed stop turned a held-to-settlement +5% per trade
into −10%. With the 0.50 cap and the confirmed stop the same replay gives +11%
per trade over 116 trades, similar in both halves but within one standard error
(±15%) of zero. Copying wallets with a profitable late-window record and
requiring distinct wallets inside a burst were both tested and rejected.

## Simulation settings

These exist to keep the research sample unbiased and are **not** intended for a
real-money system:

- Every entry uses a fixed **$5** budget regardless of portfolio value.
- Trades are never skipped for lack of cash; the simulated balance may go
  negative.
- There is no consecutive-loss auto-pause.

## Evaluation data

Every window writes one `audit_log` row under category `EVALUATION` at
cleanup: how many bursts it produced, when the first came and on which side,
the cheapest ask the book showed on a burst side when it was scored, and the
last reason the engine gave for not trading. Untraded windows are the baseline
for whether the price band sits where the flow is.

## Admin operations

Three endpoints, all requiring the admin password.

| Action | Effect |
|---|---|
| `POST /api/admin/pause` | Stops new entries. Open positions stay tracked, keep their stop armed, and still settle. The price feed and order-book subscriptions stay live. |
| `POST /api/admin/resume` | Reloads the portfolio row, restarts the scanner, resumes entries. |
| `DELETE /api/admin/wipe` | Pauses, clears all in-memory session state, deletes trades, audit log, markets and the portfolio row, then reloads the fresh portfolio. Leaves the engine **paused**. |

**Wipe then resume is enough — a process restart is not required.** The wipe
clears open positions, active markets, settlement timers, order-book
subscriptions, the scanner's seen-market memo and the strategy engine's
traded-market set before it touches the database, so nothing from the old
session survives to act against the new portfolio. Resume then rediscovers
markets from scratch.

Resuming is in one respect better than restarting: the BTC price buffer lives in
memory and is not cleared, so a window whose open is still inside the buffer
gets its strike back immediately. A restart loses that and skips the window.

Pause is deliberately not a full stop. Positions opened before the pause must
still be able to hit their stop and settle, so those paths are not gated on the
paused flag.

## Architecture

| Component   | Stack                                                       |
| ----------- | ----------------------------------------------------------- |
| Backend     | Node.js 22+, TypeScript, PostgreSQL (Supabase) via Drizzle  |
| Frontend    | Next.js dashboard, live updates over WebSocket              |
| Market data | Polymarket Gamma API, CLOB WebSocket, RTDS TWAP + raw feeds |

Backend services are single-purpose and wired through one orchestrator: market
scanner, CLOB book and tape watcher, BTC price watcher, strategy engine,
execution simulator, portfolio manager, API server.

Window boundaries and entry deadlines are defined by Polymarket, so the engine
runs on a market clock synced to the CLOB server rather than the host clock.
