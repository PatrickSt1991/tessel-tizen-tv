# Why a Web App and not Native?

This project started as a native C/C++ port of `libvlc` for Tizen 5.0 ARM,
fully cross-compiled with `arm-linux-gnueabi-gcc`, GLIBC version-string
patching, and a custom glibc compat shim for y2038 wrappers. It built cleanly,
installed cleanly, but **never launched** on the retail TV — Samsung's
launchpad on retail firmware silently refuses third-party native (`type="capp"`)
binaries from non-partner distributor certs.

Web apps (`.wgt`, `type="webapp"`) launch fine because they run in the TV's
sandboxed WebView. AVPlay covers the same codec breadth that libvlc would have
provided, just through a JS API instead of C. Net result: same user
experience, supported path.
