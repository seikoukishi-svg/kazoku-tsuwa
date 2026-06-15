package com.kazoku.tsuwa;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import com.getcapacitor.JSObject;
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

    // イヤホン（Bluetooth/有線）が繋がっていればそちらを優先。無ければ受話口。
    private void routeEarpiecePreferHeadset() {
        AudioManager am = am();
        if (am == null) return;
        am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                // 優先順位: BTヘッドセット > BT LE > 有線 > USB > 補聴器 > 受話口
                int[] priority = new int[] {
                    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
                    AudioDeviceInfo.TYPE_BLE_HEADSET,
                    AudioDeviceInfo.TYPE_WIRED_HEADSET,
                    AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
                    AudioDeviceInfo.TYPE_USB_HEADSET,
                    AudioDeviceInfo.TYPE_HEARING_AID,
                    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                };
                for (int want : priority) {
                    for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                        if (d.getType() == want) {
                            am.setCommunicationDevice(d);
                            return;
                        }
                    }
                }
            } catch (Exception e) {
                // フォールバックへ
            }
        }
        // 旧端末: スピーカーだけはOFFにする（受話口/接続中ヘッドセットに流れる）
        am.setSpeakerphoneOn(false);
    }

    // 受話口（耳に当てる）から出す。イヤホンがあればイヤホン優先。
    @PluginMethod
    public void earpiece(PluginCall call) {
        routeEarpiecePreferHeadset();
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

    // Android14+ の全画面通知（フルスクリーンインテント）が許可されているか。
    @PluginMethod
    public void checkFullScreenIntent(PluginCall call) {
        boolean granted = true;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                NotificationManager nm =
                    (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
                granted = nm == null || nm.canUseFullScreenIntent();
            }
        } catch (Exception e) {
            // 不明時は granted 扱い（過度に警告しない）
        }
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    // 全画面通知の許可設定画面を開く（Android14+）。
    @PluginMethod
    public void openFullScreenSettings(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                Intent i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT);
                i.setData(Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            }
        } catch (Exception e) {
            // ignore
        }
        call.resolve();
    }

    // 電池最適化の除外をお願いする（着信が遅延/不達になるのを防ぐ）。
    // 既に除外済みなら何もしない。ユーザーがダイアログで許可する。
    @PluginMethod
    public void requestIgnoreBattery(PluginCall call) {
        try {
            Context ctx = getContext();
            String pkg = ctx.getPackageName();
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                    && pm != null && !pm.isIgnoringBatteryOptimizations(pkg)) {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                i.setData(Uri.parse("package:" + pkg));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
            }
        } catch (Exception e) {
            // ignore
        }
        call.resolve();
    }
}
