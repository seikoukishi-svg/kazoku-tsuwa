package com.kazoku.tsuwa;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AudioRoute")
public class AudioRoutePlugin extends Plugin {

    private AudioManager am() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    private void route(int deviceType, boolean speakerphone) {
        AudioManager am = am();
        if (am == null) return;
        am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                AudioDeviceInfo found = null;
                for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                    if (d.getType() == deviceType) {
                        found = d;
                        break;
                    }
                }
                if (found != null) {
                    am.setCommunicationDevice(found);
                    return;
                }
            } catch (Exception e) {
                // フォールバックへ
            }
        }
        am.setSpeakerphoneOn(speakerphone);
    }

    // 受話口（耳に当てる）から出す
    @PluginMethod
    public void earpiece(PluginCall call) {
        route(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE, false);
        call.resolve();
    }

    // スピーカー（ハンズフリー）から出す
    @PluginMethod
    public void speaker(PluginCall call) {
        route(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, true);
        call.resolve();
    }

    // 通常モードへ戻す（通話終了時）
    @PluginMethod
    public void reset(PluginCall call) {
        AudioManager am = am();
        if (am != null) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    am.clearCommunicationDevice();
                }
            } catch (Exception e) {
                // ignore
            }
            am.setMode(AudioManager.MODE_NORMAL);
        }
        call.resolve();
    }
}
