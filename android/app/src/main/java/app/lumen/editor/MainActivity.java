package app.lumen.editor;

import android.os.Bundle;
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
    }
}
