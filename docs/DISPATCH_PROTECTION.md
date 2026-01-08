# Dispatch Protection System

This document describes the load status transition protection system that prevents accidental data loss and ensures operational integrity.

## Overview

When dispatchers change load statuses (via bulk actions in the Loads table), the system validates each transition to:
1. **Block** impossible transitions
2. **Warn** about destructive transitions (imminent pickups, active loads)
3. **Require documentation** for cancellations of assigned work

## Status Transition Matrix

| From | To | Protection Level | Behavior |
|------|-----|-----------------|----------|
| Open | Assigned | ✅ None | Direct update |
| Open | Delivered | 🛑 **Block** | Cannot deliver without assignment/transport |
| Open | Canceled | ✅ None | Dead-wood cleanup, no reason needed |
| Assigned | Open | ⚠️ **Warn** | Warns about dispatcher work loss; blocks if imminent/active |
| Assigned | Delivered | 🛑 **Block** | Only allowed if ALL dispatch legs are COMPLETED |
| Assigned | Canceled | ⚠️ **Require Reason** | Must provide cancellation reason code |
| Delivered | Any | 🛑 **Block** | Finalized loads cannot change status |
| Canceled | Any | 🛑 **Block** | Finalized loads cannot change status |

## Protection Categories

### 1. Safe Loads
Loads that can be updated without any risk:
- Open loads (no assignment to lose)
- Assigned loads with no imminent pickup and no active legs

### 2. Imminent Loads
Loads with pickup scheduled within the **buffer window** (default: 4 hours):
- Requires dispatcher confirmation before unassigning
- Shown in amber/warning section of resolution modal

### 3. Active Loads
Loads with at least one dispatch leg in `ACTIVE` status:
- Currently being transported
- Cannot be unassigned or reverted to Open
- Must complete or cancel through proper workflow

### 4. Finalized Loads
Loads with status `Completed` (Delivered) or `Canceled`:
- Cannot change status
- Skipped in bulk operations

### 5. Blocked Transitions
Impossible state changes:
- Open → Delivered (must be assigned first)
- Assigned → Delivered (dispatch legs must be completed)

### 6. Requires Reason
Transitions that need documented justification:
- Assigned → Canceled (all assigned cancellations require reason code)

## Cancellation Reason Codes

When canceling an assigned load, dispatchers must select from:

| Code | Label | Description |
|------|-------|-------------|
| `DRIVER_BREAKDOWN` | Driver Breakdown | Driver had mechanical issues or became unavailable |
| `CUSTOMER_CANCELLED` | Customer Cancelled | Customer cancelled the shipment |
| `EQUIPMENT_ISSUE` | Equipment Issue | Truck or trailer problems prevented dispatch |
| `RATE_DISPUTE` | Rate Dispute | Rate negotiation failed |
| `WEATHER_CONDITIONS` | Weather Conditions | Unsafe driving conditions |
| `CAPACITY_ISSUE` | Capacity Issue | Unable to accommodate load requirements |
| `SCHEDULING_CONFLICT` | Scheduling Conflict | Pickup/delivery windows could not be met |
| `OTHER` | Other | Requires additional notes |

## Data Model

### loadInformation Schema Fields

```typescript
// Cancellation Tracking (when status = 'Canceled')
cancellationReason?: 'DRIVER_BREAKDOWN' | 'CUSTOMER_CANCELLED' | 'EQUIPMENT_ISSUE' | 
                     'RATE_DISPUTE' | 'WEATHER_CONDITIONS' | 'CAPACITY_ISSUE' | 
                     'SCHEDULING_CONFLICT' | 'OTHER';
cancellationNotes?: string;
canceledAt?: number;        // Unix timestamp
canceledBy?: string;        // WorkOS user ID
```

## API Reference

### validateBulkStatusChange Query

Validates a batch of loads before status change.

```typescript
// convex/loads.ts
api.loads.validateBulkStatusChange({
  loadIds: Id<'loadInformation'>[],
  targetStatus: 'Open' | 'Assigned' | 'Completed' | 'Canceled',
  bufferHours?: number  // Default: 4
})
```

