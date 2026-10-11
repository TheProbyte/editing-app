package app.lumen.editor;

import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LumenNativePlugin.class);
        super.onCreate(savedInstanceState);
        // Serve the app cross-origin isolated so the multi-threaded RAW decoder
        // (WebAssembly + SharedArrayBuffer) can run.
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse r = super.shouldInterceptRequest(view, request);
                if (r != null) {
                    Map<String, String> h = r.getResponseHeaders() == null
                        ? new HashMap<>()
                        : new HashMap<>(r.getResponseHeaders());
                    h.put("Cross-Origin-Opener-Policy", "same-origin");
                    h.put("Cross-Origin-Embedder-Policy", "require-corp");
                    h.put("Cross-Origin-Resource-Policy", "same-origin");
                    r.setResponseHeaders(h);
                }
                return r;
            }
        });
        // Back goes back a page inside the editor (closes a sheet or section, returns from
        // the home screen); only when there's nowhere left to go does it leave the app.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = bridge.getWebView();
                wv.evaluateJavascript("(function(){try{return !!(window.lumenBack&&window.lumenBack())}catch(e){return false}})()", (handled) -> {
                    if (!"true".equals(handled)) {
                        setEnabled(false);
                        getOnBackPressedDispatcher().onBackPressed();
                        setEnabled(true);
                    }
                });
            }
        });
    }
}
