/**
 * Export lane data from Convex to CSV for the Python solver.
 * Run with: npx convex run scripts/export_lanes
 * Or use the Convex dashboard to export.
 */

// This is a helper — paste the output from the Convex dashboard's
// laneAnalysisEntries table into a CSV format the solver can read.
//
// For now, manually export from the Convex dashboard:
// 1. Go to your Convex dashboard
// 2. Navigate to laneAnalysisEntries table
// 3. Export as JSON
// 4. Run: node scripts/json_to_solver_csv.js < entries.json > scripts/lanes.csv

console.log(`
To export lane data for the solver:

1. Open the Convex dashboard
2. Go to the laneAnalysisEntries table
3. Filter by sessionId for the 9173Q session
4. Export as JSON
5. Save to scripts/entries.json
6. Run: node scripts/json_to_solver_csv.js

Or use the browser console on the Lane Analyzer page:
  - Open DevTools > Console
  - The lane data is already loaded in the React state
`);
