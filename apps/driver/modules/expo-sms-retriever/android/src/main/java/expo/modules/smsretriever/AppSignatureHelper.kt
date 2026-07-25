package expo.modules.smsretriever

import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/**
 * Computes the 11-character SMS Retriever app hash for the running build:
 * base64(sha256("<package> <signing-cert>"))[0..11]. Adapted from Google's
 * SmsRetriever sample. The hash differs per signing cert (dev-client vs
 * internal vs Play App Signing), so fetch it FROM the build you're testing.
 */
object AppSignatureHelper {
  private const val HASH_TYPE = "SHA-256"
  private const val NUM_HASHED_BYTES = 9
  private const val NUM_BASE64_CHAR = 11

  fun getSignatures(context: Context): List<String> {
    val pm = context.packageManager
    val packageName = context.packageName
    val signatures: Array<Signature> = if (Build.VERSION.SDK_INT >= 28) {
      val info = pm.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES)
      info.signingInfo?.apkContentsSigners ?: emptyArray()
    } else {
      @Suppress("DEPRECATION")
      pm.getPackageInfo(packageName, PackageManager.GET_SIGNATURES).signatures ?: emptyArray()
    }
    return signatures.mapNotNull { hash(packageName, it.toCharsString()) }
  }

  private fun hash(packageName: String, signature: String): String? {
    return try {
      val md = MessageDigest.getInstance(HASH_TYPE)
      md.update("$packageName $signature".toByteArray(StandardCharsets.UTF_8))
      val hashSignature = md.digest().copyOfRange(0, NUM_HASHED_BYTES)
      Base64.encodeToString(hashSignature, Base64.NO_PADDING or Base64.NO_WRAP)
        .substring(0, NUM_BASE64_CHAR)
    } catch (e: Exception) {
      null
    }
  }
}
