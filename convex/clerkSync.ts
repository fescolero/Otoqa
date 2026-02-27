'use node';

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';

/**
 * Normalize phone number to E.164 format for Clerk
 * Input: "7607553340" or "760-755-3340" or "+17607553340"
 * Output: "+17607553340"
 */
function normalizePhoneToE164(phone: string): string {
  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, '');
  
  // Handle different formats
  if (digits.length === 10) {
    // US number without country code: 7607553340 -> +17607553340
    return '+1' + digits;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    // US number with country code: 17607553340 -> +17607553340
    return '+' + digits;
  } else if (digits.length > 10) {
    // International number, assume it includes country code
    return '+' + digits;
  }
  
  // Fallback: assume US and add +1
  return '+1' + digits;
}

// Type for driver info from helper query
type DriverInfo = {
  phone: string;
  firstName: string;
  lastName: string;
};

// Type for create result
type CreateResult = 
  | { success: true; clerkUserId: string }
  | { success: false; error: string };

/**
 * Create a Clerk user for a driver
 * Called automatically when a new driver is created
 */
export const createClerkUserForDriver = internalAction({
  args: {
    phone: v.string(),
    firstName: v.string(),
    lastName: v.string(),
  },
  returns: v.union(
    v.object({
      success: v.literal(true),
      clerkUserId: v.string(),
    }),
    v.object({
      success: v.literal(false),
      error: v.string(),
    })
  ),
  handler: async (ctx, args): Promise<CreateResult> => {
    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) {
      console.error('CLERK_SECRET_KEY not configured - driver will not be able to sign in to mobile app');
      return { success: false, error: 'CLERK_SECRET_KEY not configured' };
    }

    // Convert phone to E.164 format for Clerk
    const e164Phone = normalizePhoneToE164(args.phone);
    console.log(`Creating Clerk user for driver: ${args.firstName} ${args.lastName}`);

    try {
      const response = await fetch('https://api.clerk.com/v1/users', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${clerkSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          phone_number: [e164Phone],
          first_name: args.firstName,
          last_name: args.lastName,
          skip_password_requirement: true,
        }),
      });

      const responseData = await response.json();

      if (!response.ok) {
        // Check if user already exists (this is fine)
        if (responseData.errors?.[0]?.code === 'form_identifier_exists') {
          console.log(`Clerk user already exists for this phone number`);
          return { success: true, clerkUserId: 'existing' };
        }

        const errorMessage = responseData.errors?.[0]?.message || responseData.errors?.[0]?.long_message || 'Failed to create Clerk user';
        console.error(`Failed to create Clerk user: ${errorMessage}`);
        return { success: false, error: errorMessage };
      }

      console.log(`Successfully created Clerk user ${responseData.id} for driver ${args.firstName} ${args.lastName}`);
      return { success: true, clerkUserId: responseData.id };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Error creating Clerk user: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  },
});

// Type for sync results
type SyncResults = {
  total: number;
  created: number;
  existing: number;
  failed: number;
  errors: string[];
};

/**
 * Bulk create Clerk users for all existing drivers in an organization
 * Use this to sync existing drivers to Clerk
 */
export const syncExistingDriversToClerk = internalAction({
  args: {
    organizationId: v.string(),
  },
  returns: v.object({
    total: v.number(),
    created: v.number(),
    existing: v.number(),
    failed: v.number(),
    errors: v.array(v.string()),
  }),
  handler: async (ctx, args): Promise<SyncResults> => {
    // Get all drivers for this organization using the helper query
    const drivers: DriverInfo[] = await ctx.runQuery(internal.clerkSyncHelpers.getDriversForSync, {
      organizationId: args.organizationId,
    });

    const results: SyncResults = {
      total: drivers.length,
      created: 0,
      existing: 0,
      failed: 0,
      errors: [],
    };

    for (const driver of drivers) {
      const result: CreateResult = await ctx.runAction(internal.clerkSync.createClerkUserForDriver, {
        phone: driver.phone,
        firstName: driver.firstName,
        lastName: driver.lastName,
      });

      if (result.success) {
        if (result.clerkUserId === 'existing') {
          results.existing++;
        } else {
          results.created++;
        }
      } else {
        results.failed++;
        results.errors.push(`${driver.firstName} ${driver.lastName} (${driver.phone}): ${result.error}`);
      }
    }

    return results;
  },
});

