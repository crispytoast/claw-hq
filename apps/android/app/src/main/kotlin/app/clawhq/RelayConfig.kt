package app.clawhq

import android.content.Context

/** SharedPreferences-backed store for the relay URL the user enters at first launch. */
object RelayConfig {
    private const val PREFS = "claw_hq_prefs"
    private const val KEY_RELAY_URL = "relay_url"

    fun relayUrl(ctx: Context): String? {
        val v = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_RELAY_URL, null)
        return if (v.isNullOrBlank()) null else v.trimEnd('/')
    }

    fun setRelayUrl(ctx: Context, url: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_RELAY_URL, url.trimEnd('/'))
            .apply()
    }

    fun clear(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_RELAY_URL).apply()
    }
}
