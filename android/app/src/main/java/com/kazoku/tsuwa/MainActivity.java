package com.kazoku.tsuwa;

import android.content.pm.PackageManager;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 受話口/スピーカー切替プラグインを登録（super.onCreate より前）
        registerPlugin(AudioRoutePlugin.class);
        super.onCreate(savedInstanceState);

        // 通話に必要なマイク権限を起動時に要求
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                new String[]{ android.Manifest.permission.RECORD_AUDIO },
                1001
            );
        }
    }
}
