/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as _devTools_facetSimulator from "../_devTools/facetSimulator.js";
import type * as _helpers_cronUtils from "../_helpers/cronUtils.js";
import type * as _helpers_dateUtils from "../_helpers/dateUtils.js";
import type * as _helpers_timeUtils from "../_helpers/timeUtils.js";
import type * as accountingHelpers from "../accountingHelpers.js";
import type * as accountingReports from "../accountingReports.js";
import type * as accountingStats from "../accountingStats.js";
import type * as accountingStatsHelpers from "../accountingStatsHelpers.js";
import type * as analytics from "../analytics.js";
import type * as auditLog from "../auditLog.js";
import type * as autoAssignment from "../autoAssignment.js";
import type * as autoAssignmentCron from "../autoAssignmentCron.js";
import type * as carrierMobile from "../carrierMobile.js";
import type * as carrierPartnerships from "../carrierPartnerships.js";
import type * as carrierPayCalculation from "../carrierPayCalculation.js";
import type * as carrierProfileAssignments from "../carrierProfileAssignments.js";
import type * as clerkSync from "../clerkSync.js";
import type * as clerkSyncHelpers from "../clerkSyncHelpers.js";
import type * as contractLanes from "../contractLanes.js";
import type * as crons from "../crons.js";
import type * as customers from "../customers.js";
import type * as defEntries from "../defEntries.js";
import type * as diagnosticLoadReview from "../diagnosticLoadReview.js";
import type * as diagnosticWildcardLanes from "../diagnosticWildcardLanes.js";
import type * as diagnostics from "../diagnostics.js";
import type * as dispatchLegs from "../dispatchLegs.js";
import type * as driverLocations from "../driverLocations.js";
import type * as driverMobile from "../driverMobile.js";
import type * as driverPayCalculation from "../driverPayCalculation.js";
import type * as driverProfileAssignments from "../driverProfileAssignments.js";
import type * as driverSessions from "../driverSessions.js";
import type * as driverSettlements from "../driverSettlements.js";
import type * as drivers from "../drivers.js";
import type * as externalTracking from "../externalTracking.js";
import type * as externalTrackingAuth from "../externalTrackingAuth.js";
import type * as externalTrackingAuthCrypto from "../externalTrackingAuthCrypto.js";
import type * as externalTrackingPartnerKeys from "../externalTrackingPartnerKeys.js";
import type * as externalTrackingWebhooks from "../externalTrackingWebhooks.js";
import type * as facetMaintenance from "../facetMaintenance.js";
import type * as forceResync from "../forceResync.js";
import type * as fourKitesApiClient from "../fourKitesApiClient.js";
import type * as fourKitesGpsPush from "../fourKitesGpsPush.js";
import type * as fourKitesPullSyncAction from "../fourKitesPullSyncAction.js";
import type * as fourKitesScheduledSync from "../fourKitesScheduledSync.js";
import type * as fourKitesSyncHelpers from "../fourKitesSyncHelpers.js";
import type * as fourKitesTest from "../fourKitesTest.js";
import type * as fuelEntries from "../fuelEntries.js";
import type * as fuelReceiptImport from "../fuelReceiptImport.js";
import type * as fuelReports from "../fuelReports.js";
import type * as fuelVendors from "../fuelVendors.js";
import type * as geofenceEvaluator from "../geofenceEvaluator.js";
import type * as getContractLaneFull from "../getContractLaneFull.js";
import type * as googleMaps from "../googleMaps.js";
import type * as googleRoads from "../googleRoads.js";
import type * as gpsArchive from "../gpsArchive.js";
import type * as holidays from "../holidays.js";
import type * as http from "../http.js";
import type * as integrations from "../integrations.js";
import type * as invoiceCalculations from "../invoiceCalculations.js";
import type * as invoices from "../invoices.js";
import type * as laneAnalyzer from "../laneAnalyzer.js";
import type * as laneAnalyzerActions from "../laneAnalyzerActions.js";
import type * as laneAnalyzerCalculations from "../laneAnalyzerCalculations.js";
import type * as laneAnalyzerOptimization from "../laneAnalyzerOptimization.js";
import type * as laneScheduleImport from "../laneScheduleImport.js";
import type * as lanes from "../lanes.js";
import type * as lazyLoadPromotion from "../lazyLoadPromotion.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_geo from "../lib/geo.js";
import type * as lib_loadFacets from "../lib/loadFacets.js";
import type * as lib_validators from "../lib/validators.js";
import type * as loadCarrierAssignments from "../loadCarrierAssignments.js";
import type * as loadCarrierPayables from "../loadCarrierPayables.js";
import type * as loadDocuments from "../loadDocuments.js";
import type * as loadHoldWorkflow from "../loadHoldWorkflow.js";
import type * as loadPayables from "../loadPayables.js";
import type * as loadReview from "../loadReview.js";
import type * as loadTrackingState from "../loadTrackingState.js";
import type * as loads from "../loads.js";
import type * as maintenance from "../maintenance.js";
import type * as manualCleanup from "../manualCleanup.js";
import type * as manualTemplates from "../manualTemplates.js";
import type * as migrations_001_backfill_contract_lanes from "../migrations/001_backfill_contract_lanes.js";
import type * as migrations_002_clear_load_data from "../migrations/002_clear_load_data.js";
import type * as migrations_003_update_wildcard_line_items from "../migrations/003_update_wildcard_line_items.js";
import type * as migrations_004_bootstrap_facet_definitions from "../migrations/004_bootstrap_facet_definitions.js";
import type * as migrations_005_backfill_load_tags from "../migrations/005_backfill_load_tags.js";
import type * as migrations_006_cleanup_junk_facets from "../migrations/006_cleanup_junk_facets.js";
import type * as migrations_007_strip_parsed_columns from "../migrations/007_strip_parsed_columns.js";
import type * as migrations_008_backfill_stop_denorm from "../migrations/008_backfill_stop_denorm.js";
import type * as migrations_backfillDispatchLegs from "../migrations/backfillDispatchLegs.js";
import type * as migrations_backfillFirstStopDate from "../migrations/backfillFirstStopDate.js";
import type * as migrations_backfillOrgType from "../migrations/backfillOrgType.js";
import type * as migrations_initializeOrgStats from "../migrations/initializeOrgStats.js";
import type * as migrations_unlinkFalselyLinkedCarriers from "../migrations/unlinkFalselyLinkedCarriers.js";
import type * as payPlans from "../payPlans.js";
import type * as rateProfiles from "../rateProfiles.js";
import type * as rateRules from "../rateRules.js";
import type * as recurringLoads from "../recurringLoads.js";
import type * as recurringLoadsCron from "../recurringLoadsCron.js";
import type * as routeAssignments from "../routeAssignments.js";
import type * as s3Upload from "../s3Upload.js";
import type * as sandboxData from "../sandboxData.js";
import type * as scheduleImport from "../scheduleImport.js";
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
  "_devTools/facetSimulator": typeof _devTools_facetSimulator;
  "_helpers/cronUtils": typeof _helpers_cronUtils;
  "_helpers/dateUtils": typeof _helpers_dateUtils;
  "_helpers/timeUtils": typeof _helpers_timeUtils;
  accountingHelpers: typeof accountingHelpers;
  accountingReports: typeof accountingReports;
  accountingStats: typeof accountingStats;
  accountingStatsHelpers: typeof accountingStatsHelpers;
  analytics: typeof analytics;
  auditLog: typeof auditLog;
  autoAssignment: typeof autoAssignment;
  autoAssignmentCron: typeof autoAssignmentCron;
  carrierMobile: typeof carrierMobile;
  carrierPartnerships: typeof carrierPartnerships;
  carrierPayCalculation: typeof carrierPayCalculation;
  carrierProfileAssignments: typeof carrierProfileAssignments;
  clerkSync: typeof clerkSync;
  clerkSyncHelpers: typeof clerkSyncHelpers;
  contractLanes: typeof contractLanes;
  crons: typeof crons;
  customers: typeof customers;
  defEntries: typeof defEntries;
  diagnosticLoadReview: typeof diagnosticLoadReview;
  diagnosticWildcardLanes: typeof diagnosticWildcardLanes;
  diagnostics: typeof diagnostics;
  dispatchLegs: typeof dispatchLegs;
  driverLocations: typeof driverLocations;
  driverMobile: typeof driverMobile;
  driverPayCalculation: typeof driverPayCalculation;
  driverProfileAssignments: typeof driverProfileAssignments;
  driverSessions: typeof driverSessions;
  driverSettlements: typeof driverSettlements;
  drivers: typeof drivers;
  externalTracking: typeof externalTracking;
  externalTrackingAuth: typeof externalTrackingAuth;
  externalTrackingAuthCrypto: typeof externalTrackingAuthCrypto;
  externalTrackingPartnerKeys: typeof externalTrackingPartnerKeys;
  externalTrackingWebhooks: typeof externalTrackingWebhooks;
  facetMaintenance: typeof facetMaintenance;
  forceResync: typeof forceResync;
  fourKitesApiClient: typeof fourKitesApiClient;
  fourKitesGpsPush: typeof fourKitesGpsPush;
  fourKitesPullSyncAction: typeof fourKitesPullSyncAction;
  fourKitesScheduledSync: typeof fourKitesScheduledSync;
  fourKitesSyncHelpers: typeof fourKitesSyncHelpers;
  fourKitesTest: typeof fourKitesTest;
  fuelEntries: typeof fuelEntries;
  fuelReceiptImport: typeof fuelReceiptImport;
  fuelReports: typeof fuelReports;
  fuelVendors: typeof fuelVendors;
  geofenceEvaluator: typeof geofenceEvaluator;
  getContractLaneFull: typeof getContractLaneFull;
  googleMaps: typeof googleMaps;
  googleRoads: typeof googleRoads;
  gpsArchive: typeof gpsArchive;
  holidays: typeof holidays;
  http: typeof http;
  integrations: typeof integrations;
  invoiceCalculations: typeof invoiceCalculations;
  invoices: typeof invoices;
  laneAnalyzer: typeof laneAnalyzer;
  laneAnalyzerActions: typeof laneAnalyzerActions;
  laneAnalyzerCalculations: typeof laneAnalyzerCalculations;
  laneAnalyzerOptimization: typeof laneAnalyzerOptimization;
  laneScheduleImport: typeof laneScheduleImport;
  lanes: typeof lanes;
  lazyLoadPromotion: typeof lazyLoadPromotion;
  "lib/auth": typeof lib_auth;
  "lib/geo": typeof lib_geo;
  "lib/loadFacets": typeof lib_loadFacets;
  "lib/validators": typeof lib_validators;
  loadCarrierAssignments: typeof loadCarrierAssignments;
  loadCarrierPayables: typeof loadCarrierPayables;
  loadDocuments: typeof loadDocuments;
  loadHoldWorkflow: typeof loadHoldWorkflow;
  loadPayables: typeof loadPayables;
  loadReview: typeof loadReview;
  loadTrackingState: typeof loadTrackingState;
  loads: typeof loads;
  maintenance: typeof maintenance;
  manualCleanup: typeof manualCleanup;
  manualTemplates: typeof manualTemplates;
  "migrations/001_backfill_contract_lanes": typeof migrations_001_backfill_contract_lanes;
  "migrations/002_clear_load_data": typeof migrations_002_clear_load_data;
  "migrations/003_update_wildcard_line_items": typeof migrations_003_update_wildcard_line_items;
  "migrations/004_bootstrap_facet_definitions": typeof migrations_004_bootstrap_facet_definitions;
  "migrations/005_backfill_load_tags": typeof migrations_005_backfill_load_tags;
  "migrations/006_cleanup_junk_facets": typeof migrations_006_cleanup_junk_facets;
  "migrations/007_strip_parsed_columns": typeof migrations_007_strip_parsed_columns;
  "migrations/008_backfill_stop_denorm": typeof migrations_008_backfill_stop_denorm;
  "migrations/backfillDispatchLegs": typeof migrations_backfillDispatchLegs;
  "migrations/backfillFirstStopDate": typeof migrations_backfillFirstStopDate;
  "migrations/backfillOrgType": typeof migrations_backfillOrgType;
  "migrations/initializeOrgStats": typeof migrations_initializeOrgStats;
  "migrations/unlinkFalselyLinkedCarriers": typeof migrations_unlinkFalselyLinkedCarriers;
  payPlans: typeof payPlans;
  rateProfiles: typeof rateProfiles;
  rateRules: typeof rateRules;
  recurringLoads: typeof recurringLoads;
  recurringLoadsCron: typeof recurringLoadsCron;
  routeAssignments: typeof routeAssignments;
  s3Upload: typeof s3Upload;
  sandboxData: typeof sandboxData;
  scheduleImport: typeof scheduleImport;
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

export declare const components: {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
