package xyz.speakeasyapp.app.notif

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import com.facebook.react.HeadlessJsTaskService

/**
 * Receives the RemoteInput response from the messaging notification's
 * "Reply" action and forwards it to a HeadlessJsTaskService. The JS
 * task (see index.js) calls the same handler the in-app composer
 * uses, so the encrypt + WS send + optimistic banner update logic
 * lives in one place instead of being duplicated in Kotlin.
 */
class NotifMessagingReplyReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != NotifMessagingModule.REPLY_ACTION) return
    val remoteInput = RemoteInput.getResultsFromIntent(intent) ?: return
    val replyText = remoteInput.getCharSequence(NotifMessagingModule.REPLY_RESULT_KEY)
      ?.toString()
      ?.trim()
      ?: return
    if (replyText.isEmpty()) return

    val conversationId = intent.getStringExtra(NotifMessagingModule.EXTRA_CONVERSATION_ID)
      ?: return
    val senderId = intent.getStringExtra(NotifMessagingModule.EXTRA_SENDER_ID)
      ?: return
    val msgType = intent.getStringExtra(NotifMessagingModule.EXTRA_MSG_TYPE)
      ?: "direct"

    val taskIntent = Intent(context, NotifMessagingReplyService::class.java).apply {
      putExtra(NotifMessagingModule.EXTRA_CONVERSATION_ID, conversationId)
      putExtra(NotifMessagingModule.EXTRA_SENDER_ID, senderId)
      putExtra(NotifMessagingModule.EXTRA_MSG_TYPE, msgType)
      putExtra(NotifMessagingModule.REPLY_RESULT_KEY, replyText)
    }

    HeadlessJsTaskService.acquireWakeLockNow(context)
    context.startService(taskIntent)
  }
}
