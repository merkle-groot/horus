package com.mobilepi.terminal

import android.content.Context

/** RN-free fixed Alpine identity for service launch when a local profile exists. */
object TerminalGuestIdentity {
  private const val PROFILE_PREFERENCES = "mobile_pi_profile"
  private const val KEY_PASSWORD_SALT = "password_salt"
  private const val KEY_PASSWORD_VERIFIER = "password_verifier"
  const val PROFILE_USERNAME = "horus"

  fun readStoredUsername(context: Context): String? {
    val preferences = context.getSharedPreferences(PROFILE_PREFERENCES, Context.MODE_PRIVATE)
    val configured = preferences.getString(KEY_PASSWORD_SALT, null) != null &&
      preferences.getString(KEY_PASSWORD_VERIFIER, null) != null
    return PROFILE_USERNAME.takeIf { configured }
  }
}
