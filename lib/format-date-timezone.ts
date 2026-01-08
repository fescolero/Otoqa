/**
 * Utility functions for formatting dates with timezone display
 * Shows the date/time in the original timezone with local time in tooltip
 */

export interface FormattedDateWithTimezone {
  display: string;
  tooltip: string;
  timezone: string;
}

/**
 * Extract timezone abbreviation from ISO string offset
 * e.g., "2025-11-29T06:36:00-08:00" -> "PST"
 */
function getTimezoneAbbr(isoString: string): string {
  const tzMatch = isoString.match(/([+-]\d{2}):(\d{2})$/);
  if (tzMatch) {
    const offset = parseInt(tzMatch[1]);
    // Common US timezone offsets
    if (offset === -8) return 'PST';
    if (offset === -7) return 'PDT';
    if (offset === -6) return 'MST';
    if (offset === -5) return 'CST';
    if (offset === -4) return 'EST';
    if (offset === 0) return 'UTC';
    // Generic format for other offsets
    return `UTC${offset >= 0 ? '+' : ''}${offset}`;
  }
  return 'UTC';
}

/**
 * Parse ISO string to extract date/time components in original timezone
 */
function parseISOInTimezone(isoString: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timezone: string;
} | null {
  try {
    // Match: YYYY-MM-DDTHH:mm:ss±HH:mm or YYYY-MM-DDTHH:mm±HH:mm
    let match = isoString.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?([+-]\d{2}):(\d{2})$/);
    if (match) {
      return {
        year: parseInt(match[1]),
        month: parseInt(match[2]),
        day: parseInt(match[3]),
        hour: parseInt(match[4]),
        minute: parseInt(match[5]),
        timezone: getTimezoneAbbr(isoString),
      };
    }
    
    // Try without seconds: YYYY-MM-DDTHH:mm±HH:mm
    match = isoString.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})([+-]\d{2}):(\d{2})$/);
    if (match) {
      return {
        year: parseInt(match[1]),
        month: parseInt(match[2]),
        day: parseInt(match[3]),
        hour: parseInt(match[4]),
        minute: parseInt(match[5]),
        timezone: getTimezoneAbbr(isoString),
      };
    }
    
    // Try with Z (UTC): YYYY-MM-DDTHH:mm:ssZ
    match = isoString.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?Z$/);
    if (match) {
      return {
        year: parseInt(match[1]),
        month: parseInt(match[2]),
        day: parseInt(match[3]),
        hour: parseInt(match[4]),
        minute: parseInt(match[5]),
        timezone: 'UTC',
      };
    }
    
    // Fallback: try parsing as date and extract UTC components
    const date = new Date(isoString);
    if (!isNaN(date.getTime())) {
      // Try to extract from string first to avoid timezone conversion
      const dateMatch = isoString.match(/^(\d{4})-(\d{2})-(\d{2})/);
      const timeMatch = isoString.match(/T(\d{2}):(\d{2})/);
      
      if (dateMatch && timeMatch) {
        return {
          year: parseInt(dateMatch[1]),
          month: parseInt(dateMatch[2]),
          day: parseInt(dateMatch[3]),
          hour: parseInt(timeMatch[1]),
          minute: parseInt(timeMatch[2]),
          timezone: getTimezoneAbbr(isoString),
        };
      }
      
      // Last resort: use Date object (may have timezone conversion)
      return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        timezone: getTimezoneAbbr(isoString),
      };
    }
  } catch (error) {
    console.error('Error parsing ISO string:', isoString, error);
  }
  return null;
}

/**
 * Format date/time showing original timezone, with local time in tooltip
 */
