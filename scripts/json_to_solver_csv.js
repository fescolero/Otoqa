#!/usr/bin/env node
/**
 * Convert Convex laneAnalysisEntries JSON export to solver CSV.
 * Usage: node scripts/json_to_solver_csv.js < entries.json > scripts/lanes.csv
 *
 * Or pass a file path: node scripts/json_to_solver_csv.js scripts/entries.json
 */

const fs = require('fs');

let input;
if (process.argv[2]) {
  input = fs.readFileSync(process.argv[2], 'utf-8');
} else {
  input = fs.readFileSync(0, 'utf-8'); // stdin
}

const entries = JSON.parse(input);

// CSV header matching solver expectations
const header = [
  'id', 'name',
  'origin_city', 'origin_state', 'origin_lat', 'origin_lng',
  'dest_city', 'dest_state', 'dest_lat', 'dest_lng',
  'route_miles', 'route_duration_hours',
  'pickup_time', 'pickup_end_time',
  'delivery_time', 'delivery_end_time',
  'dwell_hours', 'active_days',
];

console.log(header.join(','));

for (const e of entries) {
  const activeDays = e.scheduleRule?.activeDays?.join(',') || '1,2,3,4,5';

  // Calculate dwell from appointment types
  const originDwell = e.originAppointmentType === 'FCFS' ? 1.5 : e.originAppointmentType === 'Live' ? 1.0 : 0.25;
  const destDwell = e.destinationAppointmentType === 'FCFS' ? 1.5 : e.destinationAppointmentType === 'Live' ? 1.0 : 0.25;
  const totalDwell = originDwell + destDwell;

  const row = [
    e._id || e.id || e.name,
    e.name,
    e.originCity, e.originState,
    e.originLat || '', e.originLng || '',
    e.destinationCity, e.destinationState,
    e.destinationLat || '', e.destinationLng || '',
    e.routeMiles || 0,
    e.routeDurationHours || 0,
    e.originScheduledTime || '',
    e.originScheduledEndTime || '',
    e.destinationScheduledTime || '',
    e.destinationScheduledEndTime || '',
    totalDwell,
    `"${activeDays}"`,
  ];

  console.log(row.join(','));
}

process.stderr.write(`Exported ${entries.length} lanes\n`);
