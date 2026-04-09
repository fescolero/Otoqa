#!/usr/bin/env python3
"""v5_hybrid vs v4 benchmark runner with promotion scorecard.

Usage:
    python3 scripts/benchmark_v5_hybrid.py                          # uses default contracts list
    python3 scripts/benchmark_v5_hybrid.py contract1.json 9         # one contract, 9 drivers
    python3 scripts/benchmark_v5_hybrid.py a.json 9 b.json 10       # multiple contracts

Outputs a scorecard table and promotion verdict.
"""
import json
import sys
import time
from weekly_solver_v4 import (
    solve_weekly_v4_api, _corridor_of_leg, _row_quality_score, lanes_from_json,
    _compute_dh,
)


# Default contracts to benchmark (path, target_drivers)
DEFAULT_CONTRACTS = [
    ("917DK", "scripts/entries.json", 9),
]


def _extract_metrics(result, lane_map):
    """Extract all scorecard metrics from a solver result."""
    if not result or not result.get('success'):
        return None
    ws = result.get('weeklySchedule', [])
    if not ws:
        return None

    exact_days = 0
    est_days = 0
    max_day_dh = 0
    total_dh = 0
    worst_row_score = 0
    three_corr_rows = 0
    protected_pairs = set()  # (day, frozenset(legs)) — 2-leg same-corridor low-DH rows
    hos_violations = result.get('hosViolations', [])
    all_lanes_covered = set()

    for dr in ws:
        for dn, dd in dr.get('days', {}).items():
            legs = dd.get('legs', [])
            if not legs:
                continue
            if dd.get('isExact'):
                exact_days += 1
            else:
                est_days += 1
            day_dh = dd.get('deadheadMiles', 0)
            max_day_dh = max(max_day_dh, day_dh)
            total_dh += day_dh

            score = _row_quality_score(legs, lane_map, 1.0)
            worst_row_score = max(worst_row_score, score)

            corrs = set(_corridor_of_leg(lane_map[lid]) for lid in legs if lid in lane_map)
            if len(corrs) >= 3:
                three_corr_rows += 1

            # Identify "protected pair rows": 2 legs, same corridor, <20mi DH
            if len(legs) == 2 and len(corrs) == 1:
                la, lb = lane_map.get(legs[0]), lane_map.get(legs[1])
                if la and lb:
                    dh = _compute_dh(la, lb) + _compute_dh(lb, la)
                    if dh < 20:
                        protected_pairs.add((dn, frozenset(legs)))

            for lid in legs:
                all_lanes_covered.add((dn, lid))

    return {
        'drivers': result.get('driverCount', 0),
        'exact_days': exact_days,
        'estimated_days': est_days,
        'max_day_dh': max_day_dh,
        'total_dh': total_dh,
        'worst_row_score': worst_row_score,
        'three_plus_corridor_rows': three_corr_rows,
        'protected_pairs': protected_pairs,
        'all_lanes_covered': all_lanes_covered,
        'hos_violations': hos_violations,
        'hos_compliant': result.get('hosCompliant', False),
        'recommended_driver_count': result.get('recommendedDriverCount', result.get('driverCount', 0)),
        'min_legal_driver_count': result.get('minLegalDriverCount', result.get('driverCount', 0)),
    }