export function formatDateWithTimezone(
  dateStr: string,
  timeStr?: string,
  options?: {
    includeTime?: boolean;
    includeDate?: boolean;
    format?: 'short' | 'long' | 'time-only';
  }
): FormattedDateWithTimezone {
  if (!dateStr) {
    return { display: '—', tooltip: '', timezone: '' };
  }

  try {
    // Combine date and time if both provided
    let isoString: string;
    if (timeStr) {
      // If timeStr already contains 'T', it's a full ISO string
      if (timeStr.includes('T')) {
        isoString = timeStr;
      } else {
        isoString = `${dateStr}T${timeStr}`;
      }
    } else if (dateStr.includes('T')) {
      // dateStr is already a full ISO string
      isoString = dateStr;
    } else {
      // Just a date string, add default time
      isoString = `${dateStr}T00:00:00`;
    }

    // Ensure ISO string has timezone if missing
    if (!isoString.match(/[+-]\d{2}:\d{2}$/) && !isoString.endsWith('Z')) {
      isoString += 'Z'; // Default to UTC if no timezone
    }

    const parsed = parseISOInTimezone(isoString);
    if (!parsed) {
      // Fallback: try simple date parsing for date-only strings
      if (!dateStr.includes('T') && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const [year, month, day] = dateStr.split('-').map(Number);
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const utcDate = new Date(Date.UTC(year, month - 1, day));
        const weekday = dayNames[utcDate.getUTCDay()];
        const monthName = monthNames[month - 1];
        
        const { includeTime = true, includeDate = true, format = 'short' } = options || {};
        let display = '';
        if (includeDate) {
          display = format === 'long' 
            ? `${monthName} ${day}, ${year}`
            : `${monthName} ${day}`;
        }
        
        const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const tooltip = `${display} (${localTz})`;
        return { display, tooltip, timezone: 'UTC' };
      }
      return { display: '—', tooltip: '', timezone: '' };
    }

    const { year, month, day, hour, minute, timezone } = parsed;
    
    // Format directly from components to preserve original timezone
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    // Create a date object just to get weekday (in UTC to avoid timezone shift)
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    const weekday = dayNames[utcDate.getUTCDay()];
    const monthName = monthNames[month - 1];
    
    // Format time in 12-hour format
    const hour12 = hour % 12 || 12;
    const ampm = hour < 12 ? 'AM' : 'PM';
    const formattedTime = `${hour12}:${String(minute).padStart(2, '0')} ${ampm}`;
    
    const { includeTime = true, includeDate = true, format = 'short' } = options || {};
    
    let display = '';
    if (format === 'time-only') {
      display = `${formattedTime} ${timezone}`;
    } else if (format === 'long') {
      if (includeDate && includeTime) {
        display = `${weekday}, ${monthName} ${day} • ${formattedTime} ${timezone}`;
      } else if (includeDate) {
        display = `${monthName} ${day}, ${year}`;
      }
    } else {
      // Short format (default)
      if (includeDate && includeTime) {
        display = `${weekday}, ${monthName} ${day} • ${formattedTime} ${timezone}`;
      } else if (includeDate) {
        display = `${monthName} ${day}`;
      } else if (includeTime) {
        display = `${formattedTime} ${timezone}`;
      }
    }

    // Format local time for tooltip
    // If the stop timezone matches user's timezone, show the same time (no conversion needed)
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tzMatch = isoString.match(/([+-]\d{2}):(\d{2})$/);
    
    // Check if timezones match by comparing offsets
    // Get current timezone offset for a date at the same time
    const testDate = new Date(isoString);
    const localOffset = -testDate.getTimezoneOffset() / 60; // Convert minutes to hours
    const stopOffset = tzMatch ? parseInt(tzMatch[1]) : 0;
    
    // If offsets match (within 1 hour to account for DST), show same time without conversion
    if (Math.abs(localOffset - stopOffset) <= 1) {
      // Same timezone - tooltip shows the same time (no conversion)
      // Just replace the timezone abbreviation with the full timezone name
      const displayWithoutTz = display.replace(` ${timezone}`, '');
      const tooltip = `${displayWithoutTz} (${localTz})`;
      return { display, tooltip, timezone };
    }
    
    // Different timezone - show conversion
    const localTime = testDate.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    const tooltip = `Local time: ${localTime} (${localTz})`;

    return { display, tooltip, timezone };
  } catch {
    return { display: '—', tooltip: '', timezone: '' };
  }
}

/**
 * Format date only (no time) with timezone
 * For date-only strings, no timezone conversion is needed - dates are calendar dates
 */
