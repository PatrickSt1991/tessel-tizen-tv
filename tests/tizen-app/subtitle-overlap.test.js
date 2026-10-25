'use strict';

/* Overlapping ASS Dialogue lines used to clobber each other: the poller kept
 * only the first cue whose [start,end) held the playhead, so a \an8 location
 * sign sitting over the bottom dialogue meant the dialogue never showed.  The
 * fix paints every active cue, banded by alignment.  Player.parseAssCues is
 * the pure half of that (the poller/overlay half needs a DOM); here we assert
 * it keeps BOTH overlapping lines and tags each with the right band.
 *
 * parseAssCues reads the `AssStyle` global at call time, so it has to be in
 * place before player.js is required. */

var assert = require('assert');
var test = require('node:test');

global.AssStyle = require('../../tizen-app/js/ass-style.js');
var Player = require('../../tizen-app/js/player.js');

/* Two real overlapping lines from the reporter's file (Boku no Hero Academia
 * S5E21): a top \an8 sign and the bottom dialogue, live at the same time. */
var OVERLAP_ASS = [
    '[Script Info]',
    'ScriptType: v4.00+',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour,' +
        ' BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing,' +
        ' Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,' +
        '100,100,0,0,1,2,2,2,10,10,10,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:38.12,0:00:43.33,Default,,0,0,0,,{\\fnTahoma\\fs22\\an8}Детнерат{\\fn\\fs}',
    'Dialogue: 0,0:00:38.62,0:00:42.42,Default,,0,0,0,,' +
        '{\\fnTahoma\\fs22}Несколько лет они боролись\\Nс правительством и проиграли.{\\fn\\fs}'
].join('\n');

test('parseAssCues keeps both overlapping lines instead of dropping one', function () {
    var cues = Player.parseAssCues(OVERLAP_ASS);
    assert.strictEqual(cues.length, 2);

    // Their time ranges genuinely overlap (38.62–42.42 sits inside 38.12–43.33).
    var sign = cues.filter(function (c) { return /Детнерат/.test(c.text); })[0];
    var line = cues.filter(function (c) { return /Несколько/.test(c.text); })[0];
    assert.ok(sign && line, 'both cues present');
    assert.ok(sign.start < line.end && line.start < sign.end, 'ranges overlap');
});

test('the \\an8 sign is banded to the top, the dialogue left to the user setting', function () {
    var cues = Player.parseAssCues(OVERLAP_ASS);
    var sign = cues.filter(function (c) { return /Детнерат/.test(c.text); })[0];
    var line = cues.filter(function (c) { return /Несколько/.test(c.text); })[0];

    assert.strictEqual(sign.band, 'top');          // \an8 → top band
    assert.strictEqual(sign.halign, 'center');
    assert.strictEqual(line.band, null);           // plain bottom-default → user setting
    assert.strictEqual(line.halign, null);

    // The \N inside the dialogue is a hard line break, not literal text.
    assert.ok(/\n/.test(line.text), 'hard break preserved');
});

test('plain non-overlapping dialogue is unbanded, as before', function () {
    var cues = Player.parseAssCues([
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Just a line.'
    ].join('\n'));
    assert.strictEqual(cues.length, 1);
    assert.strictEqual(cues[0].band, null);
    assert.strictEqual(cues[0].text, 'Just a line.');
});
