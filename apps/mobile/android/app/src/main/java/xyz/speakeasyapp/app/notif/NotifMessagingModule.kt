package xyz.speakeasyapp.app.notif

import android.app.PendingIntent
import android.content.Intent
import android.graphics.BitmapFactory
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.graphics.drawable.IconCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import xyz.speakeasyapp.app.MainActivity
import xyz.speakeasyapp.app.R

/**
 * Posts MessagingStyle notifications natively, bypassing notifee for
 * image loading.
 *
 * Five prior attempts to coax notifee's Fresco-backed image pipeline
 * into loading a runtime-cached avatar PNG (file://, data:image/png;
 * base64, content:// via FileProvider) all silently dropped the URI
 * and left the launcher icon on the banner. BitmapFactory.decodeFile
 * is the standard Android path for runtime PNGs and works without
 * ceremony, so this module skips notifee entirely for the messaging
 * case: it decodes the bitmaps in-process, hands them to
 * IconCompat.createWithBitmap, and posts the notification through
 * NotificationManagerCompat. The bitmap rides along inside the
 * Notification's extras as the system needs no URI permissions to
 * render it.
 *
 * Inline reply is wired through a standard `RemoteInput` action on a
 * `BroadcastReceiver` that starts `NotifMessagingReplyService` (a
 * HeadlessJsTaskService). The headless task re-invokes the existing
 * JS reply handler so the encrypt + WS send + optimistic banner
 * update logic doesn't need to be duplicated in Kotlin.
 *
 * Tap routes to MainActivity with `notif_*` intent extras that the
 * Activity surfaces to JS via SpeakeasyNotifMessaging.consumePendingTap.
 */
class NotifMessagingModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "SpeakeasyNotifMessaging"

  @ReactMethod
  fun displayMessagingNotification(args: ReadableMap, promise: Promise) {
    try {
      val conversationId = args.getString("conversationId")
        ?: throw IllegalArgumentException("conversationId required")
      val channelId = args.getString("channelId") ?: "speakeasy_default"
      val peerHandle = args.getString("peerHandle")
        ?: throw IllegalArgumentException("peerHandle required")
      val peerAvatarPath = if (args.hasKey("peerAvatarPath") && !args.isNull("peerAvatarPath"))
        args.getString("peerAvatarPath") else null
      val selfAvatarPath = if (args.hasKey("selfAvatarPath") && !args.isNull("selfAvatarPath"))
        args.getString("selfAvatarPath") else null
      val withReply = args.getBoolean("withReply")
      val title = args.getString("title") ?: "@$peerHandle"
      val body = args.getString("body") ?: "New message"
      val msgType = args.getString("msgType") ?: "direct"
      val messages = args.getArray("messages")
        ?: throw IllegalArgumentException("messages required")

      val peerBitmap = peerAvatarPath?.let {
        try { BitmapFactory.decodeFile(it) } catch (_: Throwable) { null }
      }
      val selfBitmap = selfAvatarPath?.let {
        try { BitmapFactory.decodeFile(it) } catch (_: Throwable) { null }
      }

      val peerIcon = peerBitmap?.let { IconCompat.createWithBitmap(it) }
      val selfIcon = selfBitmap?.let { IconCompat.createWithBitmap(it) }

      val selfPerson = Person.Builder()
        .setName("You")
        .setKey("self")
        .apply { selfIcon?.let { setIcon(it) } }
        .build()

      val peerPerson = Person.Builder()
        .setName("@$peerHandle")
        .setKey(peerHandle)
        .apply { peerIcon?.let { setIcon(it) } }
        .build()

      val style = NotificationCompat.MessagingStyle(selfPerson)

      for (i in 0 until messages.size()) {
        val m = messages.getMap(i) ?: continue
        val text = if (m.hasKey("text")) m.getString("text") ?: "" else ""
        val timestamp = if (m.hasKey("timestamp"))
          m.getDouble("timestamp").toLong()
        else System.currentTimeMillis()
        val isFromPeer = if (m.hasKey("isFromPeer")) m.getBoolean("isFromPeer") else true
        val msgPerson = if (isFromPeer) peerPerson else null
        style.addMessage(
          NotificationCompat.MessagingStyle.Message(text, timestamp, msgPerson),
        )
      }

      val notifIntId = conversationId.hashCode()

      // Tap → open MainActivity with the notification data as extras.
      // MainActivity's onCreate/onNewIntent stash the extras into the
      // module so JS can consume them via `consumePendingTap`.
      val tapIntent = Intent(reactContext, MainActivity::class.java).apply {
        action = Intent.ACTION_VIEW
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        putExtra(EXTRA_CONVERSATION_ID, conversationId)
        putExtra(EXTRA_NOTIFY_KIND, "message")
        putExtra(EXTRA_MSG_TYPE, msgType)
        putExtra(EXTRA_SENDER_ID, peerHandle)
      }
      val tapPendingIntent = PendingIntent.getActivity(
        reactContext,
        notifIntId,
        tapIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

      val builder = NotificationCompat.Builder(reactContext, channelId)
        .setSmallIcon(R.drawable.ic_notification)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(style)
        .setContentIntent(tapPendingIntent)
        .setAutoCancel(true)
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        .apply { peerBitmap?.let { setLargeIcon(it) } }

      if (withReply) {
        val remoteInput = RemoteInput.Builder(REPLY_RESULT_KEY)
          .setLabel("Reply")
          .build()
        val replyIntent = Intent(reactContext, NotifMessagingReplyReceiver::class.java).apply {
          action = REPLY_ACTION
          putExtra(EXTRA_CONVERSATION_ID, conversationId)
          putExtra(EXTRA_SENDER_ID, peerHandle)
          putExtra(EXTRA_MSG_TYPE, msgType)
        }
        val replyPendingIntent = PendingIntent.getBroadcast(
          reactContext,
          notifIntId,
          replyIntent,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        val replyAction = NotificationCompat.Action.Builder(
          R.drawable.ic_notification,
          "Reply",
          replyPendingIntent,
        )
          .addRemoteInput(remoteInput)
          .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
          .setShowsUserInterface(false)
          .setAllowGeneratedReplies(false)
          .build()
        builder.addAction(replyAction)
      }

      NotificationManagerCompat.from(reactContext).notify(notifIntId, builder.build())

      val result = Arguments.createMap().apply {
        putBoolean("success", true)
        putBoolean("peerBitmapLoaded", peerBitmap != null)
        putBoolean("selfBitmapLoaded", selfBitmap != null)
      }
      promise.resolve(result)
    } catch (e: Throwable) {
      promise.reject("display_failed", e.message ?: "unknown", e)
    }
  }

  @ReactMethod
  fun cancelNotification(conversationId: String, promise: Promise) {
    try {
      NotificationManagerCompat.from(reactContext).cancel(conversationId.hashCode())
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("cancel_failed", e.message ?: "unknown", e)
    }
  }

  /**
   * Drain any tap-target data captured by MainActivity from a
   * notification-launched intent. Returns null when nothing was
   * pending. Idempotent — the second call after a single tap returns
   * null, so JS can poll on mount + AppState 'active' without
   * double-routing.
   */
  @ReactMethod
  fun consumePendingTap(promise: Promise) {
    val payload = pendingTap ?: run { promise.resolve(null); return }
    pendingTap = null
    val map = Arguments.createMap().apply {
      putString("conversation_id", payload.conversationId)
      putString("notify_kind", payload.notifyKind)
      putString("msg_type", payload.msgType)
      putString("sender_id", payload.senderId)
    }
    promise.resolve(map)
  }

  companion object {
    const val EXTRA_CONVERSATION_ID = "notif_conversation_id"
    const val EXTRA_NOTIFY_KIND = "notif_kind"
    const val EXTRA_MSG_TYPE = "notif_msg_type"
    const val EXTRA_SENDER_ID = "notif_sender_id"
    const val REPLY_ACTION = "xyz.speakeasyapp.app.NOTIF_REPLY"
    const val REPLY_RESULT_KEY = "reply_text"

    /**
     * Tap target stashed by MainActivity when a notification intent
     * arrives. Process-wide single-slot — overwritten by a newer tap,
     * cleared by `consumePendingTap`. JS races to consume on mount
     * but a missed read just leaves it for the next AppState 'active'.
     */
    @Volatile
    var pendingTap: PendingTap? = null

    fun stashTap(intent: Intent) {
      val convId = intent.getStringExtra(EXTRA_CONVERSATION_ID) ?: return
      pendingTap = PendingTap(
        conversationId = convId,
        notifyKind = intent.getStringExtra(EXTRA_NOTIFY_KIND) ?: "message",
        msgType = intent.getStringExtra(EXTRA_MSG_TYPE) ?: "direct",
        senderId = intent.getStringExtra(EXTRA_SENDER_ID) ?: "",
      )
    }
  }

  data class PendingTap(
    val conversationId: String,
    val notifyKind: String,
    val msgType: String,
    val senderId: String,
  )
}
