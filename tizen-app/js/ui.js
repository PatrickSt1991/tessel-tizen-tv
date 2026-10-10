/* Focus management + view switching + toast.
 *
 * Focus model: every "focusable" widget has tabindex (or is a <button>/<input>);
 * we manage focus manually because TV WebKit's default focus + arrow-key nav is
 * unreliable.  Each view declares its focus order via DOM order of elements
 * matching the per-view selector. */

var UI = (function () {
    var currentView = null;
    var focusable = [];
    var focusIdx  = 0;

    var FOCUSABLE_SELECTOR =
        'button, input, [tabindex="0"], .tile, .ctrl, .preset, ' +
        '.browse-list li, .track-section li:not(.muted)';

    function showView(id) {
        var views = document.querySelectorAll('.view');
        for (var i = 0; i < views.length; i++) views[i].classList.add('hidden');
        var v = document.getElementById(id);
        if (!v) return;
        v.classList.remove('hidden');
        currentView = v;
        refreshFocusables();
        // A marked element that is hidden (the Recently Played tile with
        // the list switched off, issue #142) doesn't take the cursor.
        var marked = v.querySelectorAll('[data-focus]'), initial = null;
        for (var m = 0; m < marked.length && !initial; m++)
            if (!marked[m].classList.contains('hidden') && marked[m].offsetParent !== null) initial = marked[m];
        focusOn(initial || firstWidget());
    }

    /* The first focusable that isn't a text field.  A view that opened on
     * a field opened the on-screen keyboard with it on older firmware: the
     * playlist's filter field sits first in the browse view, so every
     * group of channels came up behind the keyboard (issue #126).  A view
     * that should start on a field says so with data-focus. */
    function firstWidget() {
        for (var i = 0; i < focusable.length; i++)
            if (focusable[i].tagName !== 'INPUT') return focusable[i];
        return null;
    }

    function refreshFocusables() {
        /* Scope focusables to whichever modal/overlay is currently visible,
         * falling back to currentView for the normal case.  Without this the
         * picker (#picker) and other body-level overlays would never appear
         * in the focusable list because currentView.querySelectorAll can't
         * reach them. */
        var picker    = document.getElementById('picker');
        var trackMenu = document.getElementById('track-menu');
        var errorOv   = document.getElementById('error-overlay');

        var scope = currentView;
        if (picker    && !picker.classList.contains('hidden'))    scope = picker;
        else if (errorOv   && !errorOv.classList.contains('hidden')) scope = errorOv;
        else if (trackMenu && !trackMenu.classList.contains('hidden')) scope = trackMenu;

        focusable = scope
            ? Array.prototype.slice.call(scope.querySelectorAll(FOCUSABLE_SELECTOR))
            : [];
        focusable = focusable.filter(function (el) {
            return !el.classList.contains('hidden') && el.offsetParent !== null;
        });
    }

    function focusOn(el) {
        if (!el) return;
        // Clear .focused from everywhere, not just current focusables, so the
        // class doesn't leak across overlays.
        var prev = document.querySelectorAll('.focused');
        for (var p = 0; p < prev.length; p++) prev[p].classList.remove('focused');

        el.classList.add('focused');
        // Leaving a text field takes the on-screen keyboard down with it.  A
        // list row can't hold DOM focus itself, so without this the field
        // kept it (and the keyboard) while the cursor was visibly on a row,
        // and OK went to the keyboard instead of the row (issue #126).
        var active = document.activeElement;
        if (active && active !== el && active.tagName === 'INPUT') {
            try { active.blur(); } catch (e) {}
        }
        el.focus({ preventScroll: false });
        focusIdx = focusable.indexOf(el);
        if (focusIdx < 0) focusIdx = 0;

        // Generic "scroll into view" so settings rows / picker items / browse
        // list entries / etc. always stay visible when navigated to.
        try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
    }

    /* Geometric next-element search by direction.  Returns true if focus
     * moved geometrically, false otherwise.
     *
     * A candidate has to lie wholly past the focused element's edge, not just
     * have its centre past it: a full-width field sits "left of" a button
     * below it by centre, which made Left jump from the URL field down to
     * Play (issue #115).  Among those, one that shares a row (Left/Right) or
     * column (Up/Down) with the focused element beats one that doesn't.
     *
     * At an edge, a plain list or row wraps round (last entry → first); a
     * grid, like the URL screen's buttons and chips, stops there.
     * When `noWrap` is set, returns false without touching focus instead —
     * useful for callers that want to scroll a container instead. */
    var EDGE_SLACK = 8;   // px two neighbours' borders/shadows may overlap by

    function moveFocus(dir, noWrap) {
        refreshFocusables();
        if (!focusable.length) return false;
        var current = document.querySelector('.focused') || focusable[focusIdx] || focusable[0];
        var cr = current.getBoundingClientRect();
        var vertical = dir === 'up' || dir === 'down';

        // Distance from the focused element's edge in `d`'s direction to the
        // near edge of r; negative when r isn't past it.
        function gapTowards(d, r) {
            switch (d) {
                case 'up':    return cr.top - r.bottom;
                case 'down':  return r.top - cr.bottom;
                case 'left':  return cr.left - r.right;
                default:      return r.left - cr.right;
            }
        }
        // How far r sits off the focused element's row/column: 0 when they
        // overlap across the direction of travel.
        function offAxis(r) {
            return vertical
                ? Math.max(0, r.left - cr.right, cr.left - r.right)
                : Math.max(0, r.top - cr.bottom, cr.top - r.bottom);
        }
        function centreOffset(r) {
            return vertical
                ? Math.abs((r.left + r.right) / 2 - (cr.left + cr.right) / 2)
                : Math.abs((r.top + r.bottom) / 2 - (cr.top + cr.bottom) / 2);
        }

        var best = null, bestScore = Infinity;
        for (var i = 0; i < focusable.length; i++) {
            var el = focusable[i]; if (el === current) continue;
            var r = el.getBoundingClientRect();
            var gap = gapTowards(dir, r);
            if (gap < -EDGE_SLACK) continue;
            var off = offAxis(r);
            var score = (off > 0 ? 1e6 : 0) + Math.max(0, gap) + off * 2 + centreOffset(r) * 0.5;
            if (score < bestScore) { bestScore = score; best = el; }
        }

        if (best) { focusOn(best); return true; }
        if (noWrap) return false;

        // Wrap to the far end, but only in a plain list or row: every element
        // has to straddle the focused one's centre line.  (Overlapping isn't
        // enough — everything overlaps a full-width field.)
        var back = { up: 'down', down: 'up', left: 'right', right: 'left' }[dir];
        var mid = vertical ? (cr.left + cr.right) / 2 : (cr.top + cr.bottom) / 2;
        var wrap = null, wrapGap = -Infinity;
        for (var j = 0; j < focusable.length; j++) {
            var w = focusable[j]; if (w === current) continue;
            var wr = w.getBoundingClientRect();
            if (vertical ? (wr.left > mid || wr.right < mid) : (wr.top > mid || wr.bottom < mid)) return false;
            var g = gapTowards(back, wr);
            if (g > wrapGap) { wrapGap = g; wrap = w; }
        }
        if (wrap) focusOn(wrap);
        return false;
    }

    function activateFocused() {
        /* Look anywhere — picker / track menu / error overlay live outside
         * the current view but still own focus when visible. */
        var el = document.querySelector('.focused');
        if (!el) return false;
        if (el.tagName === 'INPUT') return false;
        el.click();
        return true;
    }

    /* Move focus to the previous/next focusable in DOM order, cycling.
     * Used by the player OSD: Up/Down should walk through the row of round
     * controls regardless of geometry (they're side-by-side, so moveFocus()'s
     * directional search wouldn't find them on Up/Down). */
    function moveFocusCyclic(delta) {
        refreshFocusables();
        if (!focusable.length) return;
        var current = document.querySelector('.focused') ||
                      focusable[focusIdx] || focusable[0];
        var i = focusable.indexOf(current);
        if (i < 0) i = 0;
        var next = focusable[(i + delta + focusable.length) % focusable.length];
        focusOn(next);
    }

    /* Toast: brief on-screen message. */
    var toastTimer = null;
    function toast(msg) {
        var t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2000);
    }

    return {
        showView:          showView,
        focusOn:           focusOn,
        moveFocus:         moveFocus,
        moveFocusCyclic:   moveFocusCyclic,
        activateFocused:   activateFocused,
        refreshFocusables: refreshFocusables,
        toast:             toast,
        get currentView() { return currentView; }
    };
})();