export function formatDateOnly(dateStr: string): FormattedDateWithTimezone {
  if (!dateStr) {
    return { display: '—', tooltip: '', timezone: '' };
  }

  try {
    // Extract just the date part if it's a full ISO string
    let dateOnly = dateStr.trim();
    if (dateOnly.includes('T')) {
      dateOnly = dateOnly.split('T')[0];
    }
    // Remove timezone if present
    if (dateOnly.includes('+')) {
      dateOnly = dateOnly.split('+')[0];
    }
    const dashCount = (dateOnly.match(/-/g) || []).length;
    if (dashCount > 2) {
      // Find the 3rd dash (timezone separator)
      let dashIndex = -1;
      let dashNum = 0;
      for (let i = 0; i < dateOnly.length; i++) {
        if (dateOnly[i] === '-') {
          dashNum++;
          if (dashNum === 3) {
            dashIndex = i;
            break;
          }
        }
      }
      if (dashIndex > 0) {
        dateOnly = dateOnly.substring(0, dashIndex);
      }
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
      return { display: '—', tooltip: '', timezone: '' };
    }

    // Parse date components
    const [year, month, day] = dateOnly.split('-').map(Number);
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    const monthName = monthNames[month - 1];
    
    // Format display (short format: "Nov 29")
    const display = `${monthName} ${day}`;
    
    // For date-only, tooltip shows the same date (no conversion - dates are calendar dates)
    // Just show the date as-is with timezone info for reference
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tooltip = display; // Same date, no conversion needed
    
    return { display, tooltip, timezone: '' };
  } catch {
    return { display: '—', tooltip: '', timezone: '' };
  }
}

/**
 * Format time window (start - end) with timezone
 */
