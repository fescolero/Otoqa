import { WorkOS } from '@workos-inc/node';

export function getWorkOS(): WorkOS | null {
  const apiKey = process.env.WORKOS_API_KEY;
  if (!apiKey) return null;
  return new WorkOS(apiKey);
}

export function requireWorkOS(): WorkOS {
  const workos = getWorkOS();
  if (!workos) {
    throw new Error('Missing WORKOS_API_KEY');
  }
  return workos;
}
