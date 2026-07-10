#!/usr/bin/env python3
"""Convert the lane import CSV to solver-compatible CSV."""
import csv
import sys

input_path = sys.argv[1]
output_path = sys.argv[2] if len(sys.argv) > 2 else 'scripts/lanes_from_import.csv'

# Known coordinates for cities in this contract
CITY_COORDS = {
    ('colton', 'ca'): (34.0430, -117.3333),
    ('san diego', 'ca'): (32.9849, -117.0801),
    ('las vegas', 'nv'): (36.1699, -115.1398),
    ('santa ana', 'ca'): (33.7455, -117.8677),
    ('san bernardino', 'ca'): (34.1083, -117.2898),
    ('moreno valley', 'ca'): (33.9425, -117.2297),
    ('city of industry', 'ca'): (33.9547, -117.9187),
    ('anaheim', 'ca'): (33.8366, -117.9143),
}

# Approximate distances and drive times between cities (miles, hours)
ROUTE_DATA = {
    ('colton', 'san diego'): (82.2, 1.32),
    ('san diego', 'colton'): (82.8, 1.41),
    ('colton', 'las vegas'): (259.0, 4.0),
    ('las vegas', 'colton'): (226.4, 3.4),
    ('colton', 'santa ana'): (50.4, 0.9),
    ('santa ana', 'colton'): (51.6, 0.9),
    ('colton', 'san bernardino'): (9.1, 0.2),
    ('san bernardino', 'colton'): (8.6, 0.2),
    ('colton', 'moreno valley'): (14.2, 0.3),
    ('moreno valley', 'colton'): (15.2, 0.4),
    ('colton', 'city of industry'): (41.1, 0.8),
    ('city of industry', 'colton'): (43.5, 0.8),
    ('colton', 'anaheim'): (34.1, 0.6),
    ('anaheim', 'colton'): (35.8, 0.7),
}

def get_coords(city, state):
    key = (city.lower().strip(), state.lower().strip())
    return CITY_COORDS.get(key, (None, None))

def get_route(orig_city, dest_city):
    key = (orig_city.lower().strip(), dest_city.lower().strip())
    return ROUTE_DATA.get(key, (0, 0))

with open(input_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f)
    rows = list(reader)

header = [
    'id', 'name',
    'origin_city', 'origin_state', 'origin_lat', 'origin_lng',
    'dest_city', 'dest_state', 'dest_lat', 'dest_lng',
    'route_miles', 'route_duration_hours',
    'pickup_time', 'pickup_end_time',
    'delivery_time', 'delivery_end_time',
    'dwell_hours', 'active_days',
]

out_rows = []
for row in rows:
    name = row.get('Lane Name', '').strip()
    if not name:
        continue

    orig_city = row.get('Origin City', '').strip()
    orig_state = row.get('Origin State', '').strip()
    dest_city = row.get('Destination City', '').strip()
    dest_state = row.get('Destination State', '').strip()

    orig_lat, orig_lng = get_coords(orig_city, orig_state)
    dest_lat, dest_lng = get_coords(dest_city, dest_state)
    miles, hours = get_route(orig_city, dest_city)

    pickup_start = row.get('Origin Time Start', '').strip()
    pickup_end = row.get('Origin Time End', '').strip()
    delivery_start = row.get('Dest Time Start', '').strip()
    delivery_end = row.get('Dest Time End', '').strip()

    # Dwell = 15 min per stop for APPT
    orig_appt = row.get('Origin Appt Type', 'APPT').strip()
    dest_appt = row.get('Dest Appt Type', 'APPT').strip()
    orig_dwell = 0.25 if orig_appt == 'APPT' else (1.5 if orig_appt == 'FCFS' else 1.0)
    dest_dwell = 0.25 if dest_appt == 'APPT' else (1.5 if dest_appt == 'FCFS' else 1.0)

    # Parse active days
    days_raw = row.get('Active Days', 'Mon-Sat').strip()
    if days_raw.lower() in ('mon-sat', 'monday-saturday'):
        active_days = '1,2,3,4,5,6'
    elif days_raw.lower() in ('mon-fri', 'weekdays'):
        active_days = '1,2,3,4,5'
    else:
        # Parse individual days
        day_map = {'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6, 'sun': 0}
        parts = [p.strip().lower()[:3] for p in days_raw.replace(',', ' ').split()]
        nums = [str(day_map.get(p, '')) for p in parts if p in day_map]
        active_days = ','.join(nums) if nums else '1,2,3,4,5,6'

    out_rows.append({
        'id': name,
        'name': name,
        'origin_city': orig_city,
        'origin_state': orig_state,
        'origin_lat': orig_lat or '',
        'origin_lng': orig_lng or '',
        'dest_city': dest_city,
        'dest_state': dest_state,
        'dest_lat': dest_lat or '',
        'dest_lng': dest_lng or '',
        'route_miles': miles,
        'route_duration_hours': hours,
        'pickup_time': pickup_start,
        'pickup_end_time': pickup_end,
        'delivery_time': delivery_start,
        'delivery_end_time': delivery_end,
        'dwell_hours': orig_dwell + dest_dwell,
        'active_days': f'"{active_days}"',
    })

with open(output_path, 'w') as f:
    f.write(','.join(header) + '\n')
    for r in out_rows:
        f.write(','.join(str(r[h]) for h in header) + '\n')

print(f"Exported {len(out_rows)} lanes to {output_path}")
