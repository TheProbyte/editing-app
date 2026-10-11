package app.lumen.editor;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.SurfaceTexture;
import android.graphics.drawable.GradientDrawable;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.DngCreator;
import android.hardware.camera2.TotalCaptureResult;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.ExifInterface;
import android.media.Image;
import android.media.ImageReader;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Size;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.Locale;

/** Minimal Camera2 RAW_SENSOR capture that writes a real DNG and hands it back to the editor. */
public class RawCameraActivity extends Activity {

    private static final int REQ_CAM = 41;
    private static final int ORANGE = 0xFFFF6A13;
    private static final int CREAM = 0xFFF2E6D0;

    private TextureView preview;
    private TextView status;
    private View shutter;

    private HandlerThread thread;
    private Handler bg;
    private CameraDevice device;
    private CameraCaptureSession session;
    private ImageReader rawReader;
    private CameraCharacteristics chars;
    private String cameraId;
    private Size rawSize;
    private Size previewSize;
    private CaptureRequest.Builder previewReq;

    private Image pendingImage;
    private TotalCaptureResult pendingResult;
    private boolean busy;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        preview = new TextureView(this);
        root.addView(preview, new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER));

        TextView title = text("RAW · DNG", 13);
        title.setTextColor(ORANGE);
        title.setLetterSpacing(0.25f);
        FrameLayout.LayoutParams tl = new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        tl.topMargin = dp(44);
        root.addView(title, tl);

        TextView close = text("✕", 22);
        close.setPadding(dp(18), dp(12), dp(18), dp(12));
        close.setOnClickListener(v -> fail(null));
        FrameLayout.LayoutParams cl = new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.START);
        cl.topMargin = dp(30);
        cl.leftMargin = dp(8);
        root.addView(close, cl);

        status = text("", 13);
        FrameLayout.LayoutParams sl = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        sl.bottomMargin = dp(160);
        root.addView(status, sl);

        shutter = new View(this);
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(ORANGE);
        g.setStroke(dp(4), CREAM);
        shutter.setBackground(g);
        shutter.setOnClickListener(v -> capture());
        FrameLayout.LayoutParams bl = new FrameLayout.LayoutParams(dp(76), dp(76), Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        bl.bottomMargin = dp(64);
        root.addView(shutter, bl);

        setContentView(root);
    }

    private TextView text(String s, int sp) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextColor(CREAM);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onResume() {
        super.onResume();
        thread = new HandlerThread("lumen-raw");
        thread.start();
        bg = new Handler(thread.getLooper());
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.CAMERA }, REQ_CAM);
            return;
        }
        startWhenReady();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        super.onRequestPermissionsResult(code, perms, res);
        if (code != REQ_CAM) return;
        if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) startWhenReady();
        else fail("Camera permission was denied");
    }

    @Override
    protected void onPause() {
        closeCamera();
        if (thread != null) {
            thread.quitSafely();
            thread = null;
        }
        super.onPause();
    }

    private void startWhenReady() {
        if (preview.isAvailable()) openCamera();
        else preview.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override public void onSurfaceTextureAvailable(SurfaceTexture s, int w, int h) { openCamera(); }
            @Override public void onSurfaceTextureSizeChanged(SurfaceTexture s, int w, int h) {}
            @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture s) { return true; }
            @Override public void onSurfaceTextureUpdated(SurfaceTexture s) {}
        });
    }

    private void openCamera() {
        if (device != null) return;
        CameraManager cm = (CameraManager) getSystemService(CAMERA_SERVICE);
        try {
            long bestArea = 0;
            for (String id : cm.getCameraIdList()) {
                CameraCharacteristics c = cm.getCameraCharacteristics(id);
                Integer facing = c.get(CameraCharacteristics.LENS_FACING);
                if (facing == null || facing != CameraCharacteristics.LENS_FACING_BACK) continue;
                int[] caps = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
                boolean raw = false;
                if (caps != null) for (int cap : caps) if (cap == CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_RAW) raw = true;
                if (!raw) continue;
                StreamConfigurationMap map = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
                if (map == null) continue;
                Size[] sizes = map.getOutputSizes(ImageFormat.RAW_SENSOR);
                if (sizes == null || sizes.length == 0) continue;
                Size big = Collections.max(Arrays.asList(sizes), (a, bb) -> Long.compare((long) a.getWidth() * a.getHeight(), (long) bb.getWidth() * bb.getHeight()));
                long area = (long) big.getWidth() * big.getHeight();
                // first back camera with RAW is normally the main sensor; prefer it unless another is clearly bigger
                if (cameraId == null || area > bestArea * 1.2) {
                    cameraId = id;
                    chars = c;
                    rawSize = big;
                    bestArea = area;
                }
            }
            if (cameraId == null) {
                fail("This phone doesn't offer RAW capture to apps");
                return;
            }
            StreamConfigurationMap map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            previewSize = pickPreview(map.getOutputSizes(SurfaceTexture.class), rawSize);
            layoutPreview();

            rawReader = ImageReader.newInstance(rawSize.getWidth(), rawSize.getHeight(), ImageFormat.RAW_SENSOR, 2);
            rawReader.setOnImageAvailableListener(r -> {
                Image img = r.acquireNextImage();
                synchronized (this) {
                    pendingImage = img;
                }
                maybeSave();
            }, bg);

            //noinspection MissingPermission
            cm.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice d) {
                    device = d;
                    startSession();
                }
                @Override public void onDisconnected(CameraDevice d) {
                    d.close();
                    device = null;
                }
                @Override public void onError(CameraDevice d, int e) {
                    d.close();
                    device = null;
                    fail("Camera error " + e);
                }
            }, bg);
        } catch (SecurityException | CameraAccessException e) {
            fail("Couldn't open the camera: " + e.getMessage());
        }
    }

    private static Size pickPreview(Size[] options, Size raw) {
        double target = (double) raw.getWidth() / raw.getHeight();
        Size best = null;
        for (Size s : options) {
            if (s.getWidth() > 1920 || s.getHeight() > 1440) continue;
            double r = (double) s.getWidth() / s.getHeight();
            if (Math.abs(r - target) > 0.02) continue;
            if (best == null || s.getWidth() * s.getHeight() > best.getWidth() * best.getHeight()) best = s;
        }
        return best != null ? best : options[0];
    }

    private void layoutPreview() {
        runOnUiThread(() -> {
            int sw = getResources().getDisplayMetrics().widthPixels;
            // sensor is landscape; we show it rotated into portrait
            int h = Math.round(sw * (float) previewSize.getWidth() / previewSize.getHeight());
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(sw, h, Gravity.CENTER);
            preview.setLayoutParams(lp);
        });
    }

    private void startSession() {
        try {
            SurfaceTexture st = preview.getSurfaceTexture();
            if (st == null) return;
            st.setDefaultBufferSize(previewSize.getWidth(), previewSize.getHeight());
            Surface ps = new Surface(st);
            previewReq = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            previewReq.addTarget(ps);
            previewReq.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            //noinspection deprecation
            device.createCaptureSession(Arrays.asList(ps, rawReader.getSurface()), new CameraCaptureSession.StateCallback() {
                @Override public void onConfigured(CameraCaptureSession s) {
                    session = s;
                    try {
                        s.setRepeatingRequest(previewReq.build(), null, bg);
                    } catch (Exception e) {
                        fail("Preview failed: " + e.getMessage());
                    }
                }
                @Override public void onConfigureFailed(CameraCaptureSession s) {
                    fail("The camera couldn't be configured for RAW");
                }
            }, bg);
        } catch (Exception e) {
            fail("Preview failed: " + e.getMessage());
        }
    }

    private void capture() {
        if (session == null || busy) return;
        busy = true;
        shutter.performHapticFeedback(HapticFeedbackConstants.CONFIRM);
        shutter.animate().scaleX(0.86f).scaleY(0.86f).setDuration(90).withEndAction(() -> shutter.animate().scaleX(1).scaleY(1).setDuration(140));
        status.setText("Capturing RAW…");
        try {
            CaptureRequest.Builder r = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
            r.addTarget(rawReader.getSurface());
            r.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            int[] shading = chars.get(CameraCharacteristics.STATISTICS_INFO_AVAILABLE_LENS_SHADING_MAP_MODES);
            if (shading != null) for (int m : shading) if (m == CameraMetadata.STATISTICS_LENS_SHADING_MAP_MODE_ON) {
                r.set(CaptureRequest.STATISTICS_LENS_SHADING_MAP_MODE, CameraMetadata.STATISTICS_LENS_SHADING_MAP_MODE_ON);
            }
            session.capture(r.build(), new CameraCaptureSession.CaptureCallback() {
                @Override public void onCaptureCompleted(CameraCaptureSession s, CaptureRequest req, TotalCaptureResult res) {
                    synchronized (RawCameraActivity.this) {
                        pendingResult = res;
                    }
                    maybeSave();
                }
            }, bg);
        } catch (Exception e) {
            busy = false;
            status.setText("Capture failed: " + e.getMessage());
        }
    }

    private void maybeSave() {
        Image img;
        TotalCaptureResult res;
        synchronized (this) {
            if (pendingImage == null || pendingResult == null) return;
            img = pendingImage;
            res = pendingResult;
            pendingImage = null;
            pendingResult = null;
        }
        String name = "LUMEN_" + new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date()) + ".dng";
        File f = new File(getCacheDir(), name);
        try (DngCreator dng = new DngCreator(chars, res); FileOutputStream os = new FileOutputStream(f)) {
            dng.setOrientation(exifOrientation());
            dng.writeImage(os, img);
        } catch (Exception e) {
            img.close();
            runOnUiThread(() -> {
                busy = false;
                status.setText("Couldn't write the DNG: " + e.getMessage());
            });
            return;
        }
        img.close();
        boolean gallery = copyToGallery(f, name);
        Intent data = new Intent();
        data.putExtra("path", f.getAbsolutePath());
        data.putExtra("name", name);
        data.putExtra("gallery", gallery);
        runOnUiThread(() -> {
            setResult(RESULT_OK, data);
            finish();
        });
    }

    private int exifOrientation() {
        Integer so = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
        int deg = so == null ? 90 : so; // activity is locked to portrait
        switch ((deg % 360 + 360) % 360) {
            case 90: return ExifInterface.ORIENTATION_ROTATE_90;
            case 180: return ExifInterface.ORIENTATION_ROTATE_180;
            case 270: return ExifInterface.ORIENTATION_ROTATE_270;
            default: return ExifInterface.ORIENTATION_NORMAL;
        }
    }

    private boolean copyToGallery(File f, String name) {
        if (Build.VERSION.SDK_INT < 29) return false;
        try {
            Uri u = LumenNativePlugin.insertMedia(getContentResolver(), name, "image/x-adobe-dng");
            try (InputStream in = new FileInputStream(f); OutputStream out = getContentResolver().openOutputStream(u)) {
                if (out == null) return false;
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            getContentResolver().update(u, v, null, null);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private void closeCamera() {
        try {
            if (session != null) session.close();
        } catch (Exception ignored) {}
        session = null;
        if (device != null) device.close();
        device = null;
        if (rawReader != null) rawReader.close();
        rawReader = null;
    }

    private void fail(String msg) {
        new Handler(Looper.getMainLooper()).post(() -> {
            Intent d = new Intent();
            if (msg != null) d.putExtra("error", msg);
            setResult(RESULT_CANCELED, d);
            finish();
        });
    }
}
