/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as _helpers_timeUtils from "../_helpers/timeUtils.js";
import type * as analytics from "../analytics.js";
import type * as auditLog from "../auditLog.js";
import type * as carrierProfileAssignments from "../carrierProfileAssignments.js";
import type * as carriers from "../carriers.js";
import type * as clerkSync from "../clerkSync.js";
import type * as clerkSyncHelpers from "../clerkSyncHelpers.js";
import type * as contractLanes from "../contractLanes.js";
import type * as crons from "../crons.js";
import type * as customers from "../customers.js";
import type * as diagnosticLoadReview from "../diagnosticLoadReview.js";
import type * as diagnosticWildcardLanes from "../diagnosticWildcardLanes.js";
import type * as diagnostics from "../diagnostics.js";
import type * as dispatchLegs from "../dispatchLegs.js";
import type * as driverLocations from "../driverLocations.js";
import type * as driverMobile from "../driverMobile.js";
import type * as driverPayCalculation from "../driverPayCalculation.js";
import type * as driverProfileAssignments from "../driverProfileAssignments.js";
import type * as driverSettlements from "../driverSettlements.js";
import type * as drivers from "../drivers.js";
import type * as forceResync from "../forceResync.js";
import type * as fourKitesApiClient from "../fourKitesApiClient.js";
import type * as fourKitesPullSyncAction from "../fourKitesPullSyncAction.js";
import type * as fourKitesScheduledSync from "../fourKitesScheduledSync.js";
import type * as fourKitesSyncHelpers from "../fourKitesSyncHelpers.js";
import type * as fourKitesTest from "../fourKitesTest.js";
import type * as getContractLaneFull from "../getContractLaneFull.js";
import type * as googleMaps from "../googleMaps.js";
import type * as googleRoads from "../googleRoads.js";
import type * as integrations from "../integrations.js";
import type * as invoiceCalculations from "../invoiceCalculations.js";
import type * as invoices from "../invoices.js";
import type * as lanes from "../lanes.js";
import type * as lazyLoadPromotion from "../lazyLoadPromotion.js";
import type * as loadHoldWorkflow from "../loadHoldWorkflow.js";
import type * as loadPayables from "../loadPayables.js";
import type * as loadReview from "../loadReview.js";
import type * as loads from "../loads.js";
import type * as maintenance from "../maintenance.js";
import type * as manualCleanup from "../manualCleanup.js";
import type * as manualTemplates from "../manualTemplates.js";
import type * as migrations_001_backfill_contract_lanes from "../migrations/001_backfill_contract_lanes.js";
import type * as migrations_002_clear_load_data from "../migrations/002_clear_load_data.js";
import type * as migrations_003_update_wildcard_line_items from "../migrations/003_update_wildcard_line_items.js";
import type * as migrations_backfillDispatchLegs from "../migrations/backfillDispatchLegs.js";
import type * as migrations_backfillFirstStopDate from "../migrations/backfillFirstStopDate.js";
import type * as migrations_initializeOrgStats from "../migrations/initializeOrgStats.js";
import type * as payPlans from "../payPlans.js";
import type * as rateProfiles from "../rateProfiles.js";
import type * as rateRules from "../rateRules.js";
import type * as s3Upload from "../s3Upload.js";
import type * as settings from "../settings.js";
import type * as stats from "../stats.js";
import type * as stats_helpers from "../stats_helpers.js";
import type * as trailers from "../trailers.js";
import type * as trucks from "../trucks.js";
import type * as vinDecoder from "../vinDecoder.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "_helpers/timeUtils": typeof _helpers_timeUtils;
  analytics: typeof analytics;
  auditLog: typeof auditLog;
  carrierProfileAssignments: typeof carrierProfileAssignments;
  carriers: typeof carriers;
  clerkSync: typeof clerkSync;
  clerkSyncHelpers: typeof clerkSyncHelpers;
  contractLanes: typeof contractLanes;
  crons: typeof crons;
  customers: typeof customers;
  diagnosticLoadReview: typeof diagnosticLoadReview;
  diagnosticWildcardLanes: typeof diagnosticWildcardLanes;
  diagnostics: typeof diagnostics;
  dispatchLegs: typeof dispatchLegs;
  driverLocations: typeof driverLocations;
  driverMobile: typeof driverMobile;
  driverPayCalculation: typeof driverPayCalculation;
  driverProfileAssignments: typeof driverProfileAssignments;
  driverSettlements: typeof driverSettlements;
  drivers: typeof drivers;
  forceResync: typeof forceResync;
  fourKitesApiClient: typeof fourKitesApiClient;
  fourKitesPullSyncAction: typeof fourKitesPullSyncAction;
  fourKitesScheduledSync: typeof fourKitesScheduledSync;
  fourKitesSyncHelpers: typeof fourKitesSyncHelpers;
  fourKitesTest: typeof fourKitesTest;
  getContractLaneFull: typeof getContractLaneFull;
  googleMaps: typeof googleMaps;
  googleRoads: typeof googleRoads;
  integrations: typeof integrations;
  invoiceCalculations: typeof invoiceCalculations;
  invoices: typeof invoices;
  lanes: typeof lanes;
  lazyLoadPromotion: typeof lazyLoadPromotion;
  loadHoldWorkflow: typeof loadHoldWorkflow;
  loadPayables: typeof loadPayables;
  loadReview: typeof loadReview;
  loads: typeof loads;
  maintenance: typeof maintenance;
  manualCleanup: typeof manualCleanup;
  manualTemplates: typeof manualTemplates;
  "migrations/001_backfill_contract_lanes": typeof migrations_001_backfill_contract_lanes;
  "migrations/002_clear_load_data": typeof migrations_002_clear_load_data;
  "migrations/003_update_wildcard_line_items": typeof migrations_003_update_wildcard_line_items;
  "migrations/backfillDispatchLegs": typeof migrations_backfillDispatchLegs;
  "migrations/backfillFirstStopDate": typeof migrations_backfillFirstStopDate;
  "migrations/initializeOrgStats": typeof migrations_initializeOrgStats;
  payPlans: typeof payPlans;
  rateProfiles: typeof rateProfiles;
  rateRules: typeof rateRules;
  s3Upload: typeof s3Upload;
  settings: typeof settings;
  stats: typeof stats;
  stats_helpers: typeof stats_helpers;
  trailers: typeof trailers;
  trucks: typeof trucks;
  vinDecoder: typeof vinDecoder;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
