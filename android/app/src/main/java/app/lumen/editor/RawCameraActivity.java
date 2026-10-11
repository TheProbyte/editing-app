package app.lumen.editor;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.SurfaceTexture;
import android.graphics.drawable.ColorDrawable;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.DngCreator;
import android.hardware.camera2.TotalCaptureResult;
import android.hardware.camera2.params.OutputConfiguration;
import android.hardware.camera2.params.SessionConfiguration;
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
import android.util.SizeF;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.OrientationEventListener;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executor;

/**
 * Camera2 RAW_SENSOR capture that writes a real DNG and hands it back to the editor.
 * Every back lens that offers RAW gets a button (.5×, 1×, 5× …), including the physical
 * lenses behind a "logical" multi-camera such as a Pixel's.
 */
public class RawCameraActivity extends Activity {

    private static final int REQ_CAM = 41;
    private static final int ACCENT = 0xFFFFC83D;
    private static final int INK = 0xFFF4F4F2;
    private static final int ACCENT_INK = 0xFF1C1500;

    /** One lens you can shoot with. */
    private static class Lens {
        String openId;      // camera to open
        String physicalId;  // physical lens inside it (null = the camera itself)
        CameraCharacteristics chars;
        Size raw;
        float eq;           // 35mm-equivalent focal length
        String label;
        boolean failed;
    }

    private TextureView preview;
    private TextView status;
    private View shutter;
    private LinearLayout lensRow;

    private HandlerThread thread;
    private Handler bg;
    private CameraDevice device;
    private CameraCaptureSession session;
    private ImageReader rawReader;
    private final List<Lens> lenses = new ArrayList<>();
    private Lens lens;
    private Size previewSize;
    private CaptureRequest.Builder previewReq;

