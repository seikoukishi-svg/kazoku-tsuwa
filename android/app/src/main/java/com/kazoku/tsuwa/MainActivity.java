package com.kazoku.tsuwa;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 受話口/スピーカー切替プラグインを登録（super.onCreate より前）
        registerPlugin(AudioRoutePlugin.class);
        super.onCreate(savedInstanceState);

        // 着信用の通知チャンネル（着信音・高優先度・ロック画面表示）を用意
        createIncomingCallChannel();

        // 通話に必要なマイク権限を起動時に要求
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                new String[]{ android.Manifest.permission.RECORD_AUDIO },
                1001
            );
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        // アプリを開いたら着信通知を消す（応答後に着信音が鳴り続けないように）
        NotificationManager nm =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancelAll();
    }

    // 着信用チャンネル: 端末の着信音・高優先度・ロック画面表示・バイブ
    private void createIncomingCallChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel("incoming_call") != null) return;

        NotificationChannel ch = new NotificationChannel(
            "incoming_call", "着信", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("家族からの着信");
        ch.enableVibration(true);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

        Uri ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        if (ring == null) {
            ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        }
        if (ring != null) {
            AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
            ch.setSound(ring, attrs);
        }
        nm.createNotificationChannel(ch);
    }
}
