package app.clawhq

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/**
 * `window.ClawHqVoiceBridge` — Android-side voice STT bridge for the WebView.
 *
 * Mirrors PM HQ's `1fccd7e` pattern (SpeechRecognizer with continuous-mode
 * restart on benign errors), exposed as a `@JavascriptInterface` so the SPA's
 * mic button can drive it. Live partials are posted back via
 * `window.__clawHqVoiceCallback(JSON.stringify({type:"partial"|"final"|"error",text}))`.
 *
 * Lifecycle:
 *   start() — checks RECORD_AUDIO permission, requests if missing (asynchronous,
 *             returns false; SPA should call again after the user grants it).
 *             Returns true if listening began this call.
 *   stop()  — stops the recognizer; the last accumulated transcript is flushed
 *             as a "final" callback.
 *
 * The recognizer is re-fired on benign errors (NO_MATCH / SPEECH_TIMEOUT /
 * RECOGNIZER_BUSY) so brief pauses don't end a continuous-mode session.
 * Non-benign errors fire a single "error" callback and stop.
 *
 * All recognizer API calls happen on the main thread; callbacks back into JS
 * also happen on the main thread (`evaluateJavascript` requires it).
 */
class VoiceBridge(
    private val activity: Activity,
    private val webView: WebView,
) {

    private val main = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var listening = false
    /** Accumulated finalized utterances, joined with spaces. Live partial is
     *  appended on top of this; on a "results" callback the partial becomes
     *  the next entry in this list. */
    private val committed = StringBuilder()

    @JavascriptInterface
    fun isAvailable(): Boolean {
        return SpeechRecognizer.isRecognitionAvailable(activity)
    }

    @JavascriptInterface
    fun hasMicPermission(): Boolean {
        return activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
    }

    /**
     * Returns true if listening began on this call. Returns false (and
     * triggers an async permission prompt) if RECORD_AUDIO isn't granted; the
     * SPA should call start() again after the prompt resolves.
     */
    @JavascriptInterface
    fun start(): Boolean {
        if (listening) return true
        if (!isAvailable()) {
            emit("error", "speech recognition not available on this device")
            return false
        }
        if (!hasMicPermission()) {
            activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1002)
            return false
        }
        main.post {
            beginListening()
        }
        return true
    }

    @JavascriptInterface
    fun stop() {
        main.post {
            listening = false
            recognizer?.stopListening()
            // Flush whatever we have as final so the SPA's voiceAnchor region
            // gets one last update before the user taps send.
            val text = committed.toString().trim()
            if (text.isNotEmpty()) emit("final", text)
            else emit("stopped", "")
            destroyRecognizer()
        }
    }

    private fun beginListening() {
        destroyRecognizer()
        committed.setLength(0)
        listening = true
        val r = SpeechRecognizer.createSpeechRecognizer(activity)
        recognizer = r
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                emit("ready", "")
            }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(partialResults: Bundle?) {
                val partial = pickTopResult(partialResults) ?: return
                val full = combineWithCommitted(partial)
                emit("partial", full)
            }
            override fun onResults(results: Bundle?) {
                val finalText = pickTopResult(results)
                if (!finalText.isNullOrBlank()) {
                    if (committed.isNotEmpty()) committed.append(" ")
                    committed.append(finalText)
                    emit("partial", committed.toString())
                }
                // Restart the recognizer to stay continuous — mirrors PM HQ's
                // continuous-mode pattern so brief pauses don't end the session.
                if (listening) {
                    main.postDelayed({ if (listening) beginListening() }, 50)
                }
            }
            override fun onError(error: Int) {
                val benign = error == SpeechRecognizer.ERROR_NO_MATCH
                    || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
                    || error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY
                if (benign) {
                    if (listening) {
                        main.postDelayed({ if (listening) beginListening() }, 50)
                    }
                    return
                }
                listening = false
                emit("error", errorName(error))
                destroyRecognizer()
            }
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        }
        try {
            r.startListening(intent)
        } catch (e: Exception) {
            Log.w(TAG, "startListening threw", e)
            listening = false
            emit("error", "startListening: ${e.message ?: "unknown"}")
            destroyRecognizer()
        }
    }

    private fun destroyRecognizer() {
        try { recognizer?.destroy() } catch (_: Exception) {}
        recognizer = null
    }

    private fun combineWithCommitted(partial: String): String {
        if (committed.isEmpty()) return partial
        return "${committed}${if (partial.isEmpty()) "" else " $partial"}"
    }

    private fun pickTopResult(bundle: Bundle?): String? {
        val list = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION) ?: return null
        return list.firstOrNull()?.takeIf { it.isNotBlank() }
    }

    private fun emit(type: String, text: String) {
        val payload = JSONObject().apply {
            put("type", type)
            put("text", text)
        }.toString()
        // evaluateJavascript must run on the UI thread.
        main.post {
            // Pass as a string literal so the SPA only needs JSON.parse on it.
            val js = "window.__clawHqVoiceCallback && window.__clawHqVoiceCallback(${JSONObject.quote(payload)})"
            try { webView.evaluateJavascript(js, null) } catch (e: Exception) {
                Log.w(TAG, "evaluateJavascript failed", e)
            }
        }
    }

    private fun errorName(code: Int): String = when (code) {
        SpeechRecognizer.ERROR_AUDIO -> "audio error"
        SpeechRecognizer.ERROR_CLIENT -> "client error"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "mic permission missing"
        SpeechRecognizer.ERROR_NETWORK -> "network error"
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network timeout"
        SpeechRecognizer.ERROR_NO_MATCH -> "no match"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "recognizer busy"
        SpeechRecognizer.ERROR_SERVER -> "server error"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "speech timeout"
        else -> "unknown error ($code)"
    }

    fun destroy() {
        listening = false
        main.post { destroyRecognizer() }
    }

    companion object {
        private const val TAG = "ClawHqVoiceBridge"
    }
}
