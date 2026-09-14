# Reading the app's log

Every debug line the app writes goes to the browser console, tagged `[vlctv]`,
and needs nothing switched on first. To see it live:

1. In Apps2Samsung, open **Installed apps → VLC TV → Debug**. This starts the
   app in debug mode and opens `chrome://inspect` for you.
2. Click **inspect** on the VLC TV entry. A DevTools window opens; type `vlctv`
   in the console's filter box to hide the TV's own noise.
3. Reproduce the problem. Warnings and errors show in red, and the Errors
   filter picks them out.

The SMB code logs under the `[SMB]` tag: what was saved (server, port, share,
user, password length), why the share browser sent you back to Settings, the
service launch, and the connection itself. Lines starting `svc` come from the
background service that speaks SMB2 (its `NEGOTIATE` / `SESSION_SETUP` /
`TREE_CONNECT` trail and socket errors); the service runs as a separate process
and does not show up in `chrome://inspect`, so the app pulls its log and
forwards it after each connection step.

If you'd rather capture a session without DevTools attached, **Settings → Debug
logging** POSTs the same lines to an HTTP listener on your PC. It ships off.
