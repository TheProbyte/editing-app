package app.lumen.editor;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageDecoder;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.HapticFeedbackConstants;
import android.view.View;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import android.database.Cursor;
import android.provider.OpenableColumns;
import com.getcapacitor.JSArray;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/** Native bits for Lumen: haptic ticks, gallery saves, RAW capture and a DNG decoder fallback. */
@CapacitorPlugin(name = "LumenNative")
public class LumenNativePlugin extends Plugin {

    private OutputStream out;
    private Uri pendingUri;
    private File pendingFile;

    // ---------------------------------------------------------------- shared to the app

    /** What another app handed over (Share, Open with, Edit), until the page takes it. */
    private static final List<Uri> shared = new ArrayList<>();
    private static LumenNativePlugin live;

    @Override
    public void load() {
        live = this;
    }

    /** Called by the activity with each intent it gets: keeps the photos / videos it carries. */
    static void offer(Activity a, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        List<Uri> uris = new ArrayList<>();
        String act = intent.getAction();
        if (Intent.ACTION_SEND.equals(act)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(act)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        } else if (Intent.ACTION_VIEW.equals(act) || Intent.ACTION_EDIT.equals(act)) {
            if (intent.getData() != null) uris.add(intent.getData());
        }
        if (uris.isEmpty()) return;
        synchronized (shared) {
            shared.clear();
            shared.addAll(uris);
        }
        // (consumed: rotating or coming back to the app doesn't open them again)
        intent.setAction(Intent.ACTION_MAIN);
        if (live != null) live.notifyListeners("shared", new JSObject(), true);
    }