export function formatTimeWindow(
  dateStr: string,
  startTime?: string,
  endTime?: string
): FormattedDateWithTimezone {
  if (!dateStr && !startTime) {
    return { display: '—', tooltip: '', timezone: '' };
  }

  try {
    // windowBeginTime might be a full ISO string or just time
    // If it already contains 'T', it's a full ISO string - use it directly
    let startIso: string;
    if (startTime && startTime.includes('T')) {
      startIso = startTime; // Already a full ISO string, ignore dateStr
    } else if (dateStr && dateStr.includes('T')) {
      startIso = dateStr; // dateStr is already a full ISO string, ignore startTime
    } else if (dateStr && startTime) {
      // Combine date and time
      startIso = `${dateStr}T${startTime}`;
    } else if (dateStr) {
      // Just a date string, add default time
      startIso = `${dateStr}T00:00:00`;
    } else {
      return { display: '—', tooltip: '', timezone: '' };
    }

    // Ensure ISO string has timezone
    if (!startIso.match(/[+-]\d{2}:\d{2}$/) && !startIso.endsWith('Z')) {
      // Try to extract timezone from dateStr if it's a full ISO string
      if (dateStr.includes('T') && dateStr.match(/[+-]\d{2}:\d{2}$/)) {
        const tzMatch = dateStr.match(/([+-]\d{2}:\d{2})$/);
        if (tzMatch) {
          startIso += tzMatch[1];
        } else {
          startIso += 'Z'; // Default to UTC
        }
      } else {
        startIso += 'Z'; // Default to UTC
      }
    }

    let endIso: string | null = null;
    if (endTime) {
      if (endTime.includes('T')) {
        endIso = endTime; // Already a full ISO string
      } else {
        endIso = `${dateStr}T${endTime}`;
      }
      // Ensure end ISO has timezone
      if (!endIso.match(/[+-]\d{2}:\d{2}$/) && !endIso.endsWith('Z')) {
        if (dateStr.includes('T') && dateStr.match(/[+-]\d{2}:\d{2}$/)) {
          const tzMatch = dateStr.match(/([+-]\d{2}:\d{2})$/);
          if (tzMatch) {
            endIso += tzMatch[1];
          } else {
            endIso += 'Z';
          }
        } else {
          endIso += 'Z';
        }
      }
    }

    const startParsed = parseISOInTimezone(startIso);
    if (!startParsed) {
      // Fallback: try to parse with Date object and extract components
      try {
        const fallbackDate = new Date(startIso);
        if (!isNaN(fallbackDate.getTime())) {
          // Extract date components from the ISO string directly if possible
          const dateMatch = startIso.match(/^(\d{4})-(\d{2})-(\d{2})/);
          const timeMatch = startIso.match(/T(\d{2}):(\d{2}):(\d{2})/);
          const tzMatch = startIso.match(/([+-]\d{2}):(\d{2})$/);
          
          let year, month, day, hour, minute, timezone;
          
          if (dateMatch && timeMatch) {
            // Extract from ISO string directly
            year = parseInt(dateMatch[1]);
            month = parseInt(dateMatch[2]);
            day = parseInt(dateMatch[3]);
            hour = parseInt(timeMatch[1]);
            minute = parseInt(timeMatch[2]);
            timezone = tzMatch ? getTimezoneAbbr(startIso) : 'UTC';
          } else {
            // Fallback to Date object (may have timezone conversion issues)
            year = fallbackDate.getFullYear();
            month = fallbackDate.getMonth() + 1;
            day = fallbackDate.getDate();
            hour = fallbackDate.getHours();
            minute = fallbackDate.getMinutes();
            timezone = tzMatch ? getTimezoneAbbr(startIso) : 'UTC';
          }
          
          const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          const utcDate = new Date(Date.UTC(year, month - 1, day));
          const weekday = dayNames[utcDate.getUTCDay()];
          const monthName = monthNames[month - 1];
          const hour12 = hour % 12 || 12;
          const ampm = hour < 12 ? 'AM' : 'PM';
          const timeStr = `${hour12}:${String(minute).padStart(2, '0')} ${ampm}`;
          
          const display = `${weekday}, ${monthName} ${day} • ${timeStr} ${timezone}`;
          const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const tooltip = `${display.replace(` ${timezone}`, '')} (${localTz})`;
          
          return { display, tooltip, timezone };
        }
      } catch (error) {
        console.error('Error parsing date:', startIso, error);
      }
      return { display: '—', tooltip: '', timezone: '' };
    }

    const { year, month, day, hour: startHour, minute: startMinute, timezone } = startParsed;
    
    // Format directly from components to preserve original timezone
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    // Get weekday (using UTC to avoid timezone shift)
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    const weekday = dayNames[utcDate.getUTCDay()];
    const monthName = monthNames[month - 1];
    
    // Format start time in 12-hour format
    const startHour12 = startHour % 12 || 12;
    const startAmpm = startHour < 12 ? 'AM' : 'PM';
    const startTimeStr = `${startHour12}:${String(startMinute).padStart(2, '0')} ${startAmpm}`;
    
    let display = `${weekday}, ${monthName} ${day} • ${startTimeStr}`;
    
    if (endIso) {
      const endParsed = parseISOInTimezone(endIso);
      if (endParsed) {
        const endHour12 = endParsed.hour % 12 || 12;
        const endAmpm = endParsed.hour < 12 ? 'AM' : 'PM';
        const endTimeStr = `${endHour12}:${String(endParsed.minute).padStart(2, '0')} ${endAmpm}`;
        display += ` - ${endTimeStr}`;
      }
    }
    display += ` ${timezone}`;

    // Tooltip with local times
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tzMatch = startIso.match(/([+-]\d{2}):(\d{2})$/);
    
    // Check if timezones match
    const localStart = new Date(startIso);
    const localOffset = -localStart.getTimezoneOffset() / 60;
    const stopOffset = tzMatch ? parseInt(tzMatch[1]) : 0;
    
    let tooltip: string;
    if (Math.abs(localOffset - stopOffset) <= 1) {
      // Same timezone - show the same time (no conversion needed)
      // Remove timezone from display and add local timezone name
      const displayWithoutTz = display.replace(` ${timezone}`, '');
      tooltip = `${displayWithoutTz} (${localTz})`;
    } else {
      // Different timezone - show conversion
      const localStartStr = localStart.toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      tooltip = `Local time: ${localStartStr}`;
      if (endIso) {
        const localEnd = new Date(endIso);
        const localEndStr = localEnd.toLocaleString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });
        tooltip += ` - ${localEndStr}`;
      }
      tooltip += ` (${localTz})`;
    }

    return { display, tooltip, timezone };
  } catch {
    return { display: '—', tooltip: '', timezone: '' };
  }
}

