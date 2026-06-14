package app.clawhq

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * `window.ClawHqUpdater` — APK self-update bridge.
 *
 * downloadAndInstall():
 *   1. Streams the latest APK from `${relayUrl}/install/apk` into the app's
 *      internal cache dir at `updates/claw-hq.apk` (overwrites any prior
 *      download).
 *   2. Wraps the file with FileProvider (content://) so Android 7+ accepts it.
 *   3. Launches `Intent.ACTION_VIEW` with the APK content URI; the system
 *      installer takes over from there. The user confirms in the system
 *      sheet; we don't (and can't) install silently.
 *
 * Callbacks back into JS via `window.__clawHqUpdaterCallback(json)`:
 *   {type:"started"}        — download began
 *   {type:"progress", bytes, total} — periodic progress
 *   {type:"installing"}     — handed off to PackageInstaller
 *   {type:"error", text}    — network or IO failure
 *
 * Errors are best-effort; once the system installer takes over we can't
 * observe its result. Cancelling at the system sheet just leaves the APK
 * in the cache for the next attempt.
 */
class UpdaterBridge(
    private val activity: Activity,
    private val webView: WebView,
) {

    private val main = Handler(Looper.getMainLooper())
    @Volatile private var downloading = false

    @JavascriptInterface
    fun isAvailable(): Boolean = true

    /**
     * Download the latest APK from the configured relay and hand it off to the
     * system installer. Returns immediately; progress + outcome ride the
     * callback channel.
     */
    @JavascriptInterface
    fun downloadAndInstall(): Boolean {
        if (downloading) return false
        val relay = RelayConfig.relayUrl(activity) ?: run {
            emit("error", "no relay URL configured")
            return false
        }
        downloading = true
        Thread {
            try {
                val apk = downloadApk(relay)
                emit("installing", "")
                launchInstaller(apk)
            } catch (e: Exception) {
                Log.w(TAG, "downloadAndInstall failed", e)
                emit("error", e.message ?: e.javaClass.simpleName)
            } finally {
                downloading = false
            }
        }.start()
        emit("started", "")
        return true
    }

    private fun downloadApk(relayUrl: String): File {
        val cacheDir = File(activity.cacheDir, "updates").apply { mkdirs() }
        val out = File(cacheDir, "claw-hq.apk")
        // Best-effort delete of any stale partial download before we begin.
        if (out.exists()) out.delete()

        val conn = URL("$relayUrl/install/apk").openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 8_000
            conn.readTimeout = 30_000
            conn.requestMethod = "GET"
            conn.connect()
            val status = conn.responseCode
            if (status !in 200..299) throw RuntimeException("HTTP $status from /install/apk")
            val total = conn.contentLengthLong
            conn.inputStream.use { input ->
                out.outputStream().use { output ->
                    val buf = ByteArray(64 * 1024)
                    var copied = 0L
                    var lastEmitMs = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        output.write(buf, 0, n)
                        copied += n
                        val now = System.currentTimeMillis()
                        // Throttle progress events to 4Hz to avoid JS-side stalls.
                        if (now - lastEmitMs > 250) {
                            emitProgress(copied, total)
                            lastEmitMs = now
                        }
                    }
                    output.flush()
                    emitProgress(copied, total)
                }
            }
        } finally {
            conn.disconnect()
        }
        return out
    }

    private fun launchInstaller(apk: File) {
        // Android 7+ requires a content:// URI; file:// throws FileUriExposedException.
        val authority = "${activity.packageName}.fileprovider"
        val uri: Uri = FileProvider.getUriForFile(activity, authority, apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        main.post {
            try {
                activity.startActivity(intent)
            } catch (e: Exception) {
                Log.w(TAG, "startActivity(install) failed", e)
                emit("error", "couldn't launch installer: ${e.message ?: e.javaClass.simpleName}")
            }
        }
    }

    private fun emitProgress(bytes: Long, total: Long) {
        val payload = JSONObject().apply {
            put("type", "progress")
            put("bytes", bytes)
            put("total", total)
        }.toString()
        deliver(payload)
    }

    private fun emit(type: String, text: String) {
        val payload = JSONObject().apply {
            put("type", type)
            put("text", text)
        }.toString()
        deliver(payload)
    }

    private fun deliver(payload: String) {
        main.post {
            val js = "window.__clawHqUpdaterCallback && window.__clawHqUpdaterCallback(${JSONObject.quote(payload)})"
            try { webView.evaluateJavascript(js, null) } catch (e: Exception) {
                Log.w(TAG, "evaluateJavascript failed", e)
            }
        }
    }

    companion object {
        private const val TAG = "ClawHqUpdater"
    }
}
