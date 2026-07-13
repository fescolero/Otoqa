package expo.modules.otoqashiftstatus

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * OtoqaShiftStatusModule — Android half of the lock-screen shift surface.
 *
 * Posts a single ongoing, silent notification with a native chronometer
 * bound to the shift start time. The chronometer ticks in the OS with no
 * app involvement, so elapsed shift time stays live on the lock screen
 * without periodic updates or battery cost. The status line (current
 * trip/stop) is updated from JS on shift lifecycle + check-in/out events.
 *
 * True lock-screen widgets barely exist on Android (removed in 5.0, only
 * partially back on some 15/16 devices) — the notification shade IS the
 * lock-screen surface drivers actually see, which is why this is a
 * notification and not an AppWidget.
 *
 * Deliberately NOT a foreground service: the app already runs a location
 * FGS during shifts, and a second service buys nothing. The notification
 * survives app backgrounding; on process death it lingers until swiped
 * (acceptable — the shift is still running) and endShiftStatus() clears
 * it on every end-shift path.
 */
class OtoqaShiftStatusModule : Module() {
  companion object {
    const val CHANNEL_ID = "shift-status"
    const val NOTIFICATION_ID = 4207
    const val PREFS_NAME = "otoqa_shift_status"
    const val PREF_STARTED_AT = "startedAtMs"
  }

  // Chronometer base — kept so status-line updates re-post with the same
  // start time instead of resetting the timer. @Volatile because the
  // AsyncFunctions run on a background dispatcher with no serialization
  // guarantee. Mirrored to SharedPreferences so an update that lands
  // right after process death (queue replay / fast check-in before the
  // resume path re-asserts) still knows the correct base.
  @Volatile private var startedAtMs: Long = 0L

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("OtoqaShiftStatus")

    // startedAtMs: epoch ms when the shift began (drives the chronometer).
    // statusLine: one-line trip/stop status under the title.
    // Returns false (no-throw) when notifications are blocked so callers
    // can fire-and-forget.
    AsyncFunction("startShiftStatus") { startedAt: Double, statusLine: String ->
      val base = startedAt.toLong()
      // A zero/negative base would anchor the chronometer to 1970 and
      // permanently no-op every subsequent update — refuse it.
      if (base <= 0L) return@AsyncFunction false
      if (!canPostNotifications()) return@AsyncFunction false
      startedAtMs = base
      prefs().edit().putLong(PREF_STARTED_AT, base).apply()
      postNotification(statusLine)
      // Card is visibly up → safe to hide the redundant FGS notification
      // (covers permission granted after the startup demotion pass).
      runCatching { demoteFgsChannels() }
      true
    }

    AsyncFunction("updateShiftStatus") { statusLine: String ->
      // Recover the chronometer base from prefs after process death so a
      // check-in that lands before the resume path re-asserts still
      // updates the surviving notification — but ONLY when the card is
      // actually on screen. Gating the rehydration on an active
      // notification prevents a late update (End Shift race, replayed
      // queue entry) from resurrecting a torn-down surface with a stale
      // base.
      if (startedAtMs == 0L && isShiftNotificationActive()) {
        startedAtMs = prefs().getLong(PREF_STARTED_AT, 0L)
      }
      if (startedAtMs == 0L || !canPostNotifications()) return@AsyncFunction false
      postNotification(statusLine)
      true
    }

    AsyncFunction("endShiftStatus") {
      startedAtMs = 0L
      // commit() (synchronous) rather than apply(): a concurrent late
      // update must not observe the old base after the cancel below.
      prefs().edit().remove(PREF_STARTED_AT).commit()
      NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
      true
    }

