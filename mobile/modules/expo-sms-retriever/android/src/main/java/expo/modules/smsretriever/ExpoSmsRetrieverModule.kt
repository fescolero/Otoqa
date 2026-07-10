package expo.modules.smsretriever

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * SMS Retriever API bridge — zero-tap OTP on Android.
 *
 * startListener() opens a ~5-minute window in which Google Play services
 * watches incoming SMS. A message whose body ends with this app's 11-char
 * signing hash is delivered to the registered receiver WITHOUT any SMS
 * permissions or user interaction, and forwarded to JS as `onSmsReceived`.
 * Messages without the hash are never delivered (JS then relies on the
 * keyboard's one-tap autofill instead).
 *
 * getAppSignatures() returns the hash(es) for the RUNNING build's signing
 * cert — dev-client, internal (preview), and Play-signed release each have
 * a different hash. The production hash must be appended to the Clerk SMS
 * template for zero-tap to fire in production.
 */
class ExpoSmsRetrieverModule : Module() {
  private var receiver: BroadcastReceiver? = null

  override fun definition() = ModuleDefinition {
    Name("ExpoSmsRetriever")
    Events("onSmsReceived")

    AsyncFunction("startListener") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      registerReceiver(context)
      SmsRetriever.getClient(context).startSmsRetriever()
        .addOnSuccessListener { promise.resolve(true) }
        .addOnFailureListener {
          unregister()
          promise.resolve(false)
        }
    }

    AsyncFunction("stopListener") {
      unregister()
    }

    AsyncFunction("getAppSignatures") {
      val context = appContext.reactContext
      if (context == null) emptyList() else AppSignatureHelper.getSignatures(context)
    }

    OnDestroy {
      unregister()
    }
  }

  private fun registerReceiver(context: Context) {
    unregister()
    val r = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context?, intent: Intent?) {
        if (intent?.action != SmsRetriever.SMS_RETRIEVED_ACTION) return
        val extras = intent.extras ?: return
        @Suppress("DEPRECATION")
        val status = extras.get(SmsRetriever.EXTRA_STATUS) as? Status ?: return
        when (status.statusCode) {
          CommonStatusCodes.SUCCESS -> {
            val message = extras.getString(SmsRetriever.EXTRA_SMS_MESSAGE)
            if (message != null) {
              this@ExpoSmsRetrieverModule.sendEvent(
                "onSmsReceived",
                mapOf("message" to message),
              )
            }
          }
          CommonStatusCodes.TIMEOUT -> {
            this@ExpoSmsRetrieverModule.sendEvent(
              "onSmsReceived",
              mapOf("timeout" to true),
            )
            unregister()
          }
        }
      }
    }
    // Play services delivers the broadcast holding SEND_PERMISSION; the
    // receiver must be exported on API 33+ to receive it.
    ContextCompat.registerReceiver(
      context,
      r,
      IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION),
      SmsRetriever.SEND_PERMISSION,
      null,
      ContextCompat.RECEIVER_EXPORTED,
    )
    receiver = r
  }

  private fun unregister() {
    receiver?.let {
      runCatching { appContext.reactContext?.unregisterReceiver(it) }
      receiver = null
    }
  }
}
