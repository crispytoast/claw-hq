package app.clawhq

import android.content.Context
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

/**
 * Tiny on-disk crash log so users can capture a launch crash without adb.
 *
 * On any uncaught exception:
 *   - Append "[ts] <stack trace>\n\n" to filesDir/last-crash.txt (overwrite, not append, to keep file small)
 *   - Let the previous default handler run (usually shows the system "this app has a bug" dialog)
 *
 * Next launch:
 *   - MainActivity reads the file, displays it in a scrollable selectable view,
 *     and deletes it after read so we don't loop.
 */
object CrashLog {
    private const val FILE = "last-crash.txt"

    fun install(ctx: Context) {
        val app = ctx.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val sw = StringWriter()
                PrintWriter(sw).use {
                    it.println("Time: ${System.currentTimeMillis()}")
                    it.println("Thread: ${thread.name}")
                    it.println("Android: ${android.os.Build.VERSION.SDK_INT} (${android.os.Build.VERSION.RELEASE})")
                    it.println("Device: ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")
                    it.println()
                    throwable.printStackTrace(it)
                }
                File(app.filesDir, FILE).writeText(sw.toString())
            } catch (_: Throwable) {
                // best-effort
            }
            previous?.uncaughtException(thread, throwable)
        }
    }

    fun readAndClear(ctx: Context): String? {
        val f = File(ctx.filesDir, FILE)
        if (!f.exists()) return null
        return try {
            val txt = f.readText()
            f.delete()
            txt
        } catch (_: Throwable) {
            null
        }
    }
}
