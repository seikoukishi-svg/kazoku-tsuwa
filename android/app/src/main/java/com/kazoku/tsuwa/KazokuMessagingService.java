package com.kazoku.tsuwa;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.media.Ringtone;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import androidx.core.app.NotificationCompat;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

// 通知プラグインのサービスを継承（トークン処理 onNewToken は super で活かす）。
// 着信(data: type=incoming_call)を受けたら、全画面着信＋制御可能な着信音を出す。
public class KazokuMessagingService extends MessagingService {

    static final String CHANNEL_ID = "kazoku_call_v2";
    static final int NOTIF_ID = 1001;
    static Ringtone ringtone;
    static final Handler handler = new Handler(Looper.getMainLooper());
    static final Runnable autoStop = new Runnable() {
        @Override
        public void run() {
            stopRinging();
        }
    };

    @Override
    public void onMessageReceived(RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        if (data != null && "incoming_call".equals(data.get("type"))) {
            String fromName = data.get("fromName");
            if (fromName == null || fromName.isEmpty()) fromName = "家族";
            ensureChannel();
            showIncomingCall(fromName);
            final Context ctx = getApplicationContext();
            handler.post(new Runnable() {
                @Override
                public void run() {
                    startRinging(ctx);
                }
            });
        } else if (data != null && "cancel_call".equals(data.get("type"))) {
            // 発信者が取り消した: 鳴動と着信通知を止める（アプリが閉じていても効く）
            stopRinging();
            NotificationManager nm =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIF_ID);
        }
        // foreground の JS（通常の通話フロー）にも渡す
        super.onMessageReceived(remoteMessage);
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
            CHANNEL_ID, "着信", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("家族からの着信");
        ch.enableVibration(true);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        ch.setSound(null, null); // 着信音は Ringtone で制御
        nm.createNotificationChannel(ch);
    }

    private void showIncomingCall(String fromName) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pi = PendingIntent.getActivity(this, 0, intent, flags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(fromName + " さんから着信")
            .setContentText("タップして応答")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(true)
            .setOngoing(true)
            .setFullScreenIntent(pi, true)
            .setContentIntent(pi);

        NotificationManager nm =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_ID, b.build());
    }

    private static void startRinging(Context ctx) {
        try {
            stopRinging();
            Uri ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            if (ring == null) {
                ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            }
            if (ring == null) return;

            ringtone = RingtoneManager.getRingtone(ctx, ring);
            if (ringtone == null) return;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                ringtone.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                ringtone.setLooping(true);
            }
            ringtone.play();
            handler.postDelayed(autoStop, 45000); // 45秒で自動停止
        } catch (Exception e) {
            // ignore
        }
    }

    // 応答/拒否/終了時に JS から呼ばれて鳴り止む
    static void stopRinging() {
        handler.removeCallbacks(autoStop);
        try {
            if (ringtone != null && ringtone.isPlaying()) {
                ringtone.stop();
            }
        } catch (Exception e) {
            // ignore
        }
        ringtone = null;
    }
}
