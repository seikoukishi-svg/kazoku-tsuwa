package com.kazoku.tsuwa;

import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
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

    @Override
    public void onResume() {
        super.onResume();
        setEarpiece(true);
    }

    @Override
    public void onPause() {
        super.onPause();
        setEarpiece(false);
    }

    // 受話口（耳に当てる方）から音を出す。false で通常モードに戻す。
    private void setEarpiece(boolean on) {
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        if (on) {
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            am.setSpeakerphoneOn(false);
        } else {
            am.setMode(AudioManager.MODE_NORMAL);
        }
    }
}
