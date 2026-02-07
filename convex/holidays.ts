import { v } from 'convex/values';
import { internalQuery, query } from './_generated/server';

/**
 * US Federal Holidays
 * Used for recurring load generation exclusions
 */

// Helper to get the Nth occurrence of a day in a month
// e.g., 3rd Monday of January
function getNthDayOfMonth(year: number, month: number, dayOfWeek: number, n: number): Date {
  const firstDay = new Date(year, month, 1);
  const firstDayOfWeek = firstDay.getDay();
  
  // Calculate days to add to get to first occurrence of target day
  let daysToAdd = dayOfWeek - firstDayOfWeek;
  if (daysToAdd < 0) daysToAdd += 7;
  
  // Add weeks to get to nth occurrence
  daysToAdd += (n - 1) * 7;
  
  return new Date(year, month, 1 + daysToAdd);
}

// Helper to get the last occurrence of a day in a month
function getLastDayOfMonth(year: number, month: number, dayOfWeek: number): Date {
  const lastDay = new Date(year, month + 1, 0);
  const lastDayOfWeek = lastDay.getDay();
  
  let daysToSubtract = lastDayOfWeek - dayOfWeek;
  if (daysToSubtract < 0) daysToSubtract += 7;
  
  return new Date(year, month + 1, -daysToSubtract);
}

// Format date as YYYY-MM-DD
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Get observed date for fixed holidays (if falls on weekend)
function getObservedDate(year: number, month: number, day: number): string {
  const date = new Date(year, month, day);
  const dayOfWeek = date.getDay();
  
  // If Saturday, observe on Friday
  if (dayOfWeek === 6) {
    return formatDate(new Date(year, month, day - 1));
  }
  // If Sunday, observe on Monday
  if (dayOfWeek === 0) {
    return formatDate(new Date(year, month, day + 1));
  }
  
  return formatDate(date);
}

/**
 * Generate US Federal Holidays for a given year
 * Returns array of dates in YYYY-MM-DD format
 */
export function getFederalHolidaysForYear(year: number): string[] {
  const holidays: string[] = [];
  
  // New Year's Day - January 1 (observed)
  holidays.push(getObservedDate(year, 0, 1));
  
  // Martin Luther King Jr. Day - 3rd Monday of January
  holidays.push(formatDate(getNthDayOfMonth(year, 0, 1, 3)));
  
  // Presidents' Day - 3rd Monday of February
  holidays.push(formatDate(getNthDayOfMonth(year, 1, 1, 3)));
  
  // Memorial Day - Last Monday of May
  holidays.push(formatDate(getLastDayOfMonth(year, 4, 1)));
  
  // Juneteenth - June 19 (observed)
  holidays.push(getObservedDate(year, 5, 19));
  
  // Independence Day - July 4 (observed)
  holidays.push(getObservedDate(year, 6, 4));
  
  // Labor Day - 1st Monday of September
  holidays.push(formatDate(getNthDayOfMonth(year, 8, 1, 1)));
  
  // Columbus Day - 2nd Monday of October
  holidays.push(formatDate(getNthDayOfMonth(year, 9, 1, 2)));
  
  // Veterans Day - November 11 (observed)
  holidays.push(getObservedDate(year, 10, 11));
  
  // Thanksgiving - 4th Thursday of November
  holidays.push(formatDate(getNthDayOfMonth(year, 10, 4, 4)));
  
  // Christmas Day - December 25 (observed)
  holidays.push(getObservedDate(year, 11, 25));
  
  return holidays;
}

// Cache for holiday lookups (keyed by year)
const holidayCache = new Map<number, Set<string>>();

function getHolidaySet(year: number): Set<string> {
  if (!holidayCache.has(year)) {
    holidayCache.set(year, new Set(getFederalHolidaysForYear(year)));
  }
  return holidayCache.get(year)!;
}

// Internal query to check if a date is a federal holiday
export const isFederalHoliday = internalQuery({
  args: {
    date: v.string(), // "YYYY-MM-DD"
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const year = parseInt(args.date.substring(0, 4));
    const holidays = getHolidaySet(year);
    return holidays.has(args.date);
  },
});

