package app.clawhq

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Application object. Owns one app-scoped CoroutineScope. On startup, if a
 * relay URL has been saved, kicks off Firebase init from /api/push/init and
 * registers the FCM token with /api/push/devices.
 *
 * Firebase is initialized PROGRAMMATICALLY (not via google-services plugin)
 * so the same APK works for every user — each user binds their own Firebase
 * project to their own relay.
 */
class ClawHqApp : Application() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        instance = this
        CrashLog.install(this)
        ensureNotificationChannel()
        bootstrapPushIfRelayKnown()
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val ch = NotificationChannel(
            NOTIF_CHANNEL_ID,
            getString(R.string.notif_channel_default_name),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = getString(R.string.notif_channel_default_desc)
        }
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(ch)
    }

    /** Kicks the full bootstrap: Firebase init from /api/push/init, then token registration. */
    fun bootstrapPushIfRelayKnown() {
        val url = RelayConfig.relayUrl(this) ?: return
        scope.launch {
            try {
                val opts = fetchFirebaseOptions(url) ?: return@launch
                initFirebaseOnce(opts)
                val token = runCatching { FirebaseMessaging.getInstance().token.await() }.getOrNull()
                    ?: return@launch
                registerToken(url, token)
            } catch (_: Throwable) {
                // Silent — user will see "no notifications" instead of a crash.
                // Re-attempted on next app start.
            }
        }
    }

    /** Called by ClawHqMessagingService whenever Google rotates the registration token. */
    fun onPushTokenRefresh(token: String) {
        val url = RelayConfig.relayUrl(this) ?: return
        scope.launch { runCatching { registerToken(url, token) } }
    }

    private fun initFirebaseOnce(opts: FirebaseOptions) {
        // Initialize the default app if not already present. Re-init throws.
        if (FirebaseApp.getApps(this).any { it.name == FirebaseApp.DEFAULT_APP_NAME }) return
        FirebaseApp.initializeApp(this, opts)
        // Messaging auto-init is off in the manifest (so missing google-services
        // resources don't crash boot). Re-enable it now that we have a real
        // FirebaseApp so the token is allocated and refreshed normally.
        runCatching { FirebaseMessaging.getInstance().isAutoInitEnabled = true }
    }

    private fun fetchFirebaseOptions(relayUrl: String): FirebaseOptions? {
        val raw = httpGet("$relayUrl/api/push/init") ?: return null
        val root = JSONObject(raw)
        val gs = root.optJSONObject("googleServicesJson") ?: return null
        val pi = gs.optJSONObject("project_info") ?: return null
        val clients = gs.optJSONArray("client") ?: return null
        if (clients.length() == 0) return null
        val client0 = clients.getJSONObject(0)
        val clientInfo = client0.optJSONObject("client_info") ?: return null
        val apiKeys = client0.optJSONArray("api_key") ?: return null
        if (apiKeys.length() == 0) return null
        val apiKey = apiKeys.getJSONObject(0).optString("current_key", "")
        if (apiKey.isEmpty()) return null

        return FirebaseOptions.Builder()
            .setApiKey(apiKey)
            .setApplicationId(clientInfo.optString("mobilesdk_app_id"))
            .setProjectId(pi.optString("project_id"))
            .setGcmSenderId(pi.optString("project_number"))
            .setStorageBucket(pi.optString("storage_bucket"))
            .build()
    }

    private fun registerToken(relayUrl: String, fcmToken: String) {
        val body = JSONObject().apply {
            put("token", fcmToken)
            put("platform", "android")
            put("label", "${Build.MANUFACTURER} ${Build.MODEL}")
        }.toString()
        httpPostJson("$relayUrl/api/push/devices", body)
    }

    private fun httpGet(url: String): String? {
        return runCatching {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 5_000
                readTimeout = 5_000
            }
            try {
                if (conn.responseCode in 200..299) conn.inputStream.bufferedReader().use { it.readText() }
                else null
            } finally {
                conn.disconnect()
            }
        }.getOrNull()
    }

    private fun httpPostJson(url: String, body: String): String? {
        return runCatching {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 5_000
                readTimeout = 5_000
                setRequestProperty("Content-Type", "application/json")
            }
            try {
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                if (conn.responseCode in 200..299) conn.inputStream.bufferedReader().use { it.readText() }
                else null
            } finally {
                conn.disconnect()
            }
        }.getOrNull()
    }

    companion object {
        const val NOTIF_CHANNEL_ID = "claw_hq_default"
        @Volatile var instance: ClawHqApp? = null
            private set
    }
}
