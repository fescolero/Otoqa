import { describe, expect, it } from 'vitest';
import { humanizeRoleSlug, parseInviteEmails, relativeActivity } from '../team-utils';

describe('parseInviteEmails', () => {
  it('splits on commas, semicolons, and whitespace, deduping case-insensitively', () => {
    expect(parseInviteEmails('a@x.com, B@x.com;  a@X.com\nc@y.io')).toEqual([
      'a@x.com',
      'b@x.com',
      'c@y.io',
    ]);
  });

  it('drops tokens that are not plausible addresses', () => {
    expect(parseInviteEmails('hello, world, a@b')).toEqual([]);
    expect(parseInviteEmails('a@b.com not-an-email')).toEqual(['a@b.com']);
    expect(parseInviteEmails('')).toEqual([]);
  });
});

describe('relativeActivity', () => {
  const NOW = Date.UTC(2026, 6, 21, 12);
  const min = 60 * 1000;

  it('buckets recency the way the members table shows it', () => {
    expect(relativeActivity(NOW - 30 * 1000, NOW)).toBe('Active now');
    expect(relativeActivity(NOW - 12 * min, NOW)).toBe('12 min ago');
    expect(relativeActivity(NOW - 2 * 60 * min, NOW)).toBe('2 hr ago');
    expect(relativeActivity(NOW - 30 * 60 * min, NOW)).toBe('Yesterday');
    expect(relativeActivity(NOW - 3 * 24 * 60 * min, NOW)).toBe('3 days ago');
  });

  it('falls back to a date beyond a week', () => {
    expect(relativeActivity(Date.UTC(2026, 5, 1, 12), NOW)).toBe('Jun 1, 2026');
  });
});

describe('humanizeRoleSlug', () => {
  it('prettifies slugs and strips the org- custom-role prefix', () => {
    expect(humanizeRoleSlug('billing-admin')).toBe('Billing admin');
    expect(humanizeRoleSlug('org-night_dispatch')).toBe('Night dispatch');
    expect(humanizeRoleSlug('admin')).toBe('Admin');
  });
});
