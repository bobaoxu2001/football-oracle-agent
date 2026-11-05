"""Focused fee and EV tests; no historical match data is invented here."""

from decimal import ROUND_HALF_UP, Decimal

import pytest

from sports_ev.kalshi import (
    american_to_prob,
    evaluate_contract,
    recommend,
    taker_fee,
)


def test_historical_fee_rounds_up_per_order():
    assert taker_fee(0.305, 100) == 1.49
    assert taker_fee(0.305, 100, rate=0.0175) == 0.38
    assert taker_fee(0.5, 1) == 0.02
    assert taker_fee(0.5, 2) == 0.04
    assert taker_fee(0.5, 3) == 0.06
    assert taker_fee(0.5, 4) == 0.07
    assert taker_fee(0.3, 1, rate=0) == 0


def test_reference_ev_and_half_up_display():
    home = evaluate_contract(0.35, 0.305)
    draw = evaluate_contract(0.31, 0.285)
    away_yes = evaluate_contract(0.34, 0.478)
    away_no = evaluate_contract(0.34, 0.522, side="no")
    assert home["total_cost"] == pytest.approx(31.99)
    assert home["ev_cents"] == pytest.approx(3.01)
    assert draw["ev_cents"] == pytest.approx(1.07)
    assert away_yes["ev_cents"] == pytest.approx(-15.55)
    assert away_no["ev_cents"] == pytest.approx(12.05)

    def display(value):
        return Decimal(str(value)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)

    assert str(display(away_yes["ev_cents"])) == "-15.6"
    assert str(display(away_no["ev_cents"])) == "12.1"


def test_binary_kelly_and_roi():
    evaluation = evaluate_contract(0.34, 0.522, side="no")
    assert evaluation["probability"] == 0.66
    assert evaluation["kelly"] == pytest.approx((0.66 - 0.5395) / (1 - 0.5395))
    assert evaluation["roi"] == pytest.approx(0.1205 / 0.5395)
    assert evaluate_contract(0.34, 0.478)["kelly"] < 0
    expensive = evaluate_contract(1, 0.999, contracts=1)
    assert expensive["cost_per_contract"] > 1
    assert expensive["kelly"] == 0
    assert expensive["kelly_usable"] is False


def test_american_odds():
    assert american_to_prob(228) == pytest.approx(100 / 328)
    assert american_to_prob(251) == pytest.approx(100 / 351)
    assert american_to_prob(109) == pytest.approx(100 / 209)
    assert american_to_prob(-200) == pytest.approx(2 / 3)


def test_recommendation_shared_cap_and_quantity_fees():
    recommendations = recommend([0.35, 0.31, 0.34], [0.305, 0.285, 0.478], 1000)
    assert {(row["outcome"], row["side"]) for row in recommendations} == {
        ("home", "yes"),
        ("away", "no"),
    }
    assert sum(Decimal(str(row["stake"])) for row in recommendations) <= Decimal(20)
    for row in recommendations:
        evaluation = row["evaluation"]
        assert row["contracts"] == evaluation["contracts"]
        assert evaluation["ev_per_contract"] >= 0.03
        assert evaluation["fee"] == taker_fee(evaluation["price"], row["contracts"])
        assert row["spread_known"] is False
    home = next(row for row in recommendations if row["outcome"] == "home")
    assert home["contracts"] == 8
    assert home["evaluation"]["ev_cents"] == 3


def test_threshold_exact_and_negative_ev():
    assert recommend([0.35, 0.31, 0.34], [0.35, 0.31, 0.34], 1000) == []
    assert recommend([0.35, 0.31, 0.34], [0.305, 0.285, 0.478], 1000, min_edge=0.13) == []
    assert recommend([0.35, 0.31, 0.34], [0.305, 0.285, 0.478], 1) == []
    assert recommend([0.35, 0.31, 0.34], [0.305, 0.285, 0.478], 0) == []


def test_reference_quantity_and_maker_rate():
    recommendations = recommend(
        [0.35, 0.31, 0.34],
        [0.305, 0.285, 0.478],
        1000,
        contracts=2,
        fee_rate=0.0175,
    )
    assert {(row["outcome"], row["side"]) for row in recommendations} == {
        ("home", "yes"),
        ("away", "no"),
    }
    for row in recommendations:
        assert row["evaluation"]["fee_rate"] == 0.0175
        assert row["evaluation"]["fee"] == taker_fee(
            row["evaluation"]["price"], row["contracts"], rate=0.0175
        )
    with pytest.raises(ValueError):
        recommend([0.35, 0.31, 0.34], [0.305, 0.285, 0.478], 1000, contracts=0)