// Public query to get federal holidays for a date range
export const getFederalHolidays = query({
  args: {
    startDate: v.string(), // "YYYY-MM-DD"
    endDate: v.string(), // "YYYY-MM-DD"
  },
  returns: v.array(
    v.object({
      date: v.string(),
      name: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const startYear = parseInt(args.startDate.substring(0, 4));
    const endYear = parseInt(args.endDate.substring(0, 4));
    
    const holidays: Array<{ date: string; name: string }> = [];
    
    // Holiday name mapping
    const holidayNames: Record<string, string> = {};
    
    for (let year = startYear; year <= endYear; year++) {
      const yearHolidays = getFederalHolidaysForYear(year);
      
      // Map dates to names
      holidayNames[getObservedDate(year, 0, 1)] = "New Year's Day";
      holidayNames[formatDate(getNthDayOfMonth(year, 0, 1, 3))] = 'Martin Luther King Jr. Day';
      holidayNames[formatDate(getNthDayOfMonth(year, 1, 1, 3))] = "Presidents' Day";
      holidayNames[formatDate(getLastDayOfMonth(year, 4, 1))] = 'Memorial Day';
      holidayNames[getObservedDate(year, 5, 19)] = 'Juneteenth';
      holidayNames[getObservedDate(year, 6, 4)] = 'Independence Day';
      holidayNames[formatDate(getNthDayOfMonth(year, 8, 1, 1))] = 'Labor Day';
      holidayNames[formatDate(getNthDayOfMonth(year, 9, 1, 2))] = 'Columbus Day';
      holidayNames[getObservedDate(year, 10, 11)] = 'Veterans Day';
      holidayNames[formatDate(getNthDayOfMonth(year, 10, 4, 4))] = 'Thanksgiving';
      holidayNames[getObservedDate(year, 11, 25)] = 'Christmas Day';
      
      for (const date of yearHolidays) {
        if (date >= args.startDate && date <= args.endDate) {
          holidays.push({
            date,
            name: holidayNames[date] || 'Federal Holiday',
          });
        }
      }
    }
    
    // Sort by date
    holidays.sort((a, b) => a.date.localeCompare(b.date));
    
    return holidays;
  },
});

// Public query to check if a specific date is a holiday
export const isHoliday = query({
  args: {
    date: v.string(), // "YYYY-MM-DD"
  },
  returns: v.object({
    isHoliday: v.boolean(),
    holidayName: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const year = parseInt(args.date.substring(0, 4));
    const holidays = getHolidaySet(year);
    
    if (!holidays.has(args.date)) {
      return { isHoliday: false };
    }
    
    // Get the holiday name
    const holidayNames: Record<string, string> = {};
    holidayNames[getObservedDate(year, 0, 1)] = "New Year's Day";
    holidayNames[formatDate(getNthDayOfMonth(year, 0, 1, 3))] = 'Martin Luther King Jr. Day';
    holidayNames[formatDate(getNthDayOfMonth(year, 1, 1, 3))] = "Presidents' Day";
    holidayNames[formatDate(getLastDayOfMonth(year, 4, 1))] = 'Memorial Day';
    holidayNames[getObservedDate(year, 5, 19)] = 'Juneteenth';
    holidayNames[getObservedDate(year, 6, 4)] = 'Independence Day';
    holidayNames[formatDate(getNthDayOfMonth(year, 8, 1, 1))] = 'Labor Day';
    holidayNames[formatDate(getNthDayOfMonth(year, 9, 1, 2))] = 'Columbus Day';
    holidayNames[getObservedDate(year, 10, 11)] = 'Veterans Day';
    holidayNames[formatDate(getNthDayOfMonth(year, 10, 4, 4))] = 'Thanksgiving';
    holidayNames[getObservedDate(year, 11, 25)] = 'Christmas Day';
    
    return {
      isHoliday: true,
      holidayName: holidayNames[args.date],
    };
  },
});
