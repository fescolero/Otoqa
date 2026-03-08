/**
 * Formats a number as currency based on the ISO code
 */
export function formatCurrency(amount: number, currency: string = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Formats a date string (YYYY-MM-DD or ISO) to a readable format.
 * Parses date-only strings by component to avoid timezone shift.
 */
export function formatDate(dateString?: string) {
  if (!dateString) return '';

  const dateOnly = dateString.includes('T') ? dateString.split('T')[0] : dateString.trim();
  const match = dateOnly.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    const year = parseInt(match[1], 10);
    return `${months[month - 1]} ${day}, ${year}`;
  }

  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Formats a Unix timestamp (ms) to a readable date.
 * Uses local time components since timestamps represent real instants.
 */
export function formatTimestamp(timestamp?: number) {
  if (timestamp == null) return '';
  return new Date(timestamp).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