def test_large_bankroll_cap_and_zero_fraction():
    recommendations = recommend(
        [0.35, 0.31, 0.34],
        [0.305, 0.285, 0.478],
        10**12,
    )
    assert sum(Decimal(str(row["stake"])) for row in recommendations) <= Decimal(2 * 10**10)
    assert all(row["evaluation"]["ev_per_contract"] >= 0.03 for row in recommendations)
    assert recommend([0.35, 0.31, 0.34], [0.305, 0.285, 0.478], 1000, kelly_fraction=0) == []


def test_explicit_spread_changes_no_ev():
    quotes = {
        "home": {"yes_ask": 0.305, "yes_bid": 0.28},
        "draw": {"yes_ask": 0.285, "no_ask": 0.74},
        "away": {"yes_ask": 0.478, "yes_bid": 0.42},
    }
    recommendations = recommend({"home": 0.35, "draw": 0.31, "away": 0.34}, quotes, 1000)
    away = next(row for row in recommendations if row["outcome"] == "away")
    assert away["evaluation"]["price"] == 0.58
    assert away["spread_known"] is True
    assert away["quote_source"] == "complement_of_yes_bid"
    assert away["evaluation"]["ev_cents"] < 12.05


@pytest.mark.parametrize("price", [0, 1, -0.1, 1.1, float("nan"), float("inf"), True])
def test_invalid_price(price):
    with pytest.raises(ValueError):
        taker_fee(price, 100)


@pytest.mark.parametrize("quantity", [0, -1, 1.1, True])
def test_invalid_quantity(quantity):
    with pytest.raises(ValueError):
        evaluate_contract(0.5, 0.5, contracts=quantity)


@pytest.mark.parametrize("probability", [-0.1, 1.1, float("nan"), float("inf"), True])
def test_invalid_probability(probability):
    with pytest.raises(ValueError):
        evaluate_contract(probability, 0.5)


@pytest.mark.parametrize("rate", [-0.1, 1.1, float("nan"), float("inf"), True])
def test_invalid_rate(rate):
    with pytest.raises(ValueError):
        taker_fee(0.5, 100, rate=rate)


@pytest.mark.parametrize("odds", [0, float("nan"), float("inf"), True])
def test_invalid_odds(odds):
    with pytest.raises(ValueError):
        american_to_prob(odds)


def test_invalid_shapes_and_controls():
    with pytest.raises(ValueError, match="sum"):
        recommend([0.35, 0.31, 0.35], [0.305, 0.285, 0.478], 1000)
    with pytest.raises(ValueError):
        recommend({"home": 0.35}, [0.305, 0.285, 0.478], 1000)
    with pytest.raises(ValueError):
        recommend([0.35, 0.31, 0.34], [0.305, 0.285], 1000)
    with pytest.raises(ValueError):
        recommend([0.35, 0.31, 0.34], [0.305, 0.285, 0.478], -1)
    with pytest.raises(ValueError):
        evaluate_contract(0.5, 0.5, side="bad")
    with pytest.raises(ValueError):
        recommend([0.35, 0.31, 0.34], [0.305, 0.285, {"yes_ask": 0.478, "yes_bid": 0.5}], 1000)


@pytest.mark.parametrize(
    "quote",
    [
        {"yes_ask": 0.4, "yes_bid": 0.3, "no_ask": 0.5},
        {"yes_ask": 0.4, "no_bid": 0.5},
        {"yes_ask": 0.4, "no_ask": 0.5},
    ],
)
def test_inconsistent_reciprocal_quotes_fail(quote):
    with pytest.raises(ValueError):
        recommend([0.4, 0.3, 0.3], [quote, 0.3, 0.3], 1000)


def test_reciprocal_float_noise_is_not_an_invalid_spread():
    quote = {"yes_ask": 0.07, "no_ask": 1 - 0.07}
    recommendations = recommend([0.4, 0.3, 0.3], [quote, 0.3, 0.3], 1000)
    assert any(row["outcome"] == "home" and row["side"] == "yes" for row in recommendations)
