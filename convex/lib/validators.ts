import { v } from 'convex/values';

// Schedule rule shape shared by contractLanes and laneAnalysisEntries.
// activeDays: 0=Sun, 1=Mon, ..., 6=Sat
export const scheduleRuleValidator = v.object({
  activeDays: v.array(v.number()),
  excludeFederalHolidays: v.boolean(),
  customExclusions: v.array(v.string()), // YYYY-MM-DD
});
