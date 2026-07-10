'use client';

import { useEffect, useState } from 'react';

interface OrgMember {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
}

/**
 * Module-level cache: every consumer on the page shares one fetch of the
 * org member list for the lifetime of the tab. Reset on failure so a
 * transient error doesn't permanently pin an empty map.
 */
let membersPromise: Promise<Map<string, string>> | null = null;

async function fetchMemberNames(): Promise<Map<string, string>> {
  const response = await fetch('/api/organization/members');
  if (!response.ok) {
    throw new Error(`Failed to fetch organization members: ${response.status}`);
  }
  const { members } = (await response.json()) as { members: OrgMember[] };
  const map = new Map<string, string>();
  for (const member of members) {
    const name = [member.firstName, member.lastName].filter(Boolean).join(' ');
    map.set(member.id, name || member.email);
  }
  return map;
}

/**
 * WorkOS user ID → display name ("First Last", falling back to email) for
 * every member of the caller's organization. Returns undefined while
 * loading; returns an empty map if the lookup fails, so callers can always
 * fall back to whatever raw value they already have.
 */
export function useOrgMemberNames(): Map<string, string> | undefined {
  const [names, setNames] = useState<Map<string, string> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    membersPromise ??= fetchMemberNames();
    membersPromise
      .then((map) => {
        if (!cancelled) setNames(map);
      })
      .catch(() => {
        membersPromise = null;
        if (!cancelled) setNames(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return names;
}
