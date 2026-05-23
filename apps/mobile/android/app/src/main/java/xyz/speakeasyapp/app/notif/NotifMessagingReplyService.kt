package xyz.speakeasyapp.app.notif

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Bridges the RemoteInput reply (delivered to
 * `NotifMessagingReplyReceiver`) into a JS task so the existing
 * `push-handler.handleInlineReplyFromData` path can encrypt + send
 * the reply without duplicating that pipeline in Kotlin.
 */
class NotifMessagingReplyService : HeadlessJsTaskService() {

  override fun getTaskConfig(intent: Intent): HeadlessJsTaskConfig? {
    val extras = intent.extras ?: return null
    val data = Arguments.createMap().apply {
      putString(
        "conversationId",
        extras.getString(NotifMessagingModule.EXTRA_CONVERSATION_ID),
      )
      putString(
        "senderId",
        extras.getString(NotifMessagingModule.EXTRA_SENDER_ID),
      )
      putString(
        "msgType",
        extras.getString(NotifMessagingModule.EXTRA_MSG_TYPE),
      )
      putString(
        "replyText",
        extras.getString(NotifMessagingModule.REPLY_RESULT_KEY),
      )
    }
    return HeadlessJsTaskConfig(
      "SpeakeasyInlineReply",
      data,
      60_000, // 60 s timeout — covers WS auth + encrypt + send + settle
      true, // allow start while app is foregrounded
    )
  }
}