    private Image pendingImage;
    private TotalCaptureResult pendingResult;
    private boolean busy;
    /** device rotation (0/90/180/270, clockwise from portrait) tracked from the sensors */
    private int deviceDeg;
    private OrientationEventListener orientationListener;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        preview = new TextureView(this);
        root.addView(preview, new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER));

        TextView title = text("RAW · DNG", 13);
        title.setTextColor(ACCENT);
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
        sl.bottomMargin = dp(210);
        root.addView(status, sl);

        lensRow = new LinearLayout(this);
        lensRow.setOrientation(LinearLayout.HORIZONTAL);
        FrameLayout.LayoutParams ll = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        ll.bottomMargin = dp(158);
        root.addView(lensRow, ll);

        // square pixel-style shutter: yellow block in a white frame
        FrameLayout shutterFrame = new FrameLayout(this);
        shutterFrame.setBackground(new ColorDrawable(INK));
        shutterFrame.setPadding(dp(5), dp(5), dp(5), dp(5));
        shutter = new View(this);
        shutter.setBackground(new ColorDrawable(ACCENT));
        shutterFrame.addView(shutter, new FrameLayout.LayoutParams(-1, -1));
        shutterFrame.setOnClickListener(v -> capture());
        FrameLayout.LayoutParams bl = new FrameLayout.LayoutParams(dp(74), dp(74), Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        bl.bottomMargin = dp(64);
        root.addView(shutterFrame, bl);

        setContentView(root);
        orientationListener = new OrientationEventListener(this) {
            @Override public void onOrientationChanged(int o) {
                if (o == ORIENTATION_UNKNOWN) return;
                deviceDeg = ((o + 45) / 90 * 90) % 360;
            }
        };
    }

    private TextView text(String s, int sp) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextColor(INK);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (orientationListener.canDetectOrientation()) orientationListener.enable();
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
        orientationListener.disable();
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

    // ------------------------------------------------------------------ lenses

    private static boolean hasRaw(CameraCharacteristics c) {
        int[] caps = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
        if (caps == null) return false;
        for (int cap : caps) if (cap == CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_RAW) return true;
        return false;
    }

    private static Size biggestRaw(CameraCharacteristics c) {
        StreamConfigurationMap map = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        if (map == null) return null;
        Size[] sizes = map.getOutputSizes(ImageFormat.RAW_SENSOR);
        if (sizes == null || sizes.length == 0) return null;
        return Collections.max(Arrays.asList(sizes), (a, b) -> Long.compare((long) a.getWidth() * a.getHeight(), (long) b.getWidth() * b.getHeight()));
    }

    private static float equivalentFocal(CameraCharacteristics c) {
        float[] f = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
        SizeF s = c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
        if (f == null || f.length == 0 || s == null) return 0;
        double diag = Math.hypot(s.getWidth(), s.getHeight());
        return diag > 0 ? (float) (f[0] * 43.27 / diag) : 0;
    }

    private void addLens(String openId, String physicalId, CameraCharacteristics c) {
        if (!hasRaw(c)) return;
        Size raw = biggestRaw(c);
        if (raw == null) return;
        Lens l = new Lens();
        l.openId = openId;
        l.physicalId = physicalId;
        l.chars = c;
        l.raw = raw;
        l.eq = equivalentFocal(c);
        // the same lens can show up twice (on its own and inside a logical camera): keep one,
        // preferring the plain camera
        for (int i = 0; i < lenses.size(); i++) {
            Lens o = lenses.get(i);
            if (o.eq > 0 && l.eq > 0 && Math.abs(o.eq - l.eq) / o.eq < 0.08) {
                if (o.physicalId != null && physicalId == null) lenses.set(i, l);
                return;
            }
        }
        lenses.add(l);
    }

    private void findLenses(CameraManager cm) throws CameraAccessException {
        lenses.clear();
        for (String id : cm.getCameraIdList()) {
            CameraCharacteristics c = cm.getCameraCharacteristics(id);
            Integer facing = c.get(CameraCharacteristics.LENS_FACING);
            if (facing == null || facing != CameraCharacteristics.LENS_FACING_BACK) continue;
            addLens(id, null, c);
            if (Build.VERSION.SDK_INT >= 28) {
                Set<String> phys = c.getPhysicalCameraIds();
                for (String pid : phys) {
                    try {
                        addLens(id, pid, cm.getCameraCharacteristics(pid));
                    } catch (Exception ignored) {}
                }
            }
        }
        Collections.sort(lenses, (a, b) -> Float.compare(a.eq, b.eq));
        // the main lens: closest to a 24-26mm view (or the biggest sensor when focal data is missing)
        Lens main = null;
        for (Lens l : lenses) {
            if (main == null) main = l;
            else if (l.eq > 0 && main.eq > 0 ? Math.abs(l.eq - 25) < Math.abs(main.eq - 25)
                    : (long) l.raw.getWidth() * l.raw.getHeight() > (long) main.raw.getWidth() * main.raw.getHeight()) main = l;
        }
        for (Lens l : lenses) {
            float k = main != null && main.eq > 0 && l.eq > 0 ? l.eq / main.eq : 1;
            if (k < 0.95) l.label = String.format(Locale.US, "%.1f×", k).replace("0.", ".");
            else l.label = Math.round(k) + "×";
        }
        if (lens == null) lens = main;
    }

    private void buildLensRow() {
        runOnUiThread(() -> {
            lensRow.removeAllViews();
            if (lenses.size() < 2) return;
            for (Lens l : lenses) {
                if (l.failed) continue;
                TextView b = text(l.label, 14);
                b.setPadding(dp(14), dp(8), dp(14), dp(8));
                boolean on = l == lens;
                b.setBackground(new ColorDrawable(on ? ACCENT : 0x66000000));
                b.setTextColor(on ? ACCENT_INK : INK);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
                lp.leftMargin = lp.rightMargin = dp(4);
                b.setOnClickListener(v -> switchLens(l));
                lensRow.addView(b, lp);
            }
        });
    }

    private void switchLens(Lens l) {
        if (l == lens || busy) return;
        lensRow.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK);
        bg.post(() -> {
            closeCamera();
            lens = l;
            buildLensRow();
            openCamera();
        });
    }

    // ------------------------------------------------------------------ camera

    private void openCamera() {
        if (device != null) return;
        CameraManager cm = (CameraManager) getSystemService(CAMERA_SERVICE);
        try {
            if (lenses.isEmpty()) findLenses(cm);
            if (lens == null) {
                fail("This phone doesn't offer RAW capture to apps");
                return;
            }
            buildLensRow();
            StreamConfigurationMap map = lens.chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            previewSize = pickPreview(map.getOutputSizes(SurfaceTexture.class), lens.raw);
            layoutPreview();

            rawReader = ImageReader.newInstance(lens.raw.getWidth(), lens.raw.getHeight(), ImageFormat.RAW_SENSOR, 2);
            rawReader.setOnImageAvailableListener(r -> {
                Image img = r.acquireNextImage();
                synchronized (this) {
                    pendingImage = img;
                }
                maybeSave();
            }, bg);

            //noinspection MissingPermission
            cm.openCamera(lens.openId, new CameraDevice.StateCallback() {
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
                    lensFailed("Camera error " + e);
                }
            }, bg);
        } catch (SecurityException | CameraAccessException e) {
            fail("Couldn't open the camera: " + e.getMessage());
        }
    }

    /** A lens that won't give RAW to apps: hide it and go back to another one. */
    private void lensFailed(String why) {
        Lens bad = lens;
        if (bad != null) bad.failed = true;
        Lens next = null;
        for (Lens l : lenses) if (!l.failed && (next == null || Math.abs(l.eq - 25) < Math.abs(next.eq - 25))) next = l;
        if (next == null) {
            fail(why);
            return;
        }
        final Lens n = next;
        runOnUiThread(() -> status.setText(bad != null ? bad.label + " can't shoot RAW for apps" : why));
        bg.post(() -> {
            closeCamera();
            lens = n;
            openCamera();
        });
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
            CameraCaptureSession.StateCallback cb = new CameraCaptureSession.StateCallback() {
                @Override public void onConfigured(CameraCaptureSession s) {
                    session = s;
                    runOnUiThread(() -> status.setText(""));
                    try {
                        s.setRepeatingRequest(previewReq.build(), null, bg);
                    } catch (Exception e) {
                        lensFailed("Preview failed: " + e.getMessage());
                    }
                }
                @Override public void onConfigureFailed(CameraCaptureSession s) {
                    lensFailed("The camera couldn't be configured for RAW");
                }
            };
            if (lens.physicalId != null && Build.VERSION.SDK_INT >= 28) {
                // stream straight from one physical lens of the logical camera
                OutputConfiguration po = new OutputConfiguration(ps);
                po.setPhysicalCameraId(lens.physicalId);
                OutputConfiguration ro = new OutputConfiguration(rawReader.getSurface());
                ro.setPhysicalCameraId(lens.physicalId);
                Executor ex = bg::post;
                device.createCaptureSession(new SessionConfiguration(SessionConfiguration.SESSION_REGULAR, Arrays.asList(po, ro), ex, cb));
            } else {
                //noinspection deprecation
                device.createCaptureSession(Arrays.asList(ps, rawReader.getSurface()), cb, bg);
            }
        } catch (Exception e) {
            lensFailed("Preview failed: " + e.getMessage());
        }
    }

    private void capture() {
        if (session == null || busy) return;
        busy = true;
        shutter.performHapticFeedback(HapticFeedbackConstants.CONFIRM);
        View frame = (View) shutter.getParent();
        frame.animate().scaleX(0.88f).scaleY(0.88f).setDuration(80).withEndAction(() -> frame.animate().scaleX(1).scaleY(1).setDuration(140));
        status.setText("Capturing RAW…");
        try {
            CaptureRequest.Builder r = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
            r.addTarget(rawReader.getSurface());
            r.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            int[] shading = lens.chars.get(CameraCharacteristics.STATISTICS_INFO_AVAILABLE_LENS_SHADING_MAP_MODES);
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

    /** The metadata that belongs to the lens that shot (a physical lens has its own). */
    @SuppressWarnings("deprecation")
    private CaptureResult resultFor(TotalCaptureResult res) {
        if (lens.physicalId == null || Build.VERSION.SDK_INT < 28) return res;
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                Map<String, TotalCaptureResult> m = res.getPhysicalCameraTotalResults();
                if (m.containsKey(lens.physicalId)) return m.get(lens.physicalId);
            }
            Map<String, CaptureResult> m = res.getPhysicalCameraResults();
            if (m.containsKey(lens.physicalId)) return m.get(lens.physicalId);
        } catch (Exception ignored) {}
        return res;
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
        try (DngCreator dng = new DngCreator(lens.chars, resultFor(res)); FileOutputStream os = new FileOutputStream(f)) {
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
        Integer so = lens.chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
        // back camera: sensor orientation plus how the phone is being held
        int deg = (so == null ? 90 : so) + deviceDeg;
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
