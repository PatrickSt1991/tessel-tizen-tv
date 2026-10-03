/* Picture viewer (issue #108) and text viewer (issue #107) for files found
 * in the USB and SMB browsers.
 *
 * Both take the remote for themselves while open: their key handler goes
 * on top of Remote's stack, so the browser underneath never sees a key, and
 * comes off again on close, when the caller's onClose puts the folder back
 * (handed the picture last on screen, to put the cursor on).
 *
 * Pictures load one at a time into a single <img>.  A decoded 4K photo is
 * ~33 MB, so nothing is preloaded, and the image is dropped on close.
 * Chromium on these TVs ignores EXIF orientation, so a phone photo can come
 * out sideways — Up / Down turn it.
 *
 * Text files are read up to MAX_TEXT_BYTES and shown as they are, with the
 * encoding guessed by TextDecode.  A bigger file shows its first part and
 * says so: painting megabytes of text into one element makes the TV's
 * WebView crawl, and nobody pages through that on a remote anyway. */

var Viewer = (function () {
    var MAX_TEXT_BYTES = 1024 * 1024;
    var SLIDESHOW_DEFAULT_S = 5;
    var BAR_MS         = 4000;

    var keyHandler = null;
    var openKind = null;       // 'image' | 'text' while one is open
    var onClose    = null;

    function $(id) { return document.getElementById(id); }

    function takeKeys(fn) {
        releaseKeys();
        keyHandler = Remote.push(fn);
    }
    function releaseKeys() {
        if (keyHandler) { Remote.pop(keyHandler); keyHandler = null; }
    }
    function close() {
        stopSlideshow(true);
        clearTimeout(pic.barTimer);
        releaseKeys();
        var el = $('image-el');
        if (el) { el.onload = el.onerror = null; el.removeAttribute('src'); }
        var pre = $('text-pre');
        if (pre) pre.textContent = '';
        // The picture on screen when the viewer closed, so the folder can put
        // the cursor on it (the slideshow may have moved on a long way).
        var last = openKind === 'image' ? pic.items[pic.idx] : null;
        openKind = null;
        var cb = onClose; onClose = null;
        if (cb) cb(last);
    }

    function humanSize(n) {
        if (typeof Browser !== 'undefined' && Browser.humanSize) return Browser.humanSize(n);
        return n ? n + ' B' : '';
    }

    /* ── Pictures ─────────────────────────────────────────────────────── */
    var pic = { items: [], idx: 0, rot: 0, timer: null, barTimer: null };

    /* items: [{ title, uri, size }] — the pictures in the folder, in list
     * order, so Left / Right walk the folder. */
    function openImage(items, idx, closeCb) {
        onClose   = closeCb || null;
        pic.items = items || [];
        pic.idx   = Math.max(0, Math.min(idx || 0, pic.items.length - 1));
        UI.showView('view-image');
        takeKeys(imageKeys);
        openKind = 'image';
        showPicture();
    }

    function showPicture() {
        var it = pic.items[pic.idx];
        if (!it) return;
        pic.rot = 0;
        applyRotation();
        var el = $('image-el');
        var status = $('image-status');
        el.classList.add('loading');
        status.textContent = I18n.t('common.loading');
        status.classList.remove('hidden');
        $('image-name').textContent = it.title;
        $('image-info').textContent = counter();
        el.onload = function () {
            el.classList.remove('loading');
            status.classList.add('hidden');
            var bits = [counter(), el.naturalWidth + ' × ' + el.naturalHeight];
            if (it.size) bits.push(humanSize(it.size));
            $('image-info').textContent = bits.join('  ·  ');
        };
        el.onerror = function () {
            el.classList.add('loading');
            status.textContent = I18n.t('image.error');
            status.classList.remove('hidden');
            if (typeof Debug !== 'undefined') Debug.warn('image failed to load: ' + it.uri);
        };
        el.src = it.uri;
        showBar();
    }

    function counter() { return (pic.idx + 1) + ' / ' + pic.items.length; }

    function step(delta) {
        if (pic.items.length < 2) return;
        pic.idx = (pic.idx + delta + pic.items.length) % pic.items.length;
        showPicture();
    }

    function applyRotation() {
        var el = $('image-el');
        el.style.transform = pic.rot ? 'rotate(' + pic.rot + 'deg)' : '';
        // Turned on its side, the picture's width runs along the screen's
        // height, so the size limits swap.
        el.classList.toggle('sideways', pic.rot % 180 !== 0);
    }
    function rotate(deg) {
        pic.rot = (pic.rot + deg + 360) % 360;
        applyRotation();
        showBar();
    }

    /* Settings → Slideshow interval (issue #126); the default when the
     * setting is missing or nonsense. */
    function slideshowMs() {
        var s = (typeof Settings !== 'undefined') ? parseInt(Settings.get('slideshowSeconds'), 10) : 0;
        return (s > 0 ? s : SLIDESHOW_DEFAULT_S) * 1000;
    }

    function toggleSlideshow() {
        if (pic.timer) { stopSlideshow(); return; }
        if (pic.items.length < 2) return;
        pic.timer = setInterval(function () { step(1); keepAwake(true); }, slideshowMs());
        keepAwake(true);
        UI.toast(I18n.t('image.slideshowOn'));
    }
    function stopSlideshow(quiet) {
        if (!pic.timer) return;
        clearInterval(pic.timer);
        pic.timer = null;
        keepAwake(false);
        if (!quiet) UI.toast(I18n.t('image.slideshowOff'));
    }

    /* The TV counts a slideshow as idle — no key presses, no video — and
     * puts its screensaver over it after a few minutes (issues #115, #126).
     * KeepAwake holds it off while the slideshow runs and is asked again
     * with every picture, since some firmware lets the switches lapse; the
     * hold is let go when the slideshow stops, so a single picture left on
     * screen still gets the screensaver, which is what protects the panel. */
    function keepAwake(on) {
        if (typeof KeepAwake === 'undefined') return;
        if (on) KeepAwake.hold('slideshow'); else KeepAwake.release();
    }
    /* The TV going to standby, or another app coming up, ends the
     * slideshow: nothing should hold the screen awake from the background. */
    if (typeof document !== 'undefined')
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'hidden' && pic.timer) stopSlideshow(true);
        });

    function showBar() {
        var bar = $('image-bar');
        bar.classList.remove('hidden');
        clearTimeout(pic.barTimer);
        pic.barTimer = setTimeout(function () { bar.classList.add('hidden'); }, BAR_MS);
    }

    function imageKeys(code) {
        var K = Remote.KEY;
        switch (code) {
            case K.LEFT:  case K.CH_DOWN: stopSlideshow(true); step(-1); return true;
            case K.RIGHT: case K.CH_UP:   stopSlideshow(true); step(+1); return true;
            case K.UP:    rotate(-90); return true;
            case K.DOWN:  rotate(+90); return true;
            case K.ENTER: case K.PLAY: case K.PAUSE: case K.PLAYPAUSE:
                toggleSlideshow(); showBar(); return true;
            case K.STOP:  stopSlideshow(); return true;
            case K.INFO:  showBar(); return true;
            case K.BACK:  close(); return true;
        }
        // Everything else is swallowed, or it would steer the hidden browser.
        return code !== K.EXIT;
    }

    /* ── Text ─────────────────────────────────────────────────────────── */
    /* item: { title, src, size } — src is what Browser.readHead reads: a
     * Tizen File for USB, the smbproxy URL for a share file. */
    function openText(item, closeCb) {
        onClose = closeCb || null;
        UI.showView('view-text');
        takeKeys(textKeys);
        openKind = 'text';
        var body = $('text-body'), pre = $('text-pre');
        $('text-name').textContent = item.title;
        $('text-info').textContent = '';
        pre.textContent = I18n.t('common.loading');
        pre.classList.add('muted');
        body.scrollTop = 0;
        textState.info = '';
        var seq = ++textState.seq;

        Browser.readHead(item.src, MAX_TEXT_BYTES, function (err, bytes, total) {
            if (seq !== textState.seq) return;   // closed, or another file opened, while reading
            if (err) {
                if (typeof Debug !== 'undefined') Debug.warn('text read failed: ' + (err.message || err));
                pre.textContent = I18n.t('text.error', err.message || String(err));
                return;
            }
            var d = TextDecode.decode(bytes);
            if (d.binary) { pre.textContent = I18n.t('text.binary'); return; }
            var text = TextDecode.normalizeLineEndings(d.text);
            if (!/\S/.test(text)) { pre.textContent = I18n.t('text.empty'); return; }
            pre.classList.remove('muted');
            pre.textContent = text;
            var size = total || item.size || bytes.length;
            var info = [d.encoding, humanSize(size)];
            if (size > bytes.length)
                info.push(I18n.t('text.truncated', humanSize(bytes.length), humanSize(size)));
            textState.info = info.join('  ·  ');
            updateTextPos();
        });
    }

    var textState = { info: '', seq: 0 };

    function updateTextPos() {
        var body = $('text-body');
        var max = body.scrollHeight - body.clientHeight;
        var pct = max > 0 ? Math.round(body.scrollTop / max * 100) : 100;
        $('text-info').textContent = (textState.info ? textState.info + '  ·  ' : '') + pct + '%';
    }

    function scrollText(dy) {
        var body = $('text-body');
        body.scrollTop = Math.max(0, body.scrollTop + dy);
        updateTextPos();
    }
    function lineHeight() {
        var pre = $('text-pre');
        var lh = parseFloat(window.getComputedStyle(pre).lineHeight);
        return isNaN(lh) ? 36 : lh;
    }

    function textKeys(code) {
        var K = Remote.KEY;
        var body = $('text-body');
        var page = Math.max(lineHeight(), body.clientHeight - 2 * lineHeight());
        if (code >= K.ZERO && code <= K.NINE) {
            var max = body.scrollHeight - body.clientHeight;
            body.scrollTop = Math.round(max * (code - K.ZERO) / 10);
            updateTextPos();
            return true;
        }
        switch (code) {
            case K.UP:    scrollText(-3 * lineHeight()); return true;
            case K.DOWN:  scrollText(+3 * lineHeight()); return true;
            case K.LEFT:  case K.CH_UP:   scrollText(-page); return true;
            case K.RIGHT: case K.CH_DOWN: scrollText(+page); return true;
            case K.BACK:  textState.seq++; close(); return true;
        }
        return code !== K.EXIT;
    }

    return { openImage: openImage, openText: openText, close: close };
})();
