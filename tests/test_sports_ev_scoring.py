"""Scoring arithmetic and ledger integrity tests using explicitly synthetic rows."""

import math

import pytest

from sports_ev.scoring import log_loss, multiclass_brier, summarize


def row(**changes):
    record = {
        "date": "2030-01-01",
        "competition": "Synthetic test",
        "home": "Team A",
        "away": "Team B",
        "p_home": 0.6,
        "p_draw": 0.25,
        "p_away": 0.15,
        "top_score": "2-1",
        "result": "2-1",
        "ht_result": "1-0",
        "outcome": "home",
        "notes": "Synthetic test data, not a historical prediction.",
    }
    record.update(changes)
    return record


def test_three_class_scores_and_baselines():
    assert multiclass_brier([0.35, 0.31, 0.34], "home") == pytest.approx(0.6342)
    assert multiclass_brier([1 / 3] * 3, "draw") == pytest.approx(2 / 3)
    assert log_loss([1 / 3] * 3, "away") == pytest.approx(math.log(3))
    assert multiclass_brier({"home": 1, "draw": 0, "away": 0}, "home") == 0
    assert multiclass_brier([1, 0, 0], "away") == 2
    assert log_loss([1, 0, 0], "away") == math.inf


def test_summary_excludes_pending_and_uses_own_expected_hits():
    records = [
        row(),
        row(
            home="Team C",
            p_home=0.2,
            p_draw=0.3,
            p_away=0.5,
            top_score="0-1",
            result="0-1",
            ht_result="0-0",
            outcome="A",
        ),
        row(home="Team E", result="", ht_result="", outcome=""),
        row(
            home="Team G",
            p_home=0.2,
            p_draw=0.5,
            p_away=0.3,
            top_score="",
            result="1-0",
            ht_result="",
            outcome="home",
        ),
    ]
    summary = summarize(records)
    assert summary["total_matches"] == 4
    assert summary["settled_matches"] == 3
    assert summary["pending_matches"] == 1
    assert summary["most_likely_hits"] == 2
    assert summary["expected_hits"] == pytest.approx(0.6 + 0.5 + 0.5)
    assert summary["top_score_hits"] == 2
    assert summary["top_score_evaluated"] == 2
    assert summary["average_goals"] == pytest.approx(5 / 3)
    assert summary["mean_brier"] == pytest.approx((0.245 + 0.38 + 0.98) / 3)
    assert summary["mean_log_loss"] == pytest.approx(-math.log(0.6 * 0.5 * 0.2) / 3)


def test_result_can_derive_outcome_and_ties_are_deterministic():
    summary = summarize([row(p_home=1 / 3, p_draw=1 / 3, p_away=1 / 3, outcome="")])
    assert summary["most_likely_hits"] == 1
    assert summary["expected_hits"] == pytest.approx(1 / 3)


def test_no_false_accuracy_when_unsettled_or_reconstructed():
    summary = summarize(
        [
            row(result="", ht_result="", outcome=""),
            row(home="Old team", notes='{"forecast_type":"retrospective"}'),
            row(home="Unverified team", notes='{"forecast_type":"historical_unverified"}'),
        ]
    )
    assert summary["settled_matches"] == 0
    assert summary["pending_matches"] == 1
    assert summary["excluded_matches"] == 2
    assert summary["mean_brier"] is None
    assert summary["mean_log_loss"] is None
    assert summary["average_goals"] is None
    assert summarize([])["total_matches"] == 0


def test_outcome_only_has_no_invented_goals_or_exact_score():
    summary = summarize([row(result="", ht_result="")])
    assert summary["settled_matches"] == 1
    assert summary["average_goals"] is None
    assert summary["top_score_evaluated"] == 0


@pytest.mark.parametrize(
    "probabilities",
    [
        [0.4, 0.4, 0.4],
        [0.4, 0.6],
        [-0.1, 0.5, 0.6],
        [True, 0, 0],
        [float("nan"), 0, 1],
        [float("inf"), 0, 1],
    ],
)
def test_invalid_probabilities_are_not_normalized(probabilities):
    with pytest.raises(ValueError):
        multiclass_brier(probabilities, "home")


@pytest.mark.parametrize(
    "changes,match",
    [
        ({"result": "0-1", "outcome": "home", "ht_result": ""}, "conflicts"),
        ({"ht_result": "3-0"}, "half-time"),
        ({"result": "unknown"}, "result"),
        ({"top_score": "2-1 or 1-0"}, "top_score"),
        ({"outcome": "win"}, "outcome"),
        ({"p_home": ""}, "probabilities"),
    ],
)
def test_invalid_rows_fail_with_row_number(changes, match):
    with pytest.raises(ValueError, match=f"row 1: .*{match}"):
        summarize([row(**changes)])


def test_duplicate_fixture_does_not_inflate_sample():
    with pytest.raises(ValueError, match="duplicate fixture"):
        summarize([row(), row()])


def test_dataframe_protocol_without_pandas_dependency():
    class Frame:
        def to_dict(self, orient):
            assert orient == "records"
            return [row()]

    assert summarize(Frame())["settled_matches"] == 1


@pytest.mark.parametrize("field", ["date", "competition", "home", "away"])
def test_missing_fixture_identity_is_rejected(field):
    with pytest.raises(ValueError, match="must all be present"):
        summarize([row(**{field: ""})])


@pytest.mark.parametrize(
    "generated,cutoff",
    [
        ("2026-10-13T20:00:00Z", "2026-10-13T18:00:00Z"),
        ("2026-10-13T18:00:00Z", "2026-10-13T20:00:00Z"),
        ("2026-10-13T17:00:00Z", "2026-10-13T18:00:00Z"),
        ("2026-10-13T19:00:00Z", "2026-10-13T18:00:00Z"),
        ("2026-10-13T17:00:00", "2026-10-13T17:00:00Z"),
    ],
)
def test_prospective_time_contradictions_cannot_enter_accuracy(generated, cutoff):
    import json

    notes = json.dumps(
        {
            "forecast_type": "prospective_manual",
            "generated_at": generated,
            "cutoff_at": cutoff,
            "kickoff_at": "2026-10-13T19:00:00Z",
        }
    )
    with pytest.raises(ValueError):
        summarize([row(notes=notes)])


def test_valid_prospective_metadata_is_scored_after_settlement():
    notes = (
        '{"forecast_type":"prospective_manual",'
        '"generated_at":"2026-10-13T03:49:24Z",'
        '"cutoff_at":"2026-10-13T03:49:24Z",'
        '"kickoff_at":"2026-10-13T19:00:00Z"}'
    )
    assert summarize([row(notes=notes)])["settled_matches"] == 1
