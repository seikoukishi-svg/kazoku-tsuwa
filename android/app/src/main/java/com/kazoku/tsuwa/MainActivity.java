package com.kazoku.tsuwa;

import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 受話口/スピーカー切替・着信停止プラグインを登録（super.onCreate より前）
        registerPlugin(AudioRoutePlugin.class);
        super.onCreate(savedInstanceState);

        // 全画面着信からの起動時、ロック画面の上に表示＋画面を点灯
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }

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
        // アプリを開いたら着信通知（バナー）を消す。着信音は応答/拒否時に stopRingtone で停止。
        NotificationManager nm =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(1001);
    }
}
