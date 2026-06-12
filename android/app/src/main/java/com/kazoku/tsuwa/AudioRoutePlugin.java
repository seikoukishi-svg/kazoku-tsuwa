package com.kazoku.tsuwa;

import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.ToneGenerator;
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

    // ===== 呼び出し音（発信側の「トゥルルル」）=====
    // 通話音声ストリームで鳴らすので、耳に当てた受話口から聞こえる。
    static ToneGenerator ringback;

    @PluginMethod
    public void startRingback(PluginCall call) {
        stopRingbackInternal();
        try {
            AudioManager am = am();
            if (am != null) am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            ringback = new ToneGenerator(AudioManager.STREAM_VOICE_CALL, 80);
            ringback.startTone(ToneGenerator.TONE_SUP_RINGTONE);
        } catch (Exception e) {
            // ignore
        }
        call.resolve();
    }

    @PluginMethod
    public void stopRingback(PluginCall call) {
        stopRingbackInternal();
        call.resolve();
    }

    static void stopRingbackInternal() {
        try {
            if (ringback != null) {
                ringback.stopTone();
                ringback.release();
            }
        } catch (Exception e) {
            // ignore
        }
        ringback = null;
    }

    // 着信音を止め、着信通知を消す（応答/拒否/終了時にJSから呼ぶ）
    @PluginMethod
    public void stopRingtone(PluginCall call) {
        KazokuMessagingService.stopRinging();
        NotificationManager nm =
            (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(1001);
        call.resolve();
    }
}
