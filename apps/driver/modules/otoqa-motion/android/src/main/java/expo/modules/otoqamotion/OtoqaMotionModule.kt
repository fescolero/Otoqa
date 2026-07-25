package expo.modules.otoqamotion

import android.Manifest
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionEvent
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.tasks.await

/**
 * OtoqaMotionModule — Phase 1d native bridge for Google Play Services
 * Activity Recognition.
 *
 * Subscribes to STILL ↔ IN_VEHICLE transitions only (per the §6.2
 * noise-floor decision in mobile/docs/gps-tracking-architecture.md).
 * The receiver is dynamic, bound to the JS lifecycle via
 * registerTransitions / unregisterTransitions, so AR events only fire
 * while the JS runtime is alive. Dead-app wake relies on FCM today
 * (PR 1b); a follow-up PR can add a static receiver + HeadlessJS task
 * if canary shows FCM alone isn't fast enough.
 *
 * Events dispatched to JS:
 *   onActivityTransition: {
 *     activityType: 'IN_VEHICLE' | 'STILL',
 *     transition:   'ENTER' | 'EXIT',
 *     elapsedRealtimeNanos: number,  // device-monotonic at the event
 *     timestamp: number,              // wall-clock millis at dispatch
 *   }
 *
 * Confidence is intentionally absent — the ActivityTransitionEvent API
 * does not expose it (only the older `requestActivityUpdates` returns
 * DetectedActivity with confidence). False-positive defense happens in
 * JS via debounce + rate-limit.
 */
class OtoqaMotionModule : Module() {

  companion object {
    private const val TRANSITION_ACTION = "expo.modules.otoqamotion.ACTION_TRANSITION"
    private const val PENDING_INTENT_REQUEST_CODE = 2401
  }

  private var pendingIntent: PendingIntent? = null
  private var receiver: BroadcastReceiver? = null

  private val reactContext: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("OtoqaMotion")

    Events("onActivityTransition")

    // Cleanly tear down when the JS context goes away (hot reload,
    // full JS shutdown). Leaves us in a known state so a subsequent
    // register can reuse the slot.
    //
    // OnDestroy's signature is `(() -> Unit)` — non-suspend — so we
    // call the sync-cleanup variant here. `removeActivityTransitionUpdates`
    // returns a Task which we fire-and-forget: the OS will reap the
    // subscription even if the Task hasn't finished by the time the
    // process exits, and BroadcastReceivers auto-unregister on process
    // death. JS callers that need to await completion use the
    // `unregisterTransitions` AsyncFunction (Coroutine variant) instead.
    OnDestroy {
      cleanupSync()
    }