def _evaluate_scorecard(v4m, v5m, contract_name):
    """Apply promotion criteria and return (hard_gates_pass, high_wins, high_ties, medium_ok, issues)."""
    issues = []

    # --- Hard gates ---
    hard_pass = True
    if v5m['drivers'] > v4m['drivers']:
        issues.append(f"HARD FAIL: drivers {v5m['drivers']} > v4 {v4m['drivers']}")
        hard_pass = False
    if not v5m['hos_compliant']:
        issues.append(f"HARD FAIL: hosCompliant={v5m['hos_compliant']}")
        hard_pass = False
    if len(v5m['hos_violations']) > len(v4m['hos_violations']):
        issues.append(f"HARD FAIL: hos_violations {len(v5m['hos_violations'])} > v4 {len(v4m['hos_violations'])}")
        hard_pass = False
    if v5m['recommended_driver_count'] > v4m['recommended_driver_count']:
        issues.append(f"HARD FAIL: recommendedDriverCount {v5m['recommended_driver_count']} > v4 {v4m['recommended_driver_count']}")
        hard_pass = False
    if v5m['min_legal_driver_count'] > v4m['min_legal_driver_count']:
        issues.append(f"HARD FAIL: minLegalDriverCount {v5m['min_legal_driver_count']} > v4 {v4m['min_legal_driver_count']}")
        hard_pass = False

    # Protected pair regression: v4 had these pairs clean, v5 must too
    regressed_pairs = v4m['protected_pairs'] - v5m['protected_pairs']
    if regressed_pairs:
        issues.append(f"HARD FAIL: protected pairs regressed: {len(regressed_pairs)}")
        hard_pass = False

    # Coverage check (best effort — counts should match)
    if len(v5m['all_lanes_covered']) != len(v4m['all_lanes_covered']):
        issues.append(f"HARD FAIL: coverage mismatch v4={len(v4m['all_lanes_covered'])} v5={len(v5m['all_lanes_covered'])}")
        hard_pass = False

    # --- High-priority quality ---
    high_wins = 0
    high_ties = 0
    high_losses = 0
    high_details = []

    # Exact days: v5 >= v4
    if v5m['exact_days'] > v4m['exact_days']:
        high_wins += 1; high_details.append("exact WIN")
    elif v5m['exact_days'] == v4m['exact_days']:
        high_ties += 1; high_details.append("exact TIE")
    else:
        high_losses += 1; high_details.append("exact LOSS")

    # Worst row score: v5 <= v4
    if v5m['worst_row_score'] < v4m['worst_row_score']:
        high_wins += 1; high_details.append("worst_score WIN")
    elif v5m['worst_row_score'] == v4m['worst_row_score']:
        high_ties += 1; high_details.append("worst_score TIE")
    else:
        high_losses += 1; high_details.append("worst_score LOSS")

    # Max day DH: v5 <= v4
    if v5m['max_day_dh'] < v4m['max_day_dh']:
        high_wins += 1; high_details.append("max_dh WIN")
    elif v5m['max_day_dh'] == v4m['max_day_dh']:
        high_ties += 1; high_details.append("max_dh TIE")
    else:
        high_losses += 1; high_details.append("max_dh LOSS")

    # --- Medium priority ---
    medium_ok = True
    medium_details = []
    if v5m['three_plus_corridor_rows'] > v4m['three_plus_corridor_rows']:
        medium_ok = False
        medium_details.append(f"3+_corr LOSS ({v4m['three_plus_corridor_rows']}→{v5m['three_plus_corridor_rows']})")
    else:
        medium_details.append(f"3+_corr OK ({v4m['three_plus_corridor_rows']}→{v5m['three_plus_corridor_rows']})")

    # Total DH: tie/win if within 2%, allow up to 5% if high wins are clear
    dh_pct = (v5m['total_dh'] - v4m['total_dh']) / max(1, v4m['total_dh']) * 100
    if dh_pct <= 2:
        medium_details.append(f"total_dh OK ({dh_pct:+.1f}%)")
    elif dh_pct <= 5 and high_wins >= 2:
        medium_details.append(f"total_dh OK-with-high-wins ({dh_pct:+.1f}%)")
    else:
        medium_ok = False
        medium_details.append(f"total_dh LOSS ({dh_pct:+.1f}%)")

    # --- Veto conditions ---
    vetoed = False
    veto_reasons = []
    if v5m['max_day_dh'] > v4m['max_day_dh'] + 50:
        vetoed = True
        veto_reasons.append(f"max_dh up by {v5m['max_day_dh'] - v4m['max_day_dh']}mi (>50)")
    if v5m['exact_days'] <= v4m['exact_days'] - 2:
        vetoed = True
        veto_reasons.append(f"exact_days down by {v4m['exact_days'] - v5m['exact_days']} (>=2)")
    if regressed_pairs:
        vetoed = True
        veto_reasons.append(f"protected pair regression")

    return {
        'hard_pass': hard_pass,
        'high_wins': high_wins,
        'high_ties': high_ties,
        'high_losses': high_losses,
        'high_details': high_details,
        'medium_ok': medium_ok,
        'medium_details': medium_details,
        'vetoed': vetoed,
        'veto_reasons': veto_reasons,
        'issues': issues,
    }


def _print_comparison(name, v4m, v5m, scorecard, v4_time, v5_time):
    """Print a side-by-side comparison for one contract."""
    print(f"\n{'='*70}")
    print(f"CONTRACT: {name}")
    print('='*70)
    print(f"{'Metric':<30} {'v4':>10} {'v5_hybrid':>12} {'Delta':>10}")
    print('-' * 70)

    def row(label, v4v, v5v, better='lower'):
        if isinstance(v4v, (int, float)) and isinstance(v5v, (int, float)):
            delta = v5v - v4v
            if better == 'lower':
                mark = '✅' if delta <= 0 else '⚠️'
            else:
                mark = '✅' if delta >= 0 else '⚠️'
            print(f"{label:<30} {v4v:>10} {v5v:>12} {delta:>+10} {mark}")
        else:
            print(f"{label:<30} {str(v4v):>10} {str(v5v):>12}")

    row("drivers", v4m['drivers'], v5m['drivers'])
    row("exact_days", v4m['exact_days'], v5m['exact_days'], better='higher')
    row("estimated_days", v4m['estimated_days'], v5m['estimated_days'])
    row("max_day_dh", v4m['max_day_dh'], v5m['max_day_dh'])
    row("total_dh", v4m['total_dh'], v5m['total_dh'])
    row("worst_row_score", round(v4m['worst_row_score']), round(v5m['worst_row_score']))
    row("3+_corridor_rows", v4m['three_plus_corridor_rows'], v5m['three_plus_corridor_rows'])
    row("protected_pairs", len(v4m['protected_pairs']), len(v5m['protected_pairs']), better='higher')
    row("runtime_s", int(v4_time), int(v5_time))

    print('-' * 70)
    print(f"Hard gates: {'✅ PASS' if scorecard['hard_pass'] else '❌ FAIL'}")
    print(f"High priority: {scorecard['high_wins']}W {scorecard['high_ties']}T {scorecard['high_losses']}L")
    print(f"  " + " | ".join(scorecard['high_details']))
    print(f"Medium: {'✅ OK' if scorecard['medium_ok'] else '⚠️ '}")
    print(f"  " + " | ".join(scorecard['medium_details']))
    if scorecard['issues']:
        print(f"Issues:")
        for i in scorecard['issues']:
            print(f"  - {i}")
    if scorecard['vetoed']:
        print(f"❌ VETOED: {'; '.join(scorecard['veto_reasons'])}")