    /**
     * The shared files, copied into the app's cache (a gallery item is only readable through
     * Android, not as a path): [{ path, name, mime }]. Copies from earlier shares are removed.
     */
    @PluginMethod
    public void takeShared(PluginCall call) {
        List<Uri> uris;
        synchronized (shared) {
            uris = new ArrayList<>(shared);
            shared.clear();
        }
        new Thread(() -> {
            File dir = new File(getContext().getCacheDir(), "shared");
            File[] old = dir.listFiles();
            if (old != null) for (File f : old) //noinspection ResultOfMethodCallIgnored
                f.delete();
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            JSArray out = new JSArray();
            ContentResolver cr = getContext().getContentResolver();
            int n = 0;
            for (Uri u : uris) {
                String name = "shared_" + (n++);
                try (Cursor c = cr.query(u, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                    if (c != null && c.moveToFirst() && c.getString(0) != null) name = c.getString(0);
                } catch (Exception ignored) {}
                String mime = cr.getType(u);
                File f = new File(dir, n + "_" + name.replaceAll("[\\\\/:*?\"<>|]", "_"));
                try (InputStream in = cr.openInputStream(u); FileOutputStream os = new FileOutputStream(f)) {
                    if (in == null) continue;
                    byte[] buf = new byte[1 << 16];
                    int r;
                    while ((r = in.read(buf)) > 0) os.write(buf, 0, r);
                } catch (Exception e) {
                    continue;
                }
                JSObject o = new JSObject();
                o.put("path", f.getAbsolutePath());
                o.put("name", name);
                o.put("mime", mime != null ? mime : "");
                out.put(o);
            }
            JSObject r = new JSObject();
            r.put("files", out);
            call.resolve(r);
        }).start();
    }

    // ---------------------------------------------------------------- haptics

    @PluginMethod
    public void tick(PluginCall call) {
        final boolean strong = call.getBoolean("strong", false);
        getActivity().runOnUiThread(() -> {
            View v = getBridge().getWebView();
            int c;
            if (Build.VERSION.SDK_INT >= 34) {
                c = strong ? HapticFeedbackConstants.SEGMENT_TICK : HapticFeedbackConstants.SEGMENT_FREQUENT_TICK;
            } else if (Build.VERSION.SDK_INT >= 30) {
                c = strong ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.CLOCK_TICK;
            } else {
                c = strong ? HapticFeedbackConstants.KEYBOARD_TAP : HapticFeedbackConstants.CLOCK_TICK;
            }
            v.performHapticFeedback(c);
        });
        call.resolve();
    }

    // ---------------------------------------------------------------- streamed writes

    @PluginMethod
    public void writeStart(PluginCall call) {
        closeQuietly();
        String name = call.getString("name", "lumen.jpg");
        String mime = call.getString("mime", "image/jpeg");
        String target = call.getString("target", "gallery");
        try {
            if ("cache".equals(target)) {
                pendingFile = new File(getContext().getCacheDir(), name);
                out = new FileOutputStream(pendingFile);
            } else {
                pendingUri = insertMedia(getContext().getContentResolver(), name, mime);
                out = getContext().getContentResolver().openOutputStream(pendingUri);
                if (out == null) throw new IOException("Could not open the gallery for writing");
            }
            call.resolve();
        } catch (Exception e) {
            closeQuietly();
            call.reject("Could not start saving: " + e.getMessage());
        }
    }

    @PluginMethod
    public void writeChunk(PluginCall call) {
        try {
            if (out == null) throw new IOException("No file open");
            out.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            call.resolve();
        } catch (Exception e) {
            closeQuietly();
            call.reject("Saving failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void writeFinish(PluginCall call) {
        try {
            if (out == null) throw new IOException("No file open");
            out.close();
            out = null;
            JSObject r = new JSObject();
            if (pendingUri != null) {
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    getContext().getContentResolver().update(pendingUri, v, null, null);
                }
                r.put("uri", pendingUri.toString());
            }
            if (pendingFile != null) r.put("path", pendingFile.getAbsolutePath());
            pendingUri = null;
            pendingFile = null;
            call.resolve(r);
        } catch (Exception e) {
            closeQuietly();
            call.reject("Saving failed: " + e.getMessage());
        }
    }

    private void closeQuietly() {
        try {
            if (out != null) out.close();
        } catch (IOException ignored) {}
        out = null;
        pendingUri = null;
        pendingFile = null;
    }

    static Uri insertMedia(ContentResolver cr, String name, String mime) throws IOException {
        ContentValues v = new ContentValues();
        // videos go to Movies/Lumen in the video collection, pictures to Pictures/Lumen
        boolean video = mime != null && mime.startsWith("video/");
        String folder = video ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES;
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        if (Build.VERSION.SDK_INT >= 29) {
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, folder + "/Lumen");
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        } else {
            File dir = new File(Environment.getExternalStoragePublicDirectory(folder), "Lumen");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            v.put(MediaStore.MediaColumns.DATA, new File(dir, name).getAbsolutePath());
        }
        Uri u = cr.insert(video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
        if (u == null) throw new IOException("The gallery refused the file");
        return u;
    }

    // ---------------------------------------------------------------- RAW camera

    @PluginMethod
    public void captureRaw(PluginCall call) {
        Intent i = new Intent(getContext(), RawCameraActivity.class);
        startActivityForResult(call, i, "rawResult");
    }

    @ActivityCallback
    private void rawResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent d = result.getData();
        if (result.getResultCode() == Activity.RESULT_OK && d != null && d.getStringExtra("path") != null) {
            JSObject r = new JSObject();
            r.put("path", d.getStringExtra("path"));
            r.put("name", d.getStringExtra("name"));
            r.put("savedToGallery", d.getBooleanExtra("gallery", false));
            call.resolve(r);
        } else {
            String err = d != null ? d.getStringExtra("error") : null;
            call.reject(err != null ? err : "cancelled");
        }
    }

    // ---------------------------------------------------------------- DNG decode fallback

    @PluginMethod
    public void decodeFile(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("No file");
            return;
        }
        try {
            Bitmap bmp;
            if (Build.VERSION.SDK_INT >= 28) {
                ImageDecoder.Source src = ImageDecoder.createSource(new File(path));
                bmp = ImageDecoder.decodeBitmap(src, (decoder, info, s) -> decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE));
            } else {
                bmp = BitmapFactory.decodeFile(path);
            }
            if (bmp == null) throw new IOException("Android can't decode this file");
            // Some decoders ignore the DNG orientation; phone sensors are landscape, so a
            // still-landscape result with a 90/270 tag hasn't been turned yet.
            int rot = 0;
            try {
                int o = new ExifInterface(path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
                rot = o == ExifInterface.ORIENTATION_ROTATE_90 ? 90 : o == ExifInterface.ORIENTATION_ROTATE_270 ? 270 : 0;
            } catch (Exception ignored) {}
            if (rot != 0 && bmp.getWidth() > bmp.getHeight()) {
                Matrix m = new Matrix();
                m.postRotate(rot);
                Bitmap r = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
                bmp.recycle();
                bmp = r;
            }
            File outFile = new File(getContext().getCacheDir(), "decoded_" + System.currentTimeMillis() + ".jpg");
            try (FileOutputStream os = new FileOutputStream(outFile)) {
                bmp.compress(Bitmap.CompressFormat.JPEG, 98, os);
            }
            JSObject r = new JSObject();
            r.put("path", outFile.getAbsolutePath());
            r.put("width", bmp.getWidth());
            r.put("height", bmp.getHeight());
            bmp.recycle();
            //noinspection ResultOfMethodCallIgnored
            new File(path).delete();
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "Decode failed");
        }
    }
}