**Returns:**
```typescript
{
  safe: { id, orderNumber, currentStatus }[],
  imminent: { id, orderNumber, pickupTime, hoursUntilPickup, currentStatus }[],
  active: { id, orderNumber }[],
  finalized: { id, orderNumber, status }[],
  blocked: { id, orderNumber, reason }[],
  requiresReason: { id, orderNumber, currentStatus }[],
  summary: {
    total: number,
    safeCount: number,
    imminentCount: number,
    activeCount: number,
    finalizedCount: number,
    blockedCount: number,
    requiresReasonCount: number,
    canProceedSafely: boolean
  }
}
```

### updateLoadStatus Mutation

Updates load status with optional cancellation metadata.

```typescript
// convex/loads.ts
api.loads.updateLoadStatus({
  loadId: Id<'loadInformation'>,
  status: 'Open' | 'Assigned' | 'Completed' | 'Canceled',
  // Required for Assigned → Canceled:
  cancellationReason?: CancellationReasonCode,
  cancellationNotes?: string,
  canceledBy?: string  // WorkOS user ID
})
```

**Side Effects:**
- `→ Open`: Clears `primaryDriverId`, `primaryCarrierId`, sets `trackingStatus = 'Pending'`, cancels PENDING legs, deletes unlocked SYSTEM payables
- `→ Canceled`: Sets `trackingStatus = 'Canceled'`, stores cancellation metadata, cancels PENDING and ACTIVE legs
- `→ Completed`: Sets `trackingStatus = 'Completed'`

## UI Components

### BulkActionResolutionModal
- **Location:** `components/loads/bulk-action-resolution-modal.tsx`
- **Purpose:** Shows impact analysis for bulk status changes
- **Sections:**
  - 🟢 Safe loads (green) - proceed automatically
  - 🟡 Imminent loads (amber) - require confirmation
  - 🔴 Active loads (red) - blocked from change
  - ⚫ Finalized loads (gray) - already completed/canceled

### CancellationReasonModal
- **Location:** `components/loads/cancellation-reason-modal.tsx`
- **Purpose:** Collects cancellation reason for assigned loads
- **Features:**
  - Reason code dropdown (required)
  - Notes field (required for "Other")
  - Shows affected loads list

## Flow Diagram

```
User selects loads → Clicks status action
                           ↓
              validateBulkStatusChange()
                           ↓
         ┌─────────────────┼─────────────────┐
         ↓                 ↓                 ↓
    Has blocked?     Has requiresReason?   All safe?
         ↓                 ↓                 ↓
   Toast error        Show Cancel      Execute directly
   (still show        Reason Modal        (toast success)
    modal if                ↓
    safe/imminent          User selects
    remain)                reason code
                              ↓
                     updateLoadStatus()
                     with reason metadata
```

## Configuration

### Buffer Hours
The "imminent" threshold can be adjusted per-call:

```typescript
validateBulkStatusChange({
  loadIds: [...],
  targetStatus: 'Open',
  bufferHours: 6  // Custom: 6 hours instead of default 4
})
```

## Files Modified

| File | Changes |
|------|---------|
| `convex/schema.ts` | Added cancellation fields to `loadInformation` |
| `convex/loads.ts` | Updated `validateBulkStatusChange`, `updateLoadStatus` |
| `components/loads-table.tsx` | Integrated validation flow |
| `components/loads/cancellation-reason-modal.tsx` | New component |
| `components/loads/bulk-action-resolution-modal.tsx` | Handles blocked/safe/imminent display |

## Future Enhancements

1. **Audit Trail**: Log all cancellation reasons to `auditLog` table
2. **Reporting**: Dashboard showing cancellation trends by reason code
3. **Notifications**: Alert operations manager when multiple cancellations occur
4. **Carrier Scorecards**: Track carrier-attributed cancellations (DRIVER_BREAKDOWN, EQUIPMENT_ISSUE)
