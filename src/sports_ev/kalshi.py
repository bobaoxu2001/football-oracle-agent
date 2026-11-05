"""Evaluate binary contracts without using market prices to make predictions.

Prices and probabilities are expressed as fractions (0.305 means 30.5 cents).
Fees implement the user-requested historical conservative estimate: each order's
``rate * contracts * price * (1 - price)`` fee is rounded UP to a whole cent.
This is an estimate, not a claim about every market's current fee schedule.
Use ``rate=0.0175`` for the requested maker-fee scenario; a maker order's fill
probability is not modeled. Pass executable ask quotes to model the spread.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal, InvalidOperation
from typing import Any

_ONE = Decimal(1)
_CENT = Decimal("0.01")
_OUTCOMES = ("home", "draw", "away")


def _number(value: Any, name: str) -> Decimal:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a finite number")
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError(f"{name} must be a finite number") from exc
    if not number.is_finite():
        raise ValueError(f"{name} must be a finite number")
    return number


def _probability(value: Any, name: str) -> Decimal:
    number = _number(value, name)
    if not 0 <= number <= 1:
        raise ValueError(f"{name} must be between 0 and 1")
    return number


def _price(value: Any, name: str = "price") -> Decimal:
    number = _number(value, name)
    if not 0 < number < 1:
        raise ValueError(f"{name} must be strictly between 0 and 1")
    return number


def _rate(value: Any) -> Decimal:
    number = _number(value, "fee_rate")
    if not 0 <= number <= 1:
        raise ValueError("fee_rate must be between 0 and 1")
    return number


def _contracts(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError("contracts must be a positive integer")
    return value


def _fee(price: Decimal, contracts: int, rate: Decimal) -> Decimal:
    return (rate * contracts * price * (_ONE - price)).quantize(_CENT, rounding=ROUND_CEILING)


def taker_fee(price: float, contracts: int, rate: float = 0.07) -> float:
    """Return the order fee in dollars, rounded up to a whole cent.

    ``price`` is the actual purchased side's price in dollars per contract.
    ``rate=0.0175`` selects the requested maker-fee estimate.
    """
    return float(_fee(_price(price), _contracts(contracts), _rate(rate)))


def american_to_prob(odds: float) -> float:
    """Convert finite, nonzero American odds to an implied probability.

    This is a price-conversion convenience, not a forecasting input.
    """
    number = _number(odds, "odds")
    if number == 0:
        raise ValueError("odds must be nonzero")
    if number > 0:
        return float(Decimal(100) / (number + Decimal(100)))
    return float(-number / (-number + Decimal(100)))


def _evaluate(
    p_model: Decimal,
    price: Decimal,
    side: str,
    contracts: int,
    fee_rate: Decimal,
) -> dict[str, Any]:
    probability = p_model if side == "yes" else _ONE - p_model
    fee = _fee(price, contracts, fee_rate)
    total_cost = price * contracts + fee
    cost = total_cost / contracts
    ev = probability - cost
    kelly_usable = cost < 1
    kelly = ev / (_ONE - cost) if kelly_usable else Decimal(0)
    return {
        "side": side,
        "p_model": float(p_model),
        "probability": float(probability),
        "price": float(price),
        "contracts": contracts,
        "fee_rate": float(fee_rate),
        "fee": float(fee),
        "total_cost": float(total_cost),
        "cost_per_contract": float(cost),
        "ev_per_contract": float(ev),
        "ev_cents": float(ev * 100),
        "expected_profit": float(ev * contracts),
        "roi": float(ev / cost),
        "kelly": float(kelly),
        "kelly_usable": kelly_usable,
    }


def evaluate_contract(
    p_model: float,
    price: float,
    side: str = "yes",
    contracts: int = 100,
    fee_rate: float = 0.07,
) -> dict[str, Any]:
    """Return cost, fee-adjusted EV, ROI, and the full binary Kelly fraction.

    ``p_model`` always describes the named outcome (e.g. away win). For a No
    contract, its win probability becomes ``1 - p_model``. ``price`` always
    describes the actual side being bought; this function never complements it.
    Kelly can be negative for negative EV. If fee-adjusted cost is at least $1,
    Kelly is reported as zero with ``kelly_usable=False``.
    """
    if side not in ("yes", "no"):
        raise ValueError("side must be 'yes' or 'no'")
    return _evaluate(
        _probability(p_model, "p_model"),
        _price(price),
        side,
        _contracts(contracts),
        _rate(fee_rate),
    )


def _three_values(values: Any, name: str) -> dict[str, Any]:
    if isinstance(values, Mapping):
        if set(values) != set(_OUTCOMES):
            raise ValueError(f"{name} must contain exactly home, draw, and away")
        return {outcome: values[outcome] for outcome in _OUTCOMES}
    if isinstance(values, Sequence) and not isinstance(values, (str, bytes)) and len(values) == 3:
        return dict(zip(_OUTCOMES, values, strict=True))
    raise ValueError(f"{name} must be a home/draw/away mapping or three values")


def _quotes(value: Any, outcome: str) -> dict[str, dict[str, Any]]:
    if not isinstance(value, Mapping):
        yes_price = _price(value, f"{outcome} price")
        return {
            "yes": {
                "price": yes_price,
                "quote_source": "yes_ask",
                "spread_known": False,
            },
            "no": {
                "price": _ONE - yes_price,
                "quote_source": "estimated_complement_of_yes_ask",
                "spread_known": False,
            },
        }
    allowed = {"yes_ask", "yes_bid", "no_ask", "no_bid"}
    if set(value) - allowed or "yes_ask" not in value:
        raise ValueError(
            f"{outcome} quotes require yes_ask and may contain yes_bid, no_ask, no_bid"
        )
    quotes = {key: _price(quote, f"{outcome} {key}") for key, quote in value.items()}
    if "yes_bid" in quotes and quotes["yes_bid"] > quotes["yes_ask"]:
        raise ValueError(f"{outcome} yes_bid cannot exceed yes_ask")
    if "no_bid" in quotes and "no_ask" in quotes:
        if quotes["no_bid"] > quotes["no_ask"]:
            raise ValueError(f"{outcome} no_bid cannot exceed no_ask")
    if "yes_bid" in quotes and "no_ask" in quotes:
        if abs(quotes["yes_bid"] + quotes["no_ask"] - _ONE) > Decimal("0.000000001"):
            raise ValueError(f"{outcome} no_ask must equal 1 - yes_bid")
    if "no_bid" in quotes:
        if abs(quotes["yes_ask"] + quotes["no_bid"] - _ONE) > Decimal("0.000000001"):
            raise ValueError(f"{outcome} yes_ask must equal 1 - no_bid")
    if (
        "no_ask" in quotes
        and quotes["yes_ask"] + quotes["no_ask"] < _ONE - Decimal("0.000000001")
    ):
        raise ValueError(f"{outcome} yes_ask + no_ask cannot be below 1")
    if "no_ask" in quotes:
        no_price = quotes["no_ask"]
        no_source = "no_ask"
        spread_known = True
    elif "yes_bid" in quotes:
        no_price = _ONE - quotes["yes_bid"]
        no_source = "complement_of_yes_bid"
        spread_known = True
    else:
        no_price = _ONE - quotes["yes_ask"]
        no_source = "estimated_complement_of_yes_ask"
        spread_known = False
    return {
        "yes": {
            "price": quotes["yes_ask"],
            "quote_source": "yes_ask",
            "spread_known": spread_known,
        },
        "no": {
            "price": no_price,
            "quote_source": no_source,
            "spread_known": spread_known,
        },
    }


def _affordable_contracts(budget: Decimal, price: Decimal, fee_rate: Decimal) -> int:
    low = 0
    high = int((budget / price).to_integral_value(rounding=ROUND_FLOOR))
    while low < high:
        middle = (low + high + 1) // 2
        cost = price * middle + _fee(price, middle, fee_rate)
        if cost <= budget:
            low = middle
        else:
            high = middle - 1
    return low


def recommend(
    match_probs: Mapping[str, float] | Sequence[float],
    kalshi_prices: Mapping[str, Any] | Sequence[Any],
    bankroll: float,
    min_edge: float = 0.03,
    kelly_fraction: float = 0.25,
    max_stake: float = 0.02,
    *,
    fee_rate: float = 0.07,
    contracts: int = 100,
) -> list[dict[str, Any]]:
    """Return eligible directions and integer-contract stake suggestions.

    Inputs use home/draw/away keys or that order in three-element sequences.
    Scalar prices are interpreted as Yes asks; No asks are estimated as their
    complements and flagged ``spread_known=False``. Supply ``yes_ask/no_ask``
    or ``yes_bid/yes_ask`` per outcome to account for the actual spread.

    ``min_edge`` is dollars per contract (0.03 means 3 cents). Eligibility is
    first screened at ``contracts`` (default 100), then rechecked with the suggested quantity
    and its actual rounded order fee. The 2% default cap is shared by all
    directions in this match. Stakes are scaled proportionally if necessary.
    These are independent binary Kelly estimates, not a jointly optimal
    portfolio across mutually exclusive football outcomes.
    """
    raw_probs = _three_values(match_probs, "match_probs")
    probabilities = {
        outcome: _probability(value, f"p_{outcome}") for outcome, value in raw_probs.items()
    }
    if abs(sum(probabilities.values()) - _ONE) > Decimal("0.000000001"):
        raise ValueError("match_probs must sum to 1")
    raw_prices = _three_values(kalshi_prices, "kalshi_prices")
    prices = {outcome: _quotes(value, outcome) for outcome, value in raw_prices.items()}
    funds = _number(bankroll, "bankroll")
    if funds < 0:
        raise ValueError("bankroll must be nonnegative")
    edge_threshold = _probability(min_edge, "min_edge")
    fraction = _probability(kelly_fraction, "kelly_fraction")
    cap_fraction = _probability(max_stake, "max_stake")
    rate = _rate(fee_rate)
    reference_quantity = _contracts(contracts)
    candidates = []
    for outcome in _OUTCOMES:
        for side in ("yes", "no"):
            quote = prices[outcome][side]
            evaluation = _evaluate(
                probabilities[outcome], quote["price"], side, reference_quantity, rate
            )
            # Keep comparisons in Decimal, including values exactly at the threshold.
            probability = probabilities[outcome] if side == "yes" else _ONE - probabilities[outcome]
            cost = (
                quote["price"] + _fee(quote["price"], reference_quantity, rate) / reference_quantity
            )
            edge = probability - cost
            if edge <= 0 or edge < edge_threshold or not evaluation["kelly_usable"]:
                continue
            kelly = edge / (_ONE - cost)
            candidates.append(
                {
                    "outcome": outcome,
                    "side": side,
                    "quote": quote,
                    "target_stake": funds * fraction * kelly,
                    "screen_ev": edge,
                }
            )
    total_target = sum((item["target_stake"] for item in candidates), Decimal(0))
    cap = funds * cap_fraction
    scale = min(_ONE, cap / total_target) if total_target > 0 else Decimal(0)
    recommendations = []
    for candidate in sorted(candidates, key=lambda item: item["screen_ev"], reverse=True):
        quote = candidate["quote"]
        quantity = _affordable_contracts(candidate["target_stake"] * scale, quote["price"], rate)
        if quantity == 0:
            continue
        outcome = candidate["outcome"]
        side = candidate["side"]
        probability = probabilities[outcome] if side == "yes" else _ONE - probabilities[outcome]
        # Per-order rounding can make 9 contracts fail a threshold that 8 pass.
        # A multiple of the screening lot always passes the same threshold,
        # bounding the search by reference_quantity even for a huge bankroll.
        minimum_quantity = max(1, quantity - reference_quantity + 1)
        while quantity >= minimum_quantity:
            fee = _fee(quote["price"], quantity, rate)
            stake = quote["price"] * quantity + fee
            edge = probability - stake / quantity
            if edge > 0 and edge >= edge_threshold:
                break
            quantity -= 1
        if quantity < minimum_quantity:
            continue
        evaluation = _evaluate(probabilities[outcome], quote["price"], side, quantity, rate)
        if not evaluation["kelly_usable"]:
            continue
        recommendations.append(
            {
                "outcome": outcome,
                "side": side,
                "contracts": quantity,
                "stake": float(stake),
                "stake_fraction": float(stake / funds),
                "evaluation": evaluation,
                "quote_source": quote["quote_source"],
                "spread_known": quote["spread_known"],
                "kelly_method": "independent_binary_scaled_to_match_cap",
            }
        )
    return recommendations
