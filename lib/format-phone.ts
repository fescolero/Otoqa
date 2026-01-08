/**
 * Format a phone number with country code
 * Assumes US/Canada (+1) if no country code is provided
 * @param phoneNumber - Raw phone number string
 * @returns Formatted phone number with country code
 */
export function formatPhoneNumber(phoneNumber: string | undefined): string {
  if (!phoneNumber) return '';

  // Remove all non-digit characters
  const digits = phoneNumber.replace(/\D/g, '');

  // If it starts with 1 and has 11 digits, it already has country code
  if (digits.length === 11 && digits.startsWith('1')) {
    const areaCode = digits.slice(1, 4);
    const prefix = digits.slice(4, 7);
    const lineNumber = digits.slice(7, 11);
    return `+1 (${areaCode}) ${prefix}-${lineNumber}`;
  }

  // If it has 10 digits, add +1 country code (US/Canada)
  if (digits.length === 10) {
    const areaCode = digits.slice(0, 3);
    const prefix = digits.slice(3, 6);
    const lineNumber = digits.slice(6, 10);
    return `+1 (${areaCode}) ${prefix}-${lineNumber}`;
  }

  // If it already starts with country code (more than 10 digits)
  if (digits.length > 11) {
    // Assume international format, just add + prefix if missing
    return phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
  }

  // Return as-is if format is unclear
  return phoneNumber;
}

/**
 * Get the raw phone number for tel: links (digits only with country code)
 * @param phoneNumber - Raw phone number string
 * @returns Phone number suitable for tel: links
 */
export function getPhoneLink(phoneNumber: string | undefined): string {
  if (!phoneNumber) return '';

  const digits = phoneNumber.replace(/\D/g, '');

  // Add +1 if it's a 10-digit US/Canada number
  if (digits.length === 10) {
    return `+1${digits}`;
  }

  // Add + if it's 11+ digits and doesn't have it
  if (digits.length >= 11) {
    return `+${digits}`;
  }

  return phoneNumber;
}
