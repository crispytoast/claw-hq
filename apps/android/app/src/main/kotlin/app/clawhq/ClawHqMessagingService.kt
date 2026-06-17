package app.clawhq

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * FCM bridge.
 *
 * onNewToken    — fires once on first launch + on every Google rotation.
 * onMessageReceived — fires for every message because the relay sends
 *                 data-only payloads (no top-level `notification` field).
 *                 We render the notification ourselves so we can suppress
 *                 it when the user is already on the matching screen.
 */
class ClawHqMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        ClawHqApp.instance?.onPushTokenRefresh(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val title = data["title"] ?: "Claw HQ"
        val body = data["body"] ?: ""
        val deepLink = data["deepLink"]
        if (title.isBlank() && body.isBlank()) return

        // Suppression: if the app is foregrounded AND the WebView is already
        // on the deep-link URL, the user is looking at the chat that just
        // completed — no notification needed. Falls through to "show" if
        // app is backgrounded, screen is off, or the user is on a different
        // chat / screen.
        if (shouldSuppress(deepLink)) return

        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            data.forEach { (k, v) -> putExtra("notif_$k", v) }
        }
        val pending = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = NotificationCompat.Builder(this, ClawHqApp.NOTIF_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pending)

        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val id = (message.messageId ?: System.currentTimeMillis().toString()).hashCode()
        nm.notify(id, builder.build())
    }

    private fun shouldSuppress(deepLink: String?): Boolean {
        val app = ClawHqApp.instance ?: return false
        if (!app.isAppForegrounded()) return false
        if (deepLink.isNullOrBlank()) return false
        val current = app.currentWebViewUrl ?: return false
        // Path-suffix match: WebView URL is full (http://relay:port/chat-detail/abc).
        // We only need to know if the path component the push points at is the
        // one currently rendered.
        return current.contains(deepLink)
    }
}
