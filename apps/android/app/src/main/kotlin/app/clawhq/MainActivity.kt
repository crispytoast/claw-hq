package app.clawhq

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * Single-activity shell.
 *
 * Two states:
 *   1. No relay URL saved → simple setup screen (EditText + Continue button).
 *   2. Relay URL saved → full-screen WebView pointed at it.
 *
 * Long-press the back gesture or tap the "Change relay URL" overflow item
 * (added later — for v0.4 we just expose `clearAndRestart()`) to reset.
 */
class MainActivity : Activity() {

    private var webView: WebView? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // If we crashed last launch, show the trace instead of trying again.
        val lastCrash = CrashLog.readAndClear(this)
        if (lastCrash != null) {
            setContentView(buildCrashView(lastCrash))
            return
        }

        requestNotificationPermissionIfNeeded()

        val relay = RelayConfig.relayUrl(this)
        if (relay == null) {
            setContentView(buildSetupView())
        } else {
            renderWebView(relay)
        }
    }

    private fun renderWebView(relayUrl: String) {
        val wv = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                    // Keep navigation inside our WebView — the relay URL is the only origin.
                    return false
                }
            }
            webChromeClient = WebChromeClient()
            setBackgroundColor(Color.parseColor("#1B1B1B"))
        }
        webView = wv
        setContentView(wv)
        wv.loadUrl(relayUrl)
    }

    private fun buildSetupView(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(64), dp(24), dp(24))
            setBackgroundColor(Color.parseColor("#1B1B1B"))
        }

        val titleTv = TextView(this).apply {
            text = getString(R.string.setup_title)
            setTextColor(Color.parseColor("#F2F2F2"))
            textSize = 22f
        }
        root.addView(titleTv)

        val subTv = TextView(this).apply {
            text = getString(R.string.setup_subtitle)
            setTextColor(Color.parseColor("#9BA3AB"))
            textSize = 14f
            setPadding(0, dp(8), 0, dp(24))
        }
        root.addView(subTv)

        val input = EditText(this).apply {
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            hint = getString(R.string.setup_hint)
            setHintTextColor(Color.parseColor("#666"))
            setTextColor(Color.parseColor("#F2F2F2"))
            setPadding(dp(12), dp(12), dp(12), dp(12))
            setBackgroundColor(Color.parseColor("#252525"))
        }
        root.addView(input)

        val err = TextView(this).apply {
            setTextColor(Color.parseColor("#F06868"))
            textSize = 13f
            visibility = View.GONE
            setPadding(0, dp(8), 0, 0)
        }
        root.addView(err)

        val btn = Button(this).apply {
            text = getString(R.string.setup_continue)
            setBackgroundColor(Color.parseColor("#5FD1F0"))
            setTextColor(Color.parseColor("#1B1B1B"))
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
            lp.topMargin = dp(20)
            layoutParams = lp
        }
        btn.setOnClickListener {
            val raw = input.text.toString().trim()
            val url = if (raw.startsWith("http://") || raw.startsWith("https://")) raw else "http://$raw"
            err.visibility = View.GONE
            btn.isEnabled = false
            btn.text = "Checking…"
            // Spin a worker thread for the reachability probe.
            Thread {
                val ok = probeReachable(url)
                runOnUiThread {
                    btn.isEnabled = true
                    btn.text = getString(R.string.setup_continue)
                    if (ok) {
                        RelayConfig.setRelayUrl(this, url)
                        ClawHqApp.instance?.bootstrapPushIfRelayKnown()
                        renderWebView(url)
                    } else {
                        err.text = getString(R.string.error_relay_unreachable)
                        err.visibility = View.VISIBLE
                    }
                }
            }.start()
        }
        root.addView(btn)

        val frame = FrameLayout(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            addView(
                root,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ).apply { gravity = Gravity.TOP },
            )
        }
        return frame
    }

    private fun probeReachable(url: String): Boolean {
        return runCatching {
            val u = java.net.URL("$url/api/system/version")
            val conn = u.openConnection() as java.net.HttpURLConnection
            try {
                conn.connectTimeout = 4_000
                conn.readTimeout = 4_000
                conn.requestMethod = "GET"
                conn.responseCode in 200..299
            } finally {
                conn.disconnect()
            }
        }.getOrDefault(false)
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val perm = Manifest.permission.POST_NOTIFICATIONS
        if (checkSelfPermission(perm) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(perm), 1001)
        }
    }

    private fun buildCrashView(trace: String): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(48), dp(20), dp(20))
            setBackgroundColor(Color.parseColor("#1B1B1B"))
        }
        root.addView(TextView(this).apply {
            text = "Crash on last launch"
            setTextColor(Color.parseColor("#F06868"))
            textSize = 18f
            setPadding(0, 0, 0, dp(8))
        })
        root.addView(TextView(this).apply {
            text = "The trace is below — long-press to copy and send to me. Tap Continue to retry."
            setTextColor(Color.parseColor("#9BA3AB"))
            textSize = 13f
            setPadding(0, 0, 0, dp(12))
        })
        val scroll = ScrollView(this)
        scroll.addView(TextView(this).apply {
            text = trace
            setTextColor(Color.parseColor("#F2F2F2"))
            textSize = 11f
            setTextIsSelectable(true)
            typeface = android.graphics.Typeface.MONOSPACE
            setPadding(dp(8), dp(8), dp(8), dp(8))
            setBackgroundColor(Color.parseColor("#252525"))
        })
        val scrollLp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
        )
        scrollLp.weight = 1f
        root.addView(scroll, scrollLp)
        root.addView(Button(this).apply {
            text = "Continue"
            setBackgroundColor(Color.parseColor("#5FD1F0"))
            setTextColor(Color.parseColor("#1B1B1B"))
            setOnClickListener {
                recreate()
            }
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
            lp.topMargin = dp(12)
            layoutParams = lp
        })
        return root
    }

    override fun onBackPressed() {
        val wv = webView
        if (wv != null && wv.canGoBack()) {
            wv.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
