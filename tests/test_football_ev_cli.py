"""Exercise the public CLI with real subprocesses and execution prices."""

from __future__ import annotations

import csv
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "football_ev.py"
EV_ARGS = ["ev", "--probs", "0.35", "0.31", "0.34", "--prices", "30.5", "28.5", "47.8"]


def run_cli(*arguments: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *arguments],
        capture_output=True,
        text=True,
        check=False,
        cwd=cwd,
    )


def test_ev_reports_all_six_sides_and_zero_spread_assumption(tmp_path):
    result = run_cli(*EV_ARGS, cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    lines = result.stdout.splitlines()
    rows = [line for line in lines if " | " in line][1:]
    assert len(rows) == 6
    assert "零价差" in result.stdout
    assert any(line.startswith("客胜-No |") and "+12.1¢" in line for line in rows)
    assert any(line.startswith("客胜-Yes |") and "-15.6¢" in line for line in rows)
    assert any(line.startswith("主胜-Yes |") and "+3.0¢" in line for line in rows)
    assert any(line.startswith("平局-Yes |") and "+1.1¢" in line for line in rows)
    suggestions = result.stdout.split("建议（", 1)[1]
    assert "平局-Yes：" not in suggestions


def test_yes_bid_and_explicit_no_ask_produce_same_evaluation():
    from_bids = run_cli(*EV_ARGS, "--bids", "29", "27", "46")
    from_asks = run_cli(*EV_ARGS, "--no-prices", "71", "73", "54")
    assert from_bids.returncode == from_asks.returncode == 0
    bid_rows = [line for line in from_bids.stdout.splitlines() if " | " in line]
    ask_rows = [line for line in from_asks.stdout.splitlines() if " | " in line]
    assert bid_rows == ask_rows
    assert "零价差" not in from_bids.stdout
    assert "零价差" not in from_asks.stdout


def test_maker_alias_matches_explicit_fee_rate():
    maker = run_cli(*EV_ARGS, "--maker")
    explicit = run_cli(*EV_ARGS, "--fee-rate", "0.0175")
    assert maker.returncode == explicit.returncode == 0
    assert maker.stdout == explicit.stdout


def test_invalid_probability_sum_and_ambiguous_quotes_are_errors():
    bad_sum = run_cli("ev", "--probs", "0.5", "0.5", "0.5", "--prices", "30", "30", "40")
    conflicting = run_cli(*EV_ARGS, "--no-prices", "70", "70", "50", "--bids", "30", "30", "50")
    assert bad_sum.returncode == conflicting.returncode == 2
    assert "概率总和须为 1" in bad_sum.stderr


def test_crossed_yes_bid_is_rejected_before_printing_evaluations():
    result = run_cli(*EV_ARGS, "--bids", "35", "27", "46")
    assert result.returncode == 2
    assert "卖出价不能高于" in result.stderr
    assert "主胜-Yes |" not in result.stdout


def test_high_minimum_edge_gives_no_recommendations():
    result = run_cli(*EV_ARGS, "--min-edge", "0.50")
    assert result.returncode == 0, result.stderr
    assert "无满足门槛的下注方向" in result.stdout


def test_pending_prediction_is_not_reported_as_history(tmp_path):
    path = tmp_path / "pending.csv"
    with path.open("w", newline="", encoding="utf-8") as target:
        writer = csv.DictWriter(
            target,
            fieldnames=[
                "date",
                "competition",
                "home",
                "away",
                "p_home",
                "p_draw",
                "p_away",
                "top_score",
                "lean",
                "result",
                "ht_result",
                "outcome",
                "notes",
            ],
        )
        writer.writeheader()
        writer.writerow(
            {
                "date": "2026-10-14",
                "competition": "Test",
                "home": "A",
                "away": "B",
                "p_home": "0.35",
                "p_draw": "0.31",
                "p_away": "0.34",
                "top_score": "1-1",
                "lean": "home",
                "notes": "新预测，尚未结算",
            }
        )
    result = run_cli("score", str(path))
    assert result.returncode == 0, result.stderr
    assert "已结算：0；待结算：1" in result.stdout
    assert "平均 Brier：N/A" in result.stdout
    assert "平均对数损失：N/A" in result.stdout
    assert "最可能结果命中：N/A" in result.stdout


def test_score_missing_file_has_clear_error(tmp_path):
    result = run_cli("score", str(tmp_path / "missing.csv"))
    assert result.returncode == 2
    assert "missing.csv" in result.stderr


def test_zero_probability_realized_outcome_reports_infinite_log_loss(tmp_path):
    path = tmp_path / "settled.csv"
    path.write_text(
        "date,competition,home,away,p_home,p_draw,p_away,top_score,result,outcome\n"
        "2030-01-01,Synthetic,A,B,0,0.5,0.5,1-1,2-0,home\n",
        encoding="utf-8",
    )
    result = run_cli("score", str(path))
    assert result.returncode == 0, result.stderr
    assert "平均对数损失：∞" in result.stdout


def test_no_price_complement_does_not_round_fee_up_from_float_noise():
    result = run_cli("ev", "--probs", "0.7", "0.2", "0.1", "--prices", "70", "20", "10")
    assert result.returncode == 0, result.stderr
    row = next(line for line in result.stdout.splitlines() if line.startswith("主胜-No |"))
    assert "$31.47" in row
    assert "$31.48" not in row


def test_inconsistent_yes_and_no_asks_are_rejected():
    result = run_cli(*EV_ARGS, "--no-prices", "50", "50", "50")
    assert result.returncode == 2
    assert "cannot be below 1" in result.stderr
