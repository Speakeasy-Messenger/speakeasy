package xyz.speakeasyapp.app.notif

import android.app.PendingIntent
import android.content.Intent
import android.graphics.BitmapFactory
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
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
      // Conversation icon (room mark for a group, peer for 1:1) — the
      // collapsed banner + shortcut icon. Falls back to the sender avatar.
      val conversationAvatarPath =
        if (args.hasKey("conversationAvatarPath") && !args.isNull("conversationAvatarPath"))
          args.getString("conversationAvatarPath") else peerAvatarPath
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
      val conversationBitmap = if (conversationAvatarPath == peerAvatarPath) peerBitmap
        else conversationAvatarPath?.let {
          try { BitmapFactory.decodeFile(it) } catch (_: Throwable) { null }
        }
      val selfBitmap = selfAvatarPath?.let {
        try { BitmapFactory.decodeFile(it) } catch (_: Throwable) { null }
      }

      // Adaptive bitmaps let Android apply the system launcher mask
      // (squircle on Samsung, circle on AOSP) the same way it does
      // for the launcher icon — so the avatar reads as a rounded
      // tile instead of a flat square. The previous Canvas-side
      // round-corners pass painted transparent corners that blended
      // invisibly against the dark notification surface; this hands
      // the rounding off to the system, which knows the user's
      // active mask shape and how to backdrop it.
      val peerIcon = peerBitmap?.let { IconCompat.createWithAdaptiveBitmap(it) }
      val conversationIcon = if (conversationBitmap === peerBitmap) peerIcon
        else conversationBitmap?.let { IconCompat.createWithAdaptiveBitmap(it) }
      val selfIcon = selfBitmap?.let { IconCompat.createWithAdaptiveBitmap(it) }

      val selfPerson = Person.Builder()
        .setName("You")
        .setKey("self")
        .apply { selfIcon?.let { setIcon(it) } }
        .build()

      // Per-message sender — the icon beside each line when expanded.
      val peerPerson = Person.Builder()
        .setName("@$peerHandle")
        .setKey(peerHandle)
        .apply { peerIcon?.let { setIcon(it) } }
        .build()
      // Conversation identity — the collapsed banner + shortcut (LEFT) icon.
      // For a group this is the room (mark + room-name title); for 1:1 it's
      // the same as the sender, so the two collapse to one icon.
      val conversationPerson = Person.Builder()
        .setName(title)
        .setKey("conv-$conversationId")
        .apply { conversationIcon?.let { setIcon(it) } }
        .build()

      val style = NotificationCompat.MessagingStyle(selfPerson)

      // For a group, name the conversation with the room title so the
      // banner header reads "<Group>", not the latest sender's handle.
      // MessagingStyle derives its header from the conversation title
      // when present and otherwise from the most-recent message's Person
      // — so without these two calls a group banner showed "@sender"
      // even though setContentTitle(title) carried the room name.
      // `isGroupConversation = true` is what makes Android actually honor
      // the conversation title (and keeps each sender labelled per-line).
      if (msgType == "group") {
        style.isGroupConversation = true
        style.conversationTitle = title
      }

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

      // Publish a long-lived sharing shortcut for this conversation. With
      // a MessagingStyle + matching shortcutId, Android 11+ promotes the
      // notification to a Conversation, which renders the peer avatar in
      // the launcher-icon slot on the LEFT (replacing the app launcher)
      // instead of bolting a second avatar onto the right beside it. On
      // pre-API-30 the shortcut is benign and the `setLargeIcon` fallback
      // below paints the avatar.
      val shortcutId = "conv-${conversationId}"
      // The Conversation-promotion header (Samsung One UI + AOSP) takes the
      // conversation NAME from the shortcut's label, NOT from
      // MessagingStyle.conversationTitle — so for a group the label must be
      // the ROOM name, or the collapsed banner shows the latest sender's
      // handle even though conversationTitle is correctly set ("Suckdixx"
      // resolved in JS but rendered "@bananaman6", fuertechino rc.51
      // 2026-06-05). 1:1 keeps the peer handle.
      val shortcutLabel = if (msgType == "group") title else "@$peerHandle"
      val shortcut = ShortcutInfoCompat.Builder(reactContext, shortcutId)
        .setShortLabel(shortcutLabel)
        .setLongLabel(shortcutLabel)
        .setIntent(
          Intent(reactContext, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            putExtra(EXTRA_CONVERSATION_ID, conversationId)
            putExtra(EXTRA_NOTIFY_KIND, "message")
            putExtra(EXTRA_MSG_TYPE, msgType)
            putExtra(EXTRA_SENDER_ID, peerHandle)
          },
        )
        .setLongLived(true)
        .setPerson(conversationPerson)
        .apply { conversationIcon?.let { setIcon(it) } }
        .setCategories(setOf("xyz.speakeasyapp.app.category.MESSAGE"))
        .build()
      ShortcutManagerCompat.pushDynamicShortcut(reactContext, shortcut)

      val builder = NotificationCompat.Builder(reactContext, channelId)
        .setSmallIcon(R.drawable.ic_notification)
        .setContentText(body)
        .setStyle(style)
        .setContentIntent(tapPendingIntent)
        .setAutoCancel(true)
        .setShortcutId(shortcutId)
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      // Title source, exactly one per notification:
      //   - group → MessagingStyle.conversationTitle (set above)
      //   - 1:1   → setContentTitle here
      // Setting BOTH made Samsung One UI render the title on two lines
      // (the #119 regression: "@sender" / room name shown twice). A 1:1
      // has no conversationTitle, so its header still comes from here.
      if (msgType != "group") {
        builder.setContentTitle(title)
      }
      // Intentionally NOT calling `setLargeIcon`. On Samsung One UI
      // and Pixel, a largeIcon paints a second avatar on the right
      // side of the notification — no real messenger does that. The
      // peer's portrait reaches the user via Android's Conversation
      // notification promotion (`shortcutId` + the dynamic
      // ShortcutInfoCompat carrying the peer Person), which replaces
      // the app icon on the LEFT with that Person.icon. One avatar,
      // correct slot.

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
