package expo.modules.otoqashiftstatus

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
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
  }

  // Chronometer base — kept so status-line updates re-post with the same
  // start time instead of resetting the timer.
  private var startedAtMs: Long = 0L

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("OtoqaShiftStatus")

    // startedAtMs: epoch ms when the shift began (drives the chronometer).
    // statusLine: one-line trip/stop status under the title.
    // Returns false (no-throw) when notifications are blocked so callers
    // can fire-and-forget.
    AsyncFunction("startShiftStatus") { startedAt: Double, statusLine: String ->
      if (!canPostNotifications()) return@AsyncFunction false
      startedAtMs = startedAt.toLong()
      postNotification(statusLine)
      true
    }

    AsyncFunction("updateShiftStatus") { statusLine: String ->
      // No active surface (start never ran or was blocked) → no-op. Never
      // resurrect a notification with a zero chronometer base.
      if (startedAtMs == 0L || !canPostNotifications()) return@AsyncFunction false
      postNotification(statusLine)
      true
    }

    AsyncFunction("endShiftStatus") {
      startedAtMs = 0L
      NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
      true
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

    // applicationInfo.icon renders monochrome-flattened in the status bar
    // on some OEMs; good enough for v1 — swap for a dedicated small icon
    // resource if it looks muddy in the field.
    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
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

    NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
  }
}