/**
 * Create Clerk user for a single existing driver by ID
 */
export const syncSingleDriverToClerk = internalAction({
  args: {
    driverId: v.id('drivers'),
  },
  returns: v.union(
    v.object({
      success: v.literal(true),
      clerkUserId: v.string(),
    }),
    v.object({
      success: v.literal(false),
      error: v.string(),
    })
  ),
  handler: async (ctx, args): Promise<CreateResult> => {
    // Get driver info using helper query
    const driver: DriverInfo | null = await ctx.runQuery(internal.clerkSyncHelpers.getDriverById, {
      driverId: args.driverId,
    });

    if (!driver) {
      return { success: false, error: 'Driver not found' };
    }

    const result: CreateResult = await ctx.runAction(internal.clerkSync.createClerkUserForDriver, {
      phone: driver.phone,
      firstName: driver.firstName,
      lastName: driver.lastName,
    });
    
    return result;
  },
});

// Type for update result
type UpdateResult = 
  | { success: true; action: string }
  | { success: false; error: string };

/**
 * Update a driver's phone number in Clerk
 * Called when a driver's phone is updated in the admin panel
 */
export const updateClerkUserPhone = internalAction({
  args: {
    oldPhone: v.string(),
    newPhone: v.string(),
    firstName: v.string(),
    lastName: v.string(),
    targetClerkUserId: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      success: v.literal(true),
      action: v.string(),
    }),
    v.object({
      success: v.literal(false),
      error: v.string(),
    })
  ),
  handler: async (ctx, args): Promise<UpdateResult> => {
    const safeParseJson = async (response: Response): Promise<unknown> => {
      const text = await response.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    };
    const updateUserPrimaryPhoneFallback = async (
      userId: string
    ): Promise<{ ok: boolean; error?: string }> => {
      const tryPatch = async (
        payload: Record<string, unknown>
      ): Promise<{ ok: boolean; error?: string }> => {
        const patchResponse = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${clerkSecretKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        if (!patchResponse.ok) {
          const patchError = await safeParseJson(patchResponse) as { errors?: Array<{ message?: string }>; raw?: string } | null;
          return {
            ok: false,
            error: patchError?.errors?.[0]?.message || patchError?.raw || `HTTP ${patchResponse.status}`,
          };
        }

        // Verify the phone was actually updated; some API variants return 200 but ignore payload.
        const verifyResponse = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${clerkSecretKey}`,
          },
        });
        if (!verifyResponse.ok) {
          return { ok: false, error: `Could not verify user after patch: HTTP ${verifyResponse.status}` };
        }
        const verifiedUser = await verifyResponse.json() as { phone_numbers?: Array<{ phone_number: string }> };
        const verifiedPhones = (verifiedUser.phone_numbers || []).map((p) => p.phone_number);
        console.log('[clerkSync.updateClerkUserPhone] fallback verify snapshot', {
          userId,
          payload,
          verifiedPhones,
          expectedPhone: newE164,
        });
        if (!verifiedPhones.includes(newE164)) {
          return { ok: false, error: 'Patch call succeeded but phone was not updated on user record' };
        }
        return { ok: true };
      };

      const firstAttempt = await tryPatch({ phone_number: [newE164] });
      if (firstAttempt.ok) return firstAttempt;

      // Some Clerk API variants accept singular value form.
      const secondAttempt = await tryPatch({ phone_number: newE164 });
      if (secondAttempt.ok) return secondAttempt;

      return secondAttempt.error
        ? secondAttempt
        : firstAttempt;
    };

    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) {
      console.error('CLERK_SECRET_KEY not configured');
      return { success: false, error: 'CLERK_SECRET_KEY not configured' };
    }

    const oldE164 = normalizePhoneToE164(args.oldPhone);
    const newE164 = normalizePhoneToE164(args.newPhone);

    console.log(`Updating Clerk user phone number`);
    try {
      // If we already know which Clerk user should be updated, prefer that over phone search.
      if (args.targetClerkUserId) {
        const userResponse = await fetch(`https://api.clerk.com/v1/users/${args.targetClerkUserId}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${clerkSecretKey}`,
          },
        });
        if (userResponse.ok) {
          const user = await userResponse.json() as { id: string; phone_numbers?: Array<{ id: string; phone_number: string }> };
          const phoneNumbers = user.phone_numbers || [];
          const alreadyHasNewPhone = phoneNumbers.some((p) => p.phone_number === newE164);
          if (alreadyHasNewPhone) {
            console.log('[clerkSync.updateClerkUserPhone] target user already has new phone', {
              userId: user.id,
              newE164,
            });
            return { success: true, action: 'already_current' };
          }

          const addPhoneResponse = await fetch(`https://api.clerk.com/v1/users/${user.id}/phone_numbers`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${clerkSecretKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              phone_number: newE164,
              verified: true,
              primary: true,
            }),
          });

          if (!addPhoneResponse.ok) {
            const errorData = await safeParseJson(addPhoneResponse) as { errors?: Array<{ code?: string; message?: string }>; raw?: string } | null;
            console.log('[clerkSync.updateClerkUserPhone] target-user add phone failed', {
              status: addPhoneResponse.status,
              errorData: errorData ?? null,
            });
            if (addPhoneResponse.status === 404) {
              const fallback = await updateUserPrimaryPhoneFallback(user.id);
              console.log('[clerkSync.updateClerkUserPhone] target-user fallback patch result', {
                ok: fallback.ok,
                error: fallback.error ?? null,
              });
              if (fallback.ok) {
                return { success: true, action: 'updated_target_user_patch' };
              }
              return { success: false, error: `Failed to update target user phone: ${fallback.error}` };
            }
            if (errorData?.errors?.[0]?.code === 'form_identifier_exists') {
              return { success: false, error: 'New phone number is already in use by another account' };
            }
            return { success: false, error: `Failed to add new phone: ${errorData?.errors?.[0]?.message || errorData?.raw || `HTTP ${addPhoneResponse.status}`}` };
          }

          const oldPhoneRecord = phoneNumbers.find((p) => p.phone_number === oldE164);
          if (oldPhoneRecord) {
            await fetch(`https://api.clerk.com/v1/users/${user.id}/phone_numbers/${oldPhoneRecord.id}`, {
              method: 'DELETE',
              headers: {
                'Authorization': `Bearer ${clerkSecretKey}`,
              },
            });
          }

          console.log('[clerkSync.updateClerkUserPhone] updated target Clerk user by ID', {
            userId: user.id,
            oldE164,
            newE164,
          });
          return { success: true, action: 'updated_target_user' };
        }
      }

      // First, find the user by their old phone number
      const searchResponse = await fetch(
        `https://api.clerk.com/v1/users?phone_number=${encodeURIComponent(oldE164)}`,
        {
          headers: {
            'Authorization': `Bearer ${clerkSecretKey}`,
          },
        }
      );

      if (!searchResponse.ok) {
        const errorData = await searchResponse.json();
        console.log('[clerkSync.updateClerkUserPhone] search failed', {
          status: searchResponse.status,
          error: errorData?.errors?.[0]?.message || null,
        });
        return { success: false, error: `Failed to search for user: ${errorData.errors?.[0]?.message}` };
      }

      const users = await searchResponse.json();
      console.log('[clerkSync.updateClerkUserPhone] search result', {
        count: Array.isArray(users) ? users.length : -1,
      });

      // Additional diagnostics: which Clerk account currently owns old/new phone.
      const newPhoneLookupResponse = await fetch(
        `https://api.clerk.com/v1/users?phone_number=${encodeURIComponent(newE164)}`,
        {
          headers: {
            'Authorization': `Bearer ${clerkSecretKey}`,
          },
        }
      );
      if (newPhoneLookupResponse.ok) {
        const newPhoneUsers = await newPhoneLookupResponse.json();
        console.log('[clerkSync.updateClerkUserPhone] old/new phone ownership snapshot', {
          oldPhoneUserIds: Array.isArray(users) ? users.map((u: { id: string }) => u.id) : [],
          newPhoneUserIds: Array.isArray(newPhoneUsers)
            ? newPhoneUsers.map((u: { id: string }) => u.id)
            : [],
        });
      } else {
        console.log('[clerkSync.updateClerkUserPhone] new phone lookup failed', {
          status: newPhoneLookupResponse.status,
        });
      }

      if (users.length === 0) {
        // User doesn't exist in Clerk - create them with the new phone
        console.log(`No Clerk user found with old phone, creating new user`);
        const createResult: CreateResult = await ctx.runAction(internal.clerkSync.createClerkUserForDriver, {
          phone: args.newPhone,
          firstName: args.firstName,
          lastName: args.lastName,
        });
        
        if (createResult.success) {
          console.log('[clerkSync.updateClerkUserPhone] created/found user via fallback', {
            action: 'created_new',
            createResult,
          });
          return { success: true, action: 'created_new' };
        } else {
          console.log('[clerkSync.updateClerkUserPhone] fallback create failed', {
            error: createResult.error,
          });
          return { success: false, error: createResult.error };
        }
      }

      const userId = users[0].id;

      // Add the new phone number to the user
      const addPhoneResponse = await fetch(`https://api.clerk.com/v1/users/${userId}/phone_numbers`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${clerkSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          phone_number: newE164,
          verified: true, // Auto-verify since admin is changing it
          primary: true,
        }),
      });

      if (!addPhoneResponse.ok) {
        const errorData = await safeParseJson(addPhoneResponse) as { errors?: Array<{ code?: string; message?: string }>; raw?: string } | null;
        console.log('[clerkSync.updateClerkUserPhone] add phone failed', {
          status: addPhoneResponse.status,
          errorData: errorData ?? null,
        });
        if (addPhoneResponse.status === 404) {
          const fallback = await updateUserPrimaryPhoneFallback(userId);
          console.log('[clerkSync.updateClerkUserPhone] fallback patch result', {
            ok: fallback.ok,
            error: fallback.error ?? null,
          });
          if (fallback.ok) {
            return { success: true, action: 'updated_patch' };
          }
          return { success: false, error: `Failed to update user phone: ${fallback.error}` };
        }
        
        // If the new phone already exists on another user, that's a problem
        if (errorData?.errors?.[0]?.code === 'form_identifier_exists') {
          return { success: false, error: 'New phone number is already in use by another account' };
        }
        
        return { success: false, error: `Failed to add new phone: ${errorData?.errors?.[0]?.message || errorData?.raw || `HTTP ${addPhoneResponse.status}`}` };
      }

      // Delete the old phone number
      const phoneNumbers = users[0].phone_numbers || [];
      const oldPhoneRecord = phoneNumbers.find((p: { phone_number: string; id: string }) => p.phone_number === oldE164);
      if (oldPhoneRecord) {
        const deleteResponse = await fetch(`https://api.clerk.com/v1/users/${userId}/phone_numbers/${oldPhoneRecord.id}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${clerkSecretKey}`,
          },
        });
        if (!deleteResponse.ok) {
          await safeParseJson(deleteResponse);
        }
      }

      console.log(`Successfully updated Clerk user phone number`);
      console.log('[clerkSync.updateClerkUserPhone] returning updated');
      return { success: true, action: 'updated' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Error updating Clerk user phone: ${errorMessage}`);
      console.log('[clerkSync.updateClerkUserPhone] returning error', { error: errorMessage });
      return { success: false, error: errorMessage };
    }
  },
});

// Type for delete result
type DeleteResult = 
  | { success: true }
  | { success: false; error: string };

/**
 * Delete a Clerk user when a driver is permanently deleted
 */
export const deleteClerkUser = internalAction({
  args: {
    phone: v.string(),
  },
  returns: v.union(
    v.object({ success: v.literal(true) }),
    v.object({ success: v.literal(false), error: v.string() })
  ),
  handler: async (ctx, args): Promise<DeleteResult> => {
    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) {
      return { success: false, error: 'CLERK_SECRET_KEY not configured' };
    }

    const e164Phone = normalizePhoneToE164(args.phone);

    try {
      // Find user by phone
      const searchResponse = await fetch(
        `https://api.clerk.com/v1/users?phone_number=${encodeURIComponent(e164Phone)}`,
        {
          headers: {
            'Authorization': `Bearer ${clerkSecretKey}`,
          },
        }
      );

      if (!searchResponse.ok) {
        return { success: false, error: 'Failed to search for user' };
      }

      const users = await searchResponse.json();
      if (users.length === 0) {
        // User doesn't exist, nothing to delete
        return { success: true };
      }

      const userId = users[0].id;

      // Delete the user
      const deleteResponse = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${clerkSecretKey}`,
        },
      });

      if (!deleteResponse.ok) {
        const errorData = await deleteResponse.json();
        return { success: false, error: errorData.errors?.[0]?.message || 'Failed to delete user' };
      }

      console.log(`Successfully deleted Clerk user ${userId}`);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  },
});

/**
 * Delete a Clerk user by their Clerk user ID
 * Used when permanently deleting carrier data
 */
export const deleteClerkUserById = internalAction({
  args: {
    clerkUserId: v.string(),
    reason: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ success: v.literal(true) }),
    v.object({ success: v.literal(false), error: v.string() })
  ),
  handler: async (ctx, args): Promise<DeleteResult> => {
    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) {
      return { success: false, error: 'CLERK_SECRET_KEY not configured' };
    }

    try {
      console.log(`Deleting Clerk user ${args.clerkUserId}. Reason: ${args.reason || 'Not specified'}`);
      
      // Delete the user directly by ID
      const deleteResponse = await fetch(`https://api.clerk.com/v1/users/${args.clerkUserId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${clerkSecretKey}`,
        },
      });

      if (!deleteResponse.ok) {
        // If 404, user already doesn't exist
        if (deleteResponse.status === 404) {
          console.log(`Clerk user ${args.clerkUserId} already deleted or doesn't exist`);
          return { success: true };
        }
        const errorData = await deleteResponse.json();
        return { success: false, error: errorData.errors?.[0]?.message || 'Failed to delete user' };
      }

      console.log(`Successfully deleted Clerk user ${args.clerkUserId}`);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  },
});