    // Demote the infrastructure notifications so the shift card is the
    // ONE visible surface. Two offenders:
    //   1. expo-location's mandatory FGS notification — its channel id is
    //      "{appId}:OTOQA_LOCATION_TRACKING", created at IMPORTANCE_LOW,
    //      and service force-cycling can strand stale copies (new
    //      notification id per service instance).
    //   2. Any other pre-existing channel raised above MIN that matches
    //      the FGS suffix (older builds / Expo Go scoped app ids).
    //
    // Mutability contract (per createNotificationChannel docs): for an
    // EXISTING channel only name/description update freely; importance
    // is lowered only if the user hasn't customized the channel; sound/
    // visibility/badge changes are ignored. So fresh installs get the
    // full IMPORTANCE_MIN + VISIBILITY_SECRET treatment (pre-create wins
    // the race with expo-location), while upgrades get MIN importance —
    // which already keeps the card off the lock screen on stock Android
    // — but retain their original visibility.
    //
    // Deliberately a NO-OP while notifications are blocked: if the shift
    // card can't post, the FGS notification is the driver's only visible
    // evidence that tracking runs — hiding it then would leave zero
    // indicator (and channel demotion is irreversible from code).
    AsyncFunction("configureQuietChannels") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@AsyncFunction true
      if (!canPostNotifications()) return@AsyncFunction false
      demoteFgsChannels()
      true
    }
  }

  private fun demoteFgsChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val fgsSuffix = ":OTOQA_LOCATION_TRACKING"
    // Pre-create for fresh installs so expo-location's own
    // LOW-importance creation never runs (it skips existing channels).
    quietChannel(nm, "${context.packageName}$fgsSuffix", "Location service")
    for (channel in nm.notificationChannels) {
      if (channel.id.endsWith(fgsSuffix) &&
        channel.importance > NotificationManager.IMPORTANCE_MIN
      ) {
        quietChannel(nm, channel.id, channel.name?.toString() ?: "Location service")
      }
    }
  }

  private fun quietChannel(nm: NotificationManager, id: String, name: String) {
    val channel = NotificationChannel(id, name, NotificationManager.IMPORTANCE_MIN)
    channel.description = "Keeps route tracking running. Status lives on the On-shift card."
    channel.setShowBadge(false)
    channel.lockscreenVisibility = Notification.VISIBILITY_SECRET
    channel.setSound(null, null)
    channel.enableVibration(false)
    nm.createNotificationChannel(channel)
  }

  private fun prefs() =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  /** True when the shift card is currently displayed (survives process death). */
  private fun isShiftNotificationActive(): Boolean {
    return try {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.activeNotifications.any { it.id == NOTIFICATION_ID }
    } catch (e: Exception) {
      false
    }
  }

  private fun canPostNotifications(): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      val granted = ContextCompat.checkSelfPermission(
        context,
        Manifest.permission.POST_NOTIFICATIONS,
      ) == PackageManager.PERMISSION_GRANTED
      if (!granted) return false
    }
    return NotificationManagerCompat.from(context).areNotificationsEnabled()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    // IMPORTANCE_LOW: visible in the shade/lock screen, never makes sound
    // or heads-up — this is a glanceable status card, not an alert.
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Shift status",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Ongoing shift timer and current trip status"
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  private fun postNotification(statusLine: String) {
    ensureChannel()

    val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
    val contentIntent = launchIntent?.let {
      PendingIntent.getActivity(
        context,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    // Android 16+ (API 36): request Live Update promotion so the card
    // gets the prominent lock-screen slot / status chip / Samsung Now
    // Bar treatment (the pill where media players live). Older versions
    // get the standard ongoing notification via the compat path.
    val notification = if (Build.VERSION.SDK_INT >= 36) {
      buildPromotedNotification(statusLine, contentIntent)
    } else {
      // applicationInfo.icon renders monochrome-flattened in the status
      // bar on some OEMs; good enough for v1 — swap for a dedicated
      // small icon resource if it looks muddy in the field.
      NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(context.applicationInfo.icon)
        .setContentTitle("On shift")
        .setContentText(statusLine)
        .setUsesChronometer(true)
        .setWhen(startedAtMs)
        .setShowWhen(true)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .apply { if (contentIntent != null) setContentIntent(contentIntent) }
        .build()
    }

    NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
  }

  /**
   * Android 16 Live Update build path. requestPromotedOngoing is a hint
   * — the system (and the user, per-app) decides whether to honor it;
   * unpromoted it renders exactly like the compat notification. Built
   * with the platform Builder because the promotion APIs are
   * platform-level (API 36) and this keeps the version gate in one
   * function.
   */
  @RequiresApi(36)
  private fun buildPromotedNotification(
    statusLine: String,
    contentIntent: PendingIntent?,
  ): Notification {
    val builder = Notification.Builder(context, CHANNEL_ID)
      .setSmallIcon(context.applicationInfo.icon)
      .setContentTitle("On shift")
      .setContentText(statusLine)
      .setUsesChronometer(true)
      .setWhen(startedAtMs)
      .setShowWhen(true)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      // Compact text for the status-bar chip when promoted.
      .setShortCriticalText("Shift")
      .requestPromotedOngoing(true)
    if (contentIntent != null) builder.setContentIntent(contentIntent)
    return builder.build()
  }
}
