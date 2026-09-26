package com.mobilepi.terminal

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.StatFs
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/** Small, app-private bridge for the launcher skin and local Alpine login. */
@ReactModule(name = HorusDeviceModule.NAME)
class HorusDeviceModule(
  private val appContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(appContext) {

  private val preferences by lazy {
    appContext.getSharedPreferences(PROFILE_PREFERENCES, Context.MODE_PRIVATE)
  }

  override fun getName(): String = NAME

  @ReactMethod
  fun getDeviceSnapshot(promise: Promise) {
    try {
      val stat = StatFs(appContext.filesDir.absolutePath)
      val memory = ActivityManager.MemoryInfo()
      val activityManager = appContext.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      activityManager.getMemoryInfo(memory)
      val battery = appContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
      val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
      val batteryPercent = if (level >= 0 && scale > 0) {
        (level.toDouble() / scale.toDouble() * 100.0).coerceIn(0.0, 100.0)
      } else {
        0.0
      }
      promise.resolve(
        Arguments.createMap().apply {
          putDouble("freeStorageBytes", stat.availableBytes.toDouble().coerceAtLeast(0.0))
          putDouble("totalStorageBytes", stat.totalBytes.toDouble().coerceAtLeast(0.0))
          putDouble("freeMemoryBytes", memory.availMem.toDouble().coerceAtLeast(0.0))
          putDouble("totalMemoryBytes", memory.totalMem.toDouble().coerceAtLeast(0.0))
          putBoolean("wifiConnected", isWifiConnected())
          putDouble("batteryPercent", batteryPercent)
          putDouble("capturedAtMs", System.currentTimeMillis().toDouble())
        },
      )
    } catch (_: Exception) {
      promise.reject("device_snapshot_failed", "device metrics unavailable")
    }
  }

  @ReactMethod
  fun getProfile(promise: Promise) {
    val configured = preferences.getString(KEY_PASSWORD_SALT, null) != null &&
      preferences.getString(KEY_PASSWORD_VERIFIER, null) != null
    if (configured) {
      preferences.edit()
        .remove(KEY_LEGACY_USERNAME)
        .remove(KEY_LEGACY_EMOJI)
        .apply()
    }
    promise.resolve(
      Arguments.createMap().apply {
        putBoolean("configured", configured)
        if (configured) {
          putBoolean("hasPassword", preferences.getBoolean(KEY_HAS_PASSWORD, false))
        }
      },
    )
  }

  @ReactMethod
  fun saveProfile(request: ReadableMap, promise: Promise) {
    val password = request.takeIf { it.hasKey("password") }?.getString("password")
    if (password == null || !isValidPassword(password)) {
      promise.resolve(Arguments.createMap().apply { putString("status", "error") })
      return
    }
    val salt = ByteArray(PASSWORD_SALT_BYTES).also(SecureRandom()::nextBytes)
    val verifier = derivePasswordVerifier(password, salt)
    preferences.edit()
      .remove(KEY_LEGACY_USERNAME)
      .remove(KEY_LEGACY_EMOJI)
      .putString(KEY_PASSWORD_SALT, Base64.encodeToString(salt, Base64.NO_WRAP))
      .putString(KEY_PASSWORD_VERIFIER, Base64.encodeToString(verifier, Base64.NO_WRAP))
      .putInt(KEY_PASSWORD_ITERATIONS, PASSWORD_ITERATIONS)
      .putBoolean(KEY_HAS_PASSWORD, true)
      .apply()
    promise.resolve(Arguments.createMap().apply { putString("status", "success") })
  }

  @ReactMethod
  fun verifyPassword(request: ReadableMap, promise: Promise) {
    val password = request.takeIf { it.hasKey("password") }?.getString("password")
    val saltText = preferences.getString(KEY_PASSWORD_SALT, null)
    val verifierText = preferences.getString(KEY_PASSWORD_VERIFIER, null)
    if (password == null || saltText == null || verifierText == null || !isValidPassword(password)) {
      promise.resolve(Arguments.createMap().apply { putString("status", "error") })
      return
    }
    val valid = try {
      val salt = Base64.decode(saltText, Base64.NO_WRAP)
      val expected = Base64.decode(verifierText, Base64.NO_WRAP)
      val actual = derivePasswordVerifier(
        password,
        salt,
        preferences.getInt(KEY_PASSWORD_ITERATIONS, PASSWORD_ITERATIONS),
      )
      MessageDigest.isEqual(expected, actual)
    } catch (_: IllegalArgumentException) {
      false
    }
    promise.resolve(Arguments.createMap().apply { putString("status", if (valid) "success" else "error") })
  }

  @ReactMethod
  fun getGithubAccount(promise: Promise) {
    val username = preferences.getString(KEY_GITHUB_USERNAME, null)
    val avatarUrl = preferences.getString(KEY_GITHUB_AVATAR_URL, null)
    promise.resolve(
      Arguments.createMap().apply {
        if (username != null && GITHUB_USERNAME_PATTERN.matches(username)) {
          putString("username", username)
          if (avatarUrl != null && GITHUB_AVATAR_PATH_PATTERN.matches(avatarUrl)) putString("avatarUrl", avatarUrl)
        }
      },
    )
  }

  @ReactMethod
  fun saveGithubAccount(request: ReadableMap, promise: Promise) {
    val username = request.takeIf { it.hasKey("username") }?.getString("username")
    val avatarUrl = request.takeIf { it.hasKey("avatarUrl") }?.getString("avatarUrl")
    if (username == null || !GITHUB_USERNAME_PATTERN.matches(username) ||
      (avatarUrl != null && !GITHUB_AVATAR_PATH_PATTERN.matches(avatarUrl))
    ) {
      promise.resolve(Arguments.createMap().apply { putString("status", "error") })
      return
    }
    preferences.edit().apply {
      putString(KEY_GITHUB_USERNAME, username)
      if (avatarUrl == null) remove(KEY_GITHUB_AVATAR_URL) else putString(KEY_GITHUB_AVATAR_URL, avatarUrl)
    }.apply()
    promise.resolve(Arguments.createMap().apply { putString("status", "success") })
  }

  @ReactMethod
  fun clearGithubAccount(promise: Promise) {
    preferences.edit()
      .remove(KEY_GITHUB_USERNAME)
      .remove(KEY_GITHUB_AVATAR_URL)
      .apply()
    promise.resolve(Arguments.createMap().apply { putString("status", "success") })
  }

  private fun isWifiConnected(): Boolean {
    val manager = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
    val network = manager.activeNetwork ?: return false
    val capabilities = manager.getNetworkCapabilities(network) ?: return false
    return capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
  }

  private fun isValidPassword(password: String): Boolean =
    password.length in 4..128 && password.all { character ->
      character >= ' ' && character != '\u007f' && character != '\n' && character != '\r'
    }

  private fun derivePasswordVerifier(
    password: String,
    salt: ByteArray,
    iterations: Int = PASSWORD_ITERATIONS,
  ): ByteArray {
    require(iterations in MIN_PASSWORD_ITERATIONS..MAX_PASSWORD_ITERATIONS)
    val spec = PBEKeySpec(password.toCharArray(), salt, iterations, PASSWORD_KEY_BITS)
    return try {
      SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
    } finally {
      spec.clearPassword()
    }
  }

  companion object {
  const val NAME = "HorusDevice"
    private const val PROFILE_PREFERENCES = "mobile_pi_profile"
    private const val KEY_LEGACY_USERNAME = "username"
    private const val KEY_LEGACY_EMOJI = "emoji"
    private const val KEY_HAS_PASSWORD = "has_password"
    private const val KEY_PASSWORD_SALT = "password_salt"
    private const val KEY_PASSWORD_VERIFIER = "password_verifier"
    private const val KEY_PASSWORD_ITERATIONS = "password_iterations"
    private const val KEY_GITHUB_USERNAME = "github_username"
    private const val KEY_GITHUB_AVATAR_URL = "github_avatar_url"
    private const val PASSWORD_SALT_BYTES = 16
    private const val PASSWORD_KEY_BITS = 256
    private const val PASSWORD_ITERATIONS = 120_000
    private const val MIN_PASSWORD_ITERATIONS = 50_000
    private const val MAX_PASSWORD_ITERATIONS = 500_000
    private val GITHUB_USERNAME_PATTERN = Regex("[A-Za-z0-9][A-Za-z0-9-]{0,38}")
    private val GITHUB_AVATAR_PATH_PATTERN = Regex("https://avatars\\.githubusercontent\\.com/[A-Za-z0-9._~!$'()*+,;=:@%/-]{1,256}")

    fun readStoredUsername(context: Context): String? = TerminalGuestIdentity.readStoredUsername(context)
  }
}
