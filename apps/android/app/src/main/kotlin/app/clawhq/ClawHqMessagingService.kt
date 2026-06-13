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
 *                 Forwards to the application so it can POST to the relay.
 * onMessageReceived — fires only when the app is in the foreground
 *                 (Android's system tray handles backgrounded notification
 *                 messages itself). For foreground, render a notification
 *                 manually so the user still gets a heads-up.
 */
class ClawHqMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        ClawHqApp.instance?.onPushTokenRefresh(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val n = message.notification
        val title = n?.title ?: message.data["title"] ?: "Claw HQ"
        val body = n?.body ?: message.data["body"] ?: ""
        if (title.isBlank() && body.isBlank()) return

        // Construct a tap intent that brings MainActivity to the front; the
        // notification's data payload becomes available to MainActivity via
        // getIntent() so future versions can deep-link into the WebView.
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            message.data.forEach { (k, v) -> putExtra("notif_$k", v) }
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
        // Stable per-message id so repeats stack rather than replace.
        val id = (message.messageId ?: System.currentTimeMillis().toString()).hashCode()
        nm.notify(id, builder.build())
    }
}
