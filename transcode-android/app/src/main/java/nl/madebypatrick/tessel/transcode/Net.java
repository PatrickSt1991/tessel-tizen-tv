package nl.madebypatrick.tessel.transcode;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;

import java.net.Inet4Address;

/** The address a TV on the same network reaches this phone on. */
final class Net {
    private Net() {}

    /** IPv4 address on Wi-Fi (or Ethernet), or null when there is neither. */
    @SuppressWarnings("deprecation") // getAllNetworks: the replacement needs a callback
    static String lanAddress(Context ctx) {
        ConnectivityManager cm = ctx.getSystemService(ConnectivityManager.class);
        if (cm == null) return null;
        for (Network n : cm.getAllNetworks()) {
            NetworkCapabilities caps = cm.getNetworkCapabilities(n);
            if (caps == null) continue;
            if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                    && !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) continue;
            LinkProperties lp = cm.getLinkProperties(n);
            if (lp == null) continue;
            for (LinkAddress la : lp.getLinkAddresses()) {
                if (la.getAddress() instanceof Inet4Address && !la.getAddress().isLoopbackAddress()) {
                    return la.getAddress().getHostAddress();
                }
            }
        }
        return null;
    }

    static String serverUrl(Context ctx) {
        String ip = lanAddress(ctx);
        return ip == null ? ctx.getString(R.string.no_wifi)
                : "http://" + ip + ":" + TranscodeService.PORT;
    }
}
