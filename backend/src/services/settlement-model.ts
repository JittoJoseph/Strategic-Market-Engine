import { WINDOW_CONFIG } from "../types/index.js";

const W = WINDOW_CONFIG.twapLookbackSeconds;

export interface SettlementForecast {
  anchorMs: number;
  secondsToEnd: number;
  twapNow: number;
  rawNow: number;
  rollingOutMean: number;
  /** Expected settlement TWAP. */
  expected: number;
  sd: number;
  /** Expected settlement minus strike, in dollars. */
  margin: number;
  /** Margin in units of sd; positive favours Up. */
  zScore: number;
}

export interface ForecastInputs {
  anchorMs: number;
  endMs: number;
  strike: number;
  twapNow: number;
  rawNow: number;
  rollingOutMean: number;
  rawSigma: number;
}

/**
 * Inside the final minute the settlement TWAP is a moving average that has
 * already absorbed most of its inputs. Over the next tau seconds it sheds its
 * oldest tau seconds and takes on tau seconds of new price:
 *
 *   E[TWAP_end] = TWAP_now + (tau / W) · (spot_now − mean of the leaving stretch)
 *
 * Only the incoming stretch is random; entering as an average, its variance
 * grows as tau³. Beyond tau = W the expectation is simply spot. Anchoring on
 * the published TWAP lets any constant offset between our raw integral and
 * Chainlink's cancel, so the TWAP is never reproduced from scratch.
 */
export function forecastSettlement(input: ForecastInputs): SettlementForecast | null {
  const tau = (input.endMs - input.anchorMs) / 1000;
  if (tau <= 0) return null;

  const expected = tau >= W ? input.rawNow : input.twapNow + (tau / W) * (input.rawNow - input.rollingOutMean);
  const a = Math.max(0, tau - W);
  const varFactor = ((tau ** 3 - a ** 3) / 3 - a * a * (tau - a)) / (W * W);
  const sd = input.rawSigma * Math.sqrt(varFactor);
  if (!(sd > 0)) return null;

  const margin = expected - input.strike;
  return {
    anchorMs: input.anchorMs,
    secondsToEnd: tau,
    twapNow: input.twapNow,
    rawNow: input.rawNow,
    rollingOutMean: input.rollingOutMean,
    expected,
    sd,
    margin,
    zScore: margin / sd,
  };
}

/** The stretch about to roll out of the average, in wall-clock ms. */
export function rollingOutRange(anchorMs: number, endMs: number): { fromMs: number; toMs: number } {
  const fromMs = anchorMs - W * 1000;
  return { fromMs, toMs: fromMs + Math.min((endMs - anchorMs) / 1000, W) * 1000 };
}
