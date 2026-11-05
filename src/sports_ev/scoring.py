"""Score recorded forecasts without counting pending or reconstructed matches.

Brier uses the unscaled three-class sum (uniform baseline 2/3). Log loss uses
natural logs and deliberately returns infinity for a zero-probability outcome.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Iterable, Mapping, Sequence
from datetime import date, datetime
from typing import Any

_OUTCOMES = ("home", "draw", "away")
_OUTCOME_ALIASES = {
    "home": "home",
    "h": "home",
    "主胜": "home",
    "draw": "draw",
    "d": "draw",
    "平": "draw",
    "平局": "draw",
    "away": "away",
    "a": "away",
    "客胜": "away",
}
_EXCLUDED_TYPES = {"retrospective", "reconstructed", "historical_unverified"}


def _missing(value: Any) -> bool:
    return (
        value is None
        or (isinstance(value, str) and not value.strip())
        or (isinstance(value, float) and math.isnan(value))
    )


def _probabilities(probs: Mapping[str, float] | Sequence[float]) -> tuple[float, ...]:
    if isinstance(probs, Mapping):
        if set(probs) != set(_OUTCOMES):
            raise ValueError("probabilities require exactly home, draw, away")
        raw = [probs[key] for key in _OUTCOMES]
    elif isinstance(probs, Sequence) and not isinstance(probs, (str, bytes)):
        raw = list(probs)
        if len(raw) != 3:
            raise ValueError("probabilities require three values")
    else:
        raise ValueError("probabilities require a mapping or three-value sequence")
    values = []
    for value in raw:
        if isinstance(value, bool):
            raise ValueError("probabilities must be finite numbers between 0 and 1")
        try:
            number = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError("probabilities must be finite numbers between 0 and 1") from exc
        if not math.isfinite(number) or not 0 <= number <= 1:
            raise ValueError("probabilities must be finite numbers between 0 and 1")
        values.append(number)
    if not math.isclose(math.fsum(values), 1.0, rel_tol=0, abs_tol=1e-9):
        raise ValueError("probabilities must sum to 1; they are never silently normalized")
    return tuple(values)


def _outcome(value: Any) -> str:
    if not isinstance(value, str) or value.strip().lower() not in _OUTCOME_ALIASES:
        raise ValueError("outcome must be home, draw, or away (H/D/A also accepted)")
    return _OUTCOME_ALIASES[value.strip().lower()]


def multiclass_brier(probs: Mapping[str, float] | Sequence[float], outcome: str) -> float:
    """Return sum((probability - one_hot_outcome)**2), in the range [0, 2]."""
    values = _probabilities(probs)
    target = _outcome(outcome)
    return math.fsum((p - int(key == target)) ** 2 for key, p in zip(_OUTCOMES, values))


def log_loss(probs: Mapping[str, float] | Sequence[float], outcome: str) -> float:
    """Return -ln(probability of the realised outcome), without epsilon clipping."""
    values = _probabilities(probs)
    probability = values[_OUTCOMES.index(_outcome(outcome))]
    return -math.log(probability) if probability else math.inf


def _score(value: Any, field: str) -> tuple[int, int] | None:
    if _missing(value):
        return None
    match = re.fullmatch(r"\s*(\d+)\s*[-:]\s*(\d+)\s*", str(value))
    if not match:
        raise ValueError(f"{field} must be a home-away score such as 2-1")
    return int(match[1]), int(match[2])


def _score_outcome(score: tuple[int, int]) -> str:
    return "home" if score[0] > score[1] else "away" if score[0] < score[1] else "draw"


def _metadata(row: Mapping[str, Any]) -> dict[str, Any]:
    notes = row.get("notes")
    if not isinstance(notes, str):
        return {}
    try:
        metadata = json.loads(notes)
    except (ValueError, TypeError):
        return {}
    return metadata if isinstance(metadata, dict) else {}


def _forecast_type(row: Mapping[str, Any]) -> str:
    if not _missing(row.get("forecast_type")):
        return str(row["forecast_type"]).strip().lower()
    return str(_metadata(row).get("forecast_type", "")).lower()


def _timestamp(value: Any, name: str) -> datetime:
    try:
        timestamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{name} must be a timezone-aware ISO timestamp") from exc
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        raise ValueError(f"{name} must be a timezone-aware ISO timestamp")
    return timestamp


def _validate_time(row: Mapping[str, Any]) -> None:
    metadata = _metadata(row)
    if not _forecast_type(row).startswith("prospective"):
        return
    generated = _timestamp(metadata.get("generated_at"), "generated_at")
    cutoff = _timestamp(metadata.get("cutoff_at"), "cutoff_at")
    kickoff = _timestamp(metadata.get("kickoff_at"), "kickoff_at")
    if generated >= kickoff or cutoff >= kickoff:
        raise ValueError("prospective forecast generated_at and cutoff_at must precede kickoff_at")
    if cutoff > generated:
        raise ValueError("cutoff_at cannot follow generated_at")


def _records(log_df: Any) -> list[Mapping[str, Any]]:
    # pandas is optional; its DataFrame can be supplied without importing it here.
    if hasattr(log_df, "to_dict") and not isinstance(log_df, Mapping):
        rows = log_df.to_dict(orient="records")
    elif isinstance(log_df, Iterable) and not isinstance(log_df, (str, bytes, Mapping)):
        rows = list(log_df)
    else:
        raise ValueError("log_df must be a DataFrame or iterable of row mappings")
    if any(not isinstance(row, Mapping) for row in rows):
        raise ValueError("every prediction row must be a mapping")
    return rows


def summarize(log_df: Any) -> dict[str, Any]:
    """Summarize settled independent matches; pending rows never improve accuracy.

    ``result`` is the regulation-time full-time score, not a penalty shoot-out.
    A result can derive the outcome; an explicitly supplied outcome must agree.
    Reconstructed/unverified historical rows are excluded when marked in notes
    JSON. Duplicate fixture keys fail rather than inflating the match count.
    The highest-probability class breaks ties in home/draw/away order.
    """
    rows = _records(log_df)
    briers, losses, expected_hits, goals = [], [], [], []
    settled = pending = excluded = hits = score_hits = score_evaluated = 0
    identities = set()
    for index, row in enumerate(rows, 1):
        if _forecast_type(row) in _EXCLUDED_TYPES:
            excluded += 1
            continue
        try:
            identity = tuple(
                "" if _missing(row.get(key)) else str(row[key]).strip()
                for key in ("date", "competition", "home", "away")
            )
            if not all(identity):
                raise ValueError("date, competition, home, and away must all be present")
            date.fromisoformat(identity[0])
            if identity[2] == identity[3]:
                raise ValueError("home and away must be different teams")
            if identity in identities:
                raise ValueError(f"duplicate fixture {identity}")
            identities.add(identity)
            _validate_time(row)
            values = _probabilities([row.get("p_home"), row.get("p_draw"), row.get("p_away")])
            actual_score = _score(row.get("result"), "result")
            half_score = _score(row.get("ht_result"), "ht_result")
            top_score = _score(row.get("top_score"), "top_score")
            target = None if _missing(row.get("outcome")) else _outcome(row["outcome"])
            if actual_score:
                from_score = _score_outcome(actual_score)
                if target and target != from_score:
                    raise ValueError("outcome conflicts with the full-time result")
                target = from_score
                if half_score and any(h > f for h, f in zip(half_score, actual_score)):
                    raise ValueError("half-time score exceeds the full-time result")
            if target is None:
                pending += 1
                continue
            settled += 1
            briers.append(multiclass_brier(values, target))
            losses.append(log_loss(values, target))
            predicted_index = max(range(3), key=values.__getitem__)
            hits += int(_OUTCOMES[predicted_index] == target)
            expected_hits.append(values[predicted_index])
            if actual_score:
                goals.append(sum(actual_score))
                if top_score:
                    score_evaluated += 1
                    score_hits += int(top_score == actual_score)
        except ValueError as exc:
            raise ValueError(f"row {index}: {exc}") from exc
    return {
        "total_matches": len(rows),
        "settled_matches": settled,
        "pending_matches": pending,
        "excluded_matches": excluded,
        "mean_brier": math.fsum(briers) / settled if settled else None,
        "baseline_brier": 2 / 3,
        "mean_log_loss": math.fsum(losses) / settled if settled else None,
        "baseline_log_loss": math.log(3),
        "most_likely_hits": hits,
        "expected_hits": math.fsum(expected_hits),
        "top_score_hits": score_hits,
        "top_score_evaluated": score_evaluated,
        "average_goals": math.fsum(goals) / len(goals) if goals else None,
        "goals_evaluated": len(goals),
    }
