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
    console.log(`Creating Clerk user for driver: ${args.firstName} ${args.lastName}, phone: ${args.phone} -> ${e164Phone}`);

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
          console.log(`Clerk user already exists for phone ${e164Phone}`);
          return { success: true, clerkUserId: 'existing' };
        }
        
        const errorMessage = responseData.errors?.[0]?.message || responseData.errors?.[0]?.long_message || 'Failed to create Clerk user';
        console.error(`Failed to create Clerk user: ${errorMessage}`, responseData);
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
    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) {
      console.error('CLERK_SECRET_KEY not configured');
      return { success: false, error: 'CLERK_SECRET_KEY not configured' };
    }

    const oldE164 = normalizePhoneToE164(args.oldPhone);
    const newE164 = normalizePhoneToE164(args.newPhone);

    console.log(`Updating Clerk user phone: ${oldE164} -> ${newE164}`);

    try {
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
        return { success: false, error: `Failed to search for user: ${errorData.errors?.[0]?.message}` };
      }

      const users = await searchResponse.json();

      if (users.length === 0) {
        // User doesn't exist in Clerk - create them with the new phone
        console.log(`No Clerk user found with old phone ${oldE164}, creating new user with ${newE164}`);
        const createResult: CreateResult = await ctx.runAction(internal.clerkSync.createClerkUserForDriver, {
          phone: args.newPhone,
          firstName: args.firstName,
          lastName: args.lastName,
        });
        
        if (createResult.success) {
          return { success: true, action: 'created_new' };
        } else {
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
        const errorData = await addPhoneResponse.json();
        
        // If the new phone already exists on another user, that's a problem
        if (errorData.errors?.[0]?.code === 'form_identifier_exists') {
          return { success: false, error: 'New phone number is already in use by another account' };
        }
        
        return { success: false, error: `Failed to add new phone: ${errorData.errors?.[0]?.message}` };
      }

      // Delete the old phone number
      const phoneNumbers = users[0].phone_numbers || [];
      const oldPhoneRecord = phoneNumbers.find((p: { phone_number: string; id: string }) => p.phone_number === oldE164);
      if (oldPhoneRecord) {
        await fetch(`https://api.clerk.com/v1/users/${userId}/phone_numbers/${oldPhoneRecord.id}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${clerkSecretKey}`,
          },
        });
      }

      console.log(`Successfully updated Clerk user ${userId} phone from ${oldE164} to ${newE164}`);
      return { success: true, action: 'updated' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Error updating Clerk user phone: ${errorMessage}`);
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