def _run_benchmark(contract_name, entries_path, target_drivers):
    """Run both v4 and v5_hybrid on a contract, return comparison."""
    print(f"\n\n{'#'*70}")
    print(f"# BENCHMARKING: {contract_name} ({entries_path}, target={target_drivers})")
    print(f"{'#'*70}")

    with open(entries_path) as f:
        entries = json.load(f)

    lanes = lanes_from_json(entries)
    lane_map = {l.id: l for l in lanes}

    # v4 baseline
    print(f"\n--- Running v4 ---")
    start = time.time()
    v4 = solve_weekly_v4_api(entries, {'best_of_n': 1, 'enable_local_optimize': True}, target_drivers)
    v4_time = time.time() - start
    v4m = _extract_metrics(v4, lane_map)
    if not v4m:
        print(f"v4 FAILED on {contract_name}")
        return None

    # v5_hybrid
    print(f"\n--- Running v5_hybrid ---")
    start = time.time()
    v5 = solve_weekly_v4_api(
        entries,
        {'solver_version': 'v5_hybrid', 'enable_local_optimize': True},
        target_drivers,
    )
    v5_time = time.time() - start
    v5m = _extract_metrics(v5, lane_map)
    if not v5m:
        print(f"v5_hybrid FAILED on {contract_name}")
        return None

    scorecard = _evaluate_scorecard(v4m, v5m, contract_name)
    _print_comparison(contract_name, v4m, v5m, scorecard, v4_time, v5_time)

    return {
        'name': contract_name,
        'v4': v4m,
        'v5': v5m,
        'scorecard': scorecard,
        'v4_time': v4_time,
        'v5_time': v5_time,
    }


def _print_promotion_verdict(results):
    """Apply promotion rule and print final verdict."""
    print(f"\n\n{'='*70}")
    print(f"PROMOTION VERDICT")
    print('='*70)

    if not results:
        print("No contracts benchmarked.")
        return

    # All hard gates must pass
    all_hard_pass = all(r['scorecard']['hard_pass'] for r in results)
    any_vetoed = any(r['scorecard']['vetoed'] for r in results)

    # ≥2 of N contracts: high wins ≥1 AND (wins+ties) ≥2
    passing_contracts = 0
    for r in results:
        sc = r['scorecard']
        if sc['high_wins'] >= 1 and (sc['high_wins'] + sc['high_ties']) >= 2:
            passing_contracts += 1

    threshold = max(2, len(results) - (len(results) // 3))  # "majority but ≥2"

    print(f"Contracts tested: {len(results)}")
    print(f"Hard gates: {'✅ all pass' if all_hard_pass else '❌ some fail'}")
    print(f"Vetoes: {'❌ at least one' if any_vetoed else '✅ none'}")
    print(f"Strong passing contracts: {passing_contracts}/{len(results)} (need ≥{threshold})")

    verdict_pass = all_hard_pass and not any_vetoed and passing_contracts >= threshold
    print()
    if verdict_pass:
        print(f"🎉 PROMOTE: v5_hybrid meets all criteria — safe to make default")
    else:
        print(f"⏸️  HOLD: v5_hybrid does NOT yet meet promotion criteria")

    print()
    for r in results:
        sc = r['scorecard']
        status = '✅' if (sc['hard_pass'] and not sc['vetoed']) else '❌'
        print(f"  {status} {r['name']}: hard={'PASS' if sc['hard_pass'] else 'FAIL'} "
              f"high={sc['high_wins']}W/{sc['high_ties']}T/{sc['high_losses']}L "
              f"{'VETOED' if sc['vetoed'] else ''}")


def main():
    args = sys.argv[1:]
    contracts = []
    if args:
        # Pair up args: path target_drivers path target_drivers ...
        i = 0
        while i < len(args):
            path = args[i]
            target = int(args[i+1]) if i+1 < len(args) else 9
            name = path.split('/')[-1].replace('.json', '')
            contracts.append((name, path, target))
            i += 2
    else:
        contracts = DEFAULT_CONTRACTS

    results = []
    for name, path, target in contracts:
        r = _run_benchmark(name, path, target)
        if r:
            results.append(r)

    _print_promotion_verdict(results)


if __name__ == '__main__':
    main()
