"""Football prediction scoring and conservative Kalshi EV estimates."""

from .kalshi import american_to_prob, evaluate_contract, recommend, taker_fee

__all__ = ["american_to_prob", "evaluate_contract", "recommend", "taker_fee"]
