package app.clawhq

import android.content.Context
import android.webkit.JavascriptInterface

/**
 * `window.ClawHqBuild` — read-only APK identity surface for the WebView.
 *
 * Lets the SPA show the user which APK they're on (versionName + versionCode)
 * alongside the relay version + web bundle build, so Settings → Updates can
 * answer "is every piece up to date?" instead of conflating three numbers.
 */
class BuildBridge(private val context: Context) {

    @JavascriptInterface
    fun getVersionName(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun getVersionCode(): Int = BuildConfig.VERSION_CODE

    @JavascriptInterface
    fun getApplicationId(): String = BuildConfig.APPLICATION_ID

    @JavascriptInterface
    fun getInstallerPackage(): String? {
        return runCatching {
            val pm = context.packageManager
            @Suppress("DEPRECATION")
            pm.getInstallerPackageName(context.packageName)
        }.getOrNull()
    }
}
