import { getSettings } from '@server/lib/settings';

// The policy follows the request owner, never the caller, so an admin
// creating or editing a request on someone's behalf cannot shorten or drop it.
export function getAutoDeletePolicyDays(
  userId: number | undefined
): number | undefined {
  if (userId === undefined) {
    return undefined;
  }

  return getSettings().main.autoDeleteUserPolicies?.find(
    (policy) => policy.userId === userId
  )?.days;
}