    AsyncFunction("registerTransitions") Coroutine { ->
      val ctx = reactContext
      assertPermission(ctx)

      // Already subscribed — treat as idempotent success. The JS
      // layer may call register on every tracking-start; redundant
      // calls shouldn't trip the Play Services client.
      if (pendingIntent != null && receiver != null) {
        return@Coroutine true
      }

      val transitions = listOf(
        ActivityTransition.Builder()
          .setActivityType(DetectedActivity.IN_VEHICLE)
          .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
          .build(),
        ActivityTransition.Builder()
          .setActivityType(DetectedActivity.IN_VEHICLE)
          .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_EXIT)
          .build(),
        ActivityTransition.Builder()
          .setActivityType(DetectedActivity.STILL)
          .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
          .build(),
        ActivityTransition.Builder()
          .setActivityType(DetectedActivity.STILL)
          .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_EXIT)
          .build(),
      )

      val intent = Intent(TRANSITION_ACTION).setPackage(ctx.packageName)
      // FLAG_MUTABLE required on Android 12+ for ActivityRecognition to
      // write the transition payload into the intent before dispatch.
      val piFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
      } else {
        PendingIntent.FLAG_UPDATE_CURRENT
      }
      val pi = PendingIntent.getBroadcast(ctx, PENDING_INTENT_REQUEST_CODE, intent, piFlags)

      val rcv = object : BroadcastReceiver() {
        override fun onReceive(receiverCtx: Context, received: Intent) {
          if (received.action != TRANSITION_ACTION) return
          if (!ActivityTransitionResult.hasResult(received)) return
          val result = ActivityTransitionResult.extractResult(received) ?: return
          result.transitionEvents.forEach { dispatchTransition(it) }
        }
      }
      // Register as non-exported since only our own PendingIntent fires
      // it. RECEIVER_NOT_EXPORTED is the Android 13+ default-secure flag.
      val filter = IntentFilter(TRANSITION_ACTION)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        ctx.registerReceiver(rcv, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        @Suppress("UnspecifiedRegisterReceiverFlag")
        ctx.registerReceiver(rcv, filter)
      }
      receiver = rcv

      val request = ActivityTransitionRequest(transitions)
      ActivityRecognition.getClient(ctx)
        .requestActivityTransitionUpdates(request, pi)
        .await()
      pendingIntent = pi
      return@Coroutine true
    }

    AsyncFunction("unregisterTransitions") Coroutine { ->
      tryUnregister()
      return@Coroutine true
    }

    /**
     * Dev-only: synthesize a transition event for Maestro + simulator
     * testing. Gated behind EXPO_PUBLIC_MOTION_MOCK=1 at the JS layer;
     * the native function itself is unguarded because the JS gate is
     * sufficient for release builds (no JS caller = no invocation).
     */
    AsyncFunction("fakeTransition") { activity: String, transition: String ->
      val activityType = when (activity) {
        "IN_VEHICLE" -> DetectedActivity.IN_VEHICLE
        "STILL" -> DetectedActivity.STILL
        else -> throw Exceptions.IllegalArgument("Unknown activity type: $activity")
      }
      val transitionType = when (transition) {
        "ENTER" -> ActivityTransition.ACTIVITY_TRANSITION_ENTER
        "EXIT" -> ActivityTransition.ACTIVITY_TRANSITION_EXIT
        else -> throw Exceptions.IllegalArgument("Unknown transition: $transition")
      }
      sendEvent(
        "onActivityTransition",
        mapOf(
          "activityType" to activityTypeToString(activityType),
          "transition" to transitionTypeToString(transitionType),
          "elapsedRealtimeNanos" to android.os.SystemClock.elapsedRealtimeNanos(),
          "timestamp" to System.currentTimeMillis(),
          "mock" to true,
        ),
      )
    }
  }

  // ------------------------------------------------------------------
  // HELPERS
  // ------------------------------------------------------------------

  private suspend fun tryUnregister() {
    val ctx = appContext.reactContext ?: return
    pendingIntent?.let { pi ->
      try {
        ActivityRecognition.getClient(ctx).removeActivityTransitionUpdates(pi).await()
      } catch (_: Throwable) {
        // Non-fatal: Play Services may already consider the request
        // stopped (e.g., app was restarted). Always clean up the
        // PendingIntent + receiver regardless.
      }
      pi.cancel()
    }
    pendingIntent = null
    receiver?.let { rcv ->
      try {
        ctx.unregisterReceiver(rcv)
      } catch (_: IllegalArgumentException) {
        // Receiver was never registered (unregisterTransitions called
        // without a prior registerTransitions). Quietly ignore.
      }
    }
    receiver = null
  }

  /**
   * Non-suspend sibling of [tryUnregister] for use in non-suspend
   * lifecycle hooks (OnDestroy). Fires the Play Services removal
   * without awaiting the Task — the OS reaps the subscription on
   * process death regardless.
   */
  private fun cleanupSync() {
    val ctx = appContext.reactContext ?: return
    pendingIntent?.let { pi ->
      try {
        // Non-awaited Task — the subscription is cleaned up best-effort.
        ActivityRecognition.getClient(ctx).removeActivityTransitionUpdates(pi)
      } catch (_: Throwable) {
        // Client may be in an error state; receiver cleanup below still runs.
      }
      pi.cancel()
    }
    pendingIntent = null
    receiver?.let { rcv ->
      try {
        ctx.unregisterReceiver(rcv)
      } catch (_: IllegalArgumentException) {
        // Never registered — no-op.
      }
    }
    receiver = null
  }

  private fun dispatchTransition(event: ActivityTransitionEvent) {
    sendEvent(
      "onActivityTransition",
      mapOf(
        "activityType" to activityTypeToString(event.activityType),
        "transition" to transitionTypeToString(event.transitionType),
        "elapsedRealtimeNanos" to event.elapsedRealTimeNanos,
        "timestamp" to System.currentTimeMillis(),
        "mock" to false,
      ),
    )
  }

  private fun activityTypeToString(type: Int): String = when (type) {
    DetectedActivity.IN_VEHICLE -> "IN_VEHICLE"
    DetectedActivity.STILL -> "STILL"
    DetectedActivity.ON_FOOT -> "ON_FOOT"
    DetectedActivity.ON_BICYCLE -> "ON_BICYCLE"
    DetectedActivity.RUNNING -> "RUNNING"
    DetectedActivity.WALKING -> "WALKING"
    DetectedActivity.TILTING -> "TILTING"
    DetectedActivity.UNKNOWN -> "UNKNOWN"
    else -> "UNKNOWN"
  }

  private fun transitionTypeToString(type: Int): String = when (type) {
    ActivityTransition.ACTIVITY_TRANSITION_ENTER -> "ENTER"
    ActivityTransition.ACTIVITY_TRANSITION_EXIT -> "EXIT"
    else -> "UNKNOWN"
  }

  private fun assertPermission(ctx: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACTIVITY_RECOGNITION) !=
        PackageManager.PERMISSION_GRANTED
      ) {
        throw Exceptions.IllegalArgument(
          "ACTIVITY_RECOGNITION permission not granted — request it via the JS permissions layer before calling registerTransitions",
        )
      }
    }
    // Pre-Q the permission is install-time (com.google.android.gms.permission.ACTIVITY_RECOGNITION);
    // it's declared in the app's merged manifest and always granted.
  }
}
