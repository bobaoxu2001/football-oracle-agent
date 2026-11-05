#!/usr/bin/env python3
"""在独立预测完成后计算 Kalshi EV，并汇总预测记录。"""

from __future__ import annotations

import argparse
import csv
import math
import sys
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

# 支持从任意工作目录直接运行此脚本，且不依赖项目已安装。
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from sports_ev.kalshi import evaluate_contract, recommend  # noqa: E402
from sports_ev.scoring import summarize  # noqa: E402

OUTCOMES = ("home", "draw", "away")
OUTCOME_LABELS = {"home": "主胜", "draw": "平局", "away": "客胜"}


def _finite_number(value: str) -> float:
    try:
        number = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("请输入有效数字。") from exc
    if not math.isfinite(number):
        raise argparse.ArgumentTypeError("数字必须有限，不能使用 NaN 或无穷大。")
    return number


def _probability(value: str) -> float:
    number = _finite_number(value)
    if not 0 <= number <= 1:
        raise argparse.ArgumentTypeError("概率须在 0 到 1 之间，例如 0.35。")
    return number


def _price_cents(value: str) -> float:
    number = _finite_number(value)
    if not 0 < number < 100:
        raise argparse.ArgumentTypeError("报价单位为分，须大于 0 且小于 100。")
    return number


def _positive_number(value: str) -> float:
    number = _finite_number(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("金额须大于 0。")
    return number


def _positive_integer(value: str) -> int:
    try:
        number = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("合约份数须为正整数。") from exc
    if number <= 0:
        raise argparse.ArgumentTypeError("合约份数须为正整数。")
    return number


def _format_decimal(value: float, places: int = 1, signed: bool = False) -> str:
    rounded = Decimal(str(value)).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)
    return format(rounded, f"{'+' if signed else ''}.{places}f")


def _format_metric(value: float | None, places: int = 3) -> str:
    if value is None:
        return "N/A"
    if math.isinf(value):
        return "∞" if value > 0 else "-∞"
    return _format_decimal(value, places)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    ev = subparsers.add_parser("ev", help="比较三项独立概率和 Kalshi 报价")
    ev.add_argument(
        "--probs",
        nargs=3,
        type=_probability,
        required=True,
        metavar=("主胜", "平局", "客胜"),
        help="模型概率，总和须为 1",
    )
    ev.add_argument(
        "--prices",
        nargs=3,
        type=_price_cents,
        required=True,
        metavar=("主胜", "平局", "客胜"),
        help="三个结果的 Yes 买入价，单位为分",
    )
    quotes = ev.add_mutually_exclusive_group()
    quotes.add_argument(
        "--no-prices",
        nargs=3,
        type=_price_cents,
        metavar=("主胜", "平局", "客胜"),
        help="真实 No 买入价，单位为分",
    )
    quotes.add_argument(
        "--bids",
        nargs=3,
        type=_price_cents,
        metavar=("主胜", "平局", "客胜"),
        help="真实 Yes 卖出价，单位为分；No 买入价 = 100 - Yes 卖出价",
    )
    ev.add_argument(
        "--bankroll", type=_positive_number, default=1000.0, help="资金（美元），默认 1000"
    )
    ev.add_argument(
        "--contracts", type=_positive_integer, default=100, help="评估订单份数，默认 100"
    )
    fees = ev.add_mutually_exclusive_group()
    fees.add_argument("--fee-rate", type=_probability, default=0.07, help="手续费率，默认 0.07")
    fees.add_argument(
        "--maker",
        dest="fee_rate",
        action="store_const",
        const=0.0175,
        help="使用 maker 示例费率 0.0175",
    )
    ev.add_argument(
        "--min-edge", type=_probability, default=0.03, help="扣费后最低 EV（美元/份），默认 0.03"
    )
    ev.add_argument(
        "--kelly-fraction", type=_probability, default=0.25, help="Kelly 倍数，默认 0.25"
    )
    ev.add_argument(
        "--max-stake", type=_probability, default=0.02, help="单场总投入占资金的上限，默认 0.02"
    )

    score = subparsers.add_parser("score", help="汇总 CSV 中已结算的预测准确度")
    score.add_argument("path", type=Path, help="预测记录表路径")
    return parser