// ==========================================
// CARRIER OWNER SYNC
// ==========================================

// Type for carrier owner info
type CarrierOwnerInfo = {
  phone: string;
  firstName: string;
  lastName: string;
  email?: string;
  organizationName: string;
};

/**
 * Look up a Clerk user by phone number
 * Returns the user ID if found, null otherwise
 */
export const findClerkUserByPhone = internalAction({
  args: {
    phone: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (_ctx, args): Promise<string | null> => {
    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) {
      console.error('CLERK_SECRET_KEY not configured');
      return null;
    }

    const e164Phone = normalizePhoneToE164(args.phone);
    console.log(`Looking up Clerk user by phone number`);

    try {
      // Search for user by phone number
      const response = await fetch(`https://api.clerk.com/v1/users?phone_number=${encodeURIComponent(e164Phone)}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${clerkSecretKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        console.error(`Failed to search Clerk users: ${response.status}`);
        return null;
      }

      const users = await response.json();
      
      if (users && users.length > 0) {
        console.log(`Found existing Clerk user`);
        return users[0].id;
      }

      console.log(`No Clerk user found for this phone number`);
      return null;
    } catch (error) {
      console.error(`Error searching Clerk users: ${error}`);
      return null;
    }
  },
});

/**
 * Create a Clerk user for a carrier owner
 * Called when a carrier organization is created or owner is added
 */
export const createClerkUserForCarrierOwner = internalAction({
  args: {
    phone: v.string(),
    firstName: v.string(),
    lastName: v.string(),
    email: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      success: v.literal(true),
      clerkUserId: v.string(),
    }),
    v.object({
      success: v.literal(false),
      error: v.string(),
    })
  ),
  handler: async (ctx, args): Promise<CreateResult> => {
    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) {
      console.error('CLERK_SECRET_KEY not configured - carrier owner will not be able to sign in to mobile app');
      return { success: false, error: 'CLERK_SECRET_KEY not configured' };
    }

    // Convert phone to E.164 format for Clerk
    const e164Phone = normalizePhoneToE164(args.phone);
    console.log(`Creating Clerk user for carrier owner: ${args.firstName} ${args.lastName}`);

    try {
      // Note: Only include phone_number - email_address requires Clerk dashboard settings
      // to be enabled, and carrier owners use phone-based auth anyway
      const requestBody: Record<string, unknown> = {
        phone_number: [e164Phone],
        first_name: args.firstName,
        last_name: args.lastName,
        skip_password_requirement: true,
      };

      const response = await fetch('https://api.clerk.com/v1/users', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${clerkSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const responseData = await response.json();

      if (!response.ok) {
        // Check if user already exists (this is fine)
        if (responseData.errors?.[0]?.code === 'form_identifier_exists') {
          console.log(`Clerk user already exists for this phone number`);
          return { success: true, clerkUserId: 'existing' };
        }

        const errorMessage = responseData.errors?.[0]?.message || responseData.errors?.[0]?.long_message || 'Failed to create Clerk user';
        console.error(`Failed to create Clerk user for carrier owner: ${errorMessage}`);
        return { success: false, error: errorMessage };
      }

      console.log(`Successfully created Clerk user ${responseData.id} for carrier owner ${args.firstName} ${args.lastName}`);
      return { success: true, clerkUserId: responseData.id };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Error creating Clerk user for carrier owner: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  },
});

// Type for carrier owner sync results
type CarrierOwnerSyncResults = {
  total: number;
  created: number;
  existing: number;
  skipped: number;
  failed: number;
  errors: string[];
};

/**
 * Bulk create Clerk users for all existing carrier owners
 * Use this to sync existing carrier organizations' owners to Clerk
 */
export const syncExistingCarrierOwnersToClerk = internalAction({
  args: {},
  returns: v.object({
    total: v.number(),
    created: v.number(),
    existing: v.number(),
    skipped: v.number(),
    failed: v.number(),
    errors: v.array(v.string()),
  }),
  handler: async (ctx): Promise<CarrierOwnerSyncResults> => {
    // Get all carrier owner identity links with phone numbers
    const identityLinks: Array<{
      phone: string | undefined;
      role: string;
      organizationId: string;
      organizationName: string;
    }> = await ctx.runQuery(internal.clerkSyncHelpers.getCarrierOwnersForSync, {});

    const results: CarrierOwnerSyncResults = {
      total: identityLinks.length,
      created: 0,
      existing: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    for (const owner of identityLinks) {
      // Skip if no phone number
      if (!owner.phone) {
        results.skipped++;
        results.errors.push(`${owner.organizationName}: No phone number on file`);
        continue;
      }

      const result: CreateResult = await ctx.runAction(internal.clerkSync.createClerkUserForCarrierOwner, {
        phone: owner.phone,
        firstName: owner.organizationName.split(' ')[0] || 'Owner', // Use org name as fallback
        lastName: owner.organizationName.split(' ').slice(1).join(' ') || 'Admin',
      });

      if (result.success) {
        if (result.clerkUserId === 'existing') {
          results.existing++;
        } else {
          results.created++;
        }
      } else {
        results.failed++;
        results.errors.push(`${owner.organizationName} (${owner.phone}): ${result.error}`);
      }
    }

    return results;
  },
});

/**
 * Create Clerk user for a single carrier owner by organization ID
 */
export const syncSingleCarrierOwnerToClerk = internalAction({
  args: {
    organizationId: v.id('organizations'),
    phone: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      success: v.literal(true),
      clerkUserId: v.string(),
    }),
    v.object({
      success: v.literal(false),
      error: v.string(),
    })
  ),
  handler: async (ctx, args): Promise<CreateResult> => {
    // Get org info for name fallback
    const org = await ctx.runQuery(internal.clerkSyncHelpers.getOrganizationById, {
      organizationId: args.organizationId,
    });

    if (!org) {
      return { success: false, error: 'Organization not found' };
    }

    const firstName = args.firstName || org.name.split(' ')[0] || 'Owner';
    const lastName = args.lastName || org.name.split(' ').slice(1).join(' ') || 'Admin';

    const result: CreateResult = await ctx.runAction(internal.clerkSync.createClerkUserForCarrierOwner, {
      phone: args.phone,
      firstName,
      lastName,
      email: args.email,
    });
    
    // Update userIdentityLinks with actual Clerk user ID
    if (result.success && result.clerkUserId) {
      let clerkUserId = result.clerkUserId;
      
      // If user already exists, look up their actual ID
      if (clerkUserId === 'existing') {
        const existingUserId = await ctx.runAction(internal.clerkSync.findClerkUserByPhone, {
          phone: args.phone,
        });
        if (existingUserId) {
          clerkUserId = existingUserId;
        }
      }
      
      // Update the record if we have a real Clerk user ID
      if (clerkUserId && clerkUserId !== 'existing') {
        await ctx.runMutation(internal.clerkSyncHelpers.updateIdentityLinkClerkUserId, {
          organizationId: args.organizationId,
          phone: args.phone,
          clerkUserId: clerkUserId,
        });
      }
    }
    
    return result;
  },
});