def _run_ev(args: argparse.Namespace) -> None:
    if not math.isclose(sum(args.probs), 1.0, rel_tol=0, abs_tol=1e-9):
        raise ValueError("主胜、平局、客胜的概率总和须为 1。")
    if args.bids is not None and any(
        bid > ask for bid, ask in zip(args.bids, args.prices, strict=True)
    ):
        raise ValueError("Yes 卖出价不能高于对应的 Yes 买入价。")

    model_probs = dict(zip(OUTCOMES, args.probs, strict=True))
    prices = {}
    for index, outcome in enumerate(OUTCOMES):
        quote = {"yes_ask": Decimal(str(args.prices[index])) / 100}
        if args.no_prices is not None:
            quote["no_ask"] = Decimal(str(args.no_prices[index])) / 100
        elif args.bids is not None:
            quote["yes_bid"] = Decimal(str(args.bids[index])) / 100
        prices[outcome] = quote

    if args.no_prices is None and args.bids is None:
        print("报价假设：没有真实 No 买入价或 Yes 卖出价，按零价差估算 No = 100 - Yes。")
        print("No 方向的结果仅用于情景评估，请使用可成交报价更新。")
    elif args.bids is not None:
        print("报价：Yes 使用买入价；No 使用 100 - Yes 卖出价，已计入价差。")
    else:
        print("报价：Yes 与 No 均使用提供的买入价，已计入价差。")
    print(f"手续费估算率：{args.fee_rate:g}；每笔订单手续费按指定公式向上取整到分。")
    print("方向 | 含费成本/份 | 订单总成本 | EV/份 | ROI | 完整 Kelly")
    for index, outcome in enumerate(OUTCOMES):
        yes_price = prices[outcome]["yes_ask"]
        if args.no_prices is not None:
            no_price = prices[outcome]["no_ask"]
        elif args.bids is not None:
            no_price = Decimal(1) - prices[outcome]["yes_bid"]
        else:
            no_price = Decimal(1) - yes_price
        for side, price in (("yes", yes_price), ("no", no_price)):
            evaluation = evaluate_contract(
                model_probs[outcome],
                price,
                side=side,
                contracts=args.contracts,
                fee_rate=args.fee_rate,
            )
            kelly = (
                f"{_format_decimal(evaluation['kelly'] * 100, signed=True)}%"
                if evaluation["kelly_usable"]
                else "N/A（成本≥$1）"
            )
            print(
                f"{OUTCOME_LABELS[outcome]}-{side.title()} | "
                f"{_format_decimal(evaluation['cost_per_contract'] * 100)}¢ | "
                f"${_format_decimal(evaluation['total_cost'], 2)} | "
                f"{_format_decimal(evaluation['ev_cents'], signed=True)}¢ | "
                f"{_format_decimal(evaluation['roi'] * 100, signed=True)}% | "
                f"{kelly}"
            )

    recommendations = recommend(
        model_probs,
        prices,
        args.bankroll,
        min_edge=args.min_edge,
        kelly_fraction=args.kelly_fraction,
        max_stake=args.max_stake,
        contracts=args.contracts,
        fee_rate=args.fee_rate,
    )
    print(
        f"建议（最低 EV {_format_decimal(args.min_edge * 100)}¢/份，"
        f"{args.kelly_fraction:g} Kelly，单场总投入上限 "
        f"${_format_decimal(args.bankroll * args.max_stake, 2)}）："
    )
    if not recommendations:
        print("无满足门槛的下注方向。")
        return
    for recommendation in recommendations:
        label = OUTCOME_LABELS[recommendation["outcome"]]
        print(
            f"  {label}-{recommendation['side'].title()}："
            f"{recommendation['contracts']} 份，含费投入 "
            f"${_format_decimal(recommendation['stake'], 2)}；"
            f"EV {_format_decimal(recommendation['evaluation']['ev_cents'], signed=True)}¢/份"
        )


def _run_score(args: argparse.Namespace) -> None:
    with args.path.open(newline="", encoding="utf-8-sig") as source:
        reader = csv.DictReader(source)
        if reader.fieldnames is None:
            raise ValueError("CSV 缺少字段名。")
        stats = summarize(list(reader))
    print(
        f"场次：{stats['total_matches']}；已结算：{stats['settled_matches']}；"
        f"待结算：{stats['pending_matches']}；排除：{stats['excluded_matches']}"
    )
    print(
        f"平均 Brier：{_format_metric(stats['mean_brier'])}；"
        f"均匀概率基准：{_format_metric(stats['baseline_brier'])}"
    )
    print(
        f"平均对数损失：{_format_metric(stats['mean_log_loss'])}；"
        f"ln 3 基准：{_format_metric(stats['baseline_log_loss'])}"
    )
    if stats["settled_matches"]:
        print(
            f"最可能结果命中：{stats['most_likely_hits']}/{stats['settled_matches']}；"
            f"按模型概率的期望命中：{_format_metric(stats['expected_hits'], 2)}"
        )
    else:
        print("最可能结果命中：N/A；按模型概率的期望命中：N/A")
    top_score = (
        f"{stats['top_score_hits']}/{stats['top_score_evaluated']}"
        if stats["top_score_evaluated"]
        else "N/A"
    )
    print(f"首选比分命中：{top_score}")
    print(f"场均进球：{_format_metric(stats['average_goals'], 2)}")


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "ev":
            _run_ev(args)
        else:
            _run_score(args)
    except (ValueError, OSError) as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
