// ComfyUI MiniMax H3 Director — timeline editor.
//
// This file is a MODIFIED version of the LTX Director timeline editor by WhatDreamsCost
// (https://github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI), by way of the CS fork by
// CGlide. It has been changed to drive MiniMax H3: storyboard prompt compilation, the
// fl2va/ref2va mode switch, the reference-video track, Retake Mode and the live
// compiled-prompt panel.
//
// Licensed under the GNU General Public License v3.0, inherited from the original.
// See LICENSE in the repository root.

const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

// Verbose tracing, off by default so the browser console stays readable.
// Run `window.MMXD_DEBUG = true` in the console (F12) and reload the workflow to get the
// timeline JSON dumped on create / sync / save / configure — that is what to attach to a
// bug report about a timeline that does not come back the way it was saved.
const mmxdLog = (...a) => { if (window.MMXD_DEBUG) console.log(...a); };

// --- UI Constants & Configuration ---
const RULER_HEIGHT = 24;
const BLOCK_HEIGHT = 160; // Increased to make the image timeline area much taller
const AUDIO_TRACK_HEIGHT = 80;
const MOTION_TRACK_HEIGHT = 80; // used as the Reference Video track height
const CANVAS_HEIGHT = RULER_HEIGHT + BLOCK_HEIGHT + MOTION_TRACK_HEIGHT + AUDIO_TRACK_HEIGHT;
const HANDLE_HIT_PX = 14;
const MIN_SEGMENT_LENGTH = 6;
// The overall_soundscape / non_diegetic_music / summary strip sits *beside* the global
// prompt box as a flex sibling, not inside it. It used to be absolutely positioned on top
// of the textarea, with the textarea shortened by a hard-coded calc() to make room — so
// the two fought over the same space and the strip sat on the box's own border. As a flex
// child the panel divides itself, and these constants only have to reserve node height.
// The 12px of bottom padding clears the panel's absolutely-positioned drag strip.
const SOUND_ROW_HEIGHT = 66;   // 50px of field + 4 top + 12 bottom to clear the resizer
const GLOBAL_PROMPT_MIN_H = 60;                                    // the prompt box alone
const GLOBAL_PROP_MIN_H = GLOBAL_PROMPT_MIN_H + SOUND_ROW_HEIGHT;  // prompt box + strip
// The per-reference "describes / retained" strip in the segment properties panel, built
// the same way. Hiding it with display:none gives the prompt box its height straight back.
const REF_NOTE_ROW_HEIGHT = 66;
// start / frames / size for a reference video. Reference frames are VAE-encoded whole and
// their latents ride through every sampling step, so a long or large clip is the usual
// cause of an out-of-memory render — and until now the only way to shorten one was to drag
// its edge on the track, with nothing anywhere saying what it currently was.
const REF_LIMITS_ROW_HEIGHT = 30;
const REF_VIDEO_SIZES = [768, 640, 512, 384, 256];   // mirrors minimax_plan.REF_VIDEO_SIZES
const PROP_MIN_H = 90;                                             // prompt box alone
const MAX_THUMBNAIL_DIM = 512; // Increased to maintain quality for taller images

const HIDDEN_WIDGET_NAMES = ["timeline_data", "local_prompts", "segment_lengths", "guide_strength", "audio_data", "use_custom_audio", "inpaint_audio", "use_custom_motion", "override_audio"];

// The Analyze API key is kept in ComfyUI's own user settings and deliberately NOT in
// `timeline_data`: that widget is serialised into the workflow JSON, so a key stored
// there would travel with every workflow the user shares, and with every screenshot of
// the properties panel (issue #15). Settings live in user/<name>/comfy.settings.json and
// stay on the machine that typed them.
const ANALYZE_KEY_SETTING = "MiniMaxH3.Analyze.ApiKey";

function getAnalyzeApiKey() {
  try {
    return app.extensionManager?.setting?.get(ANALYZE_KEY_SETTING) || "";
  } catch (e) {
    mmxdLog("could not read the Analyze API key setting:", e);
    return "";
  }
}

async function setAnalyzeApiKey(value) {
  try {
    await app.extensionManager?.setting?.set(ANALYZE_KEY_SETTING, value || "");
    return true;
  } catch (e) {
    console.warn("[MiniMaxH3] could not save the Analyze API key:", e);
    return false;
  }
}

function hideWidget(w) {
  if (!w) return;

  w.hidden = true;
  if (!w.options) w.options = {};
  w.options.hidden = true;

  // Use computeSize and draw overrides to safely collapse in LiteGraph 
  // without triggering ComfyUI's "convert to input slot" auto-behavior.
  if (!window.LiteGraph || !window.LiteGraph.vueNodesMode) {
    w.computeSize = () => [0, -4]; // -4 cancels out ComfyUI's hardcoded 4px widget padding
    if (!w._hiddenDrawHooked) {
      w._origDraw = w.hasOwnProperty('draw') ? w.draw : undefined;
      w._hiddenDrawHooked = true;
    }
    w.draw = () => { };
  }

  if (w.element) w.element.style.display = "none";
  if (w.callback) w.callback(w.value);
}

// A hidden widget keeps its input slot, and a slot whose widget is never laid out is not
// drawn anywhere: LiteGraph leaves it sitting at the node's own origin, so the settings
// panel left five invisible sockets stacked under the title bar, where a dropped link
// could still land on one (issue #14). Drop the slot when nothing is wired to it — a link
// saved in an older workflow keeps its socket, and the settings panel keeps ownership of
// the value either way. Width and height have proper connection-only inputs now.
function dropUnlinkedWidgetInput(node, name) {
  if (window.LiteGraph && window.LiteGraph.vueNodesMode) return;   // Vue hides both already
  if (!node || !node.inputs) return;
  const i = node.inputs.findIndex(sl => sl.name === name && sl.widget);
  if (i !== -1 && node.inputs[i].link == null) node.removeInput(i);
}

function showWidget(w) {
  if (!w) return;

  w.hidden = false;
  if (w.options) w.options.hidden = false;

  if (!window.LiteGraph || !window.LiteGraph.vueNodesMode) {
    delete w.computeSize;
    if (w._hiddenDrawHooked) {
      if (w._origDraw !== undefined) {
        w.draw = w._origDraw;
      } else {
        delete w.draw;
      }
      delete w._hiddenDrawHooked;
    }
  }

  if (w.element) w.element.style.display = "";
  if (w.callback) w.callback(w.value);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// --- Modern Dark/Grey UI CSS (ComfyUI Match) ---
const STYLES = `
  .mmxd-wrapper {
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    padding-bottom: 4px;
  }
  .mmxd-wrapper.drag-active {
    outline: 2px dashed #888;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 6px;
  }
  .mmxd-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 2px 0px;
    flex-wrap: wrap;
    gap: 6px;
  }
  .mmxd-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .mmxd-btn {
    background: #222;
    color: #e0e0e0;
    border: 1px solid #111;
    border-radius: 4px;
    padding: 6px 12px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: all 0.2s ease;
  }
  .mmxd-btn:hover:not(:disabled) {
    background: #333;
    border-color: #555;
  }
  .mmxd-btn.toggle-on {
    background: #1c222d;
    border-color: #283142;
    color: #e0e0e0;
  }
  .mmxd-btn.toggle-on:hover:not(:disabled) {
    background: #2a3445;
    border-color: #3b4b66;
  }
  .mmxd-btn-danger:hover:not(:disabled) {
    background: #4a1515;
    border-color: #cc4444;
    color: #ffaaaa;
  }
  .mmxd-canvas {
    background: #2a2a2a;
    cursor: pointer;
    width: 100%;
    outline: none;
    display: block; /* Ensure no inline baseline gaps */
  }
  .mmxd-prop-container {
    display: flex;
    flex-direction: column;
    width: 100%;
    flex-grow: 1; /* Automatically scales to fill node height */
    min-height: 40px;
  }
  .mmxd-prompt-wrapper {
    position: relative;
    width: 100%;
    height: 100%;
    background: #222;
    border: 1px solid #111;
    border-radius: 6px;
    box-sizing: border-box;
    transition: border-color 0.2s ease, opacity 0.2s ease;
    overflow: hidden;
  }
  .mmxd-prompt-wrapper.focus-active {
    border-color: #888;
  }
  .mmxd-wrapper.has-focus .mmxd-prompt-wrapper:not(.focus-active),
  .mmxd-wrapper:has(.mmxd-prompt-wrapper.focus-active) .mmxd-prompt-wrapper:not(.focus-active) {
    opacity: 0.65;
  }
  .mmxd-prompt-label {
    position: absolute;
    top: 5px;
    left: 8px;
    font-size: 9px;
    font-weight: bold;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    pointer-events: none;
    user-select: none;
    z-index: 5;
  }
  .mmxd-prompt-area {
    position: absolute;
    top: 20px;
    left: 0;
    width: 100%;
    height: calc(100% - 20px);
    background: transparent;
    color: #e0e0e0;
    border: none;
    padding: 0 8px 8px 8px;
    resize: none; /* Removed the manual resize corner handle */
    font-size: 12px;
    line-height: 1.4;
    box-sizing: border-box;
    outline: none;
  }
  .mmxd-prompt-area:focus {
    border-color: #888;
  }
  .mmxd-motion-info {
    width: 100%;
    height: 100%;
    background: #181818;
    color: #aaa;
    border: 1px solid #111;
    border-radius: 6px;
    padding: 10px;
    font-size: 12px;
    line-height: 1.6;
    box-sizing: border-box;
    display: none;
  }
  .mmxd-motion-info span { color: #fff; font-weight: 500; }
  .mmxd-audio-info {
    width: 100%;
    height: 100%;
    background: #181818;
    color: #aaa;
    border: 1px solid #111;
    border-radius: 6px;
    padding: 10px;
    font-size: 12px;
    line-height: 1.6;
    box-sizing: border-box;
    display: none;
  }
  .mmxd-audio-info span { color: #fff; font-weight: 500; }
  .mmxd-audio-subject-label { display: inline-flex; align-items: center; gap: 6px; margin-top: 6px; color: #aaa; }
  .mmxd-audio-subject { background: #2a2a2a; color: #e6e6e6; border: 1px solid #444; border-radius: 4px; height: 22px; padding: 0 4px; font-size: 11px; font-family: inherit; cursor: pointer; outline: none; max-width: 260px; }
  .mmxd-audio-subject:hover { background: #343434; border-color: #666; }
  /* a clip parked past the render window: still a reference, so this states a fact rather
     than warning about one */
  .mmxd-ref-only { margin-top: 6px; color: #8fb8d8; font-style: italic; }
  .mmxd-controls-group {
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 6px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 4px;
    box-sizing: border-box;
    width: 100%;
  }
  .mmxd-strength-row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    box-sizing: border-box;
  }
  .mmxd-height-resizer {
    height: 6px;
    background: #2a2a2a;
    cursor: ns-resize;
    border-radius: 3px;
    margin: 2px 0;
    transition: background 0.15s;
    border: 1px solid #1e1e1e;
  }
  .mmxd-height-resizer:hover {
    background: #444;
    border-color: #555;
  }
  .mmxd-strength-label {
    font-size: 11px;
    font-weight: 600;
    color: #fff;
    white-space: nowrap;
    margin-left: auto;
    user-select: none;
    -webkit-user-select: none;
  }
  .mmxd-strength-slider {
    -webkit-appearance: none;
    appearance: none;
    width: 80px;
    height: 4px;
    background: #444;
    border-radius: 2px;
    outline: none;
    cursor: pointer;
    border: 1px solid #222;
  }
  .mmxd-strength-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #aaa;
    cursor: pointer;
  }
  .mmxd-strength-slider:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }
  .mmxd-strength-input {
    font-size: 12px;
    color: #fff;
    background: #222;
    border: 1px solid #444;
    border-radius: 4px;
    width: 52px;
    text-align: center;
    padding: 3px;
    user-select: none;
    -webkit-user-select: none;
  }
  .mmxd-strength-input::-webkit-outer-spin-button,
  .mmxd-strength-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .mmxd-strength-input[type=number] {
    -moz-appearance: textfield;
  }
  .mmxd-strength-input:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .mmxd-gap-menu {
    position: fixed;
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 6px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    z-index: 9999;
    box-shadow: 0 4px 16px rgba(0,0,0,0.6);
  }
  .mmxd-gap-menu-btn {
    background: #2a2a2a;
    color: #e0e0e0;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 6px 14px;
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: background 0.15s ease;
  }
  .mmxd-gap-menu-btn:hover {
    background: #3a3a3a;
    border-color: #666;
  }
  .mmxd-player-controls {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 12px;
    padding: 2px 0;
    flex-wrap: wrap;
    width: 100%;
  }
  .mmxd-icon-btn {
    background: #2a2a2a;
    border: 1px solid #444;
    color: #eee;
    cursor: pointer;
    padding: 6px 12px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }
  .mmxd-icon-btn * {
    pointer-events: none;
  }
  .mmxd-icon-btn:hover {
    color: #fff;
    background: #3a3a3a;
    border-color: #666;
  }
  .mmxd-icon-btn.active {
    color: #4fff8f;
    border-color: #4fff8f;
    background: #1a3a2a;
  }
  .mmxd-seek-bar {
    -webkit-appearance: none;
    appearance: none;
    height: 6px;
    background: #444;
    border-radius: 3px;
    outline: none;
    cursor: pointer;
    border: 1px solid #222;
  }
  .mmxd-seek-bar::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #ff4444;
    cursor: pointer;
    border: 2px solid #222;
  }
  .mmxd-timeline-viewport {
    width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 10px;
    box-sizing: content-box;
  }
  .mmxd-timeline-viewport::-webkit-scrollbar {
    height: 10px;
  }
  .mmxd-timeline-viewport::-webkit-scrollbar-track {
    background: #151515;
    border-radius: 5px;
  }
  .mmxd-timeline-viewport::-webkit-scrollbar-thumb {
    background: #444;
    border-radius: 5px;
    border: 1px solid #000;
  }
  .mmxd-timeline-viewport::-webkit-scrollbar-thumb:hover {
    background: #666;
    border-color: #000;
  }
  .mmxd-zoom-controls {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: 12px;
  }
  .mmxd-zoom-slider {
    width: 80px;
    -webkit-appearance: none;
    appearance: none;
    height: 4px;
    background: #444;
    border-radius: 2px;
    outline: none;
    cursor: pointer;
  }
  .mmxd-zoom-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #aaa;
    cursor: pointer;
  }
  .mmxd-right-group {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .mmxd-segment-bounds {
    font-size: 12px;
    color: #aaa;
    font-family: monospace;
    user-select: none;
    -webkit-user-select: none;
  }
  .mmxd-timecode {
    font-size: 14px;
    font-weight: bold;
    color: #e0e0e0;
    font-family: monospace;
    user-select: none;
    -webkit-user-select: none;
  }
  .mmxd-settings-menu {
    position: fixed;
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 6px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 9999;
    box-shadow: 0 4px 20px rgba(0,0,0,0.7);
    min-width: 250px;
    width: 560px;
    max-width: 92vw;
    max-height: 60vh;
    overflow-y: auto;
  }
  .mmxd-settings-title {
    font-size: 11px;
    font-weight: 600;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding-bottom: 4px;
    border-bottom: 1px solid #333;
    margin-bottom: 2px;
  }
  .mmxd-settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .mmxd-settings-label {
    font-size: 12px;
    color: #bbb;
    flex: 1;
    white-space: nowrap;
  }
  .mmxd-number-control {
    display: flex;
    align-items: center;
    border: 1px solid #444;
    border-radius: 4px;
    background: #2a2a2a;
    overflow: hidden;
  }
  .mmxd-number-btn {
    background: #333;
    color: #aaa;
    border: none;
    width: 20px;
    height: 22px;
    cursor: pointer;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s;
    user-select: none;
  }
  .mmxd-number-btn:hover {
    background: #444;
    color: #fff;
  }
  .mmxd-settings-input {
    background: transparent;
    color: #e0e0e0;
    border: none;
    padding: 0 4px;
    font-size: 12px;
    width: 50px;
    height: 22px;
    text-align: center;
    font-family: monospace;
    outline: none;
    -moz-appearance: textfield;
  }
  .mmxd-settings-input::-webkit-outer-spin-button,
  .mmxd-settings-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .mmxd-settings-select {
    background: #2a2a2a;
    color: #e0e0e0;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 3px 4px;
    font-size: 12px;
    width: 98px;
    cursor: pointer;
  }
  .mmxd-settings-divider {
    border: none;
    border-top: 1px solid #2a2a2a;
    margin: 2px 0;
  }
  .mmxd-settings-toggle-btn {
    width: 100%;
    box-sizing: border-box;
    margin: 0;
    background: #252525;
    color: #fff;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 5px 8px;
    font-size: 11px;
    cursor: pointer;
    text-align: center;
    transition: all 0.15s;
  }
  .mmxd-settings-toggle-btn:hover {
    background: #2e2e2e;
    color: #fff;
    border-color: #555;
  }
  .mmxd-settings-close-btn {
    background: transparent;
    color: #888;
    border: none;
    cursor: pointer;
    padding: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: all 0.15s;
  }
  .mmxd-settings-close-btn:hover {
    color: #fff;
    background: rgba(255,255,255,0.1);
  }
  .mmxd-segmented-control {
    display: flex;
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 2px;
    width: 110px;
    height: 25px;
    align-items: center;
    box-sizing: border-box;
  }
  .mmxd-segment {
    flex: 1;
    text-align: center;
    font-size: 10px;
    font-weight: 500;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    cursor: pointer;
    border-radius: 4px;
    color: #888;
    transition: all 0.15s ease;
  }
  .mmxd-segment.active {
    background: #333;
    color: #fff;
  }
  .mmxd-settings-divider {
    border-top: 1px solid #333;
    margin: 4px 0;
  }
  /* --- Subject reference slots --- */
  .mmxd-characters-container { display: flex; flex-wrap: wrap; justify-content: flex-start; gap: 12px; margin-top: 6px; margin-bottom: 4px; box-sizing: border-box; width: 100%; flex-shrink: 0; }
  /* grows to nine slots, so they wrap into rows of three rather than shrinking to slivers */
  /* height is set inline from the dragged panel size — deliberately not duplicated here */
  .mmxd-character-slot { flex: 1 1 calc(33.333% - 8px); min-width: 120px; background: #1e1e1e; border: 1.5px dashed #444; border-radius: 8px; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; padding: 4px; position: relative; cursor: pointer; overflow: hidden; transition: border-color 0.2s ease, background 0.2s ease; box-sizing: border-box; }
  .mmxd-character-slot:hover { border-color: #666; background: #252525; }
  .mmxd-character-slot.drag-over { border-color: #4fff8f; background: rgba(79, 255, 143, 0.05); }
  .mmxd-character-label { font-size: 10px; font-weight: bold; color: #888; margin-bottom: 2px; pointer-events: none; }
  .mmxd-character-placeholder { font-size: 9px; color: #666; text-align: center; pointer-events: none; margin-top: 10px; }
  /* the empty slot's drop target: takes the same slack the previews row takes, so the
     text boxes below it sit at the same height whether or not an image has been dropped */
  .mmxd-character-dropzone { display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; flex: 1 1 auto; min-height: 44px; pointer-events: none; }
  .mmxd-character-dropzone .mmxd-character-placeholder { margin-top: 4px; }
  /* the only part of a slot that flexes, so dragging the panel taller grows the images */
  .mmxd-character-previews-row { display: flex; width: 100%; flex: 1 1 auto; min-height: 44px; gap: 4px; position: relative; }
  .mmxd-character-preview-wrapper { flex: 1; height: 100%; position: relative; overflow: hidden; border-radius: 3px; background: #111; }
  .mmxd-character-preview { width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
  .mmxd-character-delete { position: absolute; top: 2px; right: 2px; background: rgba(0, 0, 0, 0.85); color: #ff4444; border: none; border-radius: 50%; width: 14px; height: 14px; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 9px; transition: background 0.15s; z-index: 10; padding: 0; }
  .mmxd-character-delete:hover { background: #ff4444; color: #fff; }
  .mmxd-character-validate-btn { position: absolute; bottom: -8px; left: 50%; transform: translateX(-50%); background: rgba(0, 0, 0, 0.85); color: #e0e0e0; border: 1px solid #444; border-radius: 3px; padding: 2px 8px; font-size: 9px; font-weight: bold; cursor: pointer; transition: all 0.15s; z-index: 20; }
  .mmxd-character-validate-btn:hover { background: #4fff8f; color: #000; border-color: #4fff8f; }
  .mmxd-character-validate-btn.loading { background: #333; color: #888; cursor: wait; pointer-events: none; }
  /* Two captioned boxes per slot: what the subject IS, and what has to survive into the
     target video. Both are fixed height so the previews row above them takes the slack. */
  .mmxd-character-field { position: relative; width: 100%; flex: 0 0 32px; margin-top: 6px; background: #111; border: 1px solid #333; border-radius: 4px; box-sizing: border-box; z-index: 10; }
  .mmxd-character-field.mmxd-field-first { margin-top: 10px; }
  .mmxd-character-field.focus-active { border-color: #4fff8f; }
  .mmxd-character-field-label { position: absolute; top: 2px; left: 5px; font-size: 8px; font-weight: bold; color: #5a5a5a; text-transform: uppercase; letter-spacing: 0.5px; pointer-events: none; user-select: none; z-index: 5; }
  .mmxd-character-desc { position: absolute; top: 12px; left: 0; width: 100%; height: calc(100% - 12px); background: transparent; color: #e0e0e0; border: none; font-size: 9px; line-height: 1.3; resize: none; box-sizing: border-box; padding: 0 4px 2px 4px; outline: none; font-family: inherit; }
  .mmxd-character-desc::placeholder { color: #4a4a4a; }
  /* --- per-reference kind / retention controls --- */
  .mmxd-ref-controls { display: flex; gap: 4px; width: 100%; margin-top: 4px; box-sizing: border-box; }
  .mmxd-ref-controls .mmxd-msel { flex: 1 1 0; min-width: 0; height: 20px; font-size: 9px; padding: 0 4px 0 6px; }
  .mmxd-ref-controls .mmxd-msel-caret svg { width: 8px; height: 8px; }
  /* the subject's own voice clip: one 18px row, the previews row gives the pixels up */
  .mmxd-voice-row { display: flex; align-items: center; gap: 4px; width: 100%; height: 18px; flex: 0 0 18px; margin-top: 4px; box-sizing: border-box; position: relative; z-index: 10; }
  .mmxd-voice-add { flex: 1 1 auto; height: 18px; background: #111; color: #9a9a9a; border: 1px dashed #444; border-radius: 4px; font-size: 9px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px; padding: 0 4px; }
  .mmxd-voice-add:hover { color: #4fff8f; border-color: #4fff8f; }
  .mmxd-voice-name { flex: 1 1 auto; min-width: 0; height: 18px; line-height: 18px; background: #111; color: #4fff8f; border: 1px solid #2f5f43; border-radius: 4px; font-size: 9px; padding: 0 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; box-sizing: border-box; }
  .mmxd-voice-del { flex: 0 0 18px; width: 18px; height: 18px; background: #111; color: #ff4444; border: 1px solid #333; border-radius: 4px; display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; }
  .mmxd-voice-del:hover { background: #ff4444; color: #fff; }
  /* --- @refN autocomplete popup --- */
  .mmxd-autocomplete-menu { position: fixed; background: #181818; border: 1px solid #444; border-radius: 6px; padding: 4px; display: flex; flex-direction: column; gap: 2px; z-index: 100000; box-shadow: 0 4px 16px rgba(0,0,0,0.6); min-width: 180px; max-height: 200px; overflow-y: auto; }
  .mmxd-autocomplete-item { background: #252525; color: #aaa; border: 1px solid #333; border-radius: 4px; padding: 6px 12px; font-size: 11px; font-family: monospace; cursor: pointer; text-align: left; display: flex; align-items: center; justify-content: space-between; transition: all 0.15s ease; }
  .mmxd-autocomplete-item:hover, .mmxd-autocomplete-item.active { background: #1c222d; color: #4fff8f; border-color: #4fff8f; }
  .mmxd-autocomplete-item span { font-weight: bold; font-size: 12px; }
  .mmxd-autocomplete-item small { color: #777; font-size: 10px; }
  .mmxd-autocomplete-item.active small { color: #4fff8f; opacity: 0.8; }
  /* --- Custom menu-style dropdowns (ref mode / resolution / fps / units / resize) --- */
  .mmxd-msel { display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box; background: #2a2a2a; color: #e6e6e6; border: 1px solid #444; border-radius: 4px; height: 24px; padding: 0 6px 0 8px; font-size: 11px; font-family: inherit; cursor: pointer; outline: none; user-select: none; transition: background 0.15s ease, border-color 0.15s ease; }
  .mmxd-msel:hover, .mmxd-msel.mmxd-msel-open { background: #343434; border-color: #666; }
  .mmxd-msel:focus-visible { border-color: #6a6a6a; }
  .mmxd-msel-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mmxd-msel-caret { flex: 0 0 auto; display: inline-flex; color: #9a9a9a; }
  .mmxd-msel-caret svg { display: block; }
  .mmxd-msel-ic { display: inline-flex; align-items: center; }
  .mmxd-msel-menu { max-height: 60vh; overflow-y: auto; min-width: 120px; }
  /* group heading inside a menu-select — a label, not a row you can pick */
  .mmxd-msel-head { padding: 5px 8px 1px 8px; font-size: 9px; font-weight: 700; color: #6f6f6f; letter-spacing: 0.6px; text-transform: uppercase; white-space: nowrap; user-select: none; }
  .mmxd-gap-menu-btn.mmxd-msel-selected { background: #383838; border-color: #555; color: #fff; }
  /* --- Ref-mode toolbar dropdown: green-accent modifier on the menu trigger --- */
  .mmxd-ref-option-select { background: #1e1e1e; border-color: #3a3a3a; border-radius: 6px; height: 28px; font-weight: 500; }
  .mmxd-ref-option-select:hover, .mmxd-ref-option-select.mmxd-msel-open { background: #1e1e1e; border-color: #4fff8f; color: #fff; }
  .mmxd-ref-option-select .mmxd-msel-caret { color: #cfcfcf; }
  /* --- overall_soundscape / non_diegetic_music, docked under the global prompt --- */
  /* The wrapper positions its children absolutely, so this row sits at the bottom and
     the prompt area above it is shortened by exactly the same amount. Nothing here
     changes the node's height: the container keeps whatever the user resized it to. */
  /* A flex child of the properties panel, not an overlay inside the prompt box. It was
     absolutely positioned on top of the textarea, which meant the two fought over the
     same space: the box shrank by a hard-coded calc() and the strip sat on its border. */
  .mmxd-sound-row { flex: 0 0 66px; width: 100%; display: flex; gap: 6px; padding: 4px 0 12px 0; box-sizing: border-box; }
  /* same two-field shape as the sound strip, but a flex child of the properties panel
     rather than a strip docked inside the prompt box — see REF_NOTE_ROW_HEIGHT */
  .mmxd-ref-note-row { flex: 0 0 66px; width: 100%; display: flex; gap: 6px; padding: 4px 0 12px 0; box-sizing: border-box; }
  /* start / frames / size for a reference video — the memory levers, see REF_LIMITS_ROW_HEIGHT */
  .mmxd-ref-limits-row { flex: 0 0 30px; width: 100%; display: flex; align-items: center; gap: 10px; padding: 2px 0 4px 0; box-sizing: border-box; font-size: 10px; color: #8a8a8a; }
  .mmxd-ref-limits-row label { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .mmxd-ref-limits-row input { width: 58px; background: #111; color: #e0e0e0; border: 1px solid #333; border-radius: 3px; padding: 2px 4px; font-size: 10px; font-family: inherit; outline: none; box-sizing: border-box; }
  .mmxd-ref-limits-row input:focus { border-color: #4fff8f; }
  .mmxd-ref-limits-row .mmxd-msel { height: 20px; font-size: 10px; padding: 0 4px 0 6px; }
  .mmxd-ref-limits-note { margin-left: auto; color: #5a5a5a; }
  .mmxd-sound-field { position: relative; flex: 1 1 0; min-width: 0; background: #1c1c1c; border: 1px solid #111; border-radius: 4px; box-sizing: border-box; }
  .mmxd-sound-field.focus-active { border-color: #888; }
  .mmxd-sound-label { position: absolute; top: 3px; left: 6px; font-size: 8px; font-weight: bold; color: #5a5a5a; text-transform: uppercase; letter-spacing: 0.5px; pointer-events: none; user-select: none; z-index: 5; }
  .mmxd-sound-area { position: absolute; top: 14px; left: 0; width: 100%; height: calc(100% - 14px); background: transparent; color: #d0d0d0; border: none; padding: 0 6px 4px 6px; resize: none; font-size: 11px; line-height: 1.35; font-family: inherit; box-sizing: border-box; outline: none; }
  .mmxd-sound-area::placeholder { color: #4a4a4a; }
  /* --- subject-slot stepper: its own row above the slots, never inside their flow --- */
  .mmxd-character-stepper { display: flex; align-items: center; justify-content: flex-end; gap: 4px; height: 22px; margin-top: 6px; }
  .mmxd-character-step-btn { width: 22px; height: 22px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; background: #2a2a2a; color: #d0d0d0; border: 1px solid #444; border-radius: 4px; font-size: 14px; font-family: inherit; cursor: pointer; padding: 0; }
  .mmxd-character-step-btn:hover { background: #383838; border-color: #666; color: #fff; }
  .mmxd-character-step-count { font-size: 9px; color: #6a6a6a; text-transform: uppercase; letter-spacing: 0.5px; user-select: none; min-width: 56px; text-align: center; }
`;

let styleEl = document.getElementById("minimax-h3-director-styles");
if (!styleEl) {
  styleEl = document.createElement("style");
  styleEl.id = "minimax-h3-director-styles";
  document.head.appendChild(styleEl);
}
styleEl.textContent = STYLES;

// --- Custom menu-style dropdown (opens a mmxd-gap-menu; mimics <select> API) ---
function createMenuSelect(options, opts) {
  opts = opts || {};
  const el = document.createElement("div");
  el.className = "mmxd-msel";
  el.tabIndex = 0;
  if (opts.width) el.style.width = opts.width;
  const labEl = document.createElement("span");
  labEl.className = "mmxd-msel-label";
  const carEl = document.createElement("span");
  carEl.className = "mmxd-msel-caret";
  carEl.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
  el.appendChild(labEl);
  el.appendChild(carEl);

  let optList = options.slice();
  let current = optList.length ? optList[0].value : "";
  const optByVal = (v) => optList.find((o) => String(o.value) === String(v));
  const renderLabel = () => { const o = optByVal(current); labEl.textContent = o ? o.label : (opts.placeholder || ""); };

  let menuEl = null;
  const closeMenu = () => {
    if (!menuEl) return;
    menuEl.remove(); menuEl = null;
    el.classList.remove("mmxd-msel-open");
    document.removeEventListener("mousedown", onDocDown, true);
    window.removeEventListener("resize", closeMenu, true);
    window.removeEventListener("wheel", onWheel, true);
  };
  const onDocDown = (e) => { if (menuEl && !menuEl.contains(e.target) && !el.contains(e.target)) closeMenu(); };
  const onWheel = (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); };
  const openMenu = () => {
    if (menuEl) { closeMenu(); return; }
    menuEl = document.createElement("div");
    menuEl.className = "mmxd-gap-menu mmxd-msel-menu";
    optList.forEach((o) => {
      if (o.header) {
        const h = document.createElement("div");
        h.className = "mmxd-msel-head";
        h.textContent = o.label;
        menuEl.appendChild(h);
        return;
      }
      const b = document.createElement("button");
      b.className = "mmxd-gap-menu-btn";
      if (String(o.value) === String(current)) b.classList.add("mmxd-msel-selected");
      if (o.icon) { const ic = document.createElement("span"); ic.className = "mmxd-msel-ic"; ic.innerHTML = o.icon; b.appendChild(ic); }
      const t = document.createElement("span"); t.textContent = o.label; b.appendChild(t);
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const changed = String(current) !== String(o.value);
        current = o.value; renderLabel(); closeMenu();
        if (changed) el.dispatchEvent(new Event("change"));
      });
      menuEl.appendChild(b);
    });
    document.body.appendChild(menuEl);
    el.classList.add("mmxd-msel-open");
    const r = el.getBoundingClientRect();
    menuEl.style.position = "fixed";
    menuEl.style.minWidth = Math.max(r.width, 120) + "px";
    const mw = menuEl.offsetWidth;
    let left = r.left;
    if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - mw);
    menuEl.style.left = left + "px";
    const mh = menuEl.offsetHeight;
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - 4 - mh);
    menuEl.style.top = top + "px";
    setTimeout(() => {
      document.addEventListener("mousedown", onDocDown, true);
      window.addEventListener("resize", closeMenu, true);
      window.addEventListener("wheel", onWheel, true);
    }, 0);
  };
  el.addEventListener("click", (e) => { e.stopPropagation(); openMenu(); });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openMenu(); }
    else if (e.key === "Escape") closeMenu();
  });

  Object.defineProperty(el, "value", {
    configurable: true,
    get() { return current; },
    set(v) { current = v; renderLabel(); },
  });
  el.setMenuOptions = (newOpts) => { optList = newOpts.slice(); if (!optByVal(current) && optList.length) current = optList[0].value; renderLabel(); };

  renderLabel();
  return el;
}


// --- Full-reference vocabulary ------------------------------------------------------
// Mirrors minimax_plan.py, which mirrors the H3 reference guide
// (skills/h3-prompt-writing/references/ref-en.txt). The retention markers are shown by
// their own names rather than friendlier ones: the guide calls them "fixed English values
// in the output format", they are written into the prompt verbatim, and a prettier label
// would hide which of them you actually picked.
const MAX_SUBJECT_SLOTS = 9;

const SUBJECT_KIND_OPTIONS = [
  { value: "person", label: "person" },
  { value: "animal", label: "animal" },
  { value: "object", label: "object" },
  { value: "environment", label: "environment" },
  { value: "clothing", label: "clothing" },
  { value: "prop", label: "prop" },
  { value: "interface", label: "interface" },
  { value: "effect", label: "visual effect" },
  { value: "style", label: "style" },
  { value: "action", label: "action" },
  { value: "expression", label: "expression" },
  { value: "pose", label: "pose" },
];

const RETENTION_OPTIONS = [
  { value: "fully_preserved", label: "fully_preserved" },
  { value: "partially_preserved", label: "partially_preserved" },
  { value: "attribute_transfer", label: "attribute_transfer" },
  { value: "weak_reference", label: "weak_reference" },
];

const RETENTION_AUDIO_OPTIONS = [
  { value: "reference", label: "reference" },
  { value: "fully_copy", label: "fully_copy" },
  { value: "partially_copy", label: "partially_copy" },
  { value: "weak_reference", label: "weak_reference" },
  { value: "lock", label: "lock (exact audio)" },
];

// Refs OFF has no <Audio N> labels, so the guide's markers have nothing to attach to; the one
// thing a clip can still do there is be locked into the audio stream.
const AUDIO_LOCK_OPTIONS = [
  { value: "reference", label: "mixdown only" },
  { value: "lock", label: "lock (exact audio)" },
];

const REF_ROLE_OPTIONS = [
  // First is the fallback an unset segment reads as, so it stays the notation a timeline
  // saved before anchoring existed was written against.
  { value: "picture", label: "reference frame" },
  { value: "auto", label: "frame anchor" },
  { value: "storyboard", label: "storyboard" },
  { value: "subject", label: "defines a subject" },
];

// The reference tracks answer a narrower question: a clip is either shown to the model or
// part of the video it is asked to make.
const CLIP_ROLE_OPTIONS = [
  { value: "reference", label: "reference" },
  { value: "auto", label: "frame anchor" },
];

const CLIP_ROLE_TIP =
  "What this clip is for:\n" +
  "reference — the model is shown it, and it never appears in the video\n" +
  "frame anchor — it IS part of the video, at the moment it sits on the timeline";

const RETENTION_TIP =
  "How closely the model follows this reference (guide 4.1):\n" +
  "fully_preserved — keep it as defined\n" +
  "partially_preserved — keep it, but some defined traits change\n" +
  "attribute_transfer — move its traits onto a different subject\n" +
  "weak_reference — broad similarity only";

const RETENTION_AUDIO_TIP =
  "How the reference audio is used (guide 4.2):\n" +
  "reference — follow its timbre or style, do not copy the signal\n" +
  "fully_copy — reuse it as the complete final audio track\n" +
  "partially_copy — copy part of it, add or replace the rest\n" +
  "weak_reference — broad similarity in category or atmosphere only" + "\n" +
  "lock (exact audio) — not a guide marker: the clip goes into the audio stream itself and the video is generated around it. Needs the audio VAE; no <Audio N> label is written for it." + "\n" +
  "Only fully_copy, partially_copy and lock make the generated audio follow the clip; reference keeps the voice or style and invents the rest.";

const AUDIO_LOCK_TIP =
  "mixdown only — the clip is only on combined_audio (wire that into CreateVideo to hear it)" + "\n" +
  "lock (exact audio) — the clip is put into the audio stream and held there, so the video is generated around it. Needs the audio VAE; gaps between locked clips are generated.";

const REF_ROLE_TIP =
  "What this image is for (guide 2.2):\n" +
  "reference frame — it is DESCRIBED as a first/last frame or keyframe of its shot\n" +
  "frame anchor — it IS that frame, and is sent as one at the moment it sits on\n" +
  "storyboard — it plans the shot's viewpoint and staging\n" +
  "defines a subject — it only defines a look, so it gets no <Picture> entry";

// Slots wrap three to a row; the node has to reserve the rows or it crops the last one.
// The slot height is the user's, dragged from the strip under the panel — the previews
// row is the only part that flexes, so every pixel gained goes to the images rather than
// to the text boxes. Unlike SOUND_ROW_HEIGHT there is no matching CSS literal to keep in
// step: the height is set inline per slot, precisely so there is only one of it.
// 8 padding + 44 previews + 42 first field + 38 second field + 24 controls + 22 voice
const SUBJECT_SLOT_MIN_H = 182;
const SUBJECT_SLOT_DEFAULT_H = 237;
const SUBJECT_SLOT_GAP = 12;
const SUBJECT_RESIZER_H = 12;
const SUBJECT_STEPPER_H = 26;   // the 22px buttons and the gap under them
function subjectPanelHeight(slotCount, slotHeight) {
  const rows = Math.max(1, Math.ceil(slotCount / 3));
  const h = Math.max(SUBJECT_SLOT_MIN_H, slotHeight || SUBJECT_SLOT_DEFAULT_H);
  return rows * h + (rows - 1) * SUBJECT_SLOT_GAP + 20 + SUBJECT_RESIZER_H
    + SUBJECT_STEPPER_H;
}

// The properties panel builds its rows with innerHTML, so text the user typed has to be
// neutralised on the way in: a description holding a `<` took the row's markup with it.
function escapeAttr(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const SUBJECT_SLOTS_DEFAULT = 3;
function clampSubjectSlots(n) {
  const v = parseInt(n, 10);
  return Math.max(1, Math.min(MAX_SUBJECT_SLOTS, v > 0 ? v : SUBJECT_SLOTS_DEFAULT));
}

// A voice clip rides on the subject, not on the timeline (issue #10). Only the file name
// and what to call it are stored; the audio itself sits in ComfyUI's input folder.
function normaliseVoice(v) {
  if (!v || typeof v !== "object" || !v.audioFile) return null;
  return { audioFile: String(v.audioFile), fileName: String(v.fileName || v.audioFile),
           seconds: Number(v.seconds) > 0 ? Number(v.seconds) : 0 };
}
function voicePayload(v) {
  return v && v.audioFile
    ? { audioFile: v.audioFile, fileName: v.fileName || v.audioFile, seconds: v.seconds || 0 }
    : null;
}

function emptySubjectSlot() {
  return { images: [], description: "", shortName: "", kind: "person",
           retention: "fully_preserved", retentionNote: "", voice: null };
}

// Old timelines wrote `characters` and had neither kind nor retention. Reading them back
// with today's defaults reproduces the old wording exactly, so nothing silently changes
// meaning under an existing workflow.
function normaliseSubjectSlots(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = list.slice(0, MAX_SUBJECT_SLOTS).map((c) => ({
    images: Array.isArray(c.images) ? c.images : [],
    description: c.description || "",
    shortName: c.shortName || "",
    kind: SUBJECT_KIND_OPTIONS.some(o => o.value === c.kind) ? c.kind : "person",
    retention: RETENTION_OPTIONS.some(o => o.value === c.retention)
      ? c.retention : "fully_preserved",
    retentionNote: c.retentionNote || "",
    voice: normaliseVoice(c.voice),
  }));
  while (out.length < 3) out.push(emptySubjectSlot());
  return out;
}


// --- Icons ---
const ICONS = {
  upload: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`,
  audio: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`,
  motion: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`,
  trash: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
  text: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>`,
  play: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`,
  pause: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`,
  loop: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12A9 9 0 0 0 6 5.3L3 8"></path><polyline points="3 3 3 8 8 8"></polyline><path d="M3 12a9 9 0 0 0 15 6.7l3-2.7"></path><polyline points="21 21 21 16 16 16"></polyline></svg>`,
  minus: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  fit: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><polyline points="8 7 3 12 8 17"></polyline><polyline points="16 7 21 12 16 17"></polyline></svg>`,
  gear: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
  close: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
  start: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 3H13.5a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" /></svg>`,
  end: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" /></svg>`,
  mark: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 3H7.5a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" /><path d="M15.5 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" /></svg>`,
  help: `<svg width="14" height="14" viewBox="-5 -5 38 38" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M10.398,22.811h4.618v4.964h-4.618V22.811z M21.058,1.594C19.854,0.532,17.612,0,14.33,0c-3.711,0-6.205,0.514-7.482,1.543 c-1.277,1.027-1.916,3.027-1.916,6L4.911,8.551h4.577l-0.02-1.049c0-1.424,0.303-2.377,0.907-2.854 c0.604-0.477,1.814-0.717,3.632-0.717c1.936,0,3.184,0.228,3.74,0.676c0.559,0.451,0.837,1.457,0.837,3.017 c0,1.883-0.745,3.133-2.237,3.752l-1.797,0.766c-1.882,0.781-3.044,1.538-3.489,2.27c-0.442,0.732-0.665,2.242-0.665,4.529h4.68 v-0.646c0-1.41,0.987-2.533,2.965-3.365c2.03-0.861,3.343-1.746,3.935-2.651c0.592-0.908,0.888-2.498,0.888-4.771 C22.863,4.625,22.261,2.655,21.058,1.594z"/></svg>`,
  magnet: `<svg width="15" height="15" viewBox="-30 -55 580 580" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path stroke="currentColor" stroke-width="15" stroke-linejoin="round" stroke-linecap="round" d="M502.915,274.353l-64.2-64.2c-5.5-5.5-14.4-5.5-19.9,0l-155.1,155c-45.4,45.4-99.2,20.4-119.6,0 c-20.3-20.3-45.8-73.8,0-119.6l155.1-155c5.5-5.5,5.5-14.4,0-19.9l-64.2-64.2c-2.6-2.6-9.9-9.9-19.9,0l-155.1,155 c-101.4,116.1-55.4,232.4,0,287.9c49.4,49.4,171.9,99.3,287.8,0l155.1-155.1C512.915,284.253,505.615,276.953,502.915,274.353z M225.115,36.253l44.3,44.3l-26,26l-44.3-44.3L225.115,36.253z M328.015,429.453c-61.3,61.3-175.2,72.8-248,0 c-72.9-72.9-64.9-183.1,0-248l99.2-99.2l44.3,44.3l-99.2,99.2c-47.5,47.5-45.1,114.2,0,159.4c44.8,44.8,114.4,45,159.4,0 l99.2-99.2l44.3,44.3L328.015,429.453z M447.115,310.253l-44.3-44.3l26-26l44.3,44.3L447.115,310.253z"/></svg>`
};

// --- Data Models ---
function parseInitial(jsonStr) {
  let parsed = {
    segments: [],
    motionSegments: [],
    audioSegments: [],
    global_prompt: "",
    retake_global_prompt: "",
    // The guide's two sound sections. No retake twin on purpose — re-rolling a range
    // does not change what the room sounds like.
    overall_soundscape: "",
    non_diegetic_music: "",
    // a prompt written by hand instead of compiled; off unless explicitly turned on
    prompt_override: "",
    prompt_override_on: false,
    mainTrackEnabled: true,
    audioTrackEnabled: true,
    motionTrackEnabled: true,
    propHeight: 90,
    globalPropHeight: 114,   // GLOBAL_PROP_MIN_H: prompt box + the sound strip
    showFilenames: true,
    overrideAudio: false,
    inpaint_audio: true,
    retakeMode: false,
    retakeStart: 24,
    retakeLength: 48,
    retakePrompt: "",
    retakeStrength: 1.0,
    retakeVideo: null,
    normalStartFrame: 0,
    normalDurationFrames: 120,
    reference_mode: "OFF",
    prompt_format: "minimax",
    analyzeProvider: "ollama",
    analyzeBaseUrl: "",
    analyzeModel: "",
    summary: "",
    task_type_override: "",
    subjectSlotCount: SUBJECT_SLOTS_DEFAULT,
    subjects: normaliseSubjectSlots(null)
  };
  try {
    if (jsonStr) {
      const p = JSON.parse(jsonStr);
      if (p.global_prompt !== undefined) parsed.global_prompt = p.global_prompt;
      if (p.retake_global_prompt !== undefined) parsed.retake_global_prompt = p.retake_global_prompt;
      if (p.overall_soundscape !== undefined) parsed.overall_soundscape = p.overall_soundscape;
      if (p.non_diegetic_music !== undefined) parsed.non_diegetic_music = p.non_diegetic_music;
      if (p.prompt_override !== undefined) parsed.prompt_override = p.prompt_override;
      if (p.prompt_override_on !== undefined) parsed.prompt_override_on = !!p.prompt_override_on;
      if (p.mainTrackEnabled !== undefined) parsed.mainTrackEnabled = p.mainTrackEnabled;
      if (p.audioTrackEnabled !== undefined) parsed.audioTrackEnabled = p.audioTrackEnabled;
      if (p.motionTrackEnabled !== undefined) parsed.motionTrackEnabled = p.motionTrackEnabled;
      if (p.propHeight !== undefined) parsed.propHeight = p.propHeight;
      if (p.globalPropHeight !== undefined) parsed.globalPropHeight = p.globalPropHeight;
      if (p.showFilenames !== undefined) parsed.showFilenames = p.showFilenames;
      if (p.overrideAudio !== undefined) parsed.overrideAudio = p.overrideAudio;
      if (p.inpaint_audio !== undefined) parsed.inpaint_audio = p.inpaint_audio;
      if (p.retakeMode !== undefined) parsed.retakeMode = p.retakeMode;
      if (p.retakeStart !== undefined) parsed.retakeStart = p.retakeStart;
      if (p.retakeLength !== undefined) parsed.retakeLength = p.retakeLength;
      if (p.retakePrompt !== undefined) parsed.retakePrompt = p.retakePrompt;
      if (p.retakeStrength !== undefined) parsed.retakeStrength = p.retakeStrength;
      if (p.retakeVideo !== undefined) parsed.retakeVideo = p.retakeVideo;
      if (p.normalStartFrame !== undefined) parsed.normalStartFrame = p.normalStartFrame;
      if (p.normalDurationFrames !== undefined) parsed.normalDurationFrames = p.normalDurationFrames;
      if (p.prompt_format !== undefined) parsed.prompt_format = (String(p.prompt_format).toLowerCase() === "comfyui") ? "comfyui" : "minimax";
      if (p.reference_mode !== undefined) {
        // Normalise: only OFF / REF2VA exist here. Anything else (incl. legacy LTX
        // "Ghost Mask (End)" / "Licon MSR (Prefix)") is a reference mode -> REF2VA.
        parsed.reference_mode = (p.reference_mode === "OFF" || !p.reference_mode) ? "OFF" : "REF2VA";
      }
      if (p.analyzeProvider !== undefined) parsed.analyzeProvider = p.analyzeProvider;
      if (p.analyzeBaseUrl !== undefined) parsed.analyzeBaseUrl = p.analyzeBaseUrl;
      if (p.analyzeModel !== undefined) parsed.analyzeModel = p.analyzeModel;
      if (p.summary !== undefined) parsed.summary = p.summary || "";
      if (p.subjectSlotCount !== undefined) {
        parsed.subjectSlotCount = clampSubjectSlots(p.subjectSlotCount);
      } else if (Array.isArray(p.subjects) || Array.isArray(p.characters)) {
        // saved before the count was stored: the slots themselves are all it left behind
        parsed.subjectSlotCount =
          clampSubjectSlots((p.subjects || p.characters).length);
      }
      if (p.task_type_override !== undefined) {
        parsed.task_type_override = p.task_type_override || "";
      }
      // `subjects` is the current key; `characters` is the same panel's old one. A
      // timeline saved before subject kinds existed reads back with today's defaults,
      // which reproduce the wording it was written against.
      if (Array.isArray(p.subjects) || Array.isArray(p.characters)) {
        parsed.subjects = normaliseSubjectSlots(p.subjects || p.characters);
      }
      if (Array.isArray(p.segments)) {
        parsed.segments = p.segments.map(s => {
          // `isAnchor` is dropped rather than carried: the Image Anchor was an LTX
          // concept this node never read, so an old timeline's flag is inert and would
          // otherwise ride along in the JSON forever. Such a segment becomes an ordinary
          // image with an empty prompt, which is what it already compiled to.
          const { imgObj, videoEl, _isSeeking, thumbnails, _extractingThumbs, _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, isAnchor, ...rest } = s;
          return rest;
        });
      }
      if (Array.isArray(p.motionSegments)) {
        parsed.motionSegments = p.motionSegments.map(s => {
          const { videoEl, _isSeeking, thumbnails, _extractingThumbs, _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, ...rest } = s;
          return rest;
        });
      }
      if (Array.isArray(p.audioSegments)) {
        parsed.audioSegments = p.audioSegments.map(s => {
          const { _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _decoding, ...rest } = s;
          return rest;
        });
      }
    }
  } catch (e) { }

  // A slot with something in it must never be hidden by the count saved beside it: the
  // planner reads the slots, so its images would still be sent with no box on screen to
  // show them. Only ever raises, and only here — while editing, the stepper is the one
  // writer. It fires for a hand-edited or third-party timeline, not for one this saves.
  let lastUsed = 0;
  (parsed.subjects || []).forEach((s, i) => {
    if ((s.images && s.images.length) || (s.description || "").trim()) lastUsed = i + 1;
  });
  if (lastUsed > parsed.subjectSlotCount) {
    parsed.subjectSlotCount = clampSubjectSlots(lastUsed);
  }

  let currentStart = 0;
  for (let seg of parsed.segments) {
    if (seg.start === undefined) {
      seg.start = currentStart;
      currentStart += seg.length;
    }
    // Guarantee ID assignment to prevent node loading drag breaks
    if (!seg.id) {
      seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    }
    if (seg.isEndFrame === undefined) {
      seg.isEndFrame = false;
    }
  }

  for (let seg of parsed.motionSegments) {
    if (!seg.id) {
      seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    }
    if (seg.trimStart === undefined) seg.trimStart = 0;
  }

  for (let seg of parsed.audioSegments) {
    if (!seg.id) {
      seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    }
    if (seg.trimStart === undefined) seg.trimStart = 0;
  }

  return parsed;
}

class TimelineEditor {
  constructor(node, container, domWidget) {
    this.node = node;
    this.container = container;
    this.domWidget = domWidget;

    // Track heights (dynamic)
    this.rulerHeight = RULER_HEIGHT;
    this.blockHeight = BLOCK_HEIGHT;
    this.motionTrackHeight = MOTION_TRACK_HEIGHT;
    this.audioTrackHeight = AUDIO_TRACK_HEIGHT;
    this.canvasHeight = CANVAS_HEIGHT;

    // Core data
    this.timeline = { segments: [], motionSegments: [], audioSegments: [] };
    this.selectionType = "image"; // "image", "motion", or "audio"
    this.selectedSegmentIds = [];
    this._selectedIndex = -1;
    this._audioTrackWasEnabledBeforeOverride = false;

    // Selection box tracking
    this._isSelectingBox = false;
    this._selectBoxStart = null;
    this._selectBoxCurrent = null;
    this._selectBoxInitialSelectedIds = null;

    // Interactions
    this._isDragging = false;
    this._dragType = null;
    this._dragStartX = 0;
    this._dragInitialTimeline = null;
    this.zoomLevel = 1.0;
    this._lastZoom = 1.0;
    this._lastScale = 1.0;
    this._dragTargetId = null;
    this._dragTargetIdRight = null;
    this._previewSegments = null;
    this._lastWidth = 0;
    this._hoveredGapIdx = -1;
    this._isHovering = false;

    // Playback state
    this.currentFrame = 0;
    this.isPlaying = false;
    this.isLooping = false;
    this.audioContext = null;
    this.activeAudioNodes = [];
    this.playbackStartTime = 0;
    this.playbackStartFrame = 0;
    this._playLoopId = null;

    // File handling
    this.currentFileHandle = null;

    // --- Ghost dragging state ---
    this._ghostSegmentId = null;
    this._ghostTrack = null;
    this._ghostInitialTimeline = null;

    // Attach to Python widgets
    this._gapMenu = null;         // Active gap popup menu element
    this._gapMenuDismisser = null;

    // Attach to Python widgets
    this.startFramesWidget = this.node.widgets.find(w => w.name === "start_frame");
    this.startSecondsWidget = this.node.widgets.find(w => w.name === "start_second");
    this.endFramesWidget = this.node.widgets.find(w => w.name === "end_frame");
    this.endSecondsWidget = this.node.widgets.find(w => w.name === "end_second");
    this.durationFramesWidget = this.node.widgets.find(w => w.name === "duration_frames");
    this.durationSecondsWidget = this.node.widgets.find(w => w.name === "duration_seconds");
    this.frameRateWidget = this.node.widgets.find(w => w.name === "frame_rate");
    this.timelineDataWidget = this.node.widgets.find(w => w.name === "timeline_data");
    this.localPromptsWidget = this.node.widgets.find(w => w.name === "local_prompts");
    this.segmentLengthsWidget = this.node.widgets.find(w => w.name === "segment_lengths");
    this.guideStrengthWidget = this.node.widgets.find(w => w.name === "guide_strength");
    this.displayModeWidget = this.node.widgets.find(w => w.name === "display_mode");

    // Track the last-known frame rate so we can compute the rescale ratio
    // inside the frameRateWidget callback (the widget value is already updated
    // to the new value before the callback fires, so we can't read "old" from it).
    this._prevFrameRate = this.getFrameRate();
    this._prevStartFrames = this.getStartFrames();
    this._prevStartSeconds = this.startSecondsWidget ? this.startSecondsWidget.value : 0;

    mmxdLog("[MiniMaxDirector debug] Constructor: timelineDataWidget value:", this.timelineDataWidget?.value);
    this.timeline = parseInitial(this.timelineDataWidget?.value);
    this.retakeMode = this.timeline.retakeMode === true;
    if (this.retakeMode) {
      if (this.timeline.retake_global_prompt) {
        if (!this.node.properties) this.node.properties = {};
        this.node.properties.global_prompt = this.timeline.retake_global_prompt;
      }
    } else {
      if (this.timeline.global_prompt) {
        if (!this.node.properties) this.node.properties = {};
        this.node.properties.global_prompt = this.timeline.global_prompt;
      }
    }
    mmxdLog("[MiniMaxDirector debug] Constructor: parsed timeline:", JSON.stringify(this.timeline));

    // Treat this.timeline (from timeline_data widget) as the absolute source of truth!
    this.mainTrackEnabled = this.timeline.mainTrackEnabled !== false;
    this.audioTrackEnabled = this.timeline.audioTrackEnabled !== false;
    this.motionTrackEnabled = this.timeline.motionTrackEnabled !== false;

    // Sync the properties dictionary too so they match
    this.node.properties.mainTrackEnabled = this.mainTrackEnabled;
    this.node.properties.audioTrackEnabled = this.audioTrackEnabled;
    this.node.properties.motionTrackEnabled = this.motionTrackEnabled;
    if (this.timeline.showFilenames !== undefined) {
      this.node.properties.showFilenames = this.timeline.showFilenames;
    }
    if (this.timeline.overrideAudio !== undefined) {
      this.node.properties.overrideAudio = this.timeline.overrideAudio;
    }
    if (this.timeline.inpaint_audio !== undefined) {
      this.node.properties.inpaint_audio = this.timeline.inpaint_audio;
    }

    // Sync widgets to match the timeline data
    const inpaintWidget = this.node.widgets?.find(w => w.name === "inpaint_audio");
    if (inpaintWidget && this.timeline.inpaint_audio !== undefined) {
      inpaintWidget.value = this.timeline.inpaint_audio;
    }
    const overrideWidget = this.node.widgets?.find(w => w.name === "override_audio");
    if (overrideWidget && this.timeline.overrideAudio !== undefined) {
      overrideWidget.value = this.timeline.overrideAudio;
    }

    this._audioTrackWasEnabledBeforeOverride = this.node.properties.audioTrackWasEnabledBeforeOverride || false;
    this.loadMedia();

    this.createDOM();
    this.updateRetakeUIState();
    if (this.timeline.segments.length > 0) {
      this.selectedIndex = 0;
    }
    this.updateUIFromSelection();
    this.syncWidgetsAndUI();
    this.commitChanges(true);
    // Hide settings widgets by default to reduce node clutter.
    // Deferred so all widget types are finalized before we touch them.
    setTimeout(() => this.hideSettingsWidgets(), 0);

    let isSyncing = false;

    // --- Start Callbacks ---
    const origStartFramesCallback = this.startFramesWidget?.callback;
    if (this.startFramesWidget) {
      this.startFramesWidget.callback = (...args) => {
        if (origStartFramesCallback) origStartFramesCallback.apply(this.startFramesWidget, args);

        if (!isSyncing && this.startSecondsWidget && this.durationFramesWidget && this.endFramesWidget) {
          isSyncing = true;

          let newStartFrames = this.getStartFrames();
          const endFrame = this.endFramesWidget.value || 1;
          let newDurationFrames = Math.max(1, endFrame - newStartFrames);

          if (newDurationFrames <= 1) {
            newStartFrames = endFrame - 1;
            this.startFramesWidget.value = newStartFrames;
            newDurationFrames = 1;
          }

          this.startSecondsWidget.value = parseFloat((newStartFrames / this.getFrameRate()).toFixed(3));

          this.durationFramesWidget.value = newDurationFrames;
          if (this.durationSecondsWidget) {
            this.durationSecondsWidget.value = parseFloat((newDurationFrames / this.getFrameRate()).toFixed(3));
          }

          this._prevStartFrames = newStartFrames;
          this._prevStartSeconds = this.startSecondsWidget.value;

          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    const origStartSecondsCallback = this.startSecondsWidget?.callback;
    if (this.startSecondsWidget) {
      this.startSecondsWidget.callback = (...args) => {
        if (origStartSecondsCallback) origStartSecondsCallback.apply(this.startSecondsWidget, args);

        if (!isSyncing && this.startFramesWidget && this.durationSecondsWidget && this.endFramesWidget) {
          isSyncing = true;

          let newStartSeconds = this.startSecondsWidget.value;
          let newStartFrames = Math.max(0, Math.round(newStartSeconds * this.getFrameRate()));

          const endFrame = this.endFramesWidget.value || 1;
          let newDurationFrames = Math.max(1, endFrame - newStartFrames);

          if (newDurationFrames <= 1) {
            newStartFrames = endFrame - 1;
            newStartSeconds = newStartFrames / this.getFrameRate();
            this.startSecondsWidget.value = parseFloat(newStartSeconds.toFixed(3));
            newDurationFrames = 1;
          }

          this.startFramesWidget.value = newStartFrames;

          this.durationFramesWidget.value = newDurationFrames;
          if (this.durationSecondsWidget) {
            this.durationSecondsWidget.value = parseFloat((newDurationFrames / this.getFrameRate()).toFixed(3));
          }

          this._prevStartFrames = newStartFrames;
          this._prevStartSeconds = this.startSecondsWidget.value;

          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    // --- End Callbacks ---
    const origEndFramesCallback = this.endFramesWidget?.callback;
    if (this.endFramesWidget) {
      this.endFramesWidget.callback = (...args) => {
        if (origEndFramesCallback) origEndFramesCallback.apply(this.endFramesWidget, args);

        if (!isSyncing && this.endSecondsWidget && this.durationFramesWidget && this.startFramesWidget) {
          isSyncing = true;

          let newEndFrames = this.endFramesWidget.value;
          const startFrame = this.startFramesWidget.value || 0;
          let newDurationFrames = Math.max(1, newEndFrames - startFrame);

          if (newDurationFrames <= 1) {
            newEndFrames = startFrame + 1;
            this.endFramesWidget.value = newEndFrames;
            newDurationFrames = 1;
          }

          this.endSecondsWidget.value = parseFloat((newEndFrames / this.getFrameRate()).toFixed(3));

          this.durationFramesWidget.value = newDurationFrames;
          if (this.durationSecondsWidget) {
            this.durationSecondsWidget.value = parseFloat((newDurationFrames / this.getFrameRate()).toFixed(3));
          }

          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    const origEndSecondsCallback = this.endSecondsWidget?.callback;
    if (this.endSecondsWidget) {
      this.endSecondsWidget.callback = (...args) => {
        if (origEndSecondsCallback) origEndSecondsCallback.apply(this.endSecondsWidget, args);

        if (!isSyncing && this.endFramesWidget && this.durationSecondsWidget && this.startFramesWidget) {
          isSyncing = true;

          let newEndSeconds = this.endSecondsWidget.value;
          let newEndFrames = Math.max(1, Math.round(newEndSeconds * this.getFrameRate()));

          const startFrame = this.startFramesWidget.value || 0;
          let newDurationFrames = Math.max(1, newEndFrames - startFrame);

          if (newDurationFrames <= 1) {
            newEndFrames = startFrame + 1;
            newEndSeconds = newEndFrames / this.getFrameRate();
            this.endSecondsWidget.value = parseFloat(newEndSeconds.toFixed(3));
            newDurationFrames = 1;
          }

          this.endFramesWidget.value = newEndFrames;

          this.durationFramesWidget.value = newDurationFrames;
          if (this.durationSecondsWidget) {
            this.durationSecondsWidget.value = parseFloat((newDurationFrames / this.getFrameRate()).toFixed(3));
          }

          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    // --- Duration Callbacks ---
    const origDurationFramesCallback = this.durationFramesWidget?.callback;
    if (this.durationFramesWidget) {
      this.durationFramesWidget.callback = (...args) => {
        if (origDurationFramesCallback) origDurationFramesCallback.apply(this.durationFramesWidget, args);

        if (!isSyncing && this.durationSecondsWidget && this.startFramesWidget && this.endFramesWidget) {
          isSyncing = true;
          this.durationSecondsWidget.value = parseFloat((this.getDurationFrames() / this.getFrameRate()).toFixed(3));

          const newEndFrames = this.startFramesWidget.value + this.getDurationFrames();
          this.endFramesWidget.value = newEndFrames;
          this.endSecondsWidget.value = parseFloat((newEndFrames / this.getFrameRate()).toFixed(3));

          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    const origDurationSecondsCallback = this.durationSecondsWidget?.callback;
    if (this.durationSecondsWidget) {
      this.durationSecondsWidget.callback = (...args) => {
        if (origDurationSecondsCallback) origDurationSecondsCallback.apply(this.durationSecondsWidget, args);

        if (!isSyncing && this.durationFramesWidget && this.startFramesWidget && this.endFramesWidget) {
          isSyncing = true;
          const newFrames = Math.max(1, Math.round(this.durationSecondsWidget.value * this.getFrameRate()));
          this.durationFramesWidget.value = newFrames;

          const newEndFrames = this.startFramesWidget.value + newFrames;
          this.endFramesWidget.value = newEndFrames;
          this.endSecondsWidget.value = parseFloat((newEndFrames / this.getFrameRate()).toFixed(3));

          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    const origFrameRateCallback = this.frameRateWidget?.callback;
    if (this.frameRateWidget) {
      this.frameRateWidget.callback = (...args) => {
        if (origFrameRateCallback) origFrameRateCallback.apply(this.frameRateWidget, args);

        // Keep start_seconds and end_seconds constant; recompute frames to match the new rate.
        if (!isSyncing && this.durationSecondsWidget && this.durationFramesWidget) {
          isSyncing = true;
          const newFPS = this.getFrameRate();

          // Recompute all segment frame values from their seconds snapshots.
          // Using the snapshot avoids cumulative rounding errors when the user
          // drags the slider rapidly through many intermediate FPS values.
          this._rebaseSegmentsToFPS(newFPS);

          if (this.startSecondsWidget && this.startFramesWidget) {
            const newStartFrames = Math.max(0, Math.round(this.startSecondsWidget.value * newFPS));
            this.startFramesWidget.value = newStartFrames;
            this._prevStartFrames = newStartFrames;
          }

          if (this.endSecondsWidget && this.endFramesWidget) {
            const newEndFrames = Math.max(1, Math.round(this.endSecondsWidget.value * newFPS));
            this.endFramesWidget.value = newEndFrames;
          }

          const newFrames = Math.max(1, Math.round(this.durationSecondsWidget.value * newFPS));
          this.durationFramesWidget.value = newFrames;

          // Update our tracked previous rate now that the change is complete.
          this._prevFrameRate = newFPS;
          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    const origDisplayModeCallback = this.displayModeWidget?.callback;
    if (this.displayModeWidget) {
      this.displayModeWidget.callback = (...args) => {
        if (origDisplayModeCallback) origDisplayModeCallback.apply(this.displayModeWidget, args);
        this.updateWidgetVisibility();
        this.updateUIFromSelection();
        this.render();
      };
      this.updateWidgetVisibility(); // Initial trigger
    }

    // Polling is much more reliable in Comfy than ResizeObserver due to scale transforms
    this._renderLoop = requestAnimationFrame(() => this.checkResize());
  }

  isMultiSelectActive() {
    if (!this.selectedSegmentIds || this.selectedSegmentIds.length <= 1) return false;
    const baseIds = new Set();
    for (const id of this.selectedSegmentIds) {
      const baseId = (id.endsWith("_v") || id.endsWith("_a")) ? id.slice(0, -2) : id;
      baseIds.add(baseId);
    }
    return baseIds.size > 1;
  }

  updateSelectionFromBox() {
    if (!this._selectBoxStart || !this._selectBoxCurrent) return;

    const width = this.canvas.offsetWidth;
    const totalFrames = this.getVisualDurationFrames();
    if (!width || totalFrames <= 0) return;

    const sx = this._selectBoxStart.x;
    const sy = this._selectBoxStart.y;
    const cx = this._selectBoxCurrent.x;
    const cy = this._selectBoxCurrent.y;

    const left = Math.min(sx, cx);
    const right = Math.max(sx, cx);
    const top = Math.min(sy, cy);
    const bottom = Math.max(sy, cy);

    const newSelectedIds = new Set(this._selectBoxInitialSelectedIds || []);

    for (const track of ["image", "motion", "audio"]) {
      const arr = this.getSegmentArray(track);
      if (!arr) continue;

      let trackTop = 0;
      let trackBottom = 0;

      if (track === "image") {
        trackTop = RULER_HEIGHT;
        trackBottom = RULER_HEIGHT + this.blockHeight;
      } else if (track === "audio") {
        trackTop = RULER_HEIGHT + this.blockHeight;
        trackBottom = RULER_HEIGHT + this.blockHeight + this.audioTrackHeight;
      } else if (track === "motion") {
        trackTop = RULER_HEIGHT + this.blockHeight + this.audioTrackHeight;
        trackBottom = RULER_HEIGHT + this.blockHeight + this.audioTrackHeight + this.motionTrackHeight;
      }

      for (const seg of arr) {
        const startX = (seg.start / totalFrames) * width;
        const pxWidth = (seg.length / totalFrames) * width;
        const endX = startX + pxWidth;

        // Check rect intersection
        const intersects = (left <= endX && right >= startX && top <= trackBottom && bottom >= trackTop);

        if (intersects) {
          newSelectedIds.add(seg.id);
          const sibId = seg.id.endsWith("_v") ? seg.id.slice(0, -2) + "_a" : (seg.id.endsWith("_a") ? seg.id.slice(0, -2) + "_v" : null);
          if (sibId) {
            newSelectedIds.add(sibId);
          }
        }
      }
    }

    this.selectedSegmentIds = Array.from(newSelectedIds);
    this.syncSelectionTypeAndIndex();
  }

  syncSelectionTypeAndIndex() {
    if (!this.selectedSegmentIds || this.selectedSegmentIds.length === 0) {
      this._selectedIndex = -1;
      return;
    }
    if (this.isMultiSelectActive()) {
      this._selectedIndex = -1;
      return;
    }
    // Sync single selection (which might be video + audio sibling)
    const firstId = this.selectedSegmentIds[0];
    for (const track of ["image", "motion", "audio"]) {
      const arr = this.getSegmentArray(track);
      const idx = arr.findIndex(s => s.id === firstId);
      if (idx !== -1) {
        this.selectionType = track;
        this._selectedIndex = idx;
        break;
      }
    }
  }

  get selectedIndex() {
    return this._selectedIndex;
  }

  set selectedIndex(val) {
    this._selectedIndex = val;
    if (this.selectedSegmentIds && !this.isMultiSelectActive()) {
      if (val === -1) {
        this.selectedSegmentIds = [];
      } else {
        const arr = this.getSegmentArray(this.selectionType);
        const seg = arr ? arr[val] : null;
        if (seg) {
          this.selectedSegmentIds = [seg.id];
          if (seg.id.endsWith("_v")) {
            const sibId = seg.id.slice(0, -2) + "_a";
            if (!this.selectedSegmentIds.includes(sibId)) this.selectedSegmentIds.push(sibId);
          } else if (seg.id.endsWith("_a")) {
            const sibId = seg.id.slice(0, -2) + "_v";
            if (!this.selectedSegmentIds.includes(sibId)) this.selectedSegmentIds.push(sibId);
          }
        } else {
          this.selectedSegmentIds = [];
        }
      }
    }
  }

  destroy() {
    cancelAnimationFrame(this._renderLoop);
    this.pauseAudio();
    window.removeEventListener("keydown", this.handleKeyDown, true);
    window.removeEventListener("paste", this.handlePaste, true);
  }

  getStartFrames() {
    return parseInt((this.startFramesWidget && this.startFramesWidget.value >= 0) ? this.startFramesWidget.value : 0, 10);
  }

  getDurationFrames() {
    return parseInt((this.durationFramesWidget && this.durationFramesWidget.value > 0) ? this.durationFramesWidget.value : 24, 10);
  }

  getFrameRate() {
    return parseInt((this.frameRateWidget && this.frameRateWidget.value > 0) ? this.frameRateWidget.value : 24, 10);
  }

  // Grow the timeline duration to fit `requiredFrames` if it is currently shorter.
  // The timeline only ever grows — never shrinks — through this method.
  // Only the main track calls this, and that is the rule rather than an accident: a
  // reference is an input to the model, not content in the video, so an <Audio N> or
  // <Video N> clip must never stretch the output. Reference audio wants to be 10-15s per
  // the model card, and three of those growing the window would ask H3 for 45s of video —
  // past anything it can render. Keyframes and prompt zones decide the length; references
  // park in the shaded area past it and are sent from there.
  growTimelineIfNeeded(requiredFrames) {
    const current = this.getDurationFrames();
    if (requiredFrames <= current) return; // already big enough

    const newFrames = Math.ceil(requiredFrames);
    if (this.durationFramesWidget) {
      this.durationFramesWidget.value = newFrames;
    }
    if (this.durationSecondsWidget) {
      this.durationSecondsWidget.value = parseFloat((newFrames / this.getFrameRate()).toFixed(3));
    }
    // Notify ComfyUI that the widget value changed so it serialises correctly.
    if (window.app && window.app.graph) {
      window.app.graph.setDirtyCanvas(true, true);
    }
  }

  // Force all start/end/duration widgets to match the retake video's duration exactly.
  syncWidgetsToRetakeDuration(durationFrames) {
    if (durationFrames <= 0) return;
    const rate = this.getFrameRate();
    const durationSeconds = parseFloat((durationFrames / rate).toFixed(3));

    const wasSuppressing = this._suppressCommit;
    this._suppressCommit = true;

    if (this.startFramesWidget) {
      this.startFramesWidget.value = 0;
      if (this.startFramesWidget.callback) {
        try { this.startFramesWidget.callback(0); } catch (_) {}
      }
    }
    if (this.startSecondsWidget) {
      this.startSecondsWidget.value = 0;
    }

    if (this.durationFramesWidget) {
      this.durationFramesWidget.value = durationFrames;
      if (this.durationFramesWidget.callback) {
        try { this.durationFramesWidget.callback(durationFrames); } catch (_) {}
      }
    }
    if (this.durationSecondsWidget) {
      this.durationSecondsWidget.value = durationSeconds;
    }

    if (this.endFramesWidget) {
      this.endFramesWidget.value = durationFrames;
    }
    if (this.endSecondsWidget) {
      this.endSecondsWidget.value = durationSeconds;
    }

    this._suppressCommit = wasSuppressing;
  }

  // Returns the maximum allowed zoom level, computed so that at max zoom
  // the viewport shows exactly 4 seconds of the visual timeline.
  getMaxZoom() {
    const visualDurationSecs = this.getVisualDurationFrames() / this.getFrameRate();
    const baseMaxZoom = Math.max(1, visualDurationSecs / 4);

    // Limit max zoom to prevent canvas width from exceeding browser limits (causing crash)
    const viewportWidth = this.viewport ? this.viewport.clientWidth : 1000;
    const MAX_CANVAS_WIDTH = 32768; // Extended limit for modern browsers
    const limitMaxZoom = MAX_CANVAS_WIDTH / Math.max(1, viewportWidth);

    return Math.max(1, Math.min(baseMaxZoom, limitMaxZoom));
  }

  // Returns the visual timeline length in frames:
  // the furthest segment end (across both tracks) × 1.30, with a floor of getDurationFrames().
  // This is used for all rendering/positioning — the actual output duration is getDurationFrames().
  getVisualDurationFrames() {
    if (this.retakeMode) {
      if (this.timeline.retakeVideo) {
        const baseVideoDur = this.timeline.retakeVideo.videoDurationFrames || 0;
        // Add 15% visual buffer duration on the right to prevent the video segment
        // from being cut off by the DOM clipping (right ~9% of the viewport is clipped by ComfyUI).
        return Math.max(24, Math.ceil(baseVideoDur * 1.15));
      } else {
        return 24;
      }
    }

    let furthest = 0;
    for (const seg of this.timeline.segments) {
      furthest = Math.max(furthest, seg.start + seg.length);
    }
    for (const seg of this.timeline.audioSegments) {
      furthest = Math.max(furthest, seg.start + seg.length);
    }
    for (const seg of this.timeline.motionSegments) {
      furthest = Math.max(furthest, seg.start + seg.length);
    }
    const outputDuration = this.getDurationFrames();
    if (furthest <= 0) return outputDuration;
    return Math.max(outputDuration, Math.ceil(furthest * 1.30));
  }

  // Sync the zoom slider's max attribute to the current getMaxZoom() value,
  // clamping zoomLevel if it now exceeds the new max.
  updateZoomSliderMax() {
    if (!this.zoomSlider) return;
    const maxZoom = this.getMaxZoom();
    this.zoomSlider.max = maxZoom.toFixed(2);
    if (this.zoomLevel > maxZoom) {
      this.zoomLevel = maxZoom;
      this.zoomSlider.value = maxZoom;
      // Resize the canvas to match the clamped zoom
      const viewportWidth = this.viewport ? this.viewport.clientWidth : 0;
      if (viewportWidth > 0) {
        const newCanvasWidth = Math.max(viewportWidth, viewportWidth * this.zoomLevel);
        this.canvas.style.width = newCanvasWidth + "px";
        this.resizeCanvas(newCanvasWidth);
      }
    }
  }

  _liveScrubVideo(seg, edge) {
    if (!seg || (seg.type !== "video" && seg.type !== "motion_video")) return;
    this._ensureVideoEl(seg);
    if (!seg.videoEl) return;
    const targetSec = edge === "end"
      ? (seg.trimStart + seg.length) / this.getFrameRate()
      : seg.trimStart / this.getFrameRate();

    seg._scrubTargetSec = targetSec;
  }

  _liveScrubPlayhead() {
    const targetFrame = this.currentFrame;
    if (this.retakeMode && this.timeline.retakeVideo) {
      const retakeVid = this.timeline.retakeVideo;
      this._ensureVideoEl(retakeVid);
      if (retakeVid.videoEl) {
        const targetSec = targetFrame / this.getFrameRate();
        retakeVid._scrubTargetSec = targetSec;
      }
      return;
    }

    const seg = this.timeline.segments.find(s => s.type === "video" && targetFrame >= s.start && targetFrame < s.start + s.length);
    if (seg) {
      this._ensureVideoEl(seg);
      if (seg.videoEl) {
        const targetSec = (seg.trimStart + (targetFrame - seg.start)) / this.getFrameRate();
        seg._scrubTargetSec = targetSec;
      }
    }

    const motionSeg = this.timeline.motionSegments.find(s => s.type === "motion_video" && targetFrame >= s.start && targetFrame < s.start + s.length);
    if (motionSeg) {
      this._ensureVideoEl(motionSeg);
      if (motionSeg.videoEl) {
        const targetSec = (motionSeg.trimStart + (targetFrame - motionSeg.start)) / this.getFrameRate();
        motionSeg._scrubTargetSec = targetSec;
      }
    }
  }

  async _ensureThumbnails(seg) {
    if (seg.thumbnails) return;
    if (seg._extractingThumbs) return;

    const fileKey = seg.imageFile || seg.videoFile || seg._blobUrl;
    if (!fileKey) return;

    this._thumbnailCache = this._thumbnailCache || new Map();
    this._thumbnailPromises = this._thumbnailPromises || new Map();

    if (this._thumbnailCache.has(fileKey)) {
      seg.thumbnails = this._thumbnailCache.get(fileKey);
      this.render();
      return;
    }

    if (this._thumbnailPromises.has(fileKey)) {
      seg._extractingThumbs = true;
      try {
        const thumbs = await this._thumbnailPromises.get(fileKey);
        seg.thumbnails = thumbs;
      } catch (err) {
        console.error("Failed to await thumbnails promise:", err);
      } finally {
        seg._extractingThumbs = false;
        this.render();
      }
      return;
    }

    // Otherwise, we extract the thumbnails
    seg._extractingThumbs = true;
    seg.thumbnails = [];

    const extractPromise = (async () => {
      const thumbs = [];
      const parts = fileKey.split(/[/\\\\]/);
      const filename = parts.pop() || '';
      const subfolder = parts.join('/');
      const vidUrl = seg._blobUrl || (seg.videoEl ? seg.videoEl.src : null) || api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

      const bgVid = document.createElement('video');
      bgVid.crossOrigin = "Anonymous";
      bgVid.muted = true;
      bgVid.preload = 'auto';

      try {
        await new Promise(r => {
          let resolved = false;
          const done = () => {
            if (!resolved) {
              resolved = true;
              r();
            }
          };
          bgVid.onloadeddata = done;
          bgVid.onerror = done;
          bgVid.src = vidUrl;
          if (bgVid.readyState >= 2) {
            done();
          }
        });

        if (!bgVid.duration) {
          return thumbs;
        }

        const duration = bgVid.duration;
        const isLargeFile = seg.fileSize > 500 * 1024 * 1024;
        const numFrames = isLargeFile ? 10 : Math.max(5, Math.min(25, Math.ceil(duration * 1.0)));
        const canvas = document.createElement('canvas');
        let w = bgVid.videoWidth, h = bgVid.videoHeight;
        if (w === 0 || h === 0) return thumbs;

        if (h > this.blockHeight) {
          w = Math.round(w * (this.blockHeight / h));
          h = this.blockHeight;
        }
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');

        for (let i = 0; i < numFrames; i++) {
          // Check if the file/segment is still active in the current timeline
          const exists = this.timeline.segments.find(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey) ||
            this.timeline.motionSegments.find(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey) ||
            (this.timeline.retakeVideo && (this.timeline.retakeVideo.imageFile === fileKey || this.timeline.retakeVideo._blobUrl === fileKey));
          if (!exists) break;

          const time = (i / numFrames) * duration;
          bgVid.currentTime = time;

          await new Promise(r => {
            let resolved = false;
            const onSeek = () => { if (!resolved) { resolved = true; r(); } };
            bgVid.onseeked = onSeek;
            setTimeout(onSeek, 1000);
          });

          ctx.drawImage(bgVid, 0, 0, w, h);
          const img = new Image();
          img.src = canvas.toDataURL('image/jpeg', 0.5);
          await new Promise(r => { img.onload = r; });

          thumbs.push({ time, img });

          // Propagate the partial progress live to all active segments sharing this file
          const matchingSegs = [
            ...this.timeline.segments.filter(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey),
            ...(this.timeline.motionSegments || []).filter(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey)
          ];
          if (this.timeline.retakeVideo && (this.timeline.retakeVideo.imageFile === fileKey || this.timeline.retakeVideo._blobUrl === fileKey)) {
            matchingSegs.push(this.timeline.retakeVideo);
          }
          for (const ms of matchingSegs) {
            ms.thumbnails = thumbs;
          }

          this.render();
        }
      } catch (err) {
        console.error("Thumbnail extraction loop failed:", err);
      } finally {
        try {
          bgVid.pause();
          bgVid.onloadeddata = null;
          bgVid.onerror = null;
          bgVid.onseeked = null;
          bgVid.src = "";
          bgVid.load();
        } catch (_) { }
      }
      return thumbs;
    })();

    this._thumbnailPromises.set(fileKey, extractPromise);

    try {
      const thumbs = await extractPromise;
      this._thumbnailCache.set(fileKey, thumbs);

      const matchingSegs = [
        ...this.timeline.segments.filter(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey),
        ...(this.timeline.motionSegments || []).filter(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey)
      ];
      if (this.timeline.retakeVideo && (this.timeline.retakeVideo.imageFile === fileKey || this.timeline.retakeVideo._blobUrl === fileKey)) {
        matchingSegs.push(this.timeline.retakeVideo);
      }
      for (const ms of matchingSegs) {
        ms.thumbnails = thumbs;
        ms._extractingThumbs = false;

        // If fileKey is a blob URL, and the segment now has a server file path, cache under that path too
        if (fileKey.startsWith("blob:")) {
          const serverKey = ms.imageFile || ms.videoFile;
          if (serverKey) {
            this._thumbnailCache.set(serverKey, thumbs);
          }
        }
      }
    } catch (err) {
      console.error("Extraction error:", err);
      const matchingSegs = [
        ...this.timeline.segments.filter(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey),
        ...(this.timeline.motionSegments || []).filter(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey)
      ];
      if (this.timeline.retakeVideo && (this.timeline.retakeVideo.imageFile === fileKey || this.timeline.retakeVideo._blobUrl === fileKey)) {
        matchingSegs.push(this.timeline.retakeVideo);
      }
      for (const ms of matchingSegs) {
        ms._extractingThumbs = false;
      }
    } finally {
      this._thumbnailPromises.delete(fileKey);
      this.render();
    }
  }

  getSegmentArray(trackType) {
    if (trackType === "motion") return this.timeline.motionSegments;
    if (trackType === "audio") return this.timeline.audioSegments;
    return this.timeline.segments;
  }

  getSnappedPlayhead(mouseFrameX, logicalWidth) {
    if (!this.isSnapping) return mouseFrameX;

    const totalFrames = this.getVisualDurationFrames();
    const thresholdFrames = (15 / logicalWidth) * totalFrames;
    const snapCandidates = [0, this.getDurationFrames()];

    // Add start and end frames of active generation range
    snapCandidates.push(this.getStartFrames());
    if (this.endFramesWidget && this.endFramesWidget.value !== undefined) {
      snapCandidates.push(parseInt(this.endFramesWidget.value, 10));
    }

    if (this.retakeMode) {
      if (this.timeline.retakeVideo) {
        const baseVideoDur = this.timeline.retakeVideo.videoDurationFrames || 0;
        snapCandidates.push(baseVideoDur);
      }
      if (this.timeline.retakeStart !== undefined) {
        snapCandidates.push(this.timeline.retakeStart);
        if (this.timeline.retakeLength !== undefined) {
          snapCandidates.push(this.timeline.retakeStart + this.timeline.retakeLength);
        }
      }
    }

    const allTracks = [
      this.timeline.segments || [],
      this.timeline.motionSegments || [],
      this.timeline.audioSegments || []
    ];
    for (const track of allTracks) {
      for (const seg of track) {
        snapCandidates.push(seg.start);
        snapCandidates.push(seg.start + seg.length);
      }
    }

    let bestFrame = mouseFrameX;
    let minDiff = thresholdFrames;
    for (const candidate of snapCandidates) {
      const diff = Math.abs(mouseFrameX - candidate);
      if (diff < minDiff) {
        minDiff = diff;
        bestFrame = candidate;
      }
    }
    return bestFrame;
  }

  getTrackFromY(y) {
    if (y > RULER_HEIGHT + this.blockHeight + this.audioTrackHeight) return "motion";
    if (y > RULER_HEIGHT + this.blockHeight) return "audio";
    return "image";
  }

  _ensureVideoEl(seg) {
    if (!seg) return;

    if (seg.videoEl) {
      if (seg.videoEl.duration && !seg.videoDurationFrames) {
        const frameRate = this.getFrameRate();
        seg.videoDurationFrames = Math.max(1, Math.ceil(seg.videoEl.duration * frameRate));
      }
      if (this.retakeMode && seg === this.timeline.retakeVideo && seg.videoDurationFrames) {
        this.syncWidgetsToRetakeDuration(seg.videoDurationFrames);
        this.updateZoomSliderMax();
        this.commitChanges(true);
      }
      return;
    }

    const cacheKey = seg.imageFile || seg.videoFile || seg._blobUrl;
    if (!cacheKey) return;

    this._videoElementsCache = this._videoElementsCache || new Map();

    if (this._videoElementsCache.has(cacheKey)) {
      // Reuse the existing shared video element — do NOT re-seek it.
      // Running initVideoSeek on an already-initialized element causes cascading seeks
      // when multiple split segments share it (e.g. seg2 seeks to 5min, seg3 seeks to 10min),
      // which breaks playback on long videos. Just grab the reference and ensure thumbnails.
      seg.videoEl = this._videoElementsCache.get(cacheKey);
      if (seg.videoEl.duration && !seg.videoDurationFrames) {
        const frameRate = this.getFrameRate();
        seg.videoDurationFrames = Math.max(1, Math.ceil(seg.videoEl.duration * frameRate));
      }
      if (this.retakeMode && seg === this.timeline.retakeVideo && seg.videoDurationFrames) {
        this.syncWidgetsToRetakeDuration(seg.videoDurationFrames);
        this.updateZoomSliderMax();
        this.commitChanges(true);
      }
      this._ensureThumbnails(seg);
      return;
    }

    const isRetake = seg === this.timeline?.retakeVideo;
    const isVideo = (seg.type === "video" || isRetake) && (seg.imageFile || seg._blobUrl);
    const isMotionVideo = seg.type === "motion_video" && seg.videoFile;
    if (!isVideo && !isMotionVideo) return;

    const fileKey = (seg.type === "video" || isRetake) ? seg.imageFile : seg.videoFile;
    let vidUrl = seg._blobUrl;
    if (!vidUrl && fileKey) {
      const fileParts = fileKey.split(/[/\\\\]/);
      const justName = fileParts.pop() || '';
      const subfolder = fileParts.join('/');
      vidUrl = api.apiURL(`/view?filename=${encodeURIComponent(justName)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);
    }
    if (!vidUrl) return;

    const vid = document.createElement('video');
    vid.crossOrigin = "Anonymous";
    vid.muted = true;
    vid.preload = 'auto';

    seg.videoEl = vid;
    this._videoElementsCache.set(cacheKey, vid);

    vid.addEventListener('seeked', () => {
      this.render();
    });

    const onSeekedHandler = () => {
      vid.removeEventListener('seeked', onSeekedHandler);
      if (!seg.imageB64 || !seg.imgObj) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(vid.videoWidth, 512);
        canvas.height = Math.round((vid.videoHeight / vid.videoWidth) * canvas.width);
        canvas.getContext('2d').drawImage(vid, 0, 0, canvas.width, canvas.height);
        seg.imageB64 = canvas.toDataURL('image/jpeg');
        const img = new Image();
        img.onload = () => {
          seg.imgObj = img;
          this.render();
          this.commitChanges(true);
        };
        img.src = seg.imageB64;
      } else {
        this.render();
      }
    };

    let seekInitialized = false;
    const initVideoSeek = () => {
      if (seekInitialized) return;
      seekInitialized = true;

      if (vid.duration) {
        const frameRate = this.getFrameRate();
        const clipFrames = Math.max(1, Math.ceil(vid.duration * frameRate));
        seg.videoDurationFrames = clipFrames;
        if (this.retakeMode && seg === this.timeline.retakeVideo) {
          this.syncWidgetsToRetakeDuration(clipFrames);
          this.updateZoomSliderMax();
          this.commitChanges(true);
        }
      }

      vid.addEventListener('seeked', onSeekedHandler);
      vid.currentTime = (seg.trimStart || 0) / this.getFrameRate() + 0.01;
      this._ensureThumbnails(seg);
    };

    vid.addEventListener('loadedmetadata', initVideoSeek, { once: true });
    vid.addEventListener('loadeddata', initVideoSeek, { once: true });

    vid.src = vidUrl;

    if (vid.readyState >= 1) {
      initVideoSeek();
    }
  }

  async _getOrExtractAudio(seg) {
    if (!seg.audioFile) return;
    const isVideoFile = seg.audioFile.toLowerCase().match(/\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv)$/);
    if (!isVideoFile) return;

    this._audioExtractionPromises = this._audioExtractionPromises || new Map();
    const fileKey = seg.audioFile;

    if (this._audioExtractionPromises.has(fileKey)) {
      try {
        const res = await this._audioExtractionPromises.get(fileKey);
        if (res && res.audio_file && res.peaks) {
          seg.audioFile = res.audio_file;
          seg.waveformPeaks = res.peaks;
        }
      } catch (err) {
        console.warn("[MiniMaxDirector] Awaiting shared server audio extract promise failed:", err);
      }
      return;
    }

    const extractionPromise = (async () => {
      const resp = await api.fetchApi(`/minimax_director_get_audio?filename=${encodeURIComponent(fileKey)}`);
      if (resp.status === 200) {
        return await resp.json();
      }
      throw new Error(`Server returned status ${resp.status}`);
    })();

    this._audioExtractionPromises.set(fileKey, extractionPromise);

    try {
      const res = await extractionPromise;
      if (res && res.audio_file && res.peaks) {
        seg.audioFile = res.audio_file;
        seg.waveformPeaks = res.peaks;

        // Update all other segments matching this fileKey in the timeline
        const allAudioSegs = this.timeline.audioSegments || [];
        for (const s of allAudioSegs) {
          if (s.audioFile === fileKey) {
            s.audioFile = res.audio_file;
            s.waveformPeaks = res.peaks;
          }
        }
      }
    } catch (err) {
      console.warn("[MiniMaxDirector] Server audio check/extract failed:", err);
    } finally {
      this._audioExtractionPromises.delete(fileKey);
    }
  }

  _extractAudioOnClient(file, audSegId, blobUrl) {
    (async () => {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        const channelData = audioBuffer.getChannelData(0);
        const peaks = [];
        const numPeaks = 200;
        const step = Math.floor(channelData.length / numPeaks);
        for (let i = 0; i < numPeaks; i++) {
          let max = 0;
          for (let j = 0; j < step; j++) {
            const val = Math.abs(channelData[i * step + j]);
            if (val > max) max = val;
          }
          peaks.push(max);
        }
        for (let s of this.timeline.audioSegments) {
          if (s.id === audSegId || (blobUrl && s._blobUrl === blobUrl)) {
            s.waveformPeaks = peaks;
            s._decoding = false;
            s._audioBuffer = audioBuffer;
          }
        }
        this.render();
      } catch (e) {
        console.warn("No audio in video or decode failed", e);
        for (let s of this.timeline.audioSegments) {
          if (s.id === audSegId || (blobUrl && s._blobUrl === blobUrl)) {
            s._decoding = false;
          }
        }
        this.render();
      }
    })();
  }

  _isAudioDecodingAllowed(seg) {
    if (seg.audioFile && seg.audioFile.toLowerCase().match(/\.(wav|mp3|ogg|flac|m4a)$/)) {
      return true;
    }
    const isVideo = (seg.audioFile && seg.audioFile.toLowerCase().match(/\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv)$/)) ||
      (!seg.audioFile && seg._blobUrl);
    if (isVideo) {
      const isSmall = seg.fileSize && seg.fileSize <= 100 * 1024 * 1024;
      return !!isSmall;
    }
    return true;
  }

  async _preloadAudioSegment(seg) {
    if (seg._audioBuffer || seg._decoding) return;
    if (!seg.audioFile && !seg._blobUrl) return;

    seg._decoding = true;
    if (!this._isDragging) this.render();

    try {
      await this._getOrExtractAudio(seg);

      if (!this._isAudioDecodingAllowed(seg)) {
        seg._decoding = false;
        return;
      }

      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }

      const parts = (seg.audioFile || "").split(/[/\\\\]/);
      const filename = parts.pop() || '';
      const subfolder = parts.join('/');
      const audioUrl = seg._blobUrl || api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

      this._audioBufferCache = this._audioBufferCache || new Map();
      this._audioBufferPromises = this._audioBufferPromises || new Map();
      const cacheKey = seg.audioFile || audioUrl;

      let audioBuffer;
      if (this._audioBufferCache.has(cacheKey)) {
        audioBuffer = this._audioBufferCache.get(cacheKey);
      } else if (this._audioBufferPromises.has(cacheKey)) {
        audioBuffer = await this._audioBufferPromises.get(cacheKey);
      } else {
        const decodePromise = (async () => {
          const resp = await fetch(audioUrl);
          const arrayBuffer = await resp.arrayBuffer();
          return await this.audioContext.decodeAudioData(arrayBuffer);
        })();
        this._audioBufferPromises.set(cacheKey, decodePromise);
        try {
          audioBuffer = await decodePromise;
          this._audioBufferCache.set(cacheKey, audioBuffer);
        } finally {
          this._audioBufferPromises.delete(cacheKey);
        }
      }

      // Only the clips that really are this file. A standalone audio clip never gets a
      // `_blobUrl`, and commitChanges strips the key from every segment it saves, so
      // `s._blobUrl === seg._blobUrl` read `undefined === undefined` for the whole track: on a
      // reloaded workflow one clip's buffer was stamped over every other clip, and the play
      // button played that one file at every clip's position. The waveforms stayed right,
      // which made it look like a limit on how many audio files fit.
      const matchingSegs = this.timeline.audioSegments.filter(
        s => (seg.audioFile && s.audioFile === seg.audioFile) ||
             (seg._blobUrl && s._blobUrl === seg._blobUrl));
      for (const s of matchingSegs) {
        s._audioBuffer = audioBuffer;
        s._decoding = false;
      }
    } catch (err) {
      console.warn("Failed to preload audio segment:", err);
      seg._decoding = false;
    } finally {
      if (!this._isDragging) this.render();
    }
  }


  async _preloadMotionAudioSegment(seg) {
    if (seg._audioBuffer || seg._decodingAudio) return;
    if (!seg.videoFile && !seg._blobUrl) return;

    seg._decodingAudio = true;

    try {
      const mockSeg = {
        audioFile: seg.videoFile || seg.fileName,
        _blobUrl: seg._blobUrl,
        fileSize: seg.fileSize
      };

      await this._getOrExtractAudio(mockSeg);

      if (!this._isAudioDecodingAllowed(mockSeg)) {
        seg._decodingAudio = false;
        return;
      }

      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }

      const parts = (mockSeg.audioFile || "").split(/[/\\\\]/);
      const filename = parts.pop() || '';
      const subfolder = parts.join('/');
      const audioUrl = mockSeg._blobUrl || api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

      this._audioBufferCache = this._audioBufferCache || new Map();
      this._audioBufferPromises = this._audioBufferPromises || new Map();
      const cacheKey = mockSeg.audioFile || audioUrl;

      let audioBuffer;
      if (this._audioBufferCache.has(cacheKey)) {
        audioBuffer = this._audioBufferCache.get(cacheKey);
      } else if (this._audioBufferPromises.has(cacheKey)) {
        audioBuffer = await this._audioBufferPromises.get(cacheKey);
      } else {
        const decodePromise = (async () => {
          const resp = await fetch(audioUrl);
          const arrayBuffer = await resp.arrayBuffer();
          return await this.audioContext.decodeAudioData(arrayBuffer);
        })();
        this._audioBufferPromises.set(cacheKey, decodePromise);
        try {
          audioBuffer = await decodePromise;
          this._audioBufferCache.set(cacheKey, audioBuffer);
        } finally {
          this._audioBufferPromises.delete(cacheKey);
        }
      }
      seg._audioBuffer = audioBuffer;
    } catch (e) {
      console.warn("Failed to preload motion audio segment:", e);
    } finally {
      seg._decodingAudio = false;
    }
  }


  loadMedia() {
    for (const seg of this.timeline.segments) {
      if (seg.imageB64 && !seg.imgObj) {
        seg.imgObj = new Image();
        seg.imgObj.onload = () => { if (!this._isDragging) this.render(); };
        seg.imgObj.src = seg.imageB64;
      }
      if (seg.type === "video") {
        this._ensureVideoEl(seg);
        this._ensureThumbnails(seg);
      }
    }

    if (this.timeline.motionSegments) {
      const isOverrideAudio = !!(this.node.properties.overrideAudio || this.timeline.overrideAudio);
      for (const seg of this.timeline.motionSegments) {
        if (seg.imageB64 && !seg.imgObj) {
          seg.imgObj = new Image();
          seg.imgObj.onload = () => { if (!this._isDragging) this.render(); };
          seg.imgObj.src = seg.imageB64;
        }
        if (seg.type === "motion_video") {
          this._ensureVideoEl(seg);
          this._ensureThumbnails(seg);
          if (isOverrideAudio) {
            this._preloadMotionAudioSegment(seg);
          }
        }
      }
    }

    if (this.timeline.audioSegments) {
      for (const seg of this.timeline.audioSegments) {
        if (seg.type === "audio") {
          this._preloadAudioSegment(seg);
        }
      }
    }

    if (this.timeline.retakeVideo) {
      this._ensureVideoEl(this.timeline.retakeVideo);
      this._ensureThumbnails(this.timeline.retakeVideo);
    }
  }

  createDOM() {
    this.wrapper = document.createElement("div");
    this.wrapper.className = "mmxd-wrapper";

    this.wrapper.addEventListener("mouseenter", () => { this._isHovering = true; });
    this.wrapper.addEventListener("mouseleave", () => { this._isHovering = false; });

    this.handleKeyDown = (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName : "";
      if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;

      const isCtrl = e.ctrlKey || e.metaKey;

      if ((e.key === "Delete" || e.key === "Backspace") && this.selectedIndex !== -1 && this._isHovering) {
        this.deleteSelectedSegment();
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === " " || e.code === "Space") && this._isHovering) {
        this.togglePlay();
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === "b" || e.key === "B") && isCtrl && this._isHovering) {
        if (this.selectedIndex !== -1) {
          const arr = this.getSegmentArray(this.selectionType);
          const seg = arr[this.selectedIndex];
          if (seg) this.splitSegmentAtPlayhead(seg, this.selectionType);
        }
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === "c" || e.key === "C") && isCtrl && this._isHovering) {
        if (this.selectedIndex !== -1) {
          const arr = this.getSegmentArray(this.selectionType);
          const seg = arr[this.selectedIndex];
          if (seg) {
            window._mmxCopiedSegmentCS = { main: { ...seg }, sibling: null };
            window._mmxCopiedSegmentTypeCS = this.selectionType;

            // Keep image/video elements
            if (seg.imgObj) window._mmxCopiedSegmentCS.main.imgObj = seg.imgObj;
            if (seg.videoEl) window._mmxCopiedSegmentCS.main.videoEl = seg.videoEl;

            if (seg.id.endsWith("_v") || seg.id.endsWith("_a")) {
              const isVid = seg.id.endsWith("_v");
              const sibId = isVid ? seg.id.slice(0, -2) + "_a" : seg.id.slice(0, -2) + "_v";
              const sibArr = isVid ? this.timeline.audioSegments : this.timeline.segments;
              const sib = sibArr.find(s => s.id === sibId);
              if (sib) {
                window._mmxCopiedSegmentCS.sibling = { ...sib };
                if (sib.imgObj) window._mmxCopiedSegmentCS.sibling.imgObj = sib.imgObj;
                if (sib.videoEl) window._mmxCopiedSegmentCS.sibling.videoEl = sib.videoEl;
              }
            }
          }
        }
      } else if ((e.key === "v" || e.key === "V") && isCtrl && this._isHovering) {
        if (window._mmxCopiedSegmentCS) {
          this.pasteCopiedSegment();
          e.stopPropagation();
          e.stopImmediatePropagation();
          e.preventDefault();
        }
      } else if ((e.key === "s" || e.key === "S") && !isCtrl && this._isHovering) {
        this.isSnapping = !this.isSnapping;
        this.node.properties.isSnapping = this.isSnapping;
        if (typeof this.updateSnapStyle === "function") {
          this.updateSnapStyle();
        }
        this.commitChanges();
        this.render();
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === "i" || e.key === "I") && !isCtrl && this._isHovering) {
        if (this.startFramesWidget) {
          this.startFramesWidget.value = this.currentFrame;
          if (this.startFramesWidget.callback) {
            this.startFramesWidget.callback(this.currentFrame);
          }
          this.commitChanges();
          this.render();
        }
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === "o" || e.key === "O") && !isCtrl && this._isHovering) {
        if (this.endFramesWidget) {
          this.endFramesWidget.value = this.currentFrame;
          if (this.endFramesWidget.callback) {
            this.endFramesWidget.callback(this.currentFrame);
          }
          this.commitChanges();
          this.render();
        }
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === "x" || e.key === "X") && !isCtrl && this._isHovering) {
        this.markCurrentSelection();
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", this.handleKeyDown, true);

    this.handlePaste = (e) => {
      if (this._isHovering) {
        const activeTag = document.activeElement ? document.activeElement.tagName : "";
        if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;

        if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
          const imageFiles = Array.from(e.clipboardData.files).filter(f => f.type.startsWith("image/"));
          if (imageFiles.length > 0) {
            this.handleImageUpload(imageFiles, this.currentFrame);
            e.preventDefault();
            e.stopPropagation();
          }
        }
      }
    };
    window.addEventListener("paste", this.handlePaste, true);

    // --- Toolbar ---
    const toolbar = document.createElement("div");
    toolbar.className = "mmxd-toolbar";

    const actionGroup = document.createElement("div");
    actionGroup.className = "mmxd-actions";

    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = "image/*";
    this.fileInput.multiple = true;
    this.fileInput.style.display = "none";
    this.fileInput.addEventListener("change", (e) => this.handleImageUpload(e.target.files));

    this.audioFileInput = document.createElement("input");
    this.audioFileInput.type = "file";
    this.audioFileInput.accept = "audio/*";
    this.audioFileInput.multiple = true;
    this.audioFileInput.style.display = "none";
    this.audioFileInput.addEventListener("change", (e) => this.handleAudioUpload(e.target.files));

    this.motionFileInput = document.createElement("input");
    this.motionFileInput.type = "file";
    this.motionFileInput.accept = "video/*";
    this.motionFileInput.multiple = true;
    this.motionFileInput.style.display = "none";
    this.motionFileInput.addEventListener("change", (e) => this.handleMotionUpload(e.target.files));

    this.videoFileInput = document.createElement("input");
    this.videoFileInput.type = "file";
    this.videoFileInput.accept = "video/*";
    this.videoFileInput.multiple = true;
    this.videoFileInput.style.display = "none";
    this.videoFileInput.addEventListener("change", (e) => this.handleVideoUpload(e.target.files));

    const uploadBtn = document.createElement("button");
    uploadBtn.className = "mmxd-btn";
    uploadBtn.innerHTML = `${ICONS.upload} Add Image`;
    uploadBtn.addEventListener("click", () => this.fileInput.click());
    this.uploadBtn = uploadBtn;

    const uploadAudioBtn = document.createElement("button");
    uploadAudioBtn.className = "mmxd-btn";
    uploadAudioBtn.innerHTML = `${ICONS.audio} Add Audio`;
    uploadAudioBtn.addEventListener("click", () => this.audioFileInput.click());
    this.uploadAudioBtn = uploadAudioBtn;

    const uploadMotionBtn = document.createElement("button");
    uploadMotionBtn.className = "mmxd-btn";
    uploadMotionBtn.innerHTML = `${ICONS.motion} Add Ref Video`;
    uploadMotionBtn.addEventListener("click", () => this.motionFileInput.click());
    this.uploadMotionBtn = uploadMotionBtn;

    const uploadVideoBtn = document.createElement("button");
    uploadVideoBtn.className = "mmxd-btn";
    uploadVideoBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> Add Video`;
    uploadVideoBtn.addEventListener("click", () => this.videoFileInput.click());
    this.uploadVideoBtn = uploadVideoBtn;

    const addTextBtn = document.createElement("button");
    addTextBtn.className = "mmxd-btn";
    addTextBtn.innerHTML = `${ICONS.text} Add Text`;
    addTextBtn.addEventListener("click", () => this.addTextSegmentFreeSpace());
    this.addTextBtn = addTextBtn;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "mmxd-btn mmxd-btn-danger";
    deleteBtn.innerHTML = `${ICONS.trash} Delete`;
    deleteBtn.addEventListener("click", () => this.deleteSelectedSegment());
    this.deleteBtn = deleteBtn;

    // --- Ref Option dropdown (sits to the right of Delete) ---
    // MiniMax H3 has two conditioning paths, each with its OWN diffusion weights:
    //   OFF    -> t2va / fl2va  (minimax_h3_fl2va_*)  : prompt + first/last keyframe
    //   REF2VA -> ref2va        (minimax_h3_ref2va_*) : <Picture i>/<Video k>/<Audio j> refs
    const REF_OPTIONS = [
      { value: "OFF", label: "Refs OFF (fl2va)" },
      { value: "REF2VA", label: "Refs ON (ref2va)" },
    ];
    const refOptionSelect = createMenuSelect(REF_OPTIONS, { width: "150px" });
    refOptionSelect.classList.add("mmxd-ref-option-select");
    refOptionSelect.title = "MiniMax H3 conditioning path.\nRefs OFF = t2va/fl2va model, keyframes only.\nRefs ON = ref2va model, character/video/audio references.";
    refOptionSelect.value = this.timeline.reference_mode || "OFF";
    refOptionSelect.addEventListener("change", (e) => {
      this.timeline.reference_mode = e.target.value;
      this.commitChanges();
      // the describes/retained strip only exists in ref2va, so it has to appear and
      // disappear with the switch rather than waiting for the next selection change —
      // and the subject panel swaps `retained` for `called` on the same switch
      this.updateUIFromSelection();
      this.updateCharacterSlotsUI();
      this._syncSummaryField();
    });
    this.refOptionSelect = refOptionSelect;

    actionGroup.appendChild(this.fileInput);
    actionGroup.appendChild(this.audioFileInput);
    actionGroup.appendChild(this.motionFileInput);
    actionGroup.appendChild(this.videoFileInput);
    actionGroup.appendChild(uploadBtn);
    actionGroup.appendChild(addTextBtn);
    actionGroup.appendChild(uploadAudioBtn);
    actionGroup.appendChild(uploadVideoBtn);
    actionGroup.appendChild(uploadMotionBtn);
    actionGroup.appendChild(deleteBtn);
    actionGroup.appendChild(refOptionSelect);

    // Retake-mode-only delete button (shown next to Add Video when retakeMode is on)
    const deleteRetakeBtn = document.createElement("button");
    deleteRetakeBtn.className = "mmxd-btn mmxd-btn-danger";
    deleteRetakeBtn.innerHTML = `${ICONS.trash} Delete`;
    deleteRetakeBtn.title = "Remove retake video";
    deleteRetakeBtn.style.display = "none"; // hidden until retakeMode + video loaded
    deleteRetakeBtn.addEventListener("click", () => {
      this._deleteRetakeVideo();
    });
    this.deleteRetakeBtn = deleteRetakeBtn;
    actionGroup.appendChild(deleteRetakeBtn);

    toolbar.appendChild(actionGroup);

    const rightGroup = document.createElement("div");
    rightGroup.className = "mmxd-right-group";

    this.segmentBoundsDisplay = document.createElement("div");
    this.segmentBoundsDisplay.className = "mmxd-segment-bounds";
    this.segmentBoundsDisplay.textContent = "Start: - | End: - | Length: -";

    this.timeCodeDisplay = document.createElement("div");
    this.timeCodeDisplay.className = "mmxd-timecode";
    this.timeCodeDisplay.textContent = this.formatTime(0);

    const settingsBtn = document.createElement("button");
    settingsBtn.className = "mmxd-btn";
    settingsBtn.style.padding = "6px";
    settingsBtn.style.display = "flex";
    settingsBtn.style.alignItems = "center";
    settingsBtn.style.justifyContent = "center";
    settingsBtn.style.width = "28px";
    settingsBtn.style.height = "28px";
    settingsBtn.style.boxSizing = "border-box";
    settingsBtn.innerHTML = ICONS.gear;
    settingsBtn.title = "Settings";
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this._settingsMenu) {
        this.dismissSettingsMenu();
      } else {
        this.showSettingsMenu(settingsBtn);
      }
    });

    const inpaintToggleBtn = document.createElement("button");
    inpaintToggleBtn.className = "mmxd-btn";
    inpaintToggleBtn.style.padding = "4px 0px";
    inpaintToggleBtn.style.fontSize = "9px";
    inpaintToggleBtn.style.lineHeight = "1";
    inpaintToggleBtn.style.marginRight = "0px";
    inpaintToggleBtn.style.marginTop = "8px"; // Adjust this value to fine-tune spacing between the title and button
    inpaintToggleBtn.style.width = "72px";
    inpaintToggleBtn.style.whiteSpace = "nowrap";
    inpaintToggleBtn.style.textAlign = "center";
    inpaintToggleBtn.style.justifyContent = "center";
    inpaintToggleBtn.style.alignItems = "center";
    inpaintToggleBtn.style.gap = "0px";
    inpaintToggleBtn.style.boxSizing = "border-box";
    inpaintToggleBtn.style.borderRadius = "2px";
    inpaintToggleBtn.textContent = "Inpaint: ON";
    inpaintToggleBtn.title = "Toggle Audio Inpainting in Gaps";
    // H3 generates its stereo audio jointly with the video in a single forward pass —
    // there is no audio latent to inpaint, so this control has nothing to act on.
    // Kept in the DOM (other code queries for it) but never shown.
    inpaintToggleBtn.style.display = "none";

    this.updateInpaintToggleStyle = (isOn) => {
      inpaintToggleBtn.textContent = isOn ? "Inpaint: ON" : "Inpaint: OFF";
      if (isOn) {
        inpaintToggleBtn.classList.add("toggle-on");
      } else {
        inpaintToggleBtn.classList.remove("toggle-on");
      }
    };

    this.syncInpaintState = () => {
      const customAudioWidget = this.node.widgets?.find(w => w.name === "use_custom_audio");
      if (customAudioWidget && !customAudioWidget.value) {
        inpaintToggleBtn.disabled = true;
        inpaintToggleBtn.style.opacity = "0.4";
        inpaintToggleBtn.style.cursor = "default";
        inpaintToggleBtn.title = "Audio Inpainting requires Custom Audio to be ON";
      } else {
        inpaintToggleBtn.disabled = false;
        inpaintToggleBtn.style.opacity = "1.0";
        inpaintToggleBtn.style.cursor = "pointer";
        inpaintToggleBtn.title = "Toggle Audio Inpainting in Gaps";
      }
    };



    inpaintToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (inpaintToggleBtn.disabled) return;
      const widget = this.node.widgets?.find(w => w.name === "inpaint_audio");
      if (widget) {
        widget.value = !widget.value;
        if (this.node.properties) {
          this.node.properties.inpaint_audio = widget.value;
        }
        this.updateInpaintToggleStyle(widget.value);
        this.commitChanges(true);
        this.node.setDirtyCanvas(true, true);
      }
    });

    // Initial state check (widgets might not be ready immediately)
    setTimeout(() => {
      const inpaintWidget = this.node.widgets?.find(w => w.name === "inpaint_audio");
      if (inpaintWidget) {
        this.updateInpaintToggleStyle(inpaintWidget.value);
      }
    }, 100);

    const overrideAudioToggleBtn = document.createElement("button");
    overrideAudioToggleBtn.className = "mmxd-btn";
    overrideAudioToggleBtn.style.padding = "4px 0px";
    overrideAudioToggleBtn.style.fontSize = "9px";
    overrideAudioToggleBtn.style.lineHeight = "1";
    overrideAudioToggleBtn.style.marginRight = "0px";
    overrideAudioToggleBtn.style.marginTop = "8px"; // Adjust this value to fine-tune spacing between the title and button
    overrideAudioToggleBtn.style.width = "72px";
    overrideAudioToggleBtn.style.whiteSpace = "nowrap";
    overrideAudioToggleBtn.style.textAlign = "center";
    overrideAudioToggleBtn.style.justifyContent = "center";
    overrideAudioToggleBtn.style.alignItems = "center";
    overrideAudioToggleBtn.style.gap = "0px";
    overrideAudioToggleBtn.style.boxSizing = "border-box";
    overrideAudioToggleBtn.style.borderRadius = "2px";
    overrideAudioToggleBtn.textContent = "Audio: OFF";
    overrideAudioToggleBtn.title = "Override Audio: use the reference video's own soundtrack as the timeline audio";

    this.updateOverrideAudioToggleStyle = (isOn) => {
      overrideAudioToggleBtn.textContent = isOn ? "Audio: ON" : "Audio: OFF";
      if (isOn) {
        overrideAudioToggleBtn.classList.add("toggle-on");
      } else {
        overrideAudioToggleBtn.classList.remove("toggle-on");
      }
    };

    overrideAudioToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (overrideAudioToggleBtn.disabled) return;
      const widget = this.node.widgets?.find(w => w.name === "override_audio");
      if (widget) {
        widget.value = !widget.value;
        this.node.properties.overrideAudio = widget.value;
        this.updateOverrideAudioToggleStyle(widget.value);

        if (widget.value) {
          // When this is toggled on, the audio track will automatically be disabled/muted.
          this._audioTrackWasEnabledBeforeOverride = this.audioTrackEnabled;
          this.audioTrackEnabled = false;
          updateTrackIcon(this.audioTrackLabel._eyeBtn, "audio", false);

          const customAudioWidget = this.node.widgets?.find(w => w.name === "use_custom_audio");
          if (customAudioWidget) {
            customAudioWidget.value = false;
            if (this.updateToggleStyle) this.updateToggleStyle(false);
          }

          inpaintToggleBtn.disabled = true;
          inpaintToggleBtn.style.opacity = "0.3";

          if (this.timeline.motionSegments) {
            for (const seg of this.timeline.motionSegments) {
              if (seg.type === "motion_video") {
                this._preloadMotionAudioSegment(seg);
              }
            }
          }
        } else {
          // When toggled off, restore the audio track status if it was previously enabled
          if (this._audioTrackWasEnabledBeforeOverride) {
            this.audioTrackEnabled = true;
            updateTrackIcon(this.audioTrackLabel._eyeBtn, "audio", true);

            const customAudioWidget = this.node.widgets?.find(w => w.name === "use_custom_audio");
            if (customAudioWidget) {
              customAudioWidget.value = true;
              if (this.updateToggleStyle) this.updateToggleStyle(true);
            }

            inpaintToggleBtn.disabled = false;
            inpaintToggleBtn.style.opacity = "1.0";
          }
          this._audioTrackWasEnabledBeforeOverride = false;
        }

        this.commitChanges(true);
        this.render();
      }
    });

    // Initial state check (widgets might not be ready immediately)
    setTimeout(() => {
      const overrideWidget = this.node.widgets?.find(w => w.name === "override_audio");
      if (overrideWidget) {
        this.updateOverrideAudioToggleStyle(overrideWidget.value);
      }
    }, 100);

    const helpBtn = document.createElement("button");
    helpBtn.className = "mmxd-btn";
    helpBtn.style.padding = "6px";
    helpBtn.style.display = "flex";
    helpBtn.style.alignItems = "center";
    helpBtn.style.justifyContent = "center";
    helpBtn.style.width = "28px";
    helpBtn.style.height = "28px";
    helpBtn.style.boxSizing = "border-box";
    helpBtn.innerHTML = ICONS.help;
    helpBtn.title = "Help / Documentation";
    helpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      window.open("https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director#readme", "_blank");
    });

    this.isSnapping = this.node.properties.isSnapping !== false;

    const snapBtn = document.createElement("button");
    snapBtn.className = "mmxd-btn";
    snapBtn.style.padding = "6px";
    snapBtn.style.display = "flex";
    snapBtn.style.alignItems = "center";
    snapBtn.style.justifyContent = "center";
    snapBtn.style.width = "28px";
    snapBtn.style.height = "28px";
    snapBtn.style.boxSizing = "border-box";
    snapBtn.innerHTML = ICONS.magnet;

    const updateSnapStyle = () => {
      snapBtn.title = this.isSnapping ? "Disable Snapping (Magnet)" : "Enable Snapping (Magnet)";
      if (this.isSnapping) {
        snapBtn.classList.add("toggle-on");
      } else {
        snapBtn.classList.remove("toggle-on");
      }
    };
    this.updateSnapStyle = updateSnapStyle;
    updateSnapStyle();

    snapBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.isSnapping = !this.isSnapping;
      this.node.properties.isSnapping = this.isSnapping;
      updateSnapStyle();
      this.commitChanges();
      this.render();
    });

    const startBtn = document.createElement("button");
    startBtn.className = "mmxd-btn";
    startBtn.style.padding = "6px";
    startBtn.style.display = "flex";
    startBtn.style.alignItems = "center";
    startBtn.style.justifyContent = "center";
    startBtn.style.width = "28px";
    startBtn.style.height = "28px";
    startBtn.style.boxSizing = "border-box";
    startBtn.innerHTML = ICONS.start;
    startBtn.title = "Set Start Frame";
    startBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.retakeMode) return;
      if (this.startFramesWidget) {
        this.startFramesWidget.value = this.currentFrame;
        if (this.startFramesWidget.callback) {
          this.startFramesWidget.callback(this.currentFrame);
        }
        this.commitChanges();
        this.render();
      }
    });

    const endBtn = document.createElement("button");
    endBtn.className = "mmxd-btn";
    endBtn.style.padding = "6px";
    endBtn.style.display = "flex";
    endBtn.style.alignItems = "center";
    endBtn.style.justifyContent = "center";
    endBtn.style.width = "28px";
    endBtn.style.height = "28px";
    endBtn.style.boxSizing = "border-box";
    endBtn.innerHTML = ICONS.end;
    endBtn.title = "Set End Frame";
    endBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.retakeMode) return;
      if (this.endFramesWidget) {
        this.endFramesWidget.value = this.currentFrame;
        if (this.endFramesWidget.callback) {
          this.endFramesWidget.callback(this.currentFrame);
        }
        this.commitChanges();
        this.render();
      }
    });

    const markBtn = document.createElement("button");
    markBtn.className = "mmxd-btn";
    markBtn.style.padding = "6px";
    markBtn.style.display = "flex";
    markBtn.style.alignItems = "center";
    markBtn.style.justifyContent = "center";
    markBtn.style.width = "28px";
    markBtn.style.height = "28px";
    markBtn.style.boxSizing = "border-box";
    markBtn.innerHTML = ICONS.mark;
    markBtn.title = "Mark Selection (X)";
    markBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.retakeMode) return;
      this.markCurrentSelection();
    });

    const retakeToggleBtn = document.createElement("button");
    retakeToggleBtn.className = "mmxd-btn";
    retakeToggleBtn.style.padding = "4px 8px";
    retakeToggleBtn.style.display = "flex";
    retakeToggleBtn.style.alignItems = "center";
    retakeToggleBtn.style.justifyContent = "center";
    retakeToggleBtn.style.gap = "6px";
    retakeToggleBtn.style.height = "28px";
    retakeToggleBtn.style.boxSizing = "border-box";
    retakeToggleBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg> <span>Retake Mode</span>`;

    const updateRetakeStyle = () => {
      retakeToggleBtn.title = this.retakeMode ? "Switch to Multi-Clip Timeline" : "Switch to Retake Tab";
      if (this.retakeMode) {
        retakeToggleBtn.classList.add("toggle-on");
      } else {
        retakeToggleBtn.classList.remove("toggle-on");
      }
    };
    this.updateRetakeStyle = updateRetakeStyle;
    updateRetakeStyle();

    retakeToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      
      // Stop and mute any active playback first
      this.pauseAudio();
      
      // Save current input value to the mode we are EXITING
      if (this.retakeMode) {
        this.timeline.retake_global_prompt = this.globalPromptInput ? this.globalPromptInput.value : "";
      } else {
        this.timeline.global_prompt = this.globalPromptInput ? this.globalPromptInput.value : "";
        // Backup normal mode values before entering Retake Mode
        this.timeline.normalStartFrame = this.getStartFrames();
        this.timeline.normalDurationFrames = this.getDurationFrames();
      }

      this.retakeMode = !this.retakeMode;
      this.timeline.retakeMode = this.retakeMode;
      if (this.node.properties) {
        this.node.properties.retakeMode = this.retakeMode;
      }

      // Adjust widgets for the new mode
      if (this.retakeMode) {
        if (this.timeline.retakeVideo && this.timeline.retakeVideo.videoDurationFrames) {
          this.syncWidgetsToRetakeDuration(this.timeline.retakeVideo.videoDurationFrames);
        }
      } else {
        // Restore normal mode backup
        this._suppressCommit = true;
        if (this.timeline.normalStartFrame !== undefined && this.startFramesWidget) {
          this.startFramesWidget.value = this.timeline.normalStartFrame;
          if (this.startFramesWidget.callback) {
            try { this.startFramesWidget.callback(this.timeline.normalStartFrame); } catch (_) {}
          }
        }
        if (this.timeline.normalDurationFrames !== undefined && this.durationFramesWidget) {
          this.durationFramesWidget.value = this.timeline.normalDurationFrames;
          if (this.durationFramesWidget.callback) {
            try { this.durationFramesWidget.callback(this.timeline.normalDurationFrames); } catch (_) {}
          }
        }
        this._suppressCommit = false;
      }

      this.updateRetakeUIState();
      this.commitChanges();
      this.render();
    });

    const btnGroup = document.createElement("div");
    btnGroup.style.display = "flex";
    btnGroup.style.gap = "6px";
    btnGroup.style.alignItems = "center";
    btnGroup.appendChild(retakeToggleBtn);
    btnGroup.appendChild(snapBtn);
    btnGroup.appendChild(startBtn);
    btnGroup.appendChild(endBtn);
    btnGroup.appendChild(markBtn);
    btnGroup.appendChild(helpBtn);
    btnGroup.appendChild(settingsBtn);
    rightGroup.appendChild(btnGroup);

    toolbar.appendChild(rightGroup);

    // --- Canvas & Viewport ---
    this.viewport = document.createElement("div");
    this.viewport.className = "mmxd-timeline-viewport";

    this.viewport.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();

        let zoomDelta = e.deltaY > 0 ? -0.5 : 0.5;
        this.zoomLevel = Math.max(1, Math.min(this.getMaxZoom(), this.zoomLevel + zoomDelta));
        if (this.zoomSlider) this.zoomSlider.value = this.zoomLevel;

        const oldWidth = this.canvas.offsetWidth;
        const newWidth = this.viewport.clientWidth * this.zoomLevel;
        const mouseX = e.clientX - this.viewport.getBoundingClientRect().left;
        const scrollRatio = (this.viewport.scrollLeft + mouseX) / oldWidth;

        this.canvas.style.width = newWidth + "px";
        this.viewport.scrollLeft = scrollRatio * newWidth - mouseX;

        if (this.node) this.node.setDirtyCanvas?.(true, true);
        else if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
      }
    }, { passive: false, capture: true });

    this.canvas = document.createElement("canvas");
    this.canvas.className = "mmxd-canvas";
    this.ctx = this.canvas.getContext("2d");
    this.canvas.style.width = "100%";

    this.viewport.appendChild(this.canvas);

    this.canvas.addEventListener("mousedown", (e) => this.onMouseDown(e));
    this.canvas.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    this.canvas.style.height = `${CANVAS_HEIGHT}px`;

    // --- Content Area Container ---
    if (!this.node.properties) this.node.properties = {};
    if (this.node.properties.showFilenames === undefined) {
      this.node.properties.showFilenames = (this.timeline.showFilenames !== undefined) ? this.timeline.showFilenames : true;
    }
    if (this.node.properties.showPromptZones === undefined) {
      this.node.properties.showPromptZones = (this.timeline.showPromptZones !== undefined) ? this.timeline.showPromptZones : true;
    }
    if (this.node.properties.overrideAudio === undefined) {
      this.node.properties.overrideAudio = (this.timeline.overrideAudio !== undefined) ? this.timeline.overrideAudio : false;
    }
    if (this.node.properties.propHeight === undefined && this.timeline.propHeight !== undefined) {
      this.node.properties.propHeight = this.timeline.propHeight;
    }
    this.initialPropHeight = this.node.properties.propHeight || 90;
    this.propHeight = this.initialPropHeight;

    const propContainer = document.createElement("div");
    propContainer.className = "mmxd-prop-container";
    propContainer.style.position = "relative";
    propContainer.style.flex = "none";
    propContainer.style.height = `${this.propHeight}px`;
    propContainer.style.marginBottom = "5px"; // Add some spacing between the two prompt boxes
    this.propContainer = propContainer;

    if (this.node.properties.globalPropHeight === undefined && this.timeline.globalPropHeight !== undefined) {
      this.node.properties.globalPropHeight = this.timeline.globalPropHeight;
    }
    if (!this.node.properties.globalPropHeight) this.node.properties.globalPropHeight = GLOBAL_PROP_MIN_H;
    // Workflows saved before the sound strip existed carry a height sized for the prompt
    // alone; without this the strip eats it and leaves an 8px sliver to type in.
    this.node.properties.globalPropHeight =
      Math.max(this.node.properties.globalPropHeight, GLOBAL_PROP_MIN_H);
    this.globalPropHeight = this.node.properties.globalPropHeight;

    const globalPropContainer = document.createElement("div");
    globalPropContainer.className = "mmxd-prop-container";
    globalPropContainer.style.position = "relative";
    globalPropContainer.style.flex = "none";
    globalPropContainer.style.height = `${this.globalPropHeight}px`;
    this.globalPropContainer = globalPropContainer;

    const globalPromptWrapper = document.createElement("div");
    globalPromptWrapper.className = "mmxd-prompt-wrapper";
    globalPromptWrapper.style.width = "100%";
    globalPromptWrapper.style.flex = "1 1 auto";
    globalPromptWrapper.style.minHeight = "0";

    this.globalPromptLabel = document.createElement("div");
    this.globalPromptLabel.className = "mmxd-prompt-label";
    this.globalPromptLabel.textContent = "Global Prompt";
    globalPromptWrapper.appendChild(this.globalPromptLabel);

    this.globalPromptInput = document.createElement("textarea");
    this.globalPromptInput.className = "mmxd-prompt-area";
    this.globalPromptInput.placeholder =
      "Enter global prompt here...  (Audio: / Music: lines are lifted into the two boxes below)";
    this.globalPromptInput.spellcheck = true;
    globalPromptWrapper.appendChild(this.globalPromptInput);

    // --- overall_soundscape / non_diegetic_music -------------------------------------
    // The base and ref guides both ask for these as their own sections rather than as
    // part of the shot description. They live in the timeline JSON and nowhere else, so
    // the COMPILED PROMPT panel and the node read one and the same value — the guarantee
    // the whole planner is built around. Adding node widgets for them would mean a third
    // copy to keep in step. Issue #7.
    const soundRow = document.createElement("div");
    soundRow.className = "mmxd-sound-row";

    const makeSoundField = (label, key, placeholder) => {
      const field = document.createElement("div");
      field.className = "mmxd-sound-field";

      const cap = document.createElement("div");
      cap.className = "mmxd-sound-label";
      cap.textContent = label;
      field.appendChild(cap);

      const area = document.createElement("textarea");
      area.className = "mmxd-sound-area";
      area.placeholder = placeholder;
      area.spellcheck = true;
      area.value = this.timeline?.[key] || "";
      field.appendChild(area);

      area.addEventListener("focus", () => {
        field.classList.add("focus-active");
        this.wrapper.classList.add("has-focus");
      });
      area.addEventListener("blur", () => {
        field.classList.remove("focus-active");
        this.wrapper.classList.remove("has-focus");
        if (saveTimeout) clearTimeout(saveTimeout);
        triggerAutoSave();
      });
      area.addEventListener("input", (e) => {
        this.timeline[key] = e.target.value;
        this.commitChanges(true);
        if (this.node?._mmxRefreshPrompt) this.node._mmxRefreshPrompt();
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(triggerAutoSave, 300);
      });

      soundRow.appendChild(field);
      return area;
    };

    this.globalPromptInput.addEventListener("focus", () => {
      globalPromptWrapper.classList.add("focus-active");
      this.wrapper.classList.add("has-focus");
    });
    this.globalPromptInput.addEventListener("blur", () => {
      globalPromptWrapper.classList.remove("focus-active");
      this.wrapper.classList.remove("has-focus");
    });
    let saveTimeout = null;
    const triggerAutoSave = () => {
      try {
        const canvasEl = app.canvasEl || app.canvas?.canvas;
        if (canvasEl) {
          canvasEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
        }
        if (app.canvas && app.canvas.checkState) app.canvas.checkState();
        if (app.canvas && app.canvas.captureCanvasState) app.canvas.captureCanvasState();
      } catch (_) { }
    };

    // built here rather than above, so the two fields share the global prompt's autosave
    // debounce instead of declaring a second one
    this.soundscapeInput = makeSoundField(
      "overall_soundscape", "overall_soundscape",
      "Ambience and physical sound across the whole video. Dialogue and shot-synced effects belong in the prompt above.");
    this.musicInput = makeSoundField(
      "non_diegetic_music", "non_diegetic_music",
      "Score only the audience hears. Name instrumentation, tempo and dynamics, or write N/A.");
    // The reference guide's own section, and the one place the [task type] prefix can
    // hang. Same field pattern as the two above for the same reason: one value, read by
    // both the node and the live preview, with no second copy to fall out of step.
    this.summaryInput = makeSoundField(
      "summary", "summary",
      "One paragraph on the target video and what each reference is for. The [task type] prefix is added for you.");
    // ...and only the reference guide has it. The base guide's structure is closed —
    // the alignment instruction, then three required core fields — so with refs off the
    // box would offer a section the prompt cannot carry. The text is kept either way.
    this.summaryField = this.summaryInput.parentElement;
    this._syncSummaryField();

    this.globalPromptInput.addEventListener("input", (e) => {
      const val = e.target.value;
      this.syncGlobalPrompt(val);

      if (this.selectionType === "motion") {
        this.promptInput.value = val;
      }
      this.commitChanges(true);
      this.render();

      // Debounce ComfyUI auto-save by 300ms to avoid lag while typing
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(triggerAutoSave, 300);
    });

    this.globalPromptInput.addEventListener("blur", () => {
      if (saveTimeout) clearTimeout(saveTimeout);
      triggerAutoSave();
    });

    const globalPropResizer = document.createElement("div");
    globalPropResizer.style.position = "absolute";
    globalPropResizer.style.bottom = "0px";
    globalPropResizer.style.left = "0px";
    globalPropResizer.style.width = "100%";
    globalPropResizer.style.height = "12px"; // Hit area
    globalPropResizer.style.cursor = "ns-resize";
    globalPropResizer.style.display = "flex";
    globalPropResizer.style.justifyContent = "center";
    globalPropResizer.style.alignItems = "flex-end";
    globalPropResizer.style.paddingBottom = "4px";
    globalPropResizer.style.zIndex = "10";
    globalPropResizer.innerHTML = `<div style="width: 40px; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px;"></div>`;

    let isGlobalResizing = false;
    let startGlobalY = 0;
    let startGlobalH = 0;

    globalPropResizer.addEventListener("mousedown", (ev) => {
      isGlobalResizing = true;
      startGlobalY = ev.clientY;
      startGlobalH = this.globalPropHeight;
      ev.stopPropagation();
      ev.preventDefault();
    });

    document.addEventListener("mousemove", (ev) => {
      if (isGlobalResizing) {
        const newH = Math.max(GLOBAL_PROP_MIN_H, startGlobalH + (ev.clientY - startGlobalY));
        this.globalPropHeight = newH;
        this.node.properties.globalPropHeight = newH;
        globalPropContainer.style.height = `${newH}px`;

        if (this.node && this.node.computeSize) {
          const sz = this.node.computeSize();
          this.node.size[1] = sz[1];
          if (window.app && window.app.graph) {
            window.app.graph.setDirtyCanvas(true, true);
          }
        }
      }
    });

    document.addEventListener("mouseup", () => {
      if (isGlobalResizing) {
        isGlobalResizing = false;
      }
    });

    globalPropContainer.appendChild(globalPromptWrapper);
    globalPropContainer.appendChild(soundRow);
    globalPropContainer.appendChild(globalPropResizer);

    const propResizer = document.createElement("div");
    propResizer.style.position = "absolute";
    propResizer.style.bottom = "0px";
    propResizer.style.left = "0px";
    propResizer.style.width = "100%";
    propResizer.style.height = "12px"; // Hit area
    propResizer.style.cursor = "ns-resize";
    propResizer.style.display = "flex";
    propResizer.style.justifyContent = "center";
    propResizer.style.alignItems = "flex-end";
    propResizer.style.paddingBottom = "4px";
    propResizer.innerHTML = `<div style="width: 40px; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px;"></div>`;

    propResizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = this.propHeight;

      const doDrag = (ev) => {
        if (ev.buttons === 0) {
          stopDrag();
          return;
        }
        const newH = Math.max(this._propMinH(), startH + (ev.clientY - startY));
        this.propHeight = newH;
        this.node.properties.propHeight = newH;
        propContainer.style.height = `${newH}px`;

        if (this.node && this.node.computeSize) {
          const sz = this.node.computeSize();
          this.node.size[1] = sz[1];
          if (window.app && window.app.graph) {
            window.app.graph.setDirtyCanvas(true, true);
          }
        }
      };

      const stopDrag = () => {
        window.removeEventListener("mousemove", doDrag, true);
        window.removeEventListener("mouseup", stopDrag, true);
        document.body.style.cursor = "default";
      };

      document.body.style.cursor = "ns-resize";
      window.addEventListener("mousemove", doDrag, true);
      window.addEventListener("mouseup", stopDrag, true);
    });

    // --- Text Area (Image/Text) ---
    this.promptWrapper = document.createElement("div");
    this.promptWrapper.className = "mmxd-prompt-wrapper";
    this.promptWrapper.style.width = "100%";
    // flex rather than height:100% so the reference-note strip below can take its own
    // room when it is shown, and give it straight back when it is hidden
    this.promptWrapper.style.flex = "1 1 auto";
    this.promptWrapper.style.minHeight = "0";
    this.promptWrapper.style.display = "none";

    this.segmentPromptLabel = document.createElement("div");
    this.segmentPromptLabel.className = "mmxd-prompt-label";
    this.segmentPromptLabel.textContent = "Segment Prompt";
    this.promptWrapper.appendChild(this.segmentPromptLabel);

    this.promptInput = document.createElement("textarea");
    this.promptInput.className = "mmxd-prompt-area";
    this.promptInput.placeholder = "No segment selected!";
    this.promptInput.style.opacity = "0.4";
    this.promptWrapper.appendChild(this.promptInput);

    this.promptInput.addEventListener("focus", () => {
      this.promptWrapper.classList.add("focus-active");
      this.wrapper.classList.add("has-focus");
    });
    this.promptInput.addEventListener("blur", () => {
      this.promptWrapper.classList.remove("focus-active");
      this.wrapper.classList.remove("has-focus");
    });

    this.promptInput.addEventListener("input", () => {
      if (this.retakeMode) {
        this.timeline.retakePrompt = this.promptInput.value;
        this.commitChanges();
        return;
      }
      if (this.selectionType === "image" && this.timeline.segments[this.selectedIndex]) {
        this.timeline.segments[this.selectedIndex].prompt = this.promptInput.value;
        this.commitChanges();
      } else if (this.selectionType === "motion") {
        const val = this.promptInput.value;
        if (this.globalPromptInput) {
          this.globalPromptInput.value = val;
        }
        this.syncGlobalPrompt(val);
        this.commitChanges(true);
        this.render();

        // Debounce ComfyUI auto-save by 300ms to avoid lag while typing
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(triggerAutoSave, 300);
      }
    });

    // --- Motion Info Area ---
    this.motionInfoArea = document.createElement("div");
    this.motionInfoArea.className = "mmxd-motion-info";

    // --- Audio Info Area ---
    this.audioInfoArea = document.createElement("div");
    this.audioInfoArea.className = "mmxd-audio-info";

    // --- Reference note strip -------------------------------------------------------
    // Sits in propContainer beside the prompt box rather than inside it, because the
    // audio branch of updateUIFromSelection hides promptWrapper outright — and an audio
    // clip is exactly one of the references that needs a retention note.
    this.refNoteRow = document.createElement("div");
    this.refNoteRow.className = "mmxd-ref-note-row";
    this.refNoteRow.style.display = "none";

    const makeRefNoteField = (label, placeholder) => {
      const field = document.createElement("div");
      field.className = "mmxd-sound-field";

      const cap = document.createElement("div");
      cap.className = "mmxd-sound-label";
      cap.textContent = label;
      field.appendChild(cap);

      const area = document.createElement("textarea");
      area.className = "mmxd-sound-area";
      area.placeholder = placeholder;
      area.spellcheck = true;
      area.addEventListener("focus", () => {
        field.classList.add("focus-active");
        this.wrapper.classList.add("has-focus");
      });
      area.addEventListener("blur", () => {
        field.classList.remove("focus-active");
        this.wrapper.classList.remove("has-focus");
      });
      field.appendChild(area);
      this.refNoteRow.appendChild(field);
      return { field, area };
    };

    const descField = makeRefNoteField(
      "describes", "what this image defines, e.g. a long red wool coat");
    const noteField = makeRefNoteField(
      "retained", "what survives into the video — leave empty for the default");
    this.refDescField = descField.field;
    this.refDescInput = descField.area;
    this.refNoteInput = noteField.area;

    // Write to the timeline array, never to the segment object the selection handed us:
    // while a drag is in flight that is a preview clone and the edit would be discarded.
    const writeRefText = (key, value) => {
      const list = this.getSegmentArray(this.selectionType);
      const target = list && list[this.selectedIndex];
      if (!target) return;
      target[key] = value;
      this.commitChanges(true);
      if (this.node?._mmxRefreshPrompt) this.node._mmxRefreshPrompt();
    };
    this.refDescInput.addEventListener("input",
      () => writeRefText("refDesc", this.refDescInput.value));
    this.refNoteInput.addEventListener("input",
      () => writeRefText("refNote", this.refNoteInput.value));

    // --- Reference video limits ------------------------------------------------------
    // The two numbers that decide how much of a clip is encoded, and the resolution it is
    // encoded at. They edit the segment's own trim and length rather than shadowing them,
    // so the track keeps showing exactly what will be sent.
    this.refLimitsRow = document.createElement("div");
    this.refLimitsRow.className = "mmxd-ref-limits-row";
    this.refLimitsRow.style.display = "none";

    const limitField = (caption, title, onCommit) => {
      const label = document.createElement("label");
      label.textContent = caption;
      label.title = title;
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "1";
      input.title = title;
      const commit = () => {
        const list = this.getSegmentArray(this.selectionType);
        const target = list && list[this.selectedIndex];
        if (!target) return;
        onCommit(target, Math.max(0, Math.round(parseFloat(input.value) || 0)));
        this.commitChanges(true);
        this.render();
        this.updateUIFromSelection();
        if (this.node?._mmxRefreshPrompt) this.node._mmxRefreshPrompt();
      };
      input.addEventListener("change", commit);
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();                       // the canvas eats arrows and Delete
        if (e.key === "Enter") input.blur();
      });
      label.appendChild(input);
      this.refLimitsRow.appendChild(label);
      return input;
    };

    this.refStartInput = limitField("start", "First frame taken from the source clip.",
      (seg, value) => {
        const source = seg.videoDurationFrames || 0;
        seg.trimStart = source ? Math.min(value, Math.max(0, source - 1)) : value;
        // never let the trim run past the end of the source
        if (source) seg.length = Math.max(1, Math.min(seg.length, source - seg.trimStart));
      });

    this.refFramesInput = limitField("frames",
      "How many frames are encoded. Fewer frames is less memory, and at 24 fps this is "
      + "the clip's length in the video.",
      (seg, value) => {
        const source = seg.videoDurationFrames || 0;
        let next = Math.max(1, value);
        if (source) next = Math.min(next, Math.max(1, source - (seg.trimStart || 0)));
        // stop short of the next clip on the track rather than overlapping it
        const later = (this.timeline.motionSegments || [])
          .filter(s => s.id !== seg.id && s.start > seg.start)
          .sort((a, b) => a.start - b.start)[0];
        if (later) next = Math.min(next, Math.max(1, later.start - seg.start));
        seg.length = next;
      });

    this.refSizeSelect = createMenuSelect(
      REF_VIDEO_SIZES.map(v => ({ value: String(v), label: `${v}px` })), { width: "76px" });
    this.refSizeSelect.title =
      "Short edge the clip is decoded at. Memory goes with the square of this, so it is "
      + "the biggest lever on an out-of-memory render — 384 is about a quarter of 768.";
    this.refSizeSelect.addEventListener("change", () => {
      const list = this.getSegmentArray(this.selectionType);
      const target = list && list[this.selectedIndex];
      if (!target) return;
      target.refSize = parseInt(this.refSizeSelect.value, 10);
      this.commitChanges(true);
    });
    const sizeLabel = document.createElement("label");
    sizeLabel.textContent = "size";
    sizeLabel.appendChild(this.refSizeSelect);
    this.refLimitsRow.appendChild(sizeLabel);

    this.refLimitsNote = document.createElement("span");
    this.refLimitsNote.className = "mmxd-ref-limits-note";
    this.refLimitsRow.appendChild(this.refLimitsNote);

    propContainer.appendChild(this.promptWrapper);
    propContainer.appendChild(this.motionInfoArea);
    propContainer.appendChild(this.audioInfoArea);
    propContainer.appendChild(this.refLimitsRow);
    propContainer.appendChild(this.refNoteRow);
    propContainer.appendChild(propResizer);

    this.wrapper.addEventListener("dragover", (e) => {
      e.preventDefault();
      this.wrapper.classList.add("drag-active");

      if (this.retakeMode) {
        return; // Skip ghost segments rendering when in retakeMode
      }

      const { x, y } = this.getMousePos(e);
      const logicalWidth = this.canvas.offsetWidth;
      const totalFrames = this.getVisualDurationFrames();
      if (!logicalWidth || totalFrames <= 0) return;

      const trackType = this.getTrackFromY(y);
      const arrToModify = this.getSegmentArray(trackType);

      if (!this._ghostSegmentId || this._ghostTrack !== trackType) {
        this._ghostSegmentId = "GHOST_" + Date.now();
        this._ghostTrack = trackType;
        this._ghostInitialTimeline = arrToModify.map(s => ({ ...s }));

        const frameRate = this.getFrameRate();
        const newLength = Math.max(1, frameRate * 1);

        let mouseFrameX = x * (totalFrames / logicalWidth);
        let startFrame = clamp(Math.round(mouseFrameX - newLength / 2), 0, totalFrames - newLength);

        this._ghostInitialTimeline.push({
          id: this._ghostSegmentId,
          start: startFrame,
          length: newLength,
          type: "ghost"
        });
      }

      let mouseFrameX = x * (totalFrames / logicalWidth);
      const ghost = this._ghostInitialTimeline.find(s => s.id === this._ghostSegmentId);
      let D_mouse_start = mouseFrameX - ghost.length / 2;

      this._previewSegments = this._applyCenterDragPhysics(
        this._ghostInitialTimeline,
        this._ghostSegmentId,
        D_mouse_start,
        mouseFrameX,
        totalFrames,
        totalFrames,
        logicalWidth
      );

      for (let ps of this._previewSegments) {
        const orig = arrToModify.find(s => s.id === ps.id);
        if (orig) {
          ps.videoEl = orig.videoEl;
          ps.imgObj = orig.imgObj;
          if (orig.thumbnails) ps.thumbnails = orig.thumbnails;
        }
      }

      this.render();
    });

    this.wrapper.addEventListener("dragleave", (e) => {
      const rect = this.wrapper.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX >= rect.right ||
        e.clientY < rect.top || e.clientY >= rect.bottom) {
        this.wrapper.classList.remove("drag-active");
        this._ghostSegmentId = null;
        this._ghostTrack = null;
        this._ghostInitialTimeline = null;
        this._previewSegments = null;
        this.render();
      }
    });

    this.wrapper.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.wrapper.classList.remove("drag-active");

      let targetFrameStart = null;
      let targetTrack = this._ghostTrack || "image";

      if (this._ghostSegmentId && this._previewSegments) {
        const ghost = this._previewSegments.find(s => s.id === this._ghostSegmentId);
        if (ghost) {
          targetFrameStart = ghost.resolvedStart !== undefined ? ghost.resolvedStart : ghost.start;
        }
      }
      this._ghostSegmentId = null;
      this._ghostTrack = null;
      this._ghostInitialTimeline = null;
      this._previewSegments = null;
      this.render();

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const imageFiles = [];
        const audioFiles = [];
        const videoFiles = [];
        for (let file of e.dataTransfer.files) {
          if (file.type.startsWith("video/")) videoFiles.push(file);
          else if (file.type.startsWith("audio/")) audioFiles.push(file);
          else if (file.type.startsWith("image/")) imageFiles.push(file);
        }

        // Let implicit intent handle mixing drops: use the track we hovered over
        // for the first type we process, or fallback.
        if (videoFiles.length > 0) {
          if (targetTrack === "motion") {
            this.handleMotionUpload(videoFiles, targetFrameStart);
          } else {
            this.handleVideoUpload(videoFiles, targetFrameStart);
          }
        } else if (audioFiles.length > 0 && (targetTrack === "audio" || imageFiles.length === 0)) {
          this.handleAudioUpload(audioFiles, targetFrameStart);
        } else if (imageFiles.length > 0) {
          this.handleImageUpload(imageFiles, targetFrameStart);
        }
      }
    });

    window.addEventListener("mousemove", (e) => this.onMouseMove(e));
    window.addEventListener("mouseup", (e) => this.onMouseUp(e));

    // --- Player Controls ---
    const playerControls = document.createElement("div");
    playerControls.className = "mmxd-player-controls";

    this.playBtn = document.createElement("button");
    this.playBtn.className = "mmxd-icon-btn";
    this.playBtn.style.padding = "4px";
    this.playBtn.innerHTML = ICONS.play;
    this.playBtn.title = "Play/Pause Audio";
    this.playBtn.addEventListener("click", () => this.togglePlay());

    this.loopBtn = document.createElement("button");
    this.loopBtn.className = "mmxd-icon-btn";
    this.loopBtn.style.padding = "4px";
    this.loopBtn.innerHTML = ICONS.loop;
    this.loopBtn.title = "Toggle Loop";
    this.loopBtn.addEventListener("click", () => this.toggleLoop());

    this.seekBar = document.createElement("input");
    this.seekBar.type = "range";
    this.seekBar.className = "mmxd-seek-bar";
    this.seekBar.min = "0";
    this.seekBar.value = "0";
    this.seekBar.style.flex = "1"; // take up remaining space
    this.seekBar.addEventListener("input", (e) => {
      let val = parseInt(e.target.value, 10);
      if (this.retakeMode && this.timeline.retakeVideo) {
        const baseVideoDur = this.timeline.retakeVideo.videoDurationFrames || 0;
        if (val > baseVideoDur) {
          val = baseVideoDur;
          this.seekBar.value = val;
        }
      }
      this.currentFrame = val;
      this.updateSeekBarBackground();
      this.render();
      if (this.isPlaying) {
        this.playAudio();
      }
    });

    // --- Zoom Controls ---
    const zoomControls = document.createElement("div");
    zoomControls.className = "mmxd-zoom-controls";

    const zoomOutBtn = document.createElement("button");
    zoomOutBtn.className = "mmxd-icon-btn";
    zoomOutBtn.style.padding = "4px";
    zoomOutBtn.innerHTML = ICONS.minus;
    zoomOutBtn.title = "Zoom Out";
    zoomOutBtn.addEventListener("click", () => {
      const currentZoom = parseFloat(this.zoomSlider.value);
      this.zoomSlider.value = Math.max(1, currentZoom - 0.5);
      this.zoomSlider.dispatchEvent(new Event("input"));
    });

    this.zoomSlider = document.createElement("input");
    this.zoomSlider.type = "range";
    this.zoomSlider.className = "mmxd-zoom-slider";
    this.zoomSlider.min = "1";
    this.zoomSlider.max = "1"; // Updated dynamically via updateZoomSliderMax()
    this.zoomSlider.step = "0.1";
    this.zoomSlider.value = "1";
    this.zoomSlider.title = "Zoom Level";
    this.zoomSlider.addEventListener("input", (e) => {
      this.zoomLevel = parseFloat(e.target.value);

      const viewportWidth = this.viewport.clientWidth;
      const newCanvasWidth = Math.max(viewportWidth, viewportWidth * this.zoomLevel);

      this.canvas.style.width = newCanvasWidth + "px";
      this.resizeCanvas(newCanvasWidth);
      this._lastWidth = viewportWidth;
      this._lastZoom = this.zoomLevel;

      // Keep playhead centered
      const totalFrames = this.getVisualDurationFrames();
      const playheadRatio = this.currentFrame / totalFrames;
      const newPlayheadX = playheadRatio * newCanvasWidth;
      this.viewport.scrollLeft = newPlayheadX - (viewportWidth / 2);

      if (this.node) this.node.setDirtyCanvas?.(true, true);
      else if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
    });

    const zoomInBtn = document.createElement("button");
    zoomInBtn.className = "mmxd-icon-btn";
    zoomInBtn.style.padding = "4px";
    zoomInBtn.innerHTML = ICONS.plus;
    zoomInBtn.title = "Zoom In";
    zoomInBtn.addEventListener("click", () => {
      const currentZoom = parseFloat(this.zoomSlider.value);
      this.zoomSlider.value = Math.min(this.getMaxZoom(), currentZoom + 0.5);
      this.zoomSlider.dispatchEvent(new Event("input"));
    });

    const zoomFitBtn = document.createElement("button");
    zoomFitBtn.className = "mmxd-icon-btn";
    zoomFitBtn.style.padding = "4px";
    zoomFitBtn.style.marginLeft = "4px";
    zoomFitBtn.innerHTML = ICONS.fit;
    zoomFitBtn.title = "Zoom to Fit (show full timeline)";
    zoomFitBtn.addEventListener("click", () => {
      this.zoomLevel = 1;
      this.zoomSlider.value = 1;
      const viewportWidth = this.viewport.clientWidth;
      this.canvas.style.width = viewportWidth + "px";
      this.resizeCanvas(viewportWidth);
      this._lastWidth = viewportWidth;
      this._lastZoom = 1;
      this.viewport.scrollLeft = 0;

      if (this.node) this.node.setDirtyCanvas?.(true, true);
      else if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
    });

    zoomControls.appendChild(zoomOutBtn);
    zoomControls.appendChild(this.zoomSlider);
    zoomControls.appendChild(zoomInBtn);
    zoomControls.appendChild(zoomFitBtn);

    playerControls.appendChild(this.playBtn);
    playerControls.appendChild(this.loopBtn);
    playerControls.appendChild(this.seekBar);
    playerControls.appendChild(zoomControls);



    // --- Guide Strength Slider ---
    this.strengthRow = document.createElement("div");
    this.strengthRow.className = "mmxd-strength-row";

    this.strengthLabel = document.createElement("span");
    this.strengthLabel.className = "mmxd-strength-label";
    this.strengthLabel.textContent = "Guide Strength:";

    this.strengthValue = document.createElement("input");
    this.strengthValue.type = "text";
    this.strengthValue.className = "mmxd-strength-input";
    this.strengthValue.value = "1.00";
    this.strengthValue.disabled = true;
    this.strengthValue.style.cursor = "ew-resize";

    this.vidStrLabel = document.createElement("span");
    this.vidStrLabel.className = "mmxd-strength-label";
    this.vidStrLabel.textContent = "Video Strength:";
    this.vidStrLabel.style.display = "none";

    this.vidStrValue = document.createElement("input");
    this.vidStrValue.type = "text";
    this.vidStrValue.className = "mmxd-strength-input";
    this.vidStrValue.value = "1.00";
    this.vidStrValue.style.display = "none";
    this.vidStrValue.style.width = "40px";
    this.vidStrValue.style.cursor = "ew-resize";

    this.vidAttnLabel = document.createElement("span");
    this.vidAttnLabel.className = "mmxd-strength-label";
    this.vidAttnLabel.textContent = "Video Attn:";
    this.vidAttnLabel.style.display = "none";
    this.vidAttnLabel.style.marginLeft = "10px";

    this.vidAttnValue = document.createElement("input");
    this.vidAttnValue.type = "text";
    this.vidAttnValue.className = "mmxd-strength-input";
    this.vidAttnValue.value = "0.65";
    this.vidAttnValue.style.display = "none";
    this.vidAttnValue.style.width = "40px";
    this.vidAttnValue.style.cursor = "ew-resize";

    this.vidStrValue.addEventListener("change", (e) => {
      let val = parseFloat(e.target.value);
      if (isNaN(val)) val = 1.0;
      val = Math.max(0, Math.min(1, val));
      this.vidStrValue.value = val.toFixed(2);
      if (this.selectionType === "motion" && this.timeline.motionSegments[this.selectedIndex]) {
        this.timeline.motionSegments[this.selectedIndex].videoStrength = val;
        this.commitChanges();
      }
    });

    this.vidAttnValue.addEventListener("change", (e) => {
      let val = parseFloat(e.target.value);
      if (isNaN(val)) val = 0.65;
      val = Math.max(0, Math.min(1, val));
      this.vidAttnValue.value = val.toFixed(2);
      if (this.selectionType === "motion" && this.timeline.motionSegments[this.selectedIndex]) {
        this.timeline.motionSegments[this.selectedIndex].videoAttentionStrength = val;
        this.commitChanges();
      }
    });

    // Dragging logic for video strength
    this.vidStrValue.addEventListener("mousedown", (e) => {
      if (this.vidStrValue.disabled) return;
      const vStrStartX = e.clientX;
      const vStrStartVal = parseFloat(this.vidStrValue.value) || 1.0;
      let vStrHasMoved = false;
      let vStrIsDragging = false;

      const onMouseMove = (moveEvent) => {
        const deltaX = moveEvent.clientX - vStrStartX;
        if (Math.abs(deltaX) > 3) {
          vStrHasMoved = true;
          vStrIsDragging = true;
        }

        if (vStrIsDragging) {
          moveEvent.preventDefault();
          const sensitivity = 0.002;
          let newVal = vStrStartVal + deltaX * sensitivity;

          if (newVal < 0) newVal = 0;
          if (newVal > 1) newVal = 1;

          this.vidStrValue.value = newVal.toFixed(2);

          if (this.selectionType === "motion" && this.timeline.motionSegments[this.selectedIndex]) {
            this.timeline.motionSegments[this.selectedIndex].videoStrength = newVal;
            this.commitChanges();
          }
        }
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);

        if (!vStrHasMoved) {
          this.vidStrValue.focus();
          this.vidStrValue.select();
        }
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    // Dragging logic for video attention strength
    this.vidAttnValue.addEventListener("mousedown", (e) => {
      if (this.vidAttnValue.disabled) return;
      const vAttnStartX = e.clientX;
      const vAttnStartVal = parseFloat(this.vidAttnValue.value) || 0.65;
      let vAttnHasMoved = false;
      let vAttnIsDragging = false;

      const onMouseMove = (moveEvent) => {
        const deltaX = moveEvent.clientX - vAttnStartX;
        if (Math.abs(deltaX) > 3) {
          vAttnHasMoved = true;
          vAttnIsDragging = true;
        }

        if (vAttnIsDragging) {
          moveEvent.preventDefault();
          const sensitivity = 0.002;
          let newVal = vAttnStartVal + deltaX * sensitivity;

          if (newVal < 0) newVal = 0;
          if (newVal > 1) newVal = 1;

          this.vidAttnValue.value = newVal.toFixed(2);

          if (this.selectionType === "motion" && this.timeline.motionSegments[this.selectedIndex]) {
            this.timeline.motionSegments[this.selectedIndex].videoAttentionStrength = newVal;
            this.commitChanges();
          }
        }
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);

        if (!vAttnHasMoved) {
          this.vidAttnValue.focus();
          this.vidAttnValue.select();
        }
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    // Dragging logic for guide strength
    let isDragging = false;
    let startX = 0;
    let startVal = 0;
    let hasMoved = false;

    this.strengthValue.addEventListener("mousedown", (e) => {
      if (this.strengthValue.disabled) return;
      startX = e.clientX;
      startVal = parseFloat(this.strengthValue.value) || 1.0;
      hasMoved = false;

      const onMouseMove = (moveEvent) => {
        const deltaX = moveEvent.clientX - startX;
        if (Math.abs(deltaX) > 3) {
          hasMoved = true;
          isDragging = true;
        }

        if (isDragging) {
          moveEvent.preventDefault();
          const sensitivity = 0.002;
          let newVal = startVal + deltaX * sensitivity;

          if (newVal < 0) newVal = 0;
          if (newVal > 1) newVal = 1;

          this.strengthValue.value = newVal.toFixed(2);

          if (this.retakeMode) {
            this.timeline.retakeStrength = newVal;
            this.commitChanges();
          } else if (this.selectionType === "image" && this.timeline.segments[this.selectedIndex]) {
            const seg = this.timeline.segments[this.selectedIndex];
            if (seg.type !== "text") {
              seg.guideStrength = newVal;
              this.commitChanges();
            }
          }
        }
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);

        if (!hasMoved) {
          this.strengthValue.focus();
          this.strengthValue.select();
        }
        isDragging = false;
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    this.strengthValue.addEventListener("change", (e) => {
      let val = parseFloat(e.target.value);
      if (isNaN(val)) val = 1;
      val = Math.max(0, Math.min(1, val));
      this.strengthValue.value = val.toFixed(2);
      if (this.retakeMode) {
        this.timeline.retakeStrength = val;
        this.commitChanges();
      } else if (this.selectionType === "image" && this.timeline.segments[this.selectedIndex]) {
        const seg = this.timeline.segments[this.selectedIndex];
        if (seg.type !== "text") {
          seg.guideStrength = val;
          this.commitChanges();
        }
      }
    });

    this.strengthRow.appendChild(this.timeCodeDisplay);
    this.strengthRow.appendChild(this.segmentBoundsDisplay);
    this.strengthRow.appendChild(this.strengthLabel);
    this.strengthRow.appendChild(this.strengthValue);
    this.strengthRow.appendChild(this.vidStrLabel);
    this.strengthRow.appendChild(this.vidStrValue);
    this.strengthRow.appendChild(this.vidAttnLabel);
    this.strengthRow.appendChild(this.vidAttnValue);



    // Layout container for sidebar + viewport
    this.layoutContainer = document.createElement("div");
    this.layoutContainer.className = "mmxd-timeline-layout";
    this.layoutContainer.style.display = "flex";
    this.layoutContainer.style.flexDirection = "row";
    this.layoutContainer.style.width = "100%";
    this.layoutContainer.style.border = "1px solid #111";
    this.layoutContainer.style.borderRadius = "6px";
    this.layoutContainer.style.overflow = "hidden";

    // Sidebar
    this.sidebar = document.createElement("div");
    this.sidebar.className = "mmxd-timeline-sidebar";
    this.sidebar.style.width = "120px";
    this.sidebar.style.flexShrink = "0";
    this.sidebar.style.display = "flex";
    this.sidebar.style.flexDirection = "column";
    this.sidebar.style.borderRight = "1px solid #111";
    this.sidebar.style.boxSizing = "border-box";
    this.sidebar.style.backgroundColor = "#1e1e1e";
    this.sidebar.style.userSelect = "none";

    // Spacer for Ruler
    this.rulerSpacer = document.createElement("div");
    this.rulerSpacer.style.height = `${RULER_HEIGHT}px`;
    this.rulerSpacer.style.width = "100%";
    this.rulerSpacer.style.borderBottom = "1px solid #111";
    this.rulerSpacer.style.backgroundColor = "#1e1e1e";
    this.rulerSpacer.style.boxSizing = "border-box";
    this.rulerSpacer.style.flexShrink = "0";
    this.sidebar.appendChild(this.rulerSpacer);

    const getTrackIconHtml = (trackId, isEnabled) => {
      if (trackId === "audio") {
        if (isEnabled) {
          return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                </svg>`;
        } else {
          return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                  <line x1="1" y1="1" x2="23" y2="23"></line>
                </svg>`;
        }
      } else {
        return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
              ${!isEnabled ? '<line x1="1" y1="1" x2="23" y2="23"></line>' : ''}
            </svg>`;
      }
    };

    const updateTrackIcon = (btn, trackId, isEnabled) => {
      btn.style.color = isEnabled ? "#aaa" : "#444";
      btn.innerHTML = getTrackIconHtml(trackId, isEnabled);
    };
    this.updateTrackIcon = updateTrackIcon;

    const createTrackLabel = (text, bgColor, trackId, isEnabled, toggleCallback) => {
      const el = document.createElement("div");
      el.style.display = "flex";
      el.style.flexDirection = "column";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";
      el.style.borderBottom = "1px solid #111";
      el.style.backgroundColor = bgColor;
      el.style.boxSizing = "border-box";
      el.style.gap = "4px";
      el.style.overflow = "hidden";
      el.style.position = "relative";
      el.style.flexShrink = "0";

      const headerRow = document.createElement("div");
      headerRow.style.display = "flex";
      headerRow.style.alignItems = "center";
      headerRow.style.justifyContent = "center";
      headerRow.style.gap = "6px";

      const textSpan = document.createElement("span");
      textSpan.style.color = "#ccc";
      textSpan.style.fontSize = "12px";
      textSpan.style.fontWeight = "bold";
      textSpan.style.lineHeight = "1";
      textSpan.style.display = "inline-flex";
      textSpan.style.alignItems = "center";
      textSpan.textContent = text;

      const eyeBtn = document.createElement("div");
      eyeBtn.style.cursor = "pointer";
      eyeBtn.style.display = "inline-flex";
      eyeBtn.style.alignItems = "center";
      eyeBtn.style.justifyContent = "center";
      eyeBtn.style.width = "14px";
      eyeBtn.style.height = "14px";
      eyeBtn.style.color = isEnabled ? "#aaa" : "#444";
      eyeBtn.innerHTML = getTrackIconHtml(trackId, isEnabled);

      eyeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleCallback();
      });

      // Store reference so we can update it later
      el._eyeBtn = eyeBtn;

      headerRow.appendChild(textSpan);
      headerRow.appendChild(eyeBtn);
      el.appendChild(headerRow);

      return el;
    };

    this.mainTrackLabel = createTrackLabel("MAIN", "#1e1e1e", "main", this.mainTrackEnabled, () => {
      this.mainTrackEnabled = !this.mainTrackEnabled;
      updateTrackIcon(this.mainTrackLabel._eyeBtn, "main", this.mainTrackEnabled);
      this.commitChanges(true);
      this.render();
    });

    this.audioTrackLabel = createTrackLabel("AUDIO", "#1e1e1e", "audio", this.audioTrackEnabled, () => {
      this.audioTrackEnabled = !this.audioTrackEnabled;
      updateTrackIcon(this.audioTrackLabel._eyeBtn, "audio", this.audioTrackEnabled);

      if (this.audioTrackEnabled) {
        const overrideWidget = this.node.widgets?.find(w => w.name === "override_audio");
        if (overrideWidget && overrideWidget.value) {
          overrideWidget.value = false;
          this.node.properties.overrideAudio = false;
          if (this.updateOverrideAudioToggleStyle) this.updateOverrideAudioToggleStyle(false);
        }
        this._audioTrackWasEnabledBeforeOverride = false;
      }

      // Auto-disable custom audio if track disabled
      const customAudioWidget = this.node.widgets?.find(w => w.name === "use_custom_audio");
      if (customAudioWidget) {
        if (!this.audioTrackEnabled) {
          // Store previous state just in case, though the user requested it auto-enables
          this._prevCustomAudioState = customAudioWidget.value;
          customAudioWidget.value = false;
        } else {
          // Auto-turn it back on as requested
          customAudioWidget.value = true;
        }
        if (this.updateToggleStyle) this.updateToggleStyle(customAudioWidget.value);
      }

      // Disable toggle buttons visually
      inpaintToggleBtn.disabled = !this.audioTrackEnabled;
      inpaintToggleBtn.style.opacity = this.audioTrackEnabled ? "1.0" : "0.3";

      this.commitChanges(true);
      this.render();
    });
    this.audioTrackLabel.appendChild(inpaintToggleBtn);

    // Initialize audio toggle states immediately
    inpaintToggleBtn.disabled = !this.audioTrackEnabled;
    inpaintToggleBtn.style.opacity = this.audioTrackEnabled ? "1.0" : "0.3";

    this.motionTrackLabel = createTrackLabel("Reference Video", "#1e1e1e", "motion", this.motionTrackEnabled, () => {
      this.motionTrackEnabled = !this.motionTrackEnabled;
      updateTrackIcon(this.motionTrackLabel._eyeBtn, "motion", this.motionTrackEnabled);

      // Auto-disable custom motion if track disabled
      const customMotionWidget = this.node.widgets?.find(w => w.name === "use_custom_motion");
      if (customMotionWidget) {
        if (!this.motionTrackEnabled) {
          customMotionWidget.value = false;
        } else {
          customMotionWidget.value = true;
        }
      }

      overrideAudioToggleBtn.disabled = !this.motionTrackEnabled;
      overrideAudioToggleBtn.style.opacity = this.motionTrackEnabled ? "1.0" : "0.3";
      if (!this.motionTrackEnabled) {
        const overrideWidget = this.node.widgets?.find(w => w.name === "override_audio");
        if (overrideWidget && overrideWidget.value) {
          overrideWidget.value = false;
          this.node.properties.overrideAudio = false;
          if (this.updateOverrideAudioToggleStyle) this.updateOverrideAudioToggleStyle(false);

          // Restore audio track if it was previously enabled
          if (this._audioTrackWasEnabledBeforeOverride) {
            this.audioTrackEnabled = true;
            updateTrackIcon(this.audioTrackLabel._eyeBtn, "audio", true);

            const customAudioWidget = this.node.widgets?.find(w => w.name === "use_custom_audio");
            if (customAudioWidget) {
              customAudioWidget.value = true;
              if (this.updateToggleStyle) this.updateToggleStyle(true);
            }

            inpaintToggleBtn.disabled = false;
            inpaintToggleBtn.style.opacity = "1.0";
          }
          this._audioTrackWasEnabledBeforeOverride = false;
        }
      }

      this.commitChanges(true);
      this.render();
    });
    this.motionTrackLabel.appendChild(overrideAudioToggleBtn);

    // Initialize motion override states immediately
    overrideAudioToggleBtn.disabled = !this.motionTrackEnabled;
    overrideAudioToggleBtn.style.opacity = this.motionTrackEnabled ? "1.0" : "0.3";


    this.sidebar.appendChild(this.mainTrackLabel);
    this.sidebar.appendChild(this.audioTrackLabel);
    this.sidebar.appendChild(this.motionTrackLabel);

    const setupSidebarLabelResizing = (labelEl, dragType) => {
      labelEl.addEventListener("mousemove", (e) => {
        if (this.retakeMode) {
          labelEl.style.cursor = "default";
          return;
        }
        if (this._isDragging) return;
        const rect = labelEl.getBoundingClientRect();
        const y = e.clientY - rect.top;
        if (rect.height - y <= 8) {
          labelEl.style.cursor = "ns-resize";
        } else {
          labelEl.style.cursor = "default";
        }
      });

      labelEl.addEventListener("mousedown", (e) => {
        if (this.retakeMode) return;
        if (e.button !== 0) return;
        if (e.target.closest("svg") || e.target.style.cursor === "pointer" || window.getComputedStyle(e.target).cursor === "pointer") {
          return;
        }
        const rect = labelEl.getBoundingClientRect();
        const y = e.clientY - rect.top;
        if (rect.height - y <= 8) {
          this._isDragging = true;
          this._dragType = dragType;
          this._startBlockHeight = this.blockHeight;
          this._startAudioTrackHeight = this.audioTrackHeight;
          this._startMotionTrackHeight = this.motionTrackHeight;
          this._startY = this.getMousePos(e).y;
          document.body.style.userSelect = "none";
          document.body.style.cursor = "ns-resize";
          e.preventDefault();
          e.stopPropagation();
        }
      });
    };

    setupSidebarLabelResizing(this.mainTrackLabel, "divider");
    setupSidebarLabelResizing(this.audioTrackLabel, "audio_divider");
    setupSidebarLabelResizing(this.motionTrackLabel, "height_resize");

    this.updateSidebarHeights();

    this.layoutContainer.appendChild(this.sidebar);

    // Viewport takes remaining space
    this.viewport.style.flexGrow = "1";
    this.viewport.style.minWidth = "0";
    this.layoutContainer.appendChild(this.viewport);

    this.wrapper.appendChild(toolbar);
    this.wrapper.appendChild(this.layoutContainer);


    const controlsGroup = document.createElement("div");
    controlsGroup.className = "mmxd-controls-group";
    controlsGroup.appendChild(this.strengthRow);
    controlsGroup.appendChild(playerControls);
    this.wrapper.appendChild(controlsGroup);
    this.wrapper.appendChild(propContainer);
    this.wrapper.appendChild(this.globalPropContainer);

    // --- Subject reference slots (@refN panels) at the bottom of the editor ---
    this.createCharacterSlots(this.wrapper);

    // --- @refN autocomplete on both prompt fields ---
    if (this.globalPromptInput) this.setupAutocomplete(this.globalPromptInput);
    if (this.promptInput) this.setupAutocomplete(this.promptInput);

    // Keep the Ref Option dropdown in sync with whatever was loaded.
    if (this.refOptionSelect) {
      this.refOptionSelect.value = this.timeline.reference_mode || "OFF";
    }
    // and everything else the switch governs, for a workflow restored on the fl2va path
    this._syncSummaryField();

    this.container.appendChild(this.wrapper);
  }

  syncWidgetsAndUI() {
    mmxdLog("[MiniMaxDirector debug] syncWidgetsAndUI() called.");
    mmxdLog(`  - mainTrackEnabled: ${this.mainTrackEnabled}`);
    mmxdLog(`  - audioTrackEnabled: ${this.audioTrackEnabled}`);
    mmxdLog(`  - motionTrackEnabled: ${this.motionTrackEnabled}`);

    // 1. Sync the widgets with the loaded track enablement states
    const customAudioWidget = this.node.widgets?.find(w => w.name === "use_custom_audio");
    if (customAudioWidget) {
      customAudioWidget.value = this.audioTrackEnabled;
      mmxdLog(`  - Set use_custom_audio widget value to ${this.audioTrackEnabled}`);
    }
    const customMotionWidget = this.node.widgets?.find(w => w.name === "use_custom_motion");
    if (customMotionWidget) {
      customMotionWidget.value = this.motionTrackEnabled;
      mmxdLog(`  - Set use_custom_motion widget value to ${this.motionTrackEnabled}`);
    }

    // 2. Sync the track icon buttons
    if (this.mainTrackLabel?._eyeBtn && this.updateTrackIcon) {
      this.updateTrackIcon(this.mainTrackLabel._eyeBtn, "main", this.mainTrackEnabled);
      mmxdLog("  - Updated main track eye icon");
    }
    if (this.audioTrackLabel?._eyeBtn && this.updateTrackIcon) {
      this.updateTrackIcon(this.audioTrackLabel._eyeBtn, "audio", this.audioTrackEnabled);
      mmxdLog("  - Updated audio track eye icon");
    }
    if (this.motionTrackLabel?._eyeBtn && this.updateTrackIcon) {
      this.updateTrackIcon(this.motionTrackLabel._eyeBtn, "motion", this.motionTrackEnabled);
      mmxdLog("  - Updated motion track eye icon");
    }

    // 3. Sync the inpaint button disabled/opacity state
    const inpaintToggleBtn = this.audioTrackLabel?.querySelector(".mmxd-btn");
    if (inpaintToggleBtn) {
      inpaintToggleBtn.disabled = !this.audioTrackEnabled;
      inpaintToggleBtn.style.opacity = this.audioTrackEnabled ? "1.0" : "0.3";
      mmxdLog(`  - Updated inpaint toggle button disabled: ${inpaintToggleBtn.disabled}`);
    }

    if (this.updateInpaintToggleStyle) {
      const inpaintWidget = this.node.widgets?.find(w => w.name === "inpaint_audio");
      if (inpaintWidget) {
        mmxdLog(`  - calling updateInpaintToggleStyle with ${inpaintWidget.value}`);
        this.updateInpaintToggleStyle(inpaintWidget.value);
      }
    }

    // 4. Sync the override audio button disabled/opacity state
    const overrideAudioToggleBtn = this.motionTrackLabel?.querySelector(".mmxd-btn");
    if (overrideAudioToggleBtn) {
      overrideAudioToggleBtn.disabled = !this.motionTrackEnabled;
      overrideAudioToggleBtn.style.opacity = this.motionTrackEnabled ? "1.0" : "0.3";
      mmxdLog(`  - Updated override audio toggle button disabled: ${overrideAudioToggleBtn.disabled}`);
    }

    if (this.updateOverrideAudioToggleStyle) {
      const overrideWidget = this.node.widgets?.find(w => w.name === "override_audio");
      if (overrideWidget) {
        mmxdLog(`  - calling updateOverrideAudioToggleStyle with ${overrideWidget.value}`);
        this.updateOverrideAudioToggleStyle(overrideWidget.value);
      }
    }
  }

  checkResize() {
    this.syncLayoutToNode(false);
    const viewportWidth = this.viewport.clientWidth;
    const currentScale = this.getRenderScale();

    if (viewportWidth > 0 && (this._lastWidth !== viewportWidth || this._lastZoom !== this.zoomLevel || this._lastScale !== currentScale)) {
      this._lastWidth = viewportWidth;
      this._lastZoom = this.zoomLevel;
      this._lastScale = currentScale;

      const newCanvasWidth = Math.max(viewportWidth, viewportWidth * this.zoomLevel);
      this.canvas.style.width = newCanvasWidth + "px";
      this.resizeCanvas(newCanvasWidth);

      if (this.node) this.node.setDirtyCanvas?.(true, true);
      else if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
    }
    this._renderLoop = requestAnimationFrame(() => this.checkResize());
  }

  syncLayoutToNode(forceRender = true) {
    const nodeWidth = this.node?.size?.[0] || 1375;
    const targetWidth = Math.max(10, nodeWidth - 30);

    if (this.container) {
      this.container.style.width = `${targetWidth}px`;
      this.container.style.maxWidth = `${targetWidth}px`;
      this.container.style.setProperty("height", "auto", "important");
      this.container.style.boxSizing = "border-box";
    }
    if (this.wrapper) {
      this.wrapper.style.width = "100%";
      this.wrapper.style.maxWidth = "100%";
      this.wrapper.style.setProperty("height", "auto", "important");
      this.wrapper.style.boxSizing = "border-box";
    }
    if (this.viewport) {
      this.viewport.style.boxSizing = "content-box";
      this.viewport.style.height = `${this.canvasHeight}px`;
      this.viewport.style.minHeight = `${this.canvasHeight}px`;
      this.viewport.style.flexShrink = "0";
    }
    if (this.layoutContainer) {
      this.layoutContainer.style.flexShrink = "0";
    }

    const viewportWidth = this.viewport?.clientWidth || targetWidth;
    const canvasWidth = Math.max(viewportWidth, viewportWidth * this.zoomLevel);
    const currentWidth = parseFloat(this.canvas?.style?.width) || 0;
    if (viewportWidth > 0 && Math.abs(currentWidth - canvasWidth) > 1) {
      this.canvas.style.width = `${canvasWidth}px`;
      this.resizeCanvas(canvasWidth);
      this._lastWidth = viewportWidth;
      this._lastZoom = this.zoomLevel;
      if (forceRender) this.render();
    }
  }

  getRenderScale() {
    const dpr = window.devicePixelRatio || 1;
    let graphScale = 1;
    try {
      if (window.app && window.app.canvas && window.app.canvas.ds && window.app.canvas.ds.scale) {
        graphScale = window.app.canvas.ds.scale;
      }
    } catch (e) { }
    // Scale up if zoomed in, but don't drop below 1x DPR if zoomed out
    return dpr * Math.max(1, graphScale);
  }

  resizeCanvas(widthPx) {
    const scale = this.getRenderScale();
    const targetWidth = Math.round(widthPx * scale);
    const targetHeight = Math.round(this.canvasHeight * scale);

    this.canvas.width = targetWidth;
    this.canvas.height = targetHeight;
    this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
    this.render();
  }

  // Helper to map mouse events accurately regardless of canvas scaling
  getMousePos(e) {
    const rect = this.canvas.getBoundingClientRect();

    const scaleX = this.canvas.offsetWidth / rect.width;
    const scaleY = this.canvas.offsetHeight / rect.height;

    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    return { x, y };
  }

  // --- Async Image Upload Logic (Handles multiple images simultaneously) ---
  async handleImageUpload(files, targetFrameStart = null, explicitLength = null) {
    const frameRate = this.getFrameRate();
    const durationFrames = this.getDurationFrames();
    const newLength = explicitLength !== null ? explicitLength : frameRate * 1; // Default to 1 second long

    for (let file of files) {
      if (!file.type.startsWith("image/")) continue;

      await new Promise(async (resolve) => {
        try {
          const body = new FormData();
          body.append("image", file);
          body.append("subfolder", "whatdreamscost");
          const resp = await api.fetchApi("/upload/image", { method: "POST", body });
          if (resp.status !== 200) { resolve(); return; }

          const data = await resp.json();
          const filename = data.name;
          const subfolder = data.subfolder || "";
          const imageFile = subfolder ? subfolder + "/" + filename : filename;
          const imgUrl = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

          const img = new Image();
          img.onload = () => {

            let newStart = targetFrameStart;
            if (newStart === null) {
              // Fallback: find the first free slot, or append past the end
              newStart = 0;
              this.timeline.segments.sort((a, b) => a.start - b.start);
              for (let i = 0; i < this.timeline.segments.length; i++) {
                let seg = this.timeline.segments[i];
                if (newStart + newLength <= seg.start) break;
                newStart = Math.max(newStart, seg.start + seg.length);
              }
            }

            // Use the visual timeline as the physics bound so segments can
            // land anywhere in the padded visual area without touching duration_frames.
            const currentDuration = this.getVisualDurationFrames();

            if (targetFrameStart !== null) {
              // Resolve physics to push existing segments
              let tempId = "TEMP_" + Date.now();
              this.timeline.segments.push({ id: tempId, start: newStart, length: newLength, type: "temp" });
              let physicsCenter = newStart + this.getFrameRate() / 2;
              let result = this._applyCenterDragPhysics(this.timeline.segments, tempId, newStart, physicsCenter, currentDuration, currentDuration, 1);

              let siblingPhysics = (this.timeline.audioSegments || []).map(s => ({ ...s }));

              this._resolveGlobalPhysics(result, siblingPhysics, currentDuration, this.timeline.segments, this.timeline.audioSegments);

              // Update original segments with resolved physics to preserve imgObj
              for (let shiftedSeg of result) {
                let original = this.timeline.segments.find(s => s.id === shiftedSeg.id);
                if (original) {
                  original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
                }
              }

              for (let shiftedSib of siblingPhysics) {
                let originalSib = this.timeline.audioSegments.find(s => s.id === shiftedSib.id);
                if (originalSib) {
                  originalSib.start = shiftedSib.start;
                }
              }

              let tempSeg = this.timeline.segments.find(s => s.id === tempId);
              newStart = tempSeg.start;
              this.timeline.segments = this.timeline.segments.filter(s => s.id !== tempId);
              targetFrameStart = newStart + newLength; // For the next file in batch
            }

            // Use the full intended length — the timeline has already been grown to fit.
            let constrainedLength = newLength;

            const seg = {
              id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
              start: newStart,
              length: constrainedLength,
              prompt: "",
              type: "image",
              imageFile: imageFile,
              imageB64: imgUrl
            };

            const displayImg = new Image();
            displayImg.onload = () => {
              seg.imgObj = displayImg;
              this.render();
              resolve(); // Resolve promise letting next image process
            };
            displayImg.src = imgUrl;

            this.timeline.segments.push(seg);
            this.timeline.segments.sort((a, b) => a.start - b.start);
            this.selectionType = "image";
            this.selectedIndex = this.timeline.segments.findIndex(s => s.id === seg.id);

            if (!this.retakeMode) {
              this.growTimelineIfNeeded(seg.start + seg.length);
            }

            this.updateUIFromSelection();
            this.commitChanges(true);
          };
          img.src = imgUrl;
        } catch (err) {
          console.error("[MiniMaxDirector] Image upload failed", err);
          resolve();
        }
      });
    }
    this.fileInput.value = "";
  }

  // Shared chunked upload helper for all video types in the MiniMax H3 Director.
  // Files <= 50 MB go through ComfyUI's standard /upload/image endpoint;
  // larger files are split into 50 MB chunks and sent to the MiniMax H3 Director's
  // own /minimax_director_upload_chunk endpoint to bypass the 413 size limit.
  async _uploadVideoFile(file) {
    const CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB
    const safeFileName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');

    // First check if the file already exists on the server to de-duplicate
    try {
      const checkResp = await api.fetchApi(`/minimax_director_check_file?filename=${encodeURIComponent(safeFileName)}&size=${file.size}`);
      if (checkResp.status === 200) {
        const checkResult = await checkResp.json();
        if (checkResult.exists) {
          console.log(`[MiniMaxDirector] File already exists: ${checkResult.name}. Reusing existing file.`);
          return checkResult.name;
        }
      }
    } catch (e) {
      console.warn("[MiniMaxDirector] Failed to check for existing file, proceeding with upload", e);
    }

    if (file.size > CHUNK_SIZE) {
      // --- Chunked path ---
      const safeName = Date.now() + "_" + safeFileName;
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      for (let i = 0; i < totalChunks; i++) {
        const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const formData = new FormData();
        formData.append("file", chunk);
        formData.append("filename", safeName);
        formData.append("chunk_index", i);
        formData.append("total_chunks", totalChunks);
        const resp = await api.fetchApi("/minimax_director_upload_chunk", { method: "POST", body: formData });
        if (resp.status !== 200) throw new Error("MiniMax H3 Director video chunk upload failed");
      }
      return safeName; // filename (no subfolder) in the input dir
    } else {
      // --- Single-shot path (small file) ---
      const body = new FormData();
      body.append("image", file);
      body.append("subfolder", "whatdreamscost");
      const resp = await api.fetchApi("/upload/image", { method: "POST", body });
      if (resp.status !== 200) throw new Error(`MiniMax H3 Director video upload failed: ${resp.statusText}`);
      const data = await resp.json();
      const subfolder = data.subfolder || "";
      return subfolder ? subfolder + "/" + data.name : data.name;
    }
  }

  async handleVideoUpload(files, targetFrameStart = null) {
    const frameRate = this.getFrameRate();

    if (this.retakeMode) {
      const file = files[0];
      if (!file || !file.type.startsWith("video/")) return;

      // Clean up previous retake video if one exists
      if (this.timeline.retakeVideo) {
        const oldVid = this.timeline.retakeVideo;
        if (oldVid.videoEl) {
          oldVid.videoEl.pause();
          oldVid.videoEl.src = "";
          oldVid.videoEl.load();
        }
        if (oldVid._blobUrl) {
          URL.revokeObjectURL(oldVid._blobUrl);
        }
      }

      const blobUrl = URL.createObjectURL(file);
      const vid = document.createElement('video');
      vid.crossOrigin = "Anonymous";
      vid.preload = 'auto';
      vid.muted = true;

      await new Promise((resolve) => {
        vid.onloadeddata = async () => {
          vid.onloadeddata = null;
          const clipDurationSecs = vid.duration || 1;
          const clipFrames = Math.max(1, Math.ceil(clipDurationSecs * frameRate));

          this.timeline.retakeVideo = {
            fileName: file.name,
            imageFile: "",
            videoDurationFrames: clipFrames,
            _blobUrl: blobUrl,
            fileSize: file.size,
            videoEl: vid,
            _uploading: true
          };

          // Initialize retake region to the middle 50% of the clip (25%–75%)
          const retakeLen = Math.max(1, Math.round(clipFrames * 0.5));
          const retakeStartFrame = Math.round((clipFrames - retakeLen) / 2);
          this.timeline.retakeStart = retakeStartFrame;
          this.timeline.retakeLength = retakeLen;
          if (this.timeline.retakePrompt === undefined) this.timeline.retakePrompt = "";
          if (this.timeline.retakeStrength === undefined) this.timeline.retakeStrength = 1.0;

          // Start background upload
          this._uploadVideoFile(file).then(filePath => {
            if (this.timeline.retakeVideo) {
              this.timeline.retakeVideo.imageFile = filePath;
              this.timeline.retakeVideo._uploading = false;
            }
            this.commitChanges(true);
            this.render();
          }).catch(e => {
            console.error(e);
            if (this.timeline.retakeVideo) {
              this.timeline.retakeVideo._uploading = false;
            }
            this.commitChanges(true);
            this.render();
          });

          this._ensureThumbnails(this.timeline.retakeVideo);

          this.syncWidgetsToRetakeDuration(clipFrames);
          this.commitChanges(true);
          this.render();
          resolve();
        };
        vid.src = blobUrl;
      });
      return;
    }

    for (let file of files) {
      if (!file.type.startsWith("video/")) continue;

      await new Promise(async (resolve) => {
        try {
          // Use a local blob URL so the video element loads instantly from disk —
          // no waiting for the server upload before the segment appears.
          const blobUrl = URL.createObjectURL(file);

          const vid = document.createElement('video');
          vid.crossOrigin = "Anonymous";
          vid.preload = 'auto';
          vid.muted = true;

          vid.onloadeddata = async () => {
            vid.onloadeddata = null; // prevent re-firing if src changes or browser buffers more data
            const clipDurationSecs = vid.duration || 1;
            const clipFrames = Math.max(1, Math.ceil(clipDurationSecs * frameRate));
            let newLength = clipFrames;
            let newStart = targetFrameStart;

            if (newStart === null) {
              newStart = 0;
              this.timeline.segments.sort((a, b) => a.start - b.start);
              for (let i = 0; i < this.timeline.segments.length; i++) {
                let seg = this.timeline.segments[i];
                if (newStart + newLength <= seg.start) break;
                newStart = Math.max(newStart, seg.start + seg.length);
              }
            }

            const currentDuration = this.getVisualDurationFrames();

            if (targetFrameStart !== null) {
              let tempId = "TEMP_" + Date.now();
              let tempVidId = tempId + "_v";
              let tempAudId = tempId + "_a";

              this.timeline.segments.push({ id: tempVidId, start: newStart, length: newLength, type: "temp" });
              this.timeline.audioSegments.push({ id: tempAudId, start: newStart, length: newLength, type: "temp" });

              let physicsCenter = newStart + this.getFrameRate() / 2;

              let resultSegments = this._applyCenterDragPhysics(this.timeline.segments, tempVidId, newStart, physicsCenter, currentDuration, currentDuration, 1);
              let resultAudioSegments = this._applyCenterDragPhysics(this.timeline.audioSegments, tempAudId, newStart, physicsCenter, currentDuration, currentDuration, 1);

              this._resolveGlobalPhysics(resultSegments, resultAudioSegments, currentDuration, this.timeline.segments, this.timeline.audioSegments);

              for (let shiftedSeg of resultSegments) {
                let original = this.timeline.segments.find(s => s.id === shiftedSeg.id);
                if (original) original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
              }
              for (let shiftedSib of resultAudioSegments) {
                let originalSib = this.timeline.audioSegments.find(s => s.id === shiftedSib.id);
                if (originalSib) originalSib.start = shiftedSib.resolvedStart !== undefined ? shiftedSib.resolvedStart : shiftedSib.start;
              }

              let tempVidSeg = resultSegments.find(s => s.id === tempVidId);
              newStart = tempVidSeg.start;
              this.timeline.segments = this.timeline.segments.filter(s => s.id !== tempVidId);
              this.timeline.audioSegments = this.timeline.audioSegments.filter(s => s.id !== tempAudId);
              targetFrameStart = newStart + newLength;
            }

            const sharedId = Date.now().toString() + Math.random().toString(36).substr(2, 5);

            const vidSeg = {
              id: sharedId + "_v",
              type: "video",
              start: newStart,
              length: newLength,
              trimStart: 0,
              videoDurationFrames: clipFrames,
              imageFile: "",  // filled in once background upload completes
              fileName: file.name,
              prompt: "",
              videoEl: vid,
              _uploading: true,
              _blobUrl: blobUrl,
              fileSize: file.size
            };

            const audSeg = {
              id: sharedId + "_a",
              type: "audio",
              start: newStart,
              length: newLength,
              trimStart: 0,
              audioDurationFrames: clipFrames,
              audioFile: "",  // filled in once background upload completes
              fileName: file.name,
              waveformPeaks: [],
              _uploading: true,
              _decoding: true,
              _blobUrl: blobUrl,
              fileSize: file.size
            };

            // Extract first-frame thumbnail from local blob — instant
            vid.currentTime = 0.01;
            vid.onseeked = () => {
              vid.onseeked = null;
              const canvas = document.createElement('canvas');
              canvas.width = Math.min(vid.videoWidth, 512);
              canvas.height = Math.round((vid.videoHeight / vid.videoWidth) * canvas.width);
              const ctx = canvas.getContext('2d');
              ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
              vidSeg.imageB64 = canvas.toDataURL('image/jpeg');

              const imgObj = new Image();
              imgObj.onload = () => { vidSeg.imgObj = imgObj; this.render(); };
              imgObj.src = vidSeg.imageB64;

              // Add to timeline immediately
              this.timeline.segments.push(vidSeg);
              this.timeline.audioSegments.push(audSeg);
              this.timeline.segments.sort((a, b) => a.start - b.start);
              this.timeline.audioSegments.sort((a, b) => a.start - b.start);

              if (!this.retakeMode) {
                this.growTimelineIfNeeded(vidSeg.start + vidSeg.length);
              }

              this.selectionType = "image";
              this.selectedIndex = this.timeline.segments.findIndex(s => s.id === vidSeg.id);
              this.updateUIFromSelection();
              this.commitChanges(true);
              resolve(); // resolve immediately — don't block on upload
              this._ensureThumbnails(vidSeg);

              // Background audio extraction (waveform peaks) — runs while user can already work
              const IS_LARGE_FILE = file.size > 100 * 1024 * 1024;
              if (IS_LARGE_FILE) {
                console.log(`[MiniMaxDirector] Large file detected (${(file.size / 1024 / 1024).toFixed(1)} MB). Offloading audio extraction to server.`);
              } else {
                this._extractAudioOnClient(file, audSeg.id, blobUrl);
              }

              // Background upload — runs while the user can already work.
              // We intentionally do NOT change vid.src after upload — the blob URL
              // works perfectly for local playback. Only imageFile/audioFile
              // need updating so Python can find the file at generation time.
              this._uploadVideoFile(file).then(filePath => {
                for (let s of this.timeline.segments) {
                  if (s._blobUrl === blobUrl || s.id === vidSeg.id) {
                    s.imageFile = filePath;
                    s._uploading = false;
                  }
                }
                for (let s of this.timeline.audioSegments) {
                  if (s._blobUrl === blobUrl || s.id === audSeg.id) {
                    s.audioFile = filePath;
                    s._uploading = false;
                  }
                }
                if (blobUrl && filePath) {
                  this._thumbnailCache = this._thumbnailCache || new Map();
                  this._thumbnailPromises = this._thumbnailPromises || new Map();
                  if (this._thumbnailCache.has(blobUrl)) {
                    this._thumbnailCache.set(filePath, this._thumbnailCache.get(blobUrl));
                  }
                  if (this._thumbnailPromises.has(blobUrl)) {
                    this._thumbnailPromises.set(filePath, this._thumbnailPromises.get(blobUrl));
                  }
                }

                // Query server for extracted WAV audio file and waveform peaks
                if (filePath) {
                  api.fetchApi(`/minimax_director_get_audio?filename=${encodeURIComponent(filePath)}`)
                    .then(r => r.json())
                    .then(res => {
                      if (res.audio_file && res.peaks) {
                        for (let s of this.timeline.audioSegments) {
                          if (s.audioFile === filePath || s._blobUrl === blobUrl) {
                            s.audioFile = res.audio_file;
                            s.waveformPeaks = res.peaks;
                            s._decoding = false;
                            this._preloadAudioSegment(s);
                          }
                        }
                      } else {
                        // Fallback
                        if (IS_LARGE_FILE) {
                          console.warn("[MiniMaxDirector] Server audio extraction failed for large file, skipping.");
                          for (let s of this.timeline.audioSegments) {
                            if (s.audioFile === filePath || s._blobUrl === blobUrl) {
                              s._decoding = false;
                            }
                          }
                        } else {
                          this._extractAudioOnClient(file, audSeg.id, blobUrl);
                        }
                      }
                      this.commitChanges(true);
                      this.render();
                    })
                    .catch(err => {
                      console.error("[MiniMaxDirector] Server audio extraction query failed:", err);
                      for (let s of this.timeline.audioSegments) {
                        if (s.audioFile === filePath || s._blobUrl === blobUrl) {
                          s._decoding = false;
                        }
                      }
                      this.render();
                    });
                } else {
                  this.commitChanges(true);
                  this.render();
                }
              }).catch(err => {
                console.error("[MiniMaxDirector] Background video upload failed", err);
                const currentVidSeg = this.timeline.segments.find(s => s.id === vidSeg.id);
                if (currentVidSeg) currentVidSeg._uploading = false;
                const currentAudSeg = this.timeline.audioSegments.find(s => s.id === audSeg.id);
                if (currentAudSeg) currentAudSeg._uploading = false;
                this.render();
              });
            };
          };

          vid.onerror = (e) => {
            console.error("Video load error", e);
            URL.revokeObjectURL(blobUrl);
            resolve();
          };

          vid.src = blobUrl;

        } catch (err) {
          console.error("Video upload failed", err);
          resolve();
        }
      });
    }

    if (this.videoFileInput) {
      this.videoFileInput.value = "";
    }
  }

  async generateVideoPreviewThumbs(file, count = 18) {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.src = url;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("preview metadata failed"));
    });
    const duration = Math.max(0.001, video.duration || 0.001);
    const canvas = document.createElement("canvas");
    const maxW = 160, maxH = 90;
    const scale = Math.min(maxW / Math.max(1, video.videoWidth || maxW), maxH / Math.max(1, video.videoHeight || maxH));
    canvas.width = Math.max(1, Math.round((video.videoWidth || maxW) * scale));
    canvas.height = Math.max(1, Math.round((video.videoHeight || maxH) * scale));
    const ctx = canvas.getContext("2d");
    const thumbs = [];
    const seekTo = (t) => new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          thumbs.push(canvas.toDataURL("image/jpeg", 0.78));
        } catch (_) { }
        resolve();
      };
      video.onseeked = done;
      video.currentTime = Math.min(duration - 0.001, Math.max(0, t));
      setTimeout(done, 700);
    });
    for (let i = 0; i < count; i++) {
      const t = (duration * (i + 0.5)) / count;
      await seekTo(t);
    }
    URL.revokeObjectURL(url);
    return thumbs.filter(Boolean);
  }

  // --- Async Motion Video Upload Logic ---
  async handleMotionUpload(files, targetFrameStart = null) {
    const frameRate = this.getFrameRate();

    for (let file of files) {
      if (!(file.type.startsWith("video/") || file.name.toLowerCase().match(/\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv)$/))) continue;
      const placed = await this._loadMotionFile(file, frameRate, targetFrameStart);
      if (placed && targetFrameStart !== null) targetFrameStart = placed.nextStart;
    }
  }

  // Positioning, segment creation and insertion — shared by the two ways a reference video
  // can arrive: decoded by the browser, or described by the server when the browser will
  // not touch it. One copy on purpose; the paths differ only in where the duration and the
  // thumbnail came from.
  _insertMotionSegment({ file, clipFrames, thumbB64, videoEl, blobUrl, videoFile,
                         targetFrameStart }) {
    const newLength = clipFrames;
    let newStart = targetFrameStart;

    if (newStart === null || newStart === undefined) {
      newStart = 0;
      this.timeline.motionSegments.sort((a, b) => a.start - b.start);
      for (let i = 0; i < this.timeline.motionSegments.length; i++) {
        const s = this.timeline.motionSegments[i];
        if (newStart + newLength <= s.start) break;
        newStart = Math.max(newStart, s.start + s.length);
      }
    } else {
      const currentDuration = this.getVisualDurationFrames();
      const tempId = "TEMP_" + Date.now();
      this.timeline.motionSegments.push({ id: tempId, start: newStart, length: newLength, type: "temp" });
      const result = this._applyCenterDragPhysics(this.timeline.motionSegments, tempId, newStart, newStart + newLength / 2, currentDuration, currentDuration, 1);
      for (const shiftedSeg of result) {
        const original = this.timeline.motionSegments.find(s => s.id === shiftedSeg.id);
        if (original) original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
      }
      const tempSeg = this.timeline.motionSegments.find(s => s.id === tempId);
      newStart = tempSeg.start;
      this.timeline.motionSegments = this.timeline.motionSegments.filter(s => s.id !== tempId);
    }

    const seg = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      type: "motion_video",
      start: newStart,
      length: newLength,
      trimStart: 0,
      videoDurationFrames: clipFrames,
      videoFile: videoFile || "",   // filled in later when the upload runs in background
      fileName: file.name,
      videoStrength: 1.0,
      videoAttentionStrength: 0.65,
      resampleMode: "nearest",
      previewThumbs: [],
      previewThumbSourceFrames: clipFrames,
      fileSize: file.size
    };
    if (videoEl) seg.videoEl = videoEl;
    if (blobUrl) seg._blobUrl = blobUrl;
    if (!videoFile) seg._uploading = true;

    if (thumbB64) {
      seg.imageB64 = thumbB64;
      const imgObj = new Image();
      imgObj.onload = () => { seg.imgObj = imgObj; this.render(); };
      imgObj.src = thumbB64;
    }

    this.timeline.motionSegments.push(seg);
    this.timeline.motionSegments.sort((a, b) => a.start - b.start);

    // deliberately no growTimelineIfNeeded: a <Video N> reference is not in the video, so it
    // does not decide how long the video is — see the note on that method

    this.selectionType = "motion";
    this.selectedIndex = this.timeline.motionSegments.findIndex(s => s.id === seg.id);
    this.updateUIFromSelection();
    this.commitChanges(true);
    this.render();
    return { seg, nextStart: newStart + newLength };
  }

  // Upload in the background so the clip is usable the moment it lands on the track.
  _finishMotionUpload(seg, file, blobUrl) {
    this._uploadVideoFile(file).then(filePath => {
      for (const s of this.timeline.motionSegments) {
        if (s._blobUrl === blobUrl || s.id === seg.id) {
          s.videoFile = filePath;
          s._uploading = false;
        }
      }
      if (blobUrl && filePath) {
        this._thumbnailCache = this._thumbnailCache || new Map();
        this._thumbnailPromises = this._thumbnailPromises || new Map();
        if (this._thumbnailCache.has(blobUrl)) {
          this._thumbnailCache.set(filePath, this._thumbnailCache.get(blobUrl));
        }
        if (this._thumbnailPromises.has(blobUrl)) {
          this._thumbnailPromises.set(filePath, this._thumbnailPromises.get(blobUrl));
        }
      }
      const isOverrideAudio = !!(this.node.properties.overrideAudio || this.timeline.overrideAudio);
      if (isOverrideAudio) {
        const s = this.timeline.motionSegments.find(s => s.id === seg.id);
        if (s) this._preloadMotionAudioSegment(s);
      }
      this.commitChanges(true);
      this.render();
    }).catch(err => {
      console.error("[MiniMaxDirector] Background motion video upload failed", err);
      const currentSeg = this.timeline.motionSegments.find(s => s.id === seg.id);
      if (currentSeg) currentSeg._uploading = false;
      this.render();
    });
  }

  // Try the browser first — a local blob shows the clip instantly, with no upload to wait
  // on. If the browser will not decode it, fall back to the server rather than giving up.
  _loadMotionFile(file, frameRate, targetFrameStart) {
    return new Promise((resolve) => {
      const blobUrl = URL.createObjectURL(file);
      const vid = document.createElement('video');
      vid.crossOrigin = "Anonymous";
      vid.preload = 'auto';
      vid.muted = true;

      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };

      vid.onerror = () => {
        // Chrome refuses plenty of codecs the renderer reads without complaint — HEVC,
        // ProRes and 10-bit footage all live inside perfectly ordinary .mp4 and .mov
        // files. This used to log to the console and stop, so picking such a file did
        // nothing at all and never said why.
        URL.revokeObjectURL(blobUrl);
        this._placeMotionViaServer(file, frameRate, targetFrameStart).then(done);
      };

      vid.onloadeddata = () => {
        vid.onloadeddata = null;   // browsers re-fire this as more data buffers
        const clipFrames = Math.max(1, Math.ceil((vid.duration || 1) * frameRate));

        vid.currentTime = 0.01;
        vid.onseeked = () => {
          vid.onseeked = null;
          let thumb = "";
          try {
            const canvas = document.createElement('canvas');
            canvas.width = Math.min(vid.videoWidth, 512);
            canvas.height = Math.round((vid.videoHeight / vid.videoWidth) * canvas.width);
            canvas.getContext('2d').drawImage(vid, 0, 0, canvas.width, canvas.height);
            thumb = canvas.toDataURL('image/jpeg');
          } catch (e) {
            console.warn("[MiniMaxDirector] could not grab a thumbnail frame", e);
          }

          const { seg, nextStart } = this._insertMotionSegment({
            file, clipFrames, thumbB64: thumb, videoEl: vid, blobUrl, targetFrameStart });
          done({ nextStart });               // never block on the upload
          this._ensureThumbnails(seg);
          this._finishMotionUpload(seg, file, blobUrl);
        };
      };

      vid.src = blobUrl;
    });
  }

  // The file has to be uploaded before it can be probed, so this path is slower than the
  // blob one — but it accepts everything the renderer accepts, which is the point.
  async _placeMotionViaServer(file, frameRate, targetFrameStart) {
    try {
      const videoFile = await this._uploadVideoFile(file);
      if (!videoFile) throw new Error("the upload did not complete");

      const resp = await api.fetchApi("/minimax_director/probe_video", {
        method: "POST", body: JSON.stringify({ file: videoFile }),
      });
      const d = await resp.json();
      if (d.status !== "success") throw new Error(d.message || "the server could not read it");
      if (!d.duration) throw new Error("the file reports no duration");

      const clipFrames = Math.max(1, Math.ceil(d.duration * frameRate));
      const { seg, nextStart } = this._insertMotionSegment({
        file, clipFrames, thumbB64: d.thumb || "", videoFile, targetFrameStart });
      console.info(`[MiniMaxDirector] '${file.name}' (${d.codec || "unknown codec"}) could `
        + `not be decoded by the browser; the server read it instead.`);
      // deliberately no _ensureThumbnails here: the filmstrip is extracted through a
      // <video> element too, so it would fail the same way. The frame the server sent is
      // already on the segment.
      return { nextStart };
    } catch (err) {
      console.error("[MiniMaxDirector] reference video could not be read", err);
      alert(`Could not add "${file.name}".\n\n`
        + `${err.message || err}\n\n`
        + `The browser cannot decode this file and the server could not read it either. `
        + `Re-encoding to H.264 in an MP4 container usually fixes it.`);
      return null;
    }
  }


  // --- Async Audio Upload Logic ---
  async handleAudioUpload(files, targetFrameStart = null) {
    const frameRate = this.getFrameRate();
    const durationFrames = this.getDurationFrames();

    for (let file of files) {
      if (!file.type.startsWith("audio/")) continue;

      await new Promise(async (resolve) => {
        try {
          const body = new FormData();
          body.append("image", file);
          body.append("subfolder", "whatdreamscost");
          const resp = await api.fetchApi("/upload/image", { method: "POST", body });
          if (resp.status !== 200) { resolve(); return; }

          const data = await resp.json();
          const filename = data.name;
          const subfolder = data.subfolder || "";
          const audioFile = subfolder ? subfolder + "/" + filename : filename;

          const arrayBuffer = await file.arrayBuffer();
          const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
          const clipDurationSecs = audioBuffer.duration;
          const clipFrames = Math.max(1, Math.ceil(clipDurationSecs * frameRate));

          const channelData = audioBuffer.getChannelData(0);
          const peaks = [];
          const numPeaks = 200;
          const step = Math.floor(channelData.length / numPeaks);
          for (let i = 0; i < numPeaks; i++) {
            let max = 0;
            for (let j = 0; j < step; j++) {
              const val = Math.abs(channelData[i * step + j]);
              if (val > max) max = val;
            }
            peaks.push(max);
          }

          let newLength = clipFrames;
          let newStart = targetFrameStart;

          if (newStart === null) {
            // Find the first free slot, or place past the end of all existing audio
            newStart = 0;
            this.timeline.audioSegments.sort((a, b) => a.start - b.start);
            for (let i = 0; i < this.timeline.audioSegments.length; i++) {
              let seg = this.timeline.audioSegments[i];
              if (newStart + newLength <= seg.start) break;
              newStart = Math.max(newStart, seg.start + seg.length);
            }
          }

          // Use the visual timeline as the physics bound so segments can
          // land anywhere in the padded visual area without touching duration_frames.
          const currentDuration = this.getVisualDurationFrames();

          if (targetFrameStart !== null) {
            let tempId = "TEMP_" + Date.now();
            this.timeline.audioSegments.push({ id: tempId, start: newStart, length: newLength, type: "temp" });
            let physicsCenter = newStart + this.getFrameRate() / 2;
            let result = this._applyCenterDragPhysics(this.timeline.audioSegments, tempId, newStart, physicsCenter, currentDuration, currentDuration, 1);

            let siblingPhysics = (this.timeline.segments || []).map(s => ({ ...s }));

            this._resolveGlobalPhysics(siblingPhysics, result, currentDuration, this.timeline.segments, this.timeline.audioSegments);

            for (let shiftedSeg of result) {
              let original = this.timeline.audioSegments.find(s => s.id === shiftedSeg.id);
              if (original) original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
            }

            for (let shiftedSib of siblingPhysics) {
              let originalSib = this.timeline.segments.find(s => s.id === shiftedSib.id);
              if (originalSib) {
                originalSib.start = shiftedSib.start;
              }
            }

            let tempSeg = this.timeline.audioSegments.find(s => s.id === tempId);
            newStart = tempSeg.start;
            this.timeline.audioSegments = this.timeline.audioSegments.filter(s => s.id !== tempId);
            targetFrameStart = newStart + newLength;
          }

          // Use the full clip length — timeline has already grown to fit.
          let constrainedLength = newLength;

          const seg = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            type: "audio",
            start: newStart,
            length: constrainedLength,
            trimStart: 0,
            audioDurationFrames: clipFrames,
            audioFile: audioFile,
            fileName: file.name,
            waveformPeaks: peaks,
            _audioBuffer: audioBuffer
          };

          this.timeline.audioSegments.push(seg);
          this.timeline.audioSegments.sort((a, b) => a.start - b.start);

          // deliberately no growTimelineIfNeeded: the clip lands after the last one, which for
          // anything longer than the window means out in the shaded area, where it is an
          // <Audio N> reference and not part of the soundtrack

          this.selectionType = "audio";
          this.selectedIndex = this.timeline.audioSegments.findIndex(s => s.id === seg.id);

          this.updateUIFromSelection();
          this.commitChanges(true);
          this.render();
          resolve();
        } catch (err) {
          console.error("[MiniMaxDirector] Audio processing failed", err);
          resolve();
        }
      });
    }
    this.audioFileInput.value = "";
  }

  markSegment(seg) {
    if (!seg) return;
    const newStart = Math.round(seg.start);
    const newEnd = Math.max(newStart + 1, Math.round(seg.start + seg.length));

    const currentStart = this.getStartFrames();
    const currentEnd = this.endFramesWidget ? parseInt(this.endFramesWidget.value, 10) : (currentStart + this.getDurationFrames());

    let targetStart = newStart;
    let targetEnd = newEnd;

    if (currentStart === newStart && currentEnd === newEnd) {
      const allSegs = [
        ...(this.timeline.segments || []),
        ...(this.timeline.motionSegments || []),
        ...(this.timeline.audioSegments || [])
      ];
      let lastSegmentEnd = 0;
      for (const s of allSegs) {
        if (s.start + s.length > lastSegmentEnd) {
          lastSegmentEnd = s.start + s.length;
        }
      }
      if (lastSegmentEnd <= 0) {
        lastSegmentEnd = this.getDurationFrames();
      }
      targetStart = 0;
      targetEnd = Math.max(1, Math.round(lastSegmentEnd));
    }

    if (this.startFramesWidget && this.endFramesWidget) {
      this.startFramesWidget.value = targetStart;
      this.endFramesWidget.value = targetEnd;
      if (this.startFramesWidget.callback) {
        this.startFramesWidget.callback(targetStart);
      }
      if (this.endFramesWidget.callback) {
        this.endFramesWidget.callback(targetEnd);
      }
      this.commitChanges();
      this.render();
    }
  }

  markCurrentSelection() {
    if (this.retakeMode) {
      if (this.timeline.retakeVideo) {
        const baseVideoDur = this.timeline.retakeVideo.videoDurationFrames || 24;
        const targetStart = 0;
        const targetEnd = baseVideoDur;

        if (this.startFramesWidget && this.endFramesWidget) {
          this.startFramesWidget.value = targetStart;
          this.endFramesWidget.value = targetEnd;
          if (this.startFramesWidget.callback) {
            this.startFramesWidget.callback(targetStart);
          }
          if (this.endFramesWidget.callback) {
            this.endFramesWidget.callback(targetEnd);
          }
          this.commitChanges();
          this.render();
        }
      }
      return;
    }

    const allSegs = [
      ...(this.timeline.segments || []),
      ...(this.timeline.motionSegments || []),
      ...(this.timeline.audioSegments || [])
    ];
    let targetSegs = [];

    if (this.selectedSegmentIds && this.selectedSegmentIds.length > 0) {
      targetSegs = allSegs.filter(s => this.selectedSegmentIds.includes(s.id));
    }

    if (targetSegs.length === 0 && this.selectedIndex >= 0 && this.selectionType) {
      const arr = this.getSegmentArray(this.selectionType);
      if (arr && arr[this.selectedIndex]) {
        targetSegs = [arr[this.selectedIndex]];
      }
    }

    if (targetSegs.length === 0) return;

    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const s of targetSegs) {
      if (s.start < minStart) {
        minStart = s.start;
      }
      if (s.start + s.length > maxEnd) {
        maxEnd = s.start + s.length;
      }
    }

    if (minStart !== Infinity && maxEnd !== -Infinity) {
      const newStart = Math.round(minStart);
      const newEnd = Math.max(newStart + 1, Math.round(maxEnd));

      const currentStart = this.getStartFrames();
      const currentEnd = this.endFramesWidget ? parseInt(this.endFramesWidget.value, 10) : (currentStart + this.getDurationFrames());

      let targetStart = newStart;
      let targetEnd = newEnd;

      if (currentStart === newStart && currentEnd === newEnd) {
        let lastSegmentEnd = 0;
        for (const s of allSegs) {
          if (s.start + s.length > lastSegmentEnd) {
            lastSegmentEnd = s.start + s.length;
          }
        }
        if (lastSegmentEnd <= 0) {
          lastSegmentEnd = this.getDurationFrames();
        }
        targetStart = 0;
        targetEnd = Math.max(1, Math.round(lastSegmentEnd));
      }

      if (this.startFramesWidget && this.endFramesWidget) {
        this.startFramesWidget.value = targetStart;
        this.endFramesWidget.value = targetEnd;
        if (this.startFramesWidget.callback) {
          this.startFramesWidget.callback(targetStart);
        }
        if (this.endFramesWidget.callback) {
          this.endFramesWidget.callback(targetEnd);
        }
        this.commitChanges();
        this.render();
      }
    }
  }

  deleteSelectedSegment() {
    if (this.selectedSegmentIds && this.isMultiSelectActive()) {
      const idsToDelete = new Set(this.selectedSegmentIds);
      for (const id of this.selectedSegmentIds) {
        if (id.endsWith("_v")) idsToDelete.add(id.slice(0, -2) + "_a");
        else if (id.endsWith("_a")) idsToDelete.add(id.slice(0, -2) + "_v");
      }

      this.timeline.segments = this.timeline.segments.filter(s => !idsToDelete.has(s.id));
      this.timeline.motionSegments = this.timeline.motionSegments.filter(s => !idsToDelete.has(s.id));
      this.timeline.audioSegments = this.timeline.audioSegments.filter(s => !idsToDelete.has(s.id));

      this.selectedSegmentIds = [];
      this.selectedIndex = -1;
    } else {
      const delSibling = (seg) => {
        if (!seg || !seg.id) return;
        const isVid = seg.id.endsWith("_v");
        const isAud = seg.id.endsWith("_a");
        if (!isVid && !isAud) return;

        const siblingId = isVid ? seg.id.slice(0, -2) + "_a" : seg.id.slice(0, -2) + "_v";
        const siblingArray = isVid ? this.timeline.audioSegments : this.timeline.segments;
        const sIdx = siblingArray.findIndex(s => s.id === siblingId);
        if (sIdx !== -1) siblingArray.splice(sIdx, 1);
      };

      if (this.selectionType === "audio") {
        if (this.timeline.audioSegments.length === 0 || this.selectedIndex === -1) return;
        delSibling(this.timeline.audioSegments[this.selectedIndex]);
        this.timeline.audioSegments.splice(this.selectedIndex, 1);
        this.selectedIndex = Math.max(-1, this.selectedIndex - 1);
      } else if (this.selectionType === "motion") {
        if (this.timeline.motionSegments.length === 0 || this.selectedIndex === -1) return;
        delSibling(this.timeline.motionSegments[this.selectedIndex]);
        this.timeline.motionSegments.splice(this.selectedIndex, 1);
        this.selectedIndex = Math.max(-1, this.selectedIndex - 1);
      } else {
        if (this.timeline.segments.length === 0 || this.selectedIndex === -1) return;
        delSibling(this.timeline.segments[this.selectedIndex]);
        this.timeline.segments.splice(this.selectedIndex, 1);
        this.selectedIndex = Math.max(-1, this.selectedIndex - 1);
      }
      this.selectedSegmentIds = [];
    }
    this.updateUIFromSelection();
    this.commitChanges();
    this.render();
  }

  getCanonicalTrack(track) {
    if (track === "image" || track === "video" || track === "text") return "image";
    if (track === "audio") return "audio";
    if (track === "motion" || track === "motion_video") return "motion";
    return track;
  }

  pasteCopiedSegment() {
    if (!window._mmxCopiedSegmentCS || !window._mmxCopiedSegmentTypeCS) return;
    const trackType = window._mmxCopiedSegmentTypeCS;
    const startFrame = Math.round(this.currentFrame);
    this.pasteSegmentAtFrame(window._mmxCopiedSegmentCS.main, trackType, window._mmxCopiedSegmentCS.sibling, startFrame);
  }

  pasteSegmentAtFrame(copiedSegData, copiedTrack, siblingSegData, startFrame) {
    const isAudio = copiedTrack === "audio";

    const randId = () => Date.now().toString() + Math.random().toString(36).substr(2, 5);
    const baseId = randId();

    let mainSeg = { ...copiedSegData };
    let sibSeg = siblingSegData ? { ...siblingSegData } : null;

    if (sibSeg) {
      mainSeg.id = baseId + (isAudio ? "_a" : "_v");
      sibSeg.id = baseId + (isAudio ? "_v" : "_a");
    } else {
      if (mainSeg.id && (mainSeg.id.endsWith("_v") || mainSeg.id.endsWith("_a"))) {
        mainSeg.id = mainSeg.id.slice(0, -2);
      } else {
        mainSeg.id = baseId;
      }
    }

    if (mainSeg.thumbnails) mainSeg.thumbnails = [...mainSeg.thumbnails];
    if (sibSeg && sibSeg.thumbnails) sibSeg.thumbnails = [...sibSeg.thumbnails];

    mainSeg.start = startFrame;
    if (sibSeg) sibSeg.start = startFrame;

    const mainArr = isAudio ? [...this.timeline.audioSegments] : (copiedTrack === "motion" ? [...this.timeline.motionSegments] : [...this.timeline.segments]);
    mainArr.push(mainSeg);
    mainArr.sort((a, b) => a.start - b.start);

    const sibArr = isAudio ? [...this.timeline.segments] : [...this.timeline.audioSegments];
    if (sibSeg) {
      sibArr.push(sibSeg);
      sibArr.sort((a, b) => a.start - b.start);
    }

    const durationFrames = this.getDurationFrames();
    const totalFrames = this.getVisualDurationFrames();
    const width = this.canvas.offsetWidth || this._lastWidth;

    const mainInit = mainArr.map(s => ({ ...s }));
    const sibInit = sibSeg ? sibArr.map(s => ({ ...s })) : null;

    let finalMain, finalSib;
    finalMain = this._applyCenterDragPhysics(mainInit, mainSeg.id, startFrame, startFrame + mainSeg.length / 2, durationFrames, totalFrames, width, true);
    if (sibSeg) {
      finalSib = this._applyCenterDragPhysics(sibInit, sibSeg.id, startFrame, startFrame + sibSeg.length / 2, durationFrames, totalFrames, width, true);
    }

    if (sibSeg) {
      const activeTimeline = isAudio ? finalMain : finalSib;
      const siblingTimeline = isAudio ? finalSib : finalMain;
      this._resolveGlobalPhysics(activeTimeline, siblingTimeline, durationFrames, mainInit, sibInit);
    }

    const restoreDOM = (outArr, refArr) => {
      for (let ps of outArr) {
        const orig = refArr.find(s => s.id === ps.id);
        if (orig) {
          ps.videoEl = orig.videoEl;
          ps.imgObj = orig.imgObj;
          if (orig.thumbnails) ps.thumbnails = orig.thumbnails;
        }
      }
    };

    restoreDOM(finalMain, mainArr);
    if (sibSeg) restoreDOM(finalSib, sibArr);

    if (copiedTrack === "audio") {
      this.timeline.audioSegments = finalMain;
      if (sibSeg) this.timeline.segments = finalSib;
    } else if (copiedTrack === "motion") {
      this.timeline.motionSegments = finalMain;
    } else {
      this.timeline.segments = finalMain;
      if (sibSeg) this.timeline.audioSegments = finalSib;
    }

    this.selectionType = copiedTrack;
    this.selectedIndex = this.getSegmentArray(copiedTrack).findIndex(s => s.id === mainSeg.id);

    // Only a paste that put something on the main track can decide the output length. A lone
    // audio or reference-video clip is a reference and grows nothing; an audio clip with a `_v`
    // sibling means a real video landed on the main track, which does.
    const onMainTrack = copiedTrack === "audio" ? !!sibSeg : copiedTrack !== "motion";
    if (!this.retakeMode && onMainTrack) {
      this.growTimelineIfNeeded(mainSeg.start + mainSeg.length);
    }

    this.updateUIFromSelection();
    this.commitChanges();
    this.render();
  }

  splitSegmentAtPlayhead(seg, trackType) {
    if (this.isPlaying) {
      this.pauseAudio();
    }

    const splitFrame = Math.round(this.currentFrame);
    if (splitFrame <= seg.start || splitFrame >= seg.start + seg.length) {
      return;
    }

    const isVidLink = (trackType === "image" || trackType === "video") && seg.id.endsWith("_v");
    const isAudLink = trackType === "audio" && seg.id.endsWith("_a");
    let sibling = null;
    if (isVidLink) {
      sibling = this.timeline.audioSegments.find(s => s.id === seg.id.slice(0, -2) + "_a");
    } else if (isAudLink) {
      sibling = this.timeline.segments.find(s => s.id === seg.id.slice(0, -2) + "_v");
    }

    const randId = () => Date.now().toString() + Math.random().toString(36).substr(2, 5);
    const leftBase = randId();
    const rightBase = randId();

    const leftLen = splitFrame - seg.start;
    const rightLen = seg.start + seg.length - splitFrame;

    if (sibling) {
      const videoSeg = isVidLink ? seg : sibling;
      const audioSeg = isVidLink ? sibling : seg;

      const leftVid = {
        ...videoSeg,
        id: leftBase + "_v",
        length: leftLen,
        videoEl: null,
        _blobUrl: videoSeg._blobUrl || (videoSeg.videoEl ? videoSeg.videoEl.src : null),
        thumbnails: videoSeg.thumbnails ? [...videoSeg.thumbnails] : null
      };
      const leftAud = {
        ...audioSeg,
        id: leftBase + "_a",
        length: leftLen,
        _blobUrl: videoSeg._blobUrl || (videoSeg.videoEl ? videoSeg.videoEl.src : null)
      };

      let rightImageB64 = videoSeg.imageB64;
      let rightImgObj = videoSeg.imgObj;
      if (videoSeg.thumbnails && videoSeg.thumbnails.length > 0) {
        const targetTime = ((videoSeg.trimStart || 0) + leftLen) / this.getFrameRate();
        let nearest = videoSeg.thumbnails[0];
        let minDiff = Infinity;
        for (const t of videoSeg.thumbnails) {
          const diff = Math.abs(t.time - targetTime);
          if (diff < minDiff) {
            minDiff = diff;
            nearest = t;
          }
        }
        if (nearest && nearest.img) {
          rightImageB64 = nearest.img.src;
          rightImgObj = nearest.img;
        }
      }

      const rightVid = {
        ...videoSeg,
        id: rightBase + "_v",
        start: splitFrame,
        length: rightLen,
        trimStart: (videoSeg.trimStart || 0) + leftLen,
        videoEl: null,
        imageB64: rightImageB64,
        imgObj: rightImgObj,
        _blobUrl: videoSeg._blobUrl || (videoSeg.videoEl ? videoSeg.videoEl.src : null),
        thumbnails: videoSeg.thumbnails ? [...videoSeg.thumbnails] : null
      };
      const rightAud = {
        ...audioSeg,
        id: rightBase + "_a",
        start: splitFrame,
        length: rightLen,
        trimStart: (audioSeg.trimStart || 0) + leftLen,
        _blobUrl: videoSeg._blobUrl || (videoSeg.videoEl ? videoSeg.videoEl.src : null)
      };

      this.timeline.segments = this.timeline.segments.filter(s => s.id !== videoSeg.id);
      this.timeline.audioSegments = this.timeline.audioSegments.filter(s => s.id !== audioSeg.id);

      this.timeline.segments.push(leftVid, rightVid);
      this.timeline.audioSegments.push(leftAud, rightAud);

      this.timeline.segments.sort((a, b) => a.start - b.start);
      this.timeline.audioSegments.sort((a, b) => a.start - b.start);

      this.selectionType = trackType;
      const targetId = trackType === "audio" ? leftAud.id : leftVid.id;
      const targetArray = this.getSegmentArray(trackType);
      this.selectedIndex = targetArray.findIndex(s => s.id === targetId);

    } else {
      const targetArray = this.getSegmentArray(trackType);

      const leftSeg = {
        ...seg,
        id: leftBase,
        length: leftLen
      };
      if (seg.type === "video" || seg.type === "motion_video") {
        leftSeg.videoEl = null;
        leftSeg._blobUrl = seg._blobUrl || (seg.videoEl ? seg.videoEl.src : null);
        leftSeg.thumbnails = seg.thumbnails ? [...seg.thumbnails] : null;
      }

      let rightImageB64 = seg.imageB64;
      let rightImgObj = seg.imgObj;
      if (seg.thumbnails && seg.thumbnails.length > 0) {
        const targetTime = ((seg.trimStart || 0) + leftLen) / this.getFrameRate();
        let nearest = seg.thumbnails[0];
        let minDiff = Infinity;
        for (const t of seg.thumbnails) {
          const diff = Math.abs(t.time - targetTime);
          if (diff < minDiff) {
            minDiff = diff;
            nearest = t;
          }
        }
        if (nearest && nearest.img) {
          rightImageB64 = nearest.img.src;
          rightImgObj = nearest.img;
        }
      }

      const rightSeg = {
        ...seg,
        id: rightBase,
        start: splitFrame,
        length: rightLen,
        trimStart: (seg.trimStart || 0) + leftLen
      };
      if (seg.type === "video" || seg.type === "motion_video") {
        rightSeg.videoEl = null;
        rightSeg.imageB64 = rightImageB64;
        rightSeg.imgObj = rightImgObj;
        rightSeg._blobUrl = seg._blobUrl || (seg.videoEl ? seg.videoEl.src : null);
        rightSeg.thumbnails = seg.thumbnails ? [...seg.thumbnails] : null;
      }

      const idx = targetArray.findIndex(s => s.id === seg.id);
      if (idx !== -1) {
        targetArray.splice(idx, 1);
      }

      targetArray.push(leftSeg, rightSeg);
      targetArray.sort((a, b) => a.start - b.start);

      this.selectionType = trackType;
      this.selectedIndex = targetArray.findIndex(s => s.id === leftSeg.id);
    }

    this.loadMedia();
    this.updateUIFromSelection();
    this.commitChanges();
    this.render();
  }

  formatTime(frames, dropSuffix = false) {
    const mode = this.displayModeWidget ? this.displayModeWidget.value : "seconds";
    if (mode === "seconds") {
      const secs = Math.round(frames) / this.getFrameRate();
      return dropSuffix ? secs.toFixed(2) : secs.toFixed(2) + "s";
    }
    return dropSuffix ? Math.round(frames).toString() : Math.round(frames) + " frames";
  }

  updateWidgetVisibility() {
    const mode = this.displayModeWidget ? this.displayModeWidget.value : "seconds";
    const isSeconds = mode === "seconds";

    const isLiteGraph = !window.LiteGraph || !window.LiteGraph.vueNodesMode;

    if (isSeconds) {
      if (this.startFramesWidget) hideWidget(this.startFramesWidget);
      if (this.endFramesWidget) hideWidget(this.endFramesWidget);
      if (this.durationFramesWidget) hideWidget(this.durationFramesWidget);
      if (this.startSecondsWidget) showWidget(this.startSecondsWidget);
      if (this.endSecondsWidget) showWidget(this.endSecondsWidget);
      if (this.durationSecondsWidget) showWidget(this.durationSecondsWidget);

      // LiteGraph: remove frame input slots, restore second input slots
      if (isLiteGraph && this.node.inputs) {
        for (const name of ["start_frame", "end_frame", "duration_frames"]) {
          const idx = this.node.inputs.findIndex(i => i.name === name);
          if (idx !== -1 && this.node.inputs[idx].link == null) {
            this.node.removeInput(idx);
          }
        }
        for (const [name, type] of [["start_second", "FLOAT"], ["end_second", "FLOAT"], ["duration_seconds", "FLOAT"]]) {
          if (!this.node.inputs.find(i => i.name === name)) {
            const w = this.node.widgets?.find(w => w.name === name);
            const slot = this.node.addInput(name, type);
            // keep the slot linked to its widget
            if (w && slot != null) {
              const inp = this.node.inputs[this.node.inputs.length - 1];
              if (inp) inp.widget = { name };
            }
          }
        }
      }
    } else {
      if (this.startSecondsWidget) hideWidget(this.startSecondsWidget);
      if (this.endSecondsWidget) hideWidget(this.endSecondsWidget);
      if (this.durationSecondsWidget) hideWidget(this.durationSecondsWidget);
      if (this.startFramesWidget) showWidget(this.startFramesWidget);
      if (this.endFramesWidget) showWidget(this.endFramesWidget);
      if (this.durationFramesWidget) showWidget(this.durationFramesWidget);

      // LiteGraph: remove second input slots, restore frame input slots
      if (isLiteGraph && this.node.inputs) {
        for (const name of ["start_second", "end_second", "duration_seconds"]) {
          const idx = this.node.inputs.findIndex(i => i.name === name);
          if (idx !== -1 && this.node.inputs[idx].link == null) {
            this.node.removeInput(idx);
          }
        }
        for (const [name, type] of [["start_frame", "INT"], ["end_frame", "INT"], ["duration_frames", "INT"]]) {
          if (!this.node.inputs.find(i => i.name === name)) {
            const slot = this.node.addInput(name, type);
            if (slot != null) {
              const inp = this.node.inputs[this.node.inputs.length - 1];
              if (inp) inp.widget = { name };
            }
          }
        }
      }
    }

    // Force node resize and redraw deferred to next tick
    setTimeout(() => {
      if (this.node && this.node.computeSize) {
        const sz = this.node.computeSize();
        this.node.size[1] = sz[1];
        if (window.app && window.app.graph) {
          window.app.graph.setDirtyCanvas(true, true);
        }
      }
    }, 0);
  }

  getGlobalPrompt() {
    if (this.globalPromptInput) {
      return this.globalPromptInput.value || "";
    }
    let val = "";
    if (this.node) {
      const globalInput = this.node.inputs?.find(i => i.name === "global_prompt");
      if (globalInput && globalInput.link !== null && globalInput.link !== undefined) {
        const link = window.app.graph?.links?.[globalInput.link];
        if (link) {
          const originNode = window.app.graph.getNodeById(link.origin_id);
          if (originNode && originNode.widgets && originNode.widgets.length > 0) {
            val = originNode.widgets[0].value || "";
          }
        }
      } else {
        const w = this.node.widgets?.find(x => x.name === "global_prompt");
        if (w) {
          val = w.value || "";
        } else {
          val = this.node.properties?.global_prompt || "";
        }
      }
    }
    return val;
  }

  syncGlobalPrompt(val) {
    if (this.node.properties) {
      this.node.properties.global_prompt = val;
    }
    if (this.retakeMode) {
      this.timeline.retake_global_prompt = val;
    } else {
      this.timeline.global_prompt = val;
    }
    const globalInput = this.node.inputs?.find(i => i.name === "global_prompt");
    let synced = false;
    if (globalInput && globalInput.link !== null && globalInput.link !== undefined) {
      const link = window.app.graph?.links?.[globalInput.link];
      if (link) {
        const originNode = window.app.graph.getNodeById(link.origin_id);
        if (originNode && originNode.widgets && originNode.widgets.length > 0) {
          const w = originNode.widgets[0];
          const oldVal = w.value;
          w.value = val;
          if (originNode.onWidgetChanged) {
            originNode.onWidgetChanged(w.name, val, oldVal, w);
          }
          if (w.callback) {
            try {
              originNode.widgets[0].callback(val);
            } catch (err) { }
          }
          synced = true;
        }
      }
    }
    if (!synced) {
      const w = this.node.widgets?.find(x => x.name === "global_prompt");
      if (w) {
        const oldVal = w.value;
        w.value = val;
        if (this.node.onWidgetChanged) {
          this.node.onWidgetChanged(w.name, val, oldVal, w);
        }
        if (w.callback) {
          try {
            w.callback(val);
          } catch (err) { }
        }
      }
    }
    if (this.globalPromptInput && this.globalPromptInput.value !== val) {
      this.globalPromptInput.value = val;
    }
    if (this.node) {
      this.node.setDirtyCanvas(true, false);
    }
    if (window.app?.graph) {
      if (window.app.graph.change) window.app.graph.change();
      if (window.app.graph.onNodeChanged) window.app.graph.onNodeChanged(this.node);
      if (window.app.graph.onStateChanged) window.app.graph.onStateChanged();
    }
  }

  // The properties panel has to hold the prompt box *and*, when a reference is selected,
  // the note strip. Without this the default 90px panel would leave the prompt box 24px.
  _propMinH() {
    const notes = this.refNoteRow && this.refNoteRow.style.display !== "none";
    const limits = this.refLimitsRow && this.refLimitsRow.style.display !== "none";
    return PROP_MIN_H + (notes ? REF_NOTE_ROW_HEIGHT : 0)
                      + (limits ? REF_LIMITS_ROW_HEIGHT : 0);
  }

  // The reference-video limits, shown only for a clip on the reference-video track.
  // Frames and start edit the segment itself, so the track keeps showing what will be sent.
  _syncRefLimitsRow(seg) {
    if (!this.refLimitsRow) return;
    const refsOn = String(this.timeline.reference_mode || "OFF").toUpperCase() !== "OFF";
    if (!seg || this.selectionType !== "motion" || !refsOn || this.retakeMode) {
      this.refLimitsRow.style.display = "none";
      return;
    }
    this.refLimitsRow.style.display = "flex";

    const fps = this.getFrameRate() || 24;
    const frames = Math.max(1, Math.round(seg.length || 1));
    this.refStartInput.value = Math.max(0, Math.round(seg.trimStart || 0));
    this.refFramesInput.value = frames;
    this.refSizeSelect.value = String(seg.refSize || REF_VIDEO_SIZES[0]);

    // What this clip actually costs, in the terms that matter: seconds against the model
    // card's 2-15s window, and whether it is the one blowing the memory budget.
    const secs = frames / fps;
    const parts = [`${secs.toFixed(1)}s`];
    if (secs < 2) parts.push("under the 2s minimum");
    else if (secs > 15) parts.push("over the 15s maximum");
    // where it sits, when that is past the window: still sent, and not in the video
    if (this._refOnlyNote(seg, "motion")) parts.push("past the window, sent as a reference");
    this.refLimitsNote.textContent = parts.join(" · ");
    this.refLimitsNote.style.color = (secs < 2 || secs > 15) ? "#d08a3a" : "#5a5a5a";
  }

  // What to say about a reference clip parked outside the render window. It is still sent to
  // the model — that is the whole point of parking it there — and the shaded background only
  // says "not in the video", which is the half that misleads. Empty for a clip that reaches into
  // the window, in retake mode, and with refs off, where nothing is sent from either side.
  _refOnlyNote(seg, kind) {
    if (!seg || this.retakeMode) return "";
    if (String(this.timeline.reference_mode || "OFF").toUpperCase() === "OFF") return "";
    const winStart = this.getStartFrames();
    const winEnd = winStart + this.getDurationFrames();
    const start = seg.start || 0;
    if (start < winEnd && start + (seg.length || 0) > winStart) return "";
    return kind === "audio"
      ? "Past the render window: sent as a reference, and no part of the soundtrack."
      : "Past the render window: sent as a reference.";
  }

  // Opens the panel far enough that showing the strip does not squeeze the prompt box to
  // nothing. Only ever grows — a panel the user has already dragged taller is left alone.
  _growPropForRefNote() {
    const min = this._propMinH();
    if (!this.propContainer || this.propHeight >= min) return;
    this.propHeight = min;
    if (this.node?.properties) this.node.properties.propHeight = min;
    this.propContainer.style.height = `${min}px`;
    if (this.node?.setDirtyCanvas && typeof this.node.computeSize === "function"
        && this.node.size) {
      this.node.setSize([this.node.size[0], this.node.computeSize()[1]]);
      this.node.setDirtyCanvas(true, true);
    }
  }

  // Shows the describes/retained strip for whichever reference is selected, and fills it.
  // Hidden entirely with refs off: with no <Subject>/<Picture>/<Video>/<Audio> labels in
  // the prompt there is nothing for either sentence to attach to.
  _syncRefNoteRow(seg) {
    if (!this.refNoteRow) return;
    const refsOn = String(this.timeline.reference_mode || "OFF").toUpperCase() !== "OFF";
    const isRef = !!seg && (
      this.selectionType === "motion" || this.selectionType === "audio" ||
      (this.selectionType === "image" && (seg.type === "image" || seg.type === "video")));

    if (!refsOn || !isRef || this.retakeMode) {
      this.refNoteRow.style.display = "none";
      return;
    }
    this.refNoteRow.style.display = "flex";
    this._growPropForRefNote();

    // `describes` writes the reference's line in subject_definitions. A frame or
    // storyboard anchor is the exception: its declaration states where the image sits in
    // the video, which the timeline already knows and the user should not contradict.
    const describes = this.selectionType !== "image" || seg.refRole === "subject";
    this.refDescField.style.display = describes ? "" : "none";
    if (describes) this.refDescInput.value = seg.refDesc || "";
    this.refDescInput.placeholder = {
      audio: "e.g. the voice-timbre reference for <Subject 1>",
      motion: "e.g. the source of the camera move and cut rhythm",
    }[this.selectionType] || "what this image defines, e.g. a long red wool coat";
    this.refNoteInput.value = seg.refNote || "";
    this.refNoteInput.placeholder = this.selectionType === "audio"
      ? "what the target keeps from this audio — leave empty for the default"
      : "what survives into the video — leave empty for the default";
  }

  updateUIFromSelection() {
    if (this.selectedSegmentIds && this.isMultiSelectActive()) {
      if (this.globalPromptInput) {
        this.globalPromptInput.disabled = true;
        this.globalPromptInput.style.opacity = "0.35";
      }
      if (this.promptWrapper) this.promptWrapper.style.display = "block";
      if (this.promptInput) {
        this.promptInput.value = "";
        this.promptInput.placeholder = "(Multiple Segments Selected)";
        this.promptInput.disabled = true;
        this.promptInput.style.opacity = "0.35";
      }

      if (this.segmentPromptLabel) {
        this.segmentPromptLabel.style.display = "block";
        this.segmentPromptLabel.textContent = "Segment Prompt";
      }

      if (this.strengthRow) this.strengthRow.style.display = "flex";
      if (this.strengthLabel) this.strengthLabel.style.display = "inline";
      if (this.strengthValue) {
        this.strengthValue.style.display = "inline-block";
        this.strengthValue.value = "";
        this.strengthValue.placeholder = "(Multiple)";
        this.strengthValue.disabled = true;
        this.strengthValue.style.opacity = "0.35";
      }

      if (this.vidStrLabel) this.vidStrLabel.style.display = "none";
      if (this.vidStrValue) {
        this.vidStrValue.style.display = "none";
        this.vidStrValue.disabled = true;
        this.vidStrValue.style.opacity = "0.35";
      }
      if (this.vidAttnLabel) this.vidAttnLabel.style.display = "none";
      if (this.vidAttnValue) {
        this.vidAttnValue.style.display = "none";
        this.vidAttnValue.disabled = true;
        this.vidAttnValue.style.opacity = "0.35";
      }

      if (this.audioInfoArea) this.audioInfoArea.style.display = "none";
      if (this.motionInfoArea) this.motionInfoArea.style.display = "none";

      if (this.segmentBoundsDisplay) {
        this.segmentBoundsDisplay.textContent = "Multiple Segments Selected";
      }
      // there is no single reference to annotate, and leaving these up would show the
      // previously selected segment's values as if they belonged to this selection
      this._syncRefLimitsRow(null);
      this._syncRefNoteRow(null);
      return;
    }

    let seg = null;
    if (this.selectedIndex >= 0) {
      if (this.selectionType === "audio") {
        const origSeg = this.timeline.audioSegments[this.selectedIndex];
        if (origSeg) {
          const previewIsAudio = this._ghostTrack === 'audio' || (this._previewSegments && this._ghostTrack === null && this.selectionType === 'audio');
          const arr = (this._previewSegments && previewIsAudio) ? this._previewSegments : this.timeline.audioSegments;
          seg = arr.find(s => s.id === origSeg.id) || origSeg;
        }
      } else if (this.selectionType === "motion") {
        const origSeg = this.timeline.motionSegments[this.selectedIndex];
        if (origSeg) {
          const previewIsMotion = this._ghostTrack === 'motion' || (this._previewSegments && this._ghostTrack === null && this.selectionType === 'motion');
          const arr = (this._previewSegments && previewIsMotion) ? this._previewSegments : this.timeline.motionSegments;
          seg = arr.find(s => s.id === origSeg.id) || origSeg;
        }
      } else {
        const origSeg = this.timeline.segments[this.selectedIndex];
        if (origSeg) {
          const previewIsImage = this._ghostTrack === 'image' || (this._previewSegments && this._ghostTrack === null && this.selectionType === 'image');
          const arr = (this._previewSegments && previewIsImage) ? this._previewSegments : this.timeline.segments;
          seg = arr.find(s => s.id === origSeg.id) || origSeg;
        }
      }
    }

    // Reset default disabled/opacity values
    if (this.vidStrValue) {
      this.vidStrValue.disabled = false;
      this.vidStrValue.style.opacity = "";
    }
    if (this.vidAttnValue) {
      this.vidAttnValue.disabled = false;
      this.vidAttnValue.style.opacity = "";
    }
    if (this.strengthValue) {
      this.strengthValue.style.opacity = "";
      this.strengthValue.placeholder = "";
    }
    if (this.promptInput) {
      this.promptInput.placeholder = "";
      this.promptInput.style.opacity = "";
    }

    // Set once here rather than in each branch below: these belong to the selected
    // segment, not to whichever of the prompt box / motion info / audio info is on show.
    this._syncRefLimitsRow(seg);
    this._syncRefNoteRow(seg);

    if (this.retakeMode) {
      if (this.promptWrapper) this.promptWrapper.style.display = "block";
      this.promptInput.disabled = false;
      this.promptInput.style.opacity = "1.0";
      this.promptInput.placeholder = "Enter prompt for retake region...";
      this.promptInput.value = this.timeline.retakePrompt || "";

      this.strengthRow.style.display = "flex";
      this.strengthLabel.style.display = "inline";
      this.strengthLabel.textContent = "Guide Strength:";
      this.strengthValue.style.display = "inline-block";
      this.strengthValue.disabled = true;
      this.strengthValue.style.opacity = "0.35";
      this.strengthValue.value = (this.timeline.retakeStrength ?? 1.0).toFixed(2);

      this.vidStrLabel.style.display = "none";
      this.vidStrValue.style.display = "none";
      this.vidAttnLabel.style.display = "none";
      this.vidAttnValue.style.display = "none";

      this.audioInfoArea.style.display = "none";
      this.motionInfoArea.style.display = "none";

      if (this.segmentBoundsDisplay) {
        const startStr = this.formatTime(this.timeline.retakeStart, true);
        const endStr = this.formatTime(this.timeline.retakeStart + this.timeline.retakeLength, true);
        const lengthStr = this.formatTime(this.timeline.retakeLength, true);
        this.segmentBoundsDisplay.textContent = `Start: ${startStr} | End: ${endStr} | Length: ${lengthStr}`;
      }
    } else if (this.selectionType === "audio" && seg) {
      if (this.globalPromptInput) {
        this.globalPromptInput.disabled = false;
        this.globalPromptInput.style.opacity = "1.0";
      }
      if (this.promptWrapper) this.promptWrapper.style.display = "none";
      this.strengthRow.style.display = "flex";
      this.strengthLabel.style.display = "inline";
      this.strengthLabel.textContent = "Guide Strength:";
      this.strengthValue.style.display = "inline-block";
      this.vidStrLabel.style.display = "none";
      this.vidStrValue.style.display = "none";
      this.vidAttnLabel.style.display = "none";
      this.vidAttnValue.style.display = "none";
      this.audioInfoArea.style.display = "block";
      this.motionInfoArea.style.display = "none";
      // Whose voice this is. The reference guide has a sentence for exactly this —
      // "<Audio 1> is the voice-timbre reference for <Subject 1> (S1)." — and without
      // somewhere to say it, a second voice reference is just another numbered clip with
      // no way to tell the model who is speaking (issue #10).
      const options = this._audioSubjectOptions(seg);
      const parkedNote = this._refOnlyNote(seg, "audio");
      this.audioInfoArea.innerHTML = `
        File: <span>${escapeAttr(seg.fileName || "Unknown")}</span><br>
        Length: <span>${this.formatTime(seg.audioDurationFrames)}</span> Output Length: <span>${this.formatTime(seg.length)}</span><br>
        Trim-in: <span>${this.formatTime(Math.round(seg.trimStart))}</span> Trim-Out: <span>${this.formatTime(Math.round(seg.audioDurationFrames - (seg.trimStart + seg.length)))}</span><br>
        <label class="mmxd-audio-subject-label">Voice of:
          <select class="mmxd-audio-subject">${options}</select>
        </label>
        ${parkedNote ? `<div class="mmxd-ref-only">${parkedNote}</div>` : ""}
      `;
      const subjSel = this.audioInfoArea.querySelector(".mmxd-audio-subject");
      if (subjSel) {
        subjSel.addEventListener("change", (e) => {
          const target = this.timeline.audioSegments?.[this.selectedIndex];
          if (!target) return;
          if (e.target.value) target.subject = parseInt(e.target.value, 10);
          else delete target.subject;
          this.commitChanges(true);
          if (this.node?._mmxRefreshPrompt) this.node._mmxRefreshPrompt();
        });
      }
      this.strengthValue.value = "1.00";
      this.strengthValue.disabled = true;
    } else if (this.selectionType === "motion" && seg) {
      if (this.globalPromptInput) {
        this.globalPromptInput.disabled = true;
        this.globalPromptInput.style.opacity = "0.4";
      }
      if (this.promptWrapper) this.promptWrapper.style.display = "block";
      this.promptInput.disabled = false;
      this.promptInput.style.opacity = "1.0";
      this.promptInput.placeholder = "Global prompt (syncs across all reference-video segments)...";
      this.promptInput.value = this.getGlobalPrompt();
      if (this.segmentPromptLabel) {
        this.segmentPromptLabel.style.display = "block";
        this.segmentPromptLabel.textContent = "Global Prompt (Reference Video)";
      }

      this.strengthRow.style.display = "flex";
      this.strengthLabel.style.display = "none";
      this.strengthValue.style.display = "none";
      // Video Strength / Video Attn stay hidden: they are LTX conditioning weights, H3's
      // planner never reads them, and a control that does nothing invites tuning it (#26)
      this.vidStrLabel.style.display = "none";
      this.vidStrValue.style.display = "none";
      this.vidAttnLabel.style.display = "none";
      this.vidAttnValue.style.display = "none";

      this.audioInfoArea.style.display = "none";
      this.motionInfoArea.style.display = "none";
    } else {
      if (this.segmentPromptLabel) {
        this.segmentPromptLabel.style.display = "block";
        this.segmentPromptLabel.textContent = "Segment Prompt";
      }
      if (this.globalPromptInput) {
        this.globalPromptInput.disabled = false;
        this.globalPromptInput.style.opacity = "1.0";
      }
      this.audioInfoArea.style.display = "none";
      this.motionInfoArea.style.display = "none";
      if (this.promptWrapper) this.promptWrapper.style.display = "block";
      this.strengthRow.style.display = "flex";
      this.strengthLabel.style.display = "inline";
      this.strengthLabel.textContent = "Guide Strength:";
      this.strengthValue.style.display = "inline-block";
      this.vidStrLabel.style.display = "none";
      this.vidStrValue.style.display = "none";
      this.vidAttnLabel.style.display = "none";
      this.vidAttnValue.style.display = "none";

      if (seg) {
        if (this.selectionType !== "motion") {
          this.promptInput.value = seg.prompt || "";
          this.promptInput.placeholder =
            "Enter prompt for selected segment...   (a line like  @ref1 says: hello  becomes dialogue)";
        }
        this.promptInput.disabled = false;
        this.promptInput.style.opacity = "1.0";

        const isImage = (this.selectionType === "image") && (seg.type === "image" || seg.type === "video");
        const strength = isImage ? (seg.guideStrength ?? 1.0) : 1.0;
        this.strengthValue.value = strength.toFixed(2);
        this.strengthValue.disabled = !isImage;
        this.strengthValue.style.opacity = isImage ? "1.0" : "0.35";
      } else {
        this.promptInput.value = "";
        this.promptInput.placeholder = "No segment selected!";
        this.promptInput.disabled = true;
        this.promptInput.style.opacity = "0.4";
        this.strengthValue.value = "1.00";
        this.strengthValue.disabled = true;
        this.strengthValue.style.opacity = "0.35";
      }
    }

    if (this.segmentBoundsDisplay && !this.retakeMode) {
      if (seg) {
        const startStr = this.formatTime(seg.start, true);
        const endStr = this.formatTime(seg.start + seg.length, true);
        const lengthStr = this.formatTime(seg.length, true);
        this.segmentBoundsDisplay.textContent = `Start: ${startStr} | End: ${endStr} | Length: ${lengthStr}`;
      } else {
        this.segmentBoundsDisplay.textContent = "Start: - | End: - | Length: -";
      }
    }
  }


  updateRetakeUIState() {
    const isRetake = this.retakeMode;

    if (this.globalPromptInput) {
      const p = isRetake ? (this.timeline.retake_global_prompt || "") : (this.timeline.global_prompt || "");
      if (this.globalPromptInput.value !== p) {
        this.globalPromptInput.value = p;
        this.syncGlobalPrompt(p);
      }
    }

    // The sound sections do not switch with retake mode — one value for the whole
    // timeline — but they still have to come back when a workspace is loaded, and this
    // is the hook that runs for that.
    if (this.soundscapeInput) {
      const s = this.timeline.overall_soundscape || "";
      if (this.soundscapeInput.value !== s) this.soundscapeInput.value = s;
    }
    if (this.musicInput) {
      const m = this.timeline.non_diegetic_music || "";
      if (this.musicInput.value !== m) this.musicInput.value = m;
    }

    // 1. Set track heights
    if (isRetake) {
      if (this.blockHeight > 0 && this.audioTrackHeight > 0) {
        this._oldBlockHeight = this.blockHeight;
        this._oldAudioTrackHeight = this.audioTrackHeight;
        this._oldMotionTrackHeight = this.motionTrackHeight;
      }
      this.blockHeight = this.canvasHeight - this.rulerHeight;
      this.audioTrackHeight = 0;
      this.motionTrackHeight = 0;
      // In retake mode, uploadVideoBtn stays as "Add Video" (same as normal mode)
      if (this.mainTrackLabel) {
        const textSpan = this.mainTrackLabel.querySelector("span");
        if (textSpan) textSpan.textContent = "VIDEO";
        if (this.mainTrackLabel._eyeBtn) this.mainTrackLabel._eyeBtn.style.display = "none";
        this.mainTrackLabel.style.backgroundColor = "#1e1e1e";
        this.audioTrackLabel.style.display = "none";
        this.motionTrackLabel.style.display = "none";
      }
      if (this.sidebar) this.sidebar.style.backgroundColor = "#1e1e1e";
      if (this.rulerSpacer) this.rulerSpacer.style.backgroundColor = "#1e1e1e";
    } else {
      this.blockHeight = this._oldBlockHeight ?? BLOCK_HEIGHT;
      this.audioTrackHeight = this._oldAudioTrackHeight ?? AUDIO_TRACK_HEIGHT;
      this.motionTrackHeight = this._oldMotionTrackHeight ?? MOTION_TRACK_HEIGHT;
      if (this.uploadVideoBtn) {
        this.uploadVideoBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> Add Video`;
      }
      if (this.mainTrackLabel) {
        const textSpan = this.mainTrackLabel.querySelector("span");
        if (textSpan) textSpan.textContent = "MAIN";
        if (this.mainTrackLabel._eyeBtn) this.mainTrackLabel._eyeBtn.style.display = "inline-flex";
        this.mainTrackLabel.style.backgroundColor = "#1e1e1e";
        this.audioTrackLabel.style.display = "flex";
        this.motionTrackLabel.style.display = "flex";
      }
      if (this.sidebar) this.sidebar.style.backgroundColor = "#1e1e1e";
      if (this.rulerSpacer) this.rulerSpacer.style.backgroundColor = "#1e1e1e";
    }

    this.updateSidebarHeights();

    // Reset zoom to fit viewport when entering retake mode so full video is visible
    if (isRetake) {
      this.zoomLevel = 1;
      if (this.zoomSlider) this.zoomSlider.value = 1;
      this.updateZoomSliderMax();
      const vw = this.viewport ? this.viewport.clientWidth : 0;
      if (vw > 0) {
        this.resizeCanvas(vw);
        this._lastWidth = vw;
        this._lastZoom = 1;
        if (this.viewport) this.viewport.scrollLeft = 0;
      }
    }

    // 2. Hide/show toolbar action buttons
    if (this.uploadBtn) this.uploadBtn.style.display = isRetake ? "none" : "";
    if (this.addTextBtn) this.addTextBtn.style.display = isRetake ? "none" : "";
    if (this.uploadAudioBtn) this.uploadAudioBtn.style.display = isRetake ? "none" : "";
    if (this.uploadMotionBtn) this.uploadMotionBtn.style.display = isRetake ? "none" : "";
    if (this.deleteBtn) this.deleteBtn.style.display = isRetake ? "none" : "";
    // deleteRetakeBtn is visible whenever Retake Mode is active
    if (this.deleteRetakeBtn) {
      this.deleteRetakeBtn.style.display = isRetake ? "" : "none";
    }

    // 3. Update the toggle button class/title
    if (this.updateRetakeStyle) this.updateRetakeStyle();

    // 4. Update the prompt labels
    if (this.segmentPromptLabel) {
      this.segmentPromptLabel.textContent = isRetake ? "Retake Prompt" : "Local Prompt";
    }

    // 5. Update UI selection inputs
    this.updateUIFromSelection();
  }

  updateSidebarHeights() {
    if (this.mainTrackLabel) {
      this.mainTrackLabel.style.height = `${this.blockHeight}px`;
      this.audioTrackLabel.style.height = `${this.audioTrackHeight}px`;
      this.motionTrackLabel.style.height = `${this.motionTrackHeight}px`;
    }
  }

  // --- Rendering logic ---
  render() {
    if (!this.canvas) return;
    const width = this.canvas.offsetWidth || this._lastWidth;
    const height = this.canvasHeight;
    const totalFrames = this.getVisualDurationFrames();

    if (!width || width <= 0) return;

    this.ctx.clearRect(0, 0, width, height);

    // Lazy load active video/motion segments
    const targetFrame = this.currentFrame;
    if (this.retakeMode && this.timeline.retakeVideo) {
      this._ensureVideoEl(this.timeline.retakeVideo);
    } else {
      const activeSeg = this.timeline.segments.find(s => s.type === "video" && targetFrame >= s.start && targetFrame < s.start + s.length);
      if (activeSeg) this._ensureVideoEl(activeSeg);

      if (this.timeline.motionSegments) {
        const activeMotionSeg = this.timeline.motionSegments.find(s => s.type === "motion_video" && targetFrame >= s.start && targetFrame < s.start + s.length);
        if (activeMotionSeg) this._ensureVideoEl(activeMotionSeg);
      }
    }

    if (this.selectedIndex !== -1) {
      const selSeg = this.getSegmentArray(this.selectionType)[this.selectedIndex];
      if (selSeg && (selSeg.type === "video" || selSeg.type === "motion_video")) {
        this._ensureVideoEl(selSeg);
      }
    }

    if (this._isDragging && this._dragTargetId) {
      const dragSeg = this.timeline.segments.find(s => s.id === this._dragTargetId) ||
        (this.timeline.motionSegments && this.timeline.motionSegments.find(s => s.id === this._dragTargetId));
      if (dragSeg && (dragSeg.type === "video" || dragSeg.type === "motion_video")) {
        this._ensureVideoEl(dragSeg);
      }
    }

    // Render Track Backgrounds
    this.ctx.fillStyle = "#121212"; // Image track bg
    this.ctx.fillRect(0, RULER_HEIGHT, width, this.blockHeight);

    this.ctx.fillStyle = "#141414"; // Audio track bg
    this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight, width, this.audioTrackHeight);

    this.ctx.fillStyle = "#121212"; // Motion track bg
    this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight + this.audioTrackHeight, width, this.motionTrackHeight);



    // Determine which track the preview belongs to.
    // _ghostTrack is set during HTML file drag-and-drop.
    // During canvas mouse drags, _ghostTrack is null, so fall back to selectionType.
    const previewIsAudio = this._ghostTrack === 'audio' ||
      (this._previewSegments && this._ghostTrack === null && this.selectionType === 'audio');
    const previewIsMotion = this._ghostTrack === 'motion' ||
      (this._previewSegments && this._ghostTrack === null && this.selectionType === 'motion');
    const previewIsImage = !previewIsAudio && !previewIsMotion;

    let renderSegments = this.timeline.segments;
    let renderAudioSegments = this.timeline.audioSegments;
    let renderMotionSegments = this.timeline.motionSegments;

    if (this._isDragging && this._multiDragPreviewTimelines) {
      if (this._multiDragPreviewTimelines.image) renderSegments = this._multiDragPreviewTimelines.image;
      if (this._multiDragPreviewTimelines.motion) renderMotionSegments = this._multiDragPreviewTimelines.motion;
      if (this._multiDragPreviewTimelines.audio) renderAudioSegments = this._multiDragPreviewTimelines.audio;
    } else {
      const previewIsAudio = this._ghostTrack === 'audio' ||
        (this._previewSegments && this._ghostTrack === null && this.selectionType === 'audio');
      const previewIsMotion = this._ghostTrack === 'motion' ||
        (this._previewSegments && this._ghostTrack === null && this.selectionType === 'motion');
      const previewIsImage = !previewIsAudio && !previewIsMotion;

      if (this._previewSegments && previewIsImage) renderSegments = this._previewSegments;
      else if (this._previewSiblingSegments && previewIsAudio) renderSegments = this._previewSiblingSegments;

      if (this._previewSegments && previewIsAudio) renderAudioSegments = this._previewSegments;
      else if (this._previewSiblingSegments && previewIsImage) renderAudioSegments = this._previewSiblingSegments;

      if (this._previewSegments && previewIsMotion) renderMotionSegments = this._previewSegments;
    }

    const sortedSegments = [...renderSegments].sort((a, b) => {
      const aSel = this.selectedSegmentIds.includes(a.id) ? 1 : 0;
      const bSel = this.selectedSegmentIds.includes(b.id) ? 1 : 0;
      return aSel - bSel;
    });

    const sortedMotionSegments = [...renderMotionSegments].sort((a, b) => {
      const aSel = this.selectedSegmentIds.includes(a.id) ? 1 : 0;
      const bSel = this.selectedSegmentIds.includes(b.id) ? 1 : 0;
      return aSel - bSel;
    });

    const sortedAudioSegments = [...renderAudioSegments].sort((a, b) => {
      const aSel = this.selectedSegmentIds.includes(a.id) ? 1 : 0;
      const bSel = this.selectedSegmentIds.includes(b.id) ? 1 : 0;
      return aSel - bSel;
    });

    if (this.retakeMode) {
      // Draw Retake Mode Filmstrip and Overlay
      const retakeVid = this.timeline.retakeVideo;
      const frameRate = this.getFrameRate();
      if (retakeVid) {
        const showLivePreview = this.isPlaying || (this._isDragging && (this._dragType === "playhead" || this._dragType === "retake_left" || this._dragType === "retake_right" || this._dragType === "retake_center"));

        // Calculate the actual visual width of the base video block
        const baseVideoDur = retakeVid.videoDurationFrames || 0;
        const videoWidthPx = totalFrames > 0 ? (baseVideoDur / totalFrames) * width : width;

        if (showLivePreview) {
          let targetTime = this.currentFrame / frameRate;
          if (this._isDragging) {
            if (this._dragType === "retake_left") {
              targetTime = (this.timeline.retakeStart ?? 0) / frameRate;
            } else if (this._dragType === "retake_right") {
              targetTime = ((this.timeline.retakeStart ?? 0) + (this.timeline.retakeLength ?? baseVideoDur)) / frameRate;
            } else if (this._dragType === "retake_center") {
              targetTime = (this.timeline.retakeStart ?? 0) / frameRate;
            }
          }

          let drawSource = null;
          const useLiveVideo = this.isPlaying || (this._isDragging ? this._dragType !== "playhead" : true);
          if (useLiveVideo && retakeVid.videoEl && retakeVid.videoEl.readyState >= 2 && !retakeVid.videoEl.seeking) {
            drawSource = retakeVid.videoEl;
          } else if (retakeVid.thumbnails && retakeVid.thumbnails.length > 0) {
            let nearestImg = retakeVid.thumbnails[0].img;
            let minDiff = Infinity;
            for (const t of retakeVid.thumbnails) {
              const diff = Math.abs(t.time - targetTime);
              if (diff < minDiff) {
                minDiff = diff;
                nearestImg = t.img;
              }
            }
            drawSource = nearestImg;
          } else {
            drawSource = retakeVid.videoEl || (retakeVid.imgObj && retakeVid.imgObj.complete ? retakeVid.imgObj : null);
          }

          this.ctx.fillStyle = "#000";
          this.ctx.fillRect(0, RULER_HEIGHT + 1, videoWidthPx, this.blockHeight - 2);

          if (drawSource) {
            const isVid = !!drawSource.videoWidth;
            const natW = isVid ? drawSource.videoWidth : drawSource.naturalWidth;
            const natH = isVid ? drawSource.videoHeight : drawSource.naturalHeight;

            if (natW > 0) {
              const imgRatio = natW / natH;
              const trackRatio = videoWidthPx / this.blockHeight;
              let drawW, drawH, drawX, drawY;

              if (imgRatio > trackRatio) {
                drawW = videoWidthPx;
                drawH = videoWidthPx / imgRatio;
                drawX = 0;
                drawY = RULER_HEIGHT + (this.blockHeight - drawH) / 2;

                this.ctx.save();
                this.ctx.beginPath();
                this.ctx.rect(0, RULER_HEIGHT + 1, videoWidthPx, this.blockHeight - 2);
                this.ctx.clip();
                this.ctx.drawImage(drawSource, drawX, drawY, drawW, drawH);
                this.ctx.restore();
              } else {
                drawH = this.blockHeight;
                drawW = this.blockHeight * imgRatio;
                drawY = RULER_HEIGHT;
                drawX = (videoWidthPx - drawW) / 2;

                this.ctx.save();
                this.ctx.beginPath();
                this.ctx.rect(0, RULER_HEIGHT + 1, videoWidthPx, this.blockHeight - 2);
                this.ctx.clip();

                // Draw centered preview frame
                this.ctx.drawImage(drawSource, drawX, drawY, drawW, drawH);

                // Tile to the left
                let leftX = drawX - drawW;
                while (leftX + drawW > 0) {
                  this.ctx.drawImage(drawSource, leftX, drawY, drawW, drawH);
                  leftX -= drawW;
                }

                // Tile to the right
                let rightX = drawX + drawW;
                while (rightX < videoWidthPx) {
                  this.ctx.drawImage(drawSource, rightX, drawY, drawW, drawH);
                  rightX += drawW;
                }

                this.ctx.restore();
              }
            }
          }
        } else {
          // Static state: pick the midpoint thumbnail and tile it at its natural aspect ratio,
          // matching the visual appearance of the live-preview path.
          const durationSecs = baseVideoDur / frameRate;
          const midTime = durationSecs / 2;

          let drawSource = null;
          if (retakeVid.thumbnails && retakeVid.thumbnails.length > 0) {
            let nearestImg = retakeVid.thumbnails[0].img;
            let minDiff = Infinity;
            for (const t of retakeVid.thumbnails) {
              const diff = Math.abs(t.time - midTime);
              if (diff < minDiff) {
                minDiff = diff;
                nearestImg = t.img;
              }
            }
            drawSource = nearestImg;
          } else {
            drawSource = retakeVid.imgObj && retakeVid.imgObj.complete ? retakeVid.imgObj : null;
          }

          this.ctx.fillStyle = "#000";
          this.ctx.fillRect(0, RULER_HEIGHT + 1, videoWidthPx, this.blockHeight - 2);

          if (drawSource) {
            const isVid = !!drawSource.videoWidth;
            const natW = isVid ? drawSource.videoWidth : drawSource.naturalWidth;
            const natH = isVid ? drawSource.videoHeight : drawSource.naturalHeight;

            if (natW > 0) {
              const imgRatio = natW / natH;
              const trackRatio = videoWidthPx / this.blockHeight;

              this.ctx.save();
              this.ctx.beginPath();
              this.ctx.rect(0, RULER_HEIGHT + 1, videoWidthPx, this.blockHeight - 2);
              this.ctx.clip();

              if (imgRatio > trackRatio) {
                // Video is wider than the track: fill width, letterbox top/bottom
                const drawW = videoWidthPx;
                const drawH = videoWidthPx / imgRatio;
                const drawY = RULER_HEIGHT + (this.blockHeight - drawH) / 2;
                this.ctx.drawImage(drawSource, 0, drawY, drawW, drawH);
              } else {
                // Video is taller/square: fill height and tile left+right at natural AR
                const drawH = this.blockHeight;
                const drawW = drawH * imgRatio;
                const drawX = (videoWidthPx - drawW) / 2;
                const drawY = RULER_HEIGHT;
                // Draw centered tile
                this.ctx.drawImage(drawSource, drawX, drawY, drawW, drawH);
                // Tile to the left
                let leftX = drawX - drawW;
                while (leftX + drawW > 0) {
                  this.ctx.drawImage(drawSource, leftX, drawY, drawW, drawH);
                  leftX -= drawW;
                }
                // Tile to the right
                let rightX = drawX + drawW;
                while (rightX < videoWidthPx) {
                  this.ctx.drawImage(drawSource, rightX, drawY, drawW, drawH);
                  rightX += drawW;
                }
              }

              this.ctx.restore();
            }
          }
        }


        if (retakeVid._uploading || retakeVid._extractingThumbs) {
          this.ctx.save();
          this.ctx.fillStyle = "rgba(0, 14, 37, 0.8)";
          const upText = retakeVid._extractingThumbs ? "Extracting frames..." : "Uploading base video...";
          this.ctx.font = "bold 11px sans-serif";
          const upW = this.ctx.measureText(upText).width + 20;
          this.ctx.fillRect(10, RULER_HEIGHT + 35, upW, 24);
          this.ctx.fillStyle = "#fff";
          this.ctx.textBaseline = "middle";
          this.ctx.textAlign = "center";
          this.ctx.fillText(upText, 10 + upW / 2, RULER_HEIGHT + 47);
          this.ctx.restore();
        }

      } else {
        // No video loaded: Render a placeholder box with upload instructions centered on active timeline
        this.ctx.fillStyle = "#121212";
        this.ctx.fillRect(0, RULER_HEIGHT + 1, width, this.blockHeight - 2);

        // In retake mode, center the placeholder across the visible viewport
        const activeStart = this.viewport ? this.viewport.scrollLeft : 0;
        let activeWidth = this.viewport ? this.viewport.clientWidth : width;
        // The right ~9% of the DOM is clipped, so squish the box to visually center it in the unclipped area
        activeWidth = activeWidth * 0.91;

        this.ctx.strokeStyle = "#555";
        this.ctx.lineWidth = 2;
        this.ctx.setLineDash([6, 6]);
        this.ctx.strokeRect(activeStart + 12, RULER_HEIGHT + 12, Math.max(10, activeWidth - 24), this.blockHeight - 24);
        this.ctx.setLineDash([]);

        this.ctx.fillStyle = "#888";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.font = "14px sans-serif";
        this.ctx.fillText("Drag & Drop or Click to Add a Video", activeStart + activeWidth / 2, RULER_HEIGHT + this.blockHeight / 2);
      }

      // Only draw the retake region overlay, borders, handles, and label if a video is loaded
      if (this.timeline.retakeVideo) {
        // Draw the white outline retake region overlay box bounded by retakeStart and retakeLength.
        // Tint outside the box (locked/preserved regions) with a dark blue-grey tint overlay (rgba(3, 5, 12, 0.75)).
        const retakeStart = this.timeline.retakeStart ?? 0;
        const retakeLength = this.timeline.retakeLength ?? totalFrames;

        const baseVideoDur = this.timeline.retakeVideo.videoDurationFrames || 0;
        const videoWidthPx = totalFrames > 0 ? (baseVideoDur / totalFrames) * width : width;

        const rX1 = (retakeStart / totalFrames) * width;
        const rX2 = ((retakeStart + retakeLength) / totalFrames) * width;

        // Tint preserved left region
        if (rX1 > 0) {
          this.ctx.fillStyle = "rgba(0, 0, 0, 0.70)";
          this.ctx.fillRect(0, RULER_HEIGHT + 1, rX1, this.blockHeight - 2);
        }

        // Tint preserved right region (only up to videoWidthPx, not the padding zone)
        if (rX2 < videoWidthPx) {
          this.ctx.fillStyle = "rgba(0, 0, 0, 0.70)";
          this.ctx.fillRect(rX2, RULER_HEIGHT + 1, videoWidthPx - rX2, this.blockHeight - 2);
        }

        // Draw the Retake Overlay Box
        const boxW = rX2 - rX1;

        // White border
        this.ctx.strokeStyle = "#ffffff";
        this.ctx.lineWidth = 2.5;
        this.ctx.strokeRect(rX1, RULER_HEIGHT + 1, boxW, this.blockHeight - 2);

        // Draw handles on the left and right edges
        this.ctx.fillStyle = "#ffffff";
        this.ctx.beginPath();
        this.ctx.roundRect(rX1 - 3, RULER_HEIGHT + this.blockHeight / 2 - 20, 6, 40, 3);
        this.ctx.fill();

        this.ctx.beginPath();
        this.ctx.roundRect(rX2 - 3, RULER_HEIGHT + this.blockHeight / 2 - 20, 6, 40, 3);
        this.ctx.fill();

        // Draw "RETAKE REGION" centered label inside the retake box
        {
          const labelPadX = 14;
          const labelPadY = 7;
          const labelFontSize = 15;
          const labelText = "RETAKE REGION";
          const labelY = RULER_HEIGHT + this.blockHeight - labelFontSize - labelPadY * 2 - 4;
          const labelCenterX = rX1 + boxW / 2;

          this.ctx.save();
          // Clip to retake region so text/bg never bleeds outside
          this.ctx.beginPath();
          this.ctx.rect(rX1, RULER_HEIGHT, boxW, this.blockHeight);
          this.ctx.clip();

          this.ctx.font = `bold ${labelFontSize}px sans-serif`;
          this.ctx.textAlign = "center";
          this.ctx.textBaseline = "middle";

          // Truncate if too narrow
          let displayText = labelText;
          const maxTextW = Math.max(0, boxW - labelPadX * 2 - 8);
          if (this.ctx.measureText(displayText).width > maxTextW) {
            while (displayText.length > 0 && this.ctx.measureText(displayText + "…").width > maxTextW) {
              displayText = displayText.slice(0, -1);
            }
            displayText = displayText.length > 0 ? displayText + "…" : "";
          }

          if (displayText.length > 0) {
            const textW = this.ctx.measureText(displayText).width;
            const bgW = textW + labelPadX * 2;
            const bgH = labelFontSize + labelPadY * 2;
            const bgX = labelCenterX - bgW / 2;
            const bgY = labelY - bgH / 2;

            // Background pill
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.62)";
            this.ctx.beginPath();
            this.ctx.roundRect(bgX, bgY, bgW, bgH, 3);
            this.ctx.fill();

            // Label text
            this.ctx.fillStyle = "#ffffff";
            this.ctx.fillText(displayText, labelCenterX, labelY);
          }
          this.ctx.restore();
        }

        // Show video info badge / filename (styled exactly like a regular video segment, drawn on top of overlays)
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.rect(0, RULER_HEIGHT, videoWidthPx, this.blockHeight);
        this.ctx.clip();

        // 1. Draw the "VIDEO" label badge
        this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
        this.ctx.fillRect(0, RULER_HEIGHT + 1, 42, 16);
        this.ctx.fillStyle = "#fff";
        this.ctx.font = "bold 10px sans-serif";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText("VIDEO", 21, RULER_HEIGHT + 9);

        // 2. Draw the filename badge
        if (this.node.properties.showFilenames && videoWidthPx > 46) {
          let rawPath = retakeVid.imageFile || retakeVid.fileName || "";
          let fname = rawPath.split(/[/\\]/).pop() || "";
          this.ctx.font = "9px sans-serif";
          this.ctx.textAlign = "left";
          this.ctx.textBaseline = "middle";
          const maxFileTextW = videoWidthPx - 42 - 10;
          if (this.ctx.measureText(fname).width > maxFileTextW) {
            while (fname.length > 0 && this.ctx.measureText(fname + "…").width > maxFileTextW) {
              fname = fname.slice(0, -1);
            }
            fname += "…";
          }
          const textW = this.ctx.measureText(fname).width;
          this.ctx.fillStyle = "rgba(0, 0, 0, 0.50)";
          this.ctx.fillRect(43, RULER_HEIGHT + 1, textW + 8, 16);
          this.ctx.fillStyle = "#fff";
          this.ctx.fillText(fname, 47, RULER_HEIGHT + 9);
        }
        this.ctx.restore();

      }
    } else {
      // --- Draw Image/Text Segments ---
      for (let i = 0; i < sortedSegments.length; i++) {
        const seg = sortedSegments[i];
        const rawStartX = (seg.start / totalFrames) * width;
        const rawEndX = ((seg.start + seg.length) / totalFrames) * width;
        const startX = Math.floor(rawStartX);
        const pxWidth = Math.max(1, Math.floor(rawEndX) - startX);
        const isSelected = this.selectedSegmentIds.includes(seg.id);

        const originalSeg = this.timeline.segments.find(s => s.id === seg.id);
        const imgObj = originalSeg ? originalSeg.imgObj : seg.imgObj;
        const videoEl = originalSeg ? originalSeg.videoEl : seg.videoEl;

        const isPlayheadOverSeg = (this.currentFrame >= seg.start && this.currentFrame < seg.start + seg.length);
        const isScrubbingThis = this._isDragging && (this._dragTargetId === seg.id || this._dragTargetIdRight === seg.id);
        const isLiveActive = this.isPlaying && isPlayheadOverSeg;

        if ((this._isDragging && this.selectionType === "image" && seg.id === this._dragTargetId) || (this._ghostSegmentId && seg.id === this._ghostSegmentId)) {
          this.ctx.globalAlpha = 0.65;
        } else {
          this.ctx.globalAlpha = 1.0;
        }

        if (seg.type === "ghost") {
          this.ctx.fillStyle = "#2a2a2a";
          this.ctx.fillRect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);

          this.ctx.strokeStyle = "#777";
          this.ctx.lineWidth = 2;
          this.ctx.setLineDash([5, 5]);
          this.ctx.strokeRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
          this.ctx.setLineDash([]);

          this.ctx.fillStyle = "#aaa";
          this.ctx.textAlign = "center";
          this.ctx.textBaseline = "middle";
          this.ctx.font = "bold 12px sans-serif";
          this.ctx.fillText("Drop to Place", startX + pxWidth / 2, RULER_HEIGHT + this.blockHeight / 2);
        } else {
          this.ctx.fillStyle = seg.type === "text" ? "#000b12" : "#000";
          this.ctx.fillRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
        }

        let drawSource = null;
        if (isLiveActive && videoEl && videoEl.readyState >= 2) {
          drawSource = videoEl;
        } else {
          if (seg.type === "video" && seg.thumbnails && seg.thumbnails.length > 0) {
            const targetTime = seg._scrubTargetSec !== undefined
              ? seg._scrubTargetSec
              : (isPlayheadOverSeg ? (this.currentFrame - seg.start + seg.trimStart) / this.getFrameRate() : seg.trimStart / this.getFrameRate());
            let nearestImg = seg.thumbnails[0].img;
            let minDiff = Infinity;
            for (const t of seg.thumbnails) {
              const diff = Math.abs(t.time - targetTime);
              if (diff < minDiff) {
                minDiff = diff;
                nearestImg = t.img;
              }
            }
            drawSource = nearestImg;
          } else {
            drawSource = imgObj && imgObj.complete ? imgObj : null;
          }
        }

        if (drawSource && seg.type !== "ghost") {
          const isVid = !!drawSource.videoWidth;
          const natW = isVid ? drawSource.videoWidth : drawSource.naturalWidth;
          const natH = isVid ? drawSource.videoHeight : drawSource.naturalHeight;

          if (natW > 0) {
            const imgRatio = natW / natH;
            const boxRatio = pxWidth / this.blockHeight;
            let drawW, drawH, drawX, drawY;
            if (imgRatio > boxRatio) {
              drawW = pxWidth; drawH = pxWidth / imgRatio;
              drawX = startX; drawY = RULER_HEIGHT + (this.blockHeight - drawH) / 2;
            } else {
              drawH = this.blockHeight; drawW = this.blockHeight * imgRatio;
              drawY = RULER_HEIGHT; drawX = startX + (pxWidth - drawW) / 2;
            }

            // Clip to segment bounds so tiled images don't bleed into adjacent segments
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
            this.ctx.clip();

            if (imgRatio > boxRatio) {
              // Fits width, vertical letterboxing (black bars top/bottom) — keep as is
              this.ctx.drawImage(drawSource, drawX, drawY, drawW, drawH);
            } else {
              // Fits height, horizontal letterboxing (black bars left/right)
              this.ctx.drawImage(drawSource, drawX, drawY, drawW, drawH);

              // Tile left
              let leftX = drawX - drawW;
              while (leftX + drawW > startX) {
                this.ctx.drawImage(drawSource, leftX, drawY, drawW, drawH);
                leftX -= drawW;
              }
              // Tile right
              let rightX = drawX + drawW;
              while (rightX < startX + pxWidth) {
                this.ctx.drawImage(drawSource, rightX, drawY, drawW, drawH);
                rightX += drawW;
              }
            }
            this.ctx.restore();
          }
        }

        if ((seg.type === "video" || drawSource) && seg.type !== "ghost") {
          if (seg.type === "video" && pxWidth > 0) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);
            this.ctx.clip();
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
            this.ctx.fillRect(startX, RULER_HEIGHT + 1, 42, 16);
            this.ctx.fillStyle = "#fff";
            this.ctx.font = "bold 10px sans-serif";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";
            this.ctx.fillText("VIDEO", startX + 21, RULER_HEIGHT + 9);
            this.ctx.restore();

            // Uploading / Loading indicator badge (bottom-left corner)
            if ((seg._uploading || seg._extractingThumbs) && pxWidth > 60) {
              this.ctx.save();
              this.ctx.beginPath();
              this.ctx.rect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);
              this.ctx.clip();
              this.ctx.font = "bold 9px sans-serif";
              const upText = seg._extractingThumbs ? "Loading..." : "Uploading...";
              const upW = this.ctx.measureText(upText).width + 10;
              this.ctx.fillStyle = "rgba(0, 14, 37, 0.7)";
              this.ctx.fillRect(startX + 1, RULER_HEIGHT + this.blockHeight - 17, upW, 16);
              this.ctx.fillStyle = "#fff";
              this.ctx.textAlign = "center";
              this.ctx.textBaseline = "middle";
              this.ctx.fillText(upText, startX + 1 + upW / 2, RULER_HEIGHT + this.blockHeight - 9);
              this.ctx.restore();
            }

            // Filename next to VIDEO tag
            if (this.node.properties.showFilenames && pxWidth > 46) {
              this.ctx.save();
              this.ctx.beginPath();
              this.ctx.rect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);
              this.ctx.clip();
              let rawPath = seg.imageFile || "";
              let fname = rawPath.split(/[/\\]/).pop() || "";
              this.ctx.font = "9px sans-serif";
              this.ctx.textAlign = "left";
              this.ctx.textBaseline = "middle";
              const maxFileTextW = pxWidth - 42 - 10;
              if (this.ctx.measureText(fname).width > maxFileTextW) {
                while (fname.length > 0 && this.ctx.measureText(fname + "…").width > maxFileTextW) {
                  fname = fname.slice(0, -1);
                }
                fname += "…";
              }
              const textW = this.ctx.measureText(fname).width;
              this.ctx.fillStyle = "rgba(0, 0, 0, 0.50)";
              this.ctx.fillRect(startX + 43, RULER_HEIGHT + 1, textW + 8, 16);
              this.ctx.fillStyle = "#fff";
              this.ctx.fillText(fname, startX + 47, RULER_HEIGHT + 9);
              this.ctx.restore();
            }
          } else if (seg.type === "image" && pxWidth > 0) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);
            this.ctx.clip();
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
            this.ctx.fillRect(startX, RULER_HEIGHT + 1, 42, 16);
            this.ctx.fillStyle = "#fff";
            this.ctx.font = "bold 10px sans-serif";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";
            this.ctx.fillText("IMAGE", startX + 21, RULER_HEIGHT + 9);
            this.ctx.restore();

            // Filename next to IMAGE tag
            if (this.node.properties.showFilenames && pxWidth > 46) {
              this.ctx.save();
              this.ctx.beginPath();
              this.ctx.rect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);
              this.ctx.clip();
              let rawPath = seg.imageFile || "";
              let fname = rawPath.split(/[/\\]/).pop() || "";
              this.ctx.font = "9px sans-serif";
              this.ctx.textAlign = "left";
              this.ctx.textBaseline = "middle";
              const maxFileTextW = pxWidth - 42 - 10;
              if (this.ctx.measureText(fname).width > maxFileTextW) {
                while (fname.length > 0 && this.ctx.measureText(fname + "…").width > maxFileTextW) {
                  fname = fname.slice(0, -1);
                }
                fname += "…";
              }
              const textW = this.ctx.measureText(fname).width;
              this.ctx.fillStyle = "rgba(0, 0, 0, 0.50)";
              this.ctx.fillRect(startX + 43, RULER_HEIGHT + 1, textW + 8, 16);
              this.ctx.fillStyle = "#fff";
              this.ctx.fillText(fname, startX + 47, RULER_HEIGHT + 9);
              this.ctx.restore();
            }
          }

          if (seg.type === "image" && seg.isEndFrame && pxWidth > 0) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);
            this.ctx.clip();

            this.ctx.font = "bold 9px sans-serif";
            const badgeText = "END FRAME";
            const badgeTextW = this.ctx.measureText(badgeText).width;
            const badgeW = badgeTextW + 10;
            const badgeH = 16;
            const badgeX = startX + pxWidth - badgeW;
            const badgeY = RULER_HEIGHT + 1;

            this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
            this.ctx.fillRect(badgeX, badgeY, badgeW, badgeH);

            this.ctx.fillStyle = "#fff";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";
            this.ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + badgeH / 2);
            this.ctx.restore();
          }

          // the row under IMAGE / the filename
          this.drawAnchorBadge(seg, startX, pxWidth, RULER_HEIGHT, this.blockHeight,
                               RULER_HEIGHT + 19);

          // --- Prompt subtitle overlay ---
          if (seg.prompt && seg.type !== "ghost" && pxWidth > 24) {
            const overlayH = Math.round(this.blockHeight * 0.20);
            const overlayY = RULER_HEIGHT + this.blockHeight - overlayH;

            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX, overlayY, pxWidth, overlayH);
            this.ctx.clip();

            // Translucent background
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
            this.ctx.fillRect(startX, overlayY, pxWidth, overlayH);

            // Text
            const fontSize = Math.min(11, overlayH * 0.58);
            this.ctx.font = `${fontSize}px sans-serif`;
            this.ctx.fillStyle = "#e0e3ed";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";

            // Measure and truncate to single line
            const maxTextW = pxWidth - 10;
            let label = seg.prompt;
            if (this.ctx.measureText(label).width > maxTextW) {
              while (label.length > 0 && this.ctx.measureText(label + "…").width > maxTextW) {
                label = label.slice(0, -1);
              }
              label += "…";
            }

            this.ctx.fillText(label, startX + pxWidth / 2, overlayY + overlayH / 2);
            this.ctx.restore();
          }
        } else if (seg.type === "text") {
          const pad = 8;
          const boxW = pxWidth - pad * 2;
          if (boxW > 12) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX + pad, RULER_HEIGHT + pad, boxW, this.blockHeight - pad * 2);
            this.ctx.clip();
            this.ctx.fillStyle = "#e0e3ed";
            this.ctx.font = "11px sans-serif";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "top";
            const label = seg.prompt || "(no prompt)";
            const words = label.split(" ");
            const lineH = 15;
            let line = "";
            let lines = [];
            for (const word of words) {
              const test = line ? line + " " + word : word;
              if (this.ctx.measureText(test).width > boxW && line) {
                lines.push(line);
                line = word;
              } else {
                line = test;
              }
            }
            if (line) lines.push(line);

            const maxLines = Math.max(1, Math.floor((this.blockHeight - pad * 2) / lineH));
            if (lines.length > maxLines) {
              lines = lines.slice(0, maxLines);
              lines[lines.length - 1] += "…";
            }

            const totalTextHeight = lines.length * lineH;
            let ty = RULER_HEIGHT + (this.blockHeight - totalTextHeight) / 2 + 2;

            for (const l of lines) {
              this.ctx.fillText(l, startX + pxWidth / 2, ty);
              ty += lineH;
            }
            this.ctx.restore();
          }
        }

        if (isSelected) {
          const outlineColor = "#fff";
          this.ctx.strokeStyle = outlineColor;
          this.ctx.lineWidth = 2;
          this.ctx.strokeRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
          if (!this.isMultiSelectActive()) {
            this.ctx.fillStyle = outlineColor;
            this.ctx.beginPath();
            this.ctx.roundRect(startX, RULER_HEIGHT + this.blockHeight / 2 - 12, 4, 24, 2);
            this.ctx.fill();
            this.ctx.beginPath();
            this.ctx.roundRect(startX + pxWidth - 4, RULER_HEIGHT + this.blockHeight / 2 - 12, 4, 24, 2);
            this.ctx.fill();
          }
        } else {
          // Idle segments share the same black border.
          this.ctx.strokeStyle = "#000";
          this.ctx.lineWidth = 1.5;
          this.ctx.strokeRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
        }

        this.ctx.globalAlpha = 1.0;
      }

      // --- Prompt zones: boundary lines (always) + zone ribbon (toggle) ---
      // A "zone" is the span one prompt governs.
      if (totalFrames > 0 && this.blockHeight > 20) {
        const zoneSegs = sortedSegments
          .filter(s => s.type !== "ghost")
          .slice()
          .sort((a, b) => a.start - b.start);
        const realZoneSegs = zoneSegs;

        if (realZoneSegs.length > 0) {
          const zones = realZoneSegs.map((s, i) => ({
            startFrame: i === 0 ? 0 : s.start,
            endFrame: (i < realZoneSegs.length - 1) ? realZoneSegs[i + 1].start : totalFrames,
            prompt: (s.prompt || "").trim(),
          }));

          const zf2x = (fr) => Math.floor((fr / totalFrames) * width);
          const ZONE_FILLS = ["#1b64a8", "#0f6e56", "#9e3b1c", "#5b3a8c", "#8a6d1f", "#2f7d7a", "#7a2f5c", "#3f6d1f"];
          const hexToRgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; };
          const zoneColor = (i) => { const solid = ZONE_FILLS[i % ZONE_FILLS.length]; return { solid, line: hexToRgba(solid, 0.6) }; };

          const showZoneBar = !!this.node.properties.showPromptZones;
          const ZONE_BAR_H = 18;
          const zoneBarY = RULER_HEIGHT;

          // Zone ribbon (toggle): solid full-colour pills with white labels.
          if (showZoneBar) {
            const GAP = 2, RAD = 5;
            const drawPill = (x, y, w, h, r) => {
              r = Math.min(r, h / 2, w / 2);
              this.ctx.beginPath();
              this.ctx.moveTo(x + r, y);
              this.ctx.arcTo(x + w, y, x + w, y + h, r);
              this.ctx.arcTo(x + w, y + h, x, y + h, r);
              this.ctx.arcTo(x, y + h, x, y, r);
              this.ctx.arcTo(x, y, x + w, y, r);
              this.ctx.closePath();
            };
            this.ctx.fillStyle = "rgba(14, 16, 22, 1)";
            this.ctx.fillRect(0, zoneBarY, width, ZONE_BAR_H);
            for (let i = 0; i < zones.length; i++) {
              const z = zones[i];
              const zx0 = zf2x(z.startFrame);
              const zx1 = zf2x(z.endFrame);
              const px = zx0 + GAP;
              const pillW = Math.max(0, (zx1 - GAP) - px);
              if (pillW < 2) continue;
              const col = zoneColor(i);
              this.ctx.fillStyle = col.solid;
              drawPill(px, zoneBarY, pillW, ZONE_BAR_H, RAD);
              this.ctx.fill();
              if (pillW > 26) {
                this.ctx.save();
                this.ctx.beginPath();
                this.ctx.rect(px + 8, zoneBarY, pillW - 12, ZONE_BAR_H);
                this.ctx.clip();
                this.ctx.font = "bold 11px sans-serif";
                this.ctx.textAlign = "left";
                this.ctx.textBaseline = "middle";
                const hasPrompt = z.prompt.length > 0;
                this.ctx.fillStyle = hasPrompt ? "#ffffff" : "rgba(255, 255, 255, 0.6)";
                let label = hasPrompt ? z.prompt : "(no prompt)";
                const maxW = pillW - 16;
                if (this.ctx.measureText(label).width > maxW) {
                  while (label.length > 0 && this.ctx.measureText(label + "\u2026").width > maxW) {
                    label = label.slice(0, -1);
                  }
                  label += "\u2026";
                }
                this.ctx.fillText(label, px + 8, zoneBarY + ZONE_BAR_H / 2 + 0.5);
                this.ctx.restore();
              }
            }
          }

          // Boundary lines (always on): a full-height divider at each handoff,
          // drawn last so they stay crisp over both the ribbon and the segments.
          for (let i = 1; i < zones.length; i++) {
            const bx = zf2x(zones[i].startFrame) + 0.5;
            this.ctx.save();
            this.ctx.strokeStyle = zoneColor(i).line;
            this.ctx.lineWidth = 1.5;
            this.ctx.setLineDash([4, 3]);
            this.ctx.beginPath();
            this.ctx.moveTo(bx, RULER_HEIGHT + 1);
            this.ctx.lineTo(bx, RULER_HEIGHT + this.blockHeight - 1);
            this.ctx.stroke();
            this.ctx.setLineDash([]);
            this.ctx.restore();
          }
        }
      }

      // --- Draw Motion Segments ---
      for (let i = 0; i < sortedMotionSegments.length; i++) {
        const seg = sortedMotionSegments[i];
        const startX = Math.floor((seg.start / totalFrames) * width);
        const rawEndX = ((seg.start + seg.length) / totalFrames) * width;
        const pxWidth = Math.max(1, Math.floor(rawEndX) - startX);
        const isSelected = this.selectedSegmentIds.includes(seg.id);
        const trackY = RULER_HEIGHT + this.blockHeight + this.audioTrackHeight;

        if ((this._isDragging && this.selectionType === "motion" && seg.id === this._dragTargetId) || (this._ghostSegmentId && seg.id === this._ghostSegmentId)) {
          this.ctx.globalAlpha = 0.65;
        } else {
          this.ctx.globalAlpha = 1.0;
        }

        if (seg.type === "ghost") {
          this.ctx.fillStyle = "#1a1a1a";
          this.ctx.fillRect(startX, trackY, pxWidth, this.motionTrackHeight);
          this.ctx.strokeStyle = "#555";
          this.ctx.lineWidth = 2;
          this.ctx.setLineDash([5, 5]);
          this.ctx.strokeRect(startX, trackY, pxWidth, this.motionTrackHeight);
          this.ctx.setLineDash([]);
          this.ctx.fillStyle = "#888";
          this.ctx.textAlign = "center";
          this.ctx.textBaseline = "middle";
          this.ctx.font = "bold 12px sans-serif";
          this.ctx.fillText("Drop Motion", startX + pxWidth / 2, trackY + this.motionTrackHeight / 2);
        } else {
          this.ctx.fillStyle = "#000";
          this.ctx.fillRect(startX, trackY + 1, pxWidth, this.motionTrackHeight - 2);

          const originalSeg = this.timeline.motionSegments.find(s => s.id === seg.id);
          const imgObj = originalSeg ? originalSeg.imgObj : seg.imgObj;
          const videoEl = originalSeg ? originalSeg.videoEl : seg.videoEl;

          const isPlayheadOverSeg = (this.currentFrame >= seg.start && this.currentFrame < seg.start + seg.length);
          const isScrubbingThis = this._isDragging && (this._dragTargetId === seg.id || this._dragTargetIdRight === seg.id);
          const isLiveActive = this.isPlaying && isPlayheadOverSeg;

          let drawSource = null;
          if (isLiveActive && videoEl && videoEl.readyState >= 2) {
            drawSource = videoEl;
          } else {
            if (seg.type === "motion_video" && seg.thumbnails && seg.thumbnails.length > 0) {
              const targetTime = seg._scrubTargetSec !== undefined
                ? seg._scrubTargetSec
                : (isPlayheadOverSeg ? (this.currentFrame - seg.start + seg.trimStart) / this.getFrameRate() : seg.trimStart / this.getFrameRate());
              let nearestImg = seg.thumbnails[0].img;
              let minDiff = Infinity;
              for (const t of seg.thumbnails) {
                const diff = Math.abs(t.time - targetTime);
                if (diff < minDiff) {
                  minDiff = diff;
                  nearestImg = t.img;
                }
              }
              drawSource = nearestImg;
            } else {
              drawSource = imgObj && imgObj.complete ? imgObj : null;
            }
          }

          if (drawSource && seg.type !== "ghost") {
            const natW = drawSource.videoWidth || drawSource.naturalWidth;
            const natH = drawSource.videoHeight || drawSource.naturalHeight;

            if (natW > 0) {
              const imgRatio = natW / natH;
              const boxRatio = pxWidth / this.motionTrackHeight;
              let drawW, drawH, drawX, drawY;
              if (imgRatio > boxRatio) {
                drawW = pxWidth; drawH = pxWidth / imgRatio;
                drawX = startX; drawY = trackY + (this.motionTrackHeight - drawH) / 2;
              } else {
                drawH = this.motionTrackHeight; drawW = this.motionTrackHeight * imgRatio;
                drawY = trackY; drawX = startX + (pxWidth - drawW) / 2;
              }

              this.ctx.save();
              this.ctx.beginPath();
              this.ctx.rect(startX, trackY + 1, pxWidth, this.motionTrackHeight - 2);
              this.ctx.clip();

              if (imgRatio > boxRatio) {
                this.ctx.drawImage(drawSource, drawX, drawY, drawW, drawH);
              } else {
                this.ctx.drawImage(drawSource, drawX, drawY, drawW, drawH);
                let leftX = drawX - drawW;
                while (leftX + drawW > startX) {
                  this.ctx.drawImage(drawSource, leftX, drawY, drawW, drawH);
                  leftX -= drawW;
                }
                let rightX = drawX + drawW;
                while (rightX < startX + pxWidth) {
                  this.ctx.drawImage(drawSource, rightX, drawY, drawW, drawH);
                  rightX += drawW;
                }
              }
              this.ctx.restore();
            }
          }

          if (pxWidth > 0 && seg.type !== "ghost") {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX, trackY, pxWidth, this.motionTrackHeight);
            this.ctx.clip();
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
            this.ctx.fillRect(startX, trackY + 1, 75, 16);
            this.ctx.fillStyle = "#fff";
            this.ctx.font = "bold 10px sans-serif";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";
            this.ctx.fillText("Reference Video", startX + 37, trackY + 9);
            this.ctx.restore();

            // Uploading / Loading indicator badge (bottom-left corner)
            if ((seg._uploading || seg._extractingThumbs) && pxWidth > 60) {
              this.ctx.save();
              this.ctx.beginPath();
              this.ctx.rect(startX, trackY, pxWidth, this.motionTrackHeight);
              this.ctx.clip();
              this.ctx.font = "bold 9px sans-serif";
              const upText = seg._extractingThumbs ? "Loading..." : "Uploading...";
              const upW = this.ctx.measureText(upText).width + 10;
              this.ctx.fillStyle = "rgba(0, 14, 37, 0.7)";
              this.ctx.fillRect(startX + 1, trackY + this.motionTrackHeight - 17, upW, 16);
              this.ctx.fillStyle = "#fff";
              this.ctx.textAlign = "center";
              this.ctx.textBaseline = "middle";
              this.ctx.fillText(upText, startX + 1 + upW / 2, trackY + this.motionTrackHeight - 9);
              this.ctx.restore();
            }

            // Filename next to IC-LoRA Video tag
            if (this.node.properties.showFilenames && pxWidth > 80) {
              this.ctx.save();
              this.ctx.beginPath();
              this.ctx.rect(startX, trackY, pxWidth, this.motionTrackHeight);
              this.ctx.clip();
              let rawPath = seg.videoFile || "";
              let fname = rawPath.split(/[/\\]/).pop() || "";
              this.ctx.font = "9px sans-serif";
              this.ctx.textAlign = "left";
              this.ctx.textBaseline = "middle";
              const maxFileTextW = pxWidth - 75 - 10;
              if (this.ctx.measureText(fname).width > maxFileTextW) {
                while (fname.length > 0 && this.ctx.measureText(fname + "…").width > maxFileTextW) {
                  fname = fname.slice(0, -1);
                }
                fname += "…";
              }
              const textW = this.ctx.measureText(fname).width;
              this.ctx.fillStyle = "rgba(0, 0, 0, 0.50)";
              this.ctx.fillRect(startX + 76, trackY + 1, textW + 8, 16);
              this.ctx.fillStyle = "#fff";
              this.ctx.fillText(fname, startX + 80, trackY + 9);
              this.ctx.restore();
            }
          }

          // --- Global Prompt subtitle overlay ---
          const globalPromptStr = this.getGlobalPrompt();
          if (globalPromptStr && seg.type !== "ghost" && pxWidth > 24) {
            const overlayH = Math.round(this.motionTrackHeight * 0.25);
            const overlayY = trackY + this.motionTrackHeight - overlayH;

            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX, overlayY, pxWidth, overlayH);
            this.ctx.clip();

            // Translucent background
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
            this.ctx.fillRect(startX, overlayY, pxWidth, overlayH);

            // Text
            const fontSize = Math.min(11, overlayH * 0.58);
            this.ctx.font = `${fontSize}px sans-serif`;
            this.ctx.fillStyle = "#e0e3ed";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";

            // Measure and truncate to single line
            const maxTextW = pxWidth - 10;
            let label = globalPromptStr;
            if (this.ctx.measureText(label).width > maxTextW) {
              while (label.length > 0 && this.ctx.measureText(label + "…").width > maxTextW) {
                label = label.slice(0, -1);
              }
              label += "…";
            }

            this.ctx.fillText(label, startX + pxWidth / 2, overlayY + overlayH / 2);
            this.ctx.restore();
          }

          if (isSelected) {
            this.ctx.strokeStyle = "#fff";
            this.ctx.lineWidth = 2;
            this.ctx.strokeRect(startX, trackY + 1, pxWidth, this.motionTrackHeight - 2);
            if (!this.isMultiSelectActive()) {
              this.ctx.fillStyle = "#fff";
              this.ctx.beginPath();
              this.ctx.roundRect(startX, trackY + this.motionTrackHeight / 2 - 12, 4, 24, 2);
              this.ctx.fill();
              this.ctx.beginPath();
              this.ctx.roundRect(startX + pxWidth - 4, trackY + this.motionTrackHeight / 2 - 12, 4, 24, 2);
              this.ctx.fill();
            }
          } else {
            this.ctx.strokeStyle = "#000";
            this.ctx.lineWidth = 1.5;
            this.ctx.strokeRect(startX, trackY + 1, pxWidth, this.motionTrackHeight - 2);
          }
          this.drawAnchorBadge(seg, startX, pxWidth, trackY, this.motionTrackHeight,
                               trackY + 2);
        }
        this.ctx.globalAlpha = 1.0;
      }

      // --- Draw Audio Segments ---
      for (let i = 0; i < sortedAudioSegments.length; i++) {
        const seg = sortedAudioSegments[i];
        const rawStartX = (seg.start / totalFrames) * width;
        const rawEndX = ((seg.start + seg.length) / totalFrames) * width;
        const startX = Math.floor(rawStartX);
        const pxWidth = Math.max(1, Math.floor(rawEndX) - startX);
        const isSelected = this.selectedSegmentIds.includes(seg.id);
        const trackY = RULER_HEIGHT + this.blockHeight;

        if ((this._isDragging && this.selectionType === "audio" && seg.id === this._dragTargetId) || (this._ghostSegmentId && seg.id === this._ghostSegmentId)) {
          this.ctx.globalAlpha = 0.65;
        } else {
          this.ctx.globalAlpha = 1.0;
        }

        if (seg.type === "ghost") {
          this.ctx.fillStyle = "#1a1a1a";
          this.ctx.fillRect(startX, trackY, pxWidth, this.audioTrackHeight);
          this.ctx.strokeStyle = "#555";
          this.ctx.lineWidth = 2;
          this.ctx.setLineDash([5, 5]);
          this.ctx.strokeRect(startX, trackY, pxWidth, this.audioTrackHeight);
          this.ctx.setLineDash([]);
          this.ctx.fillStyle = "#888";
          this.ctx.textAlign = "center";
          this.ctx.textBaseline = "middle";
          this.ctx.font = "bold 12px sans-serif";
          this.ctx.fillText("Drop Audio", startX + pxWidth / 2, trackY + this.audioTrackHeight / 2);
        } else {
          const showHandles = !this.isMultiSelectActive();
          const outlineColor = isSelected ? "#fff" : null;
          this.drawAudioSegmentVisuals(this.ctx, seg, isSelected, trackY, this.audioTrackHeight, startX, pxWidth, outlineColor, showHandles);
          this.drawAnchorBadge(seg, startX, pxWidth, trackY, this.audioTrackHeight,
                               trackY + 2);
        }
        this.ctx.globalAlpha = 1.0;
      }


      // --- Dim Disabled Tracks ---
      this.ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
      if (!this.mainTrackEnabled) {
        this.ctx.fillRect(0, RULER_HEIGHT, width, this.blockHeight);
      }
      if (!this.audioTrackEnabled) {
        this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight, width, this.audioTrackHeight);
      }
      if (!this.motionTrackEnabled) {
        this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight + this.audioTrackHeight, width, this.motionTrackHeight);
      }
    }

    // --- Draw Ruler & Divider AFTER segments to prevent overlap ---
    // Ruler Background
    this.ctx.fillStyle = "#1e1e1e";
    this.ctx.fillRect(0, 0, width, RULER_HEIGHT);

    // Crisp Ruler Text
    this.ctx.fillStyle = "#aaa";
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.font = "10px sans-serif";

    const frameRate = this.getFrameRate();
    const mode = this.displayModeWidget ? this.displayModeWidget.value : "seconds";

    // Define logical steps for both modes
    let steps;
    if (mode === "seconds") {
      steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    } else {
      steps = [1, 2, 5, 10, 24, 48, 120, 240, 480, 960, 1920];
    }

    const minSpacingPx = 60;
    let majorStep = steps[steps.length - 1];
    for (let i = 0; i < steps.length; i++) {
      const stepFrames = mode === "seconds" ? steps[i] * frameRate : steps[i];
      const spacingPx = (stepFrames / totalFrames) * width;
      if (spacingPx >= minSpacingPx) {
        majorStep = steps[i];
        break;
      }
    }

    const majorStepFrames = mode === "seconds" ? majorStep * frameRate : majorStep;

    let minorStep;
    if (mode === "seconds") {
      if (majorStep <= 0.2) minorStep = majorStep / 2;
      else if (majorStep <= 1) minorStep = majorStep / 5;
      else if (majorStep <= 5) minorStep = 1;
      else if (majorStep <= 15) minorStep = 5;
      else if (majorStep <= 30) minorStep = 10;
      else if (majorStep <= 60) minorStep = 10;
      else minorStep = majorStep / 5;
    } else {
      if (majorStep <= 5) minorStep = 1;
      else if (majorStep <= 10) minorStep = 2;
      else if (majorStep <= 24) minorStep = 6;
      else if (majorStep <= 48) minorStep = 12;
      else minorStep = majorStep / 5;
    }
    const minorStepFrames = mode === "seconds" ? minorStep * frameRate : minorStep;

    this.ctx.fillStyle = "#444";
    const totalMinorTicks = Math.floor(totalFrames / minorStepFrames);
    for (let i = 0; i <= totalMinorTicks; i++) {
      const frameVal = i * minorStepFrames;
      if (Math.abs(frameVal % majorStepFrames) < 0.1) continue;

      const x = (frameVal / totalFrames) * width;
      this.ctx.fillRect(Math.floor(x), RULER_HEIGHT - 3, 1, 3);
    }

    this.ctx.fillStyle = "#aaa";
    const totalMajorTicks = Math.floor(totalFrames / majorStepFrames);
    for (let i = 0; i <= totalMajorTicks; i++) {
      const frameVal = i * majorStepFrames;
      const x = (frameVal / totalFrames) * width;

      this.ctx.fillStyle = "#aaa";
      this.ctx.fillRect(Math.floor(x), RULER_HEIGHT - 6, 1, 6);

      if (frameVal > 0 && frameVal < totalFrames) {
        this.ctx.textAlign = "center";
        this.ctx.fillText(this.formatTime(frameVal, true), x, RULER_HEIGHT / 2);
      }
    }

    this.ctx.textAlign = "left";
    const zeroLabel = mode === "seconds" ? "0" : this.formatTime(0, true);
    this.ctx.fillText(zeroLabel, 4, RULER_HEIGHT / 2);

    // Divider
    this.ctx.fillStyle = "#111";
    this.ctx.fillRect(0, RULER_HEIGHT - 1, width, 1);
    this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight - 1, width, 2);
    this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight + this.audioTrackHeight - 1, width, 1);

    // Draw gap "+" buttons
    if (!this._isDragging && !this.retakeMode) {
      const BTN_R = 12;
      const gapRegions = this.getGapRegions();
      for (let i = 0; i < gapRegions.length; i++) {
        const gap = gapRegions[i];
        if (gap.widthPx < BTN_R * 2 + 8) continue;
        const hov = this._hoveredGapIdx === i;
        const BTN_W = 18;
        const BTN_H = 18;
        this.ctx.beginPath();
        this.ctx.roundRect(gap.centerX - BTN_W / 2, gap.centerY - BTN_H / 2, BTN_W, BTN_H, 4);
        this.ctx.fillStyle = hov ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.05)";
        this.ctx.fill();
        this.ctx.fillStyle = hov ? "#fff" : "#888";
        this.ctx.font = "14px sans-serif";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText("+", gap.centerX, gap.centerY + 1);
      }
    }

    // --- Out-of-duration shadow overlay ---
    // Skip in retake mode — the retake region has its own overlay and the
    // start/end frame widgets are locked, so this overlay would be misleading.
    if (!this.retakeMode) {
      const startFrames = this.getStartFrames();
      const durationFrames = this.getDurationFrames();
      const outputFrames = startFrames + durationFrames;

      if (startFrames > 0) {
        const startX = (startFrames / totalFrames) * width;
        this.ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
        this.ctx.fillRect(0, RULER_HEIGHT, startX, this.blockHeight + this.motionTrackHeight + this.audioTrackHeight);
        this.ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
        this.ctx.fillRect(0, 0, startX, RULER_HEIGHT);
      }

      if (outputFrames < totalFrames) {
        const cutoffX = (outputFrames / totalFrames) * width;
        // Semi-transparent black overlay on both tracks
        this.ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
        this.ctx.fillRect(cutoffX, RULER_HEIGHT, width - cutoffX, this.blockHeight + this.motionTrackHeight + this.audioTrackHeight);
        // Subtle tinted ruler overlay
        this.ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
        this.ctx.fillRect(cutoffX, 0, width - cutoffX, RULER_HEIGHT);
      }
    }

    // --- Draw Playhead ---
    const playheadX = (this.currentFrame / totalFrames) * width;

    // Playhead Line
    this.ctx.beginPath();
    this.ctx.moveTo(playheadX, 14);
    this.ctx.lineTo(playheadX, this.canvasHeight);
    this.ctx.strokeStyle = "#ff4444";
    this.ctx.lineWidth = 1.5;
    this.ctx.stroke();

    // Playhead Handle (Polygon above numbers)
    this.ctx.fillStyle = "#ff4444";
    this.ctx.beginPath();
    this.ctx.moveTo(playheadX - 6, 0);
    this.ctx.lineTo(playheadX + 6, 0);
    this.ctx.lineTo(playheadX + 6, 8);
    this.ctx.lineTo(playheadX, 14);
    this.ctx.lineTo(playheadX - 6, 8);
    this.ctx.fill();

    // Draw vertical grab bar on the right edge of viewport for resizing width
    const grabBarW = 4;
    const grabBarH = 50;
    const grabBarX = this.viewport.scrollLeft + this.viewport.clientWidth - grabBarW - 3;
    const grabBarY = RULER_HEIGHT + (this.blockHeight + this.motionTrackHeight + this.audioTrackHeight - grabBarH) / 2;

    this.ctx.fillStyle = "rgba(40, 40, 40, 0.6)";
    this.ctx.beginPath();
    this.ctx.roundRect(grabBarX, grabBarY, grabBarW, grabBarH, 2);
    this.ctx.fill();

    // Draw horizontal grab bar at the bottom of viewport for resizing height
    const hBarW = 50;
    const hBarH = 4;
    const hBarX = this.viewport.scrollLeft + (this.viewport.clientWidth - hBarW) / 2;
    const visibleBottom = Math.min(this.canvasHeight, this.viewport.scrollTop + this.viewport.clientHeight);
    const hBarY = visibleBottom - hBarH - 3; // 3px from the visible bottom edge

    this.ctx.fillStyle = "rgba(20, 20, 20, 0.8)";
    this.ctx.beginPath();
    this.ctx.roundRect(hBarX, hBarY, hBarW, hBarH, 2);
    this.ctx.fill();

    // --- Draw Selection Box Overlay ---
    if (this._isSelectingBox && this._selectBoxStart && this._selectBoxCurrent) {
      const sx = this._selectBoxStart.x;
      const sy = this._selectBoxStart.y;
      const cx = this._selectBoxCurrent.x;
      const cy = this._selectBoxCurrent.y;

      const left = Math.min(sx, cx);
      const top = Math.min(sy, cy);
      const rectWidth = Math.abs(cx - sx);
      const rectHeight = Math.abs(cy - sy);

      this.ctx.save();
      this.ctx.fillStyle = "rgba(59, 130, 246, 0.2)";
      this.ctx.fillRect(left, top, rectWidth, rectHeight);

      this.ctx.strokeStyle = "rgba(29, 78, 216, 0.9)";
      this.ctx.lineWidth = 1.5;
      this.ctx.setLineDash([4, 4]);
      this.ctx.strokeRect(left, top, rectWidth, rectHeight);
      this.ctx.setLineDash([]);
      this.ctx.restore();
    }

    this.updatePlayerUI();
  }



  // --- Where an anchored segment lands in the output ---
  // Only anchored ones are badged, and the planner decides which those are: on the main
  // track a middle image, on the reference tracks whatever is set to "frame anchor". In
  // seconds, not frames, because the ruler runs at the timeline's fps and this number is
  // the model's own 24 — a bare frame count would be read against the wrong clock.
  drawAnchorBadge(seg, startX, pxWidth, clipY, clipH, badgeY) {
    const anchorFrame = this.node?._mmxAnchors?.[seg.id];
    if (anchorFrame === undefined || anchorFrame === null || pxWidth <= 40) return;
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(startX, clipY, pxWidth, clipH);
    this.ctx.clip();

    this.ctx.font = "bold 9px sans-serif";
    const anchorFps = this.node?._mmxAnchorFps || 24;
    const text = `⚓ ${(anchorFrame / anchorFps).toFixed(1)}s`;
    const badgeW = this.ctx.measureText(text).width + 10;

    this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
    this.ctx.fillRect(startX + 1, badgeY, badgeW, 16);
    this.ctx.fillStyle = "#fff";
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.fillText(text, startX + 1 + badgeW / 2, badgeY + 8);
    this.ctx.restore();
  }

  drawAudioSegmentVisuals(ctx, seg, isSelected, yOffset, trackHeight, startX, pxWidth, outlineColor = null, showHandles = true) {
    ctx.fillStyle = isSelected ? "#2a4a3a" : "#1a2a1a";
    ctx.fillRect(startX, yOffset + 2, pxWidth, trackHeight - 3);

    if (seg.waveformPeaks && pxWidth > 0) {
      ctx.fillStyle = isSelected ? "rgba(100, 255, 100, 0.6)" : "rgba(100, 255, 100, 0.3)";
      const startRatio = seg.trimStart / seg.audioDurationFrames;
      const endRatio = (seg.trimStart + seg.length) / seg.audioDurationFrames;
      const peakCount = seg.waveformPeaks.length;
      const centerY = yOffset + trackHeight / 2;

      ctx.beginPath();
      for (let i = 0; i < pxWidth; i++) {
        const pixelRatio = i / pxWidth;
        const globalRatio = startRatio + pixelRatio * (endRatio - startRatio);
        const peakIdx = Math.floor(globalRatio * peakCount);

        if (peakIdx >= 0 && peakIdx < peakCount) {
          const val = seg.waveformPeaks[peakIdx];
          const amp = (val * (trackHeight - 12) / 2) * 0.9;
          ctx.fillRect(startX + i, centerY - amp, 1, amp * 2);
        }
      }
    }

    const strokeColor = outlineColor || (isSelected ? "#4fff8f" : "#000");
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = isSelected || outlineColor ? 2 : 1.5;
    ctx.strokeRect(startX, yOffset + 2, pxWidth, trackHeight - 3);

    if ((isSelected || outlineColor) && showHandles) {
      ctx.fillStyle = strokeColor;
      ctx.beginPath();
      ctx.roundRect(startX, yOffset + trackHeight / 2 - 12, 4, 24, 2);
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(startX + pxWidth - 4, yOffset + trackHeight / 2 - 12, 4, 24, 2);
      ctx.fill();
    }

    ctx.fillStyle = "#ccc";
    ctx.font = "11px sans-serif";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.save();
    ctx.beginPath();
    ctx.rect(startX, yOffset + 2, pxWidth, trackHeight - 3);
    ctx.clip();

    let text = seg.fileName || "Audio Track";
    const maxWidth = pxWidth - 12;
    if (ctx.measureText(text).width > maxWidth && maxWidth > 0) {
      while (text.length > 0 && ctx.measureText(text + "...").width > maxWidth) {
        text = text.slice(0, -1);
      }
      text = text + "...";
    }

    ctx.fillText(text, startX + 6, yOffset + 8);
    ctx.restore();

    // Show Uploading or Decoding badge in bottom-left if applicable
    if ((seg._uploading || seg._decoding) && pxWidth > 60) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(startX, yOffset + 2, pxWidth, trackHeight - 3);
      ctx.clip();
      ctx.font = "bold 9px sans-serif";
      const upText = seg._decoding ? "Decoding..." : "Uploading...";
      const upW = ctx.measureText(upText).width + 10;
      ctx.fillStyle = "rgba(0, 14, 37, 0.7)";
      ctx.fillRect(startX + 1, yOffset + trackHeight - 17, upW, 14);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(upText, startX + 1 + upW / 2, yOffset + trackHeight - 10);
      ctx.restore();
    }
  }


  // --- Interaction Logic ---
  getHitTest(mouseX, mouseY) {
    const width = this.canvas.offsetWidth;
    const totalFrames = this.getVisualDurationFrames();

    // Check Playhead Handle first
    const playheadX = (this.currentFrame / totalFrames) * width;
    if (mouseY <= 24 && Math.abs(mouseX - playheadX) <= 12) {
      return { type: "playhead" };
    }

    if (mouseY <= RULER_HEIGHT) {
      return { type: "ruler" };
    }

    if (mouseY < RULER_HEIGHT || mouseY > this.canvasHeight) return null;

    const trackType = this.getTrackFromY(mouseY);
    const trackSegments = this.getSegmentArray(trackType);

    if (trackSegments.length === 0) return null;

    // Helper to check if a segment (or its sibling video/audio counterpart) is uploading/decoding
    const isSegmentProcessing = (s) => {
      if (!s) return false;
      if (s._uploading || s._decoding) return true;
      const isVid = s.id?.endsWith("_v");
      const isAud = s.id?.endsWith("_a");
      if (isVid || isAud) {
        const siblingId = isVid ? s.id.slice(0, -2) + "_a" : s.id.slice(0, -2) + "_v";
        const siblingArray = isVid ? this.timeline.audioSegments : this.timeline.segments;
        const sibling = siblingArray.find(x => x.id === siblingId);
        if (sibling && (sibling._uploading || sibling._decoding)) {
          return true;
        }
      }
      return false;
    };

    // The variables width and totalFrames are already declared above.

    let sortedSegments = [...trackSegments]
      .map((s, i) => ({ ...s, originalIndex: i }))
      .sort((a, b) => a.start - b.start);

    const HANDLE_CORE = 4;

    for (let i = 0; i < sortedSegments.length; i++) {
      const seg = sortedSegments[i];
      const startX = (seg.start / totalFrames) * width;
      const pxWidth = (seg.length / totalFrames) * width;
      const endX = startX + pxWidth;

      const prevSeg = sortedSegments[i - 1];
      const nextSeg = sortedSegments[i + 1];

      const isLeftJoint = prevSeg && prevSeg.start + prevSeg.length === seg.start;
      if (!isLeftJoint) {
        if (Math.abs(mouseX - startX) <= HANDLE_HIT_PX) {
          if (!isSegmentProcessing(seg)) {
            return { type: "edge", index: seg.originalIndex, dir: "left", track: trackType };
          }
        }
      }

      const isRightJoint = nextSeg && nextSeg.start === seg.start + seg.length;
      if (isRightJoint) {
        const dx = mouseX - endX;
        if (Math.abs(dx) <= HANDLE_HIT_PX) {
          if (dx < -HANDLE_CORE) {
            if (!isSegmentProcessing(seg)) {
              return { type: "edge", index: seg.originalIndex, dir: "right", track: trackType };
            }
          } else if (dx > HANDLE_CORE) {
            if (!isSegmentProcessing(nextSeg)) {
              return { type: "edge", index: nextSeg.originalIndex, dir: "left", track: trackType };
            }
          } else {
            if (!isSegmentProcessing(seg) && !isSegmentProcessing(nextSeg)) {
              return { type: "joint", leftIndex: seg.originalIndex, rightIndex: nextSeg.originalIndex, track: trackType };
            }
          }
        }
      } else {
        if (Math.abs(mouseX - endX) <= HANDLE_HIT_PX) {
          if (!isSegmentProcessing(seg)) {
            return { type: "edge", index: seg.originalIndex, dir: "right", track: trackType };
          }
        }
      }
    }

    for (let i = 0; i < sortedSegments.length; i++) {
      const seg = sortedSegments[i];
      const startX = (seg.start / totalFrames) * width;
      const pxWidth = (seg.length / totalFrames) * width;
      const endX = startX + pxWidth;

      if (mouseX >= startX && mouseX < endX) {
        return { type: "center", index: seg.originalIndex, track: trackType };
      }
    }

    return null;
  }

  onMouseDown(e) {
    if (e.button === 2 && this.retakeMode) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.button !== 0) return;
    const { x, y } = this.getMousePos(e);

    // In retake mode: block box selection — no multi-segment operations allowed
    if (e.shiftKey && !this.retakeMode) {
      this._isSelectingBox = true;
      this._isDragging = true;
      this._dragType = "box_select";
      this._selectBoxStart = { x, y };
      this._selectBoxCurrent = { x, y };
      this._selectBoxInitialSelectedIds = (e.ctrlKey || e.metaKey) ? [...this.selectedSegmentIds] : [];
      this.selectedSegmentIds = [...this._selectBoxInitialSelectedIds];
      this.syncSelectionTypeAndIndex();
      this.updateUIFromSelection();
      this.render();
      return;
    }

    // Canvas height and width resizing apply in both modes.
    const visibleBottom = Math.min(this.canvasHeight, this.viewport.scrollTop + this.viewport.clientHeight);
    const isAtBottom = Math.abs(y - visibleBottom) <= 15;
    if (isAtBottom) {
      this._isDragging = true;
      this._dragType = "height_resize";
      this._startBlockHeight = this.blockHeight;
      this._startY = y;
      document.body.style.userSelect = "none";
      return;
    }

    const viewRect = this.viewport.getBoundingClientRect();
    const isAtRightEdge = Math.abs(e.clientX - viewRect.right) <= 20;
    if (isAtRightEdge) {
      this._isDragging = true;
      this._dragType = "width_resize";
      this._startNodeWidth = this.node.size[0];
      this._startX = e.clientX;
      document.body.style.userSelect = "none";
      return;
    }

    // Track height dividers only apply in normal timeline mode.
    if (!this.retakeMode) {
      const isOverDivider = Math.abs(y - (RULER_HEIGHT + this.blockHeight)) <= 8;
      const isOverAudioDivider = Math.abs(y - (RULER_HEIGHT + this.blockHeight + this.audioTrackHeight)) <= 8;
      if (isOverDivider) {
        this._isDragging = true;
        this._dragType = "divider";
        this._startBlockHeight = this.blockHeight;
        this._startAudioTrackHeight = this.audioTrackHeight;
        this._startY = y;
        return;
      } else if (isOverAudioDivider) {
        this._isDragging = true;
        this._dragType = "audio_divider";
        this._startMotionTrackHeight = this.motionTrackHeight;
        this._startAudioTrackHeight = this.audioTrackHeight;
        this._startY = y;
        return;
      }
    }

    if (this.retakeMode) {
      // If no video is loaded on the retake timeline, clicking in the timeline opens the file explorer
      if (y >= RULER_HEIGHT && y <= RULER_HEIGHT + this.blockHeight) {
        if (!this.timeline.retakeVideo) {
          if (this.videoFileInput) {
            this.videoFileInput.click();
          }
          return;
        }
      }

      if (y < RULER_HEIGHT) {
        this._isDragging = true;
        this._dragType = "playhead";
        const logicalWidth = this.canvas.offsetWidth;
        const totalFrames = this.getVisualDurationFrames();
        let mouseFrameX = x * (totalFrames / logicalWidth);
        mouseFrameX = this.getSnappedPlayhead(mouseFrameX, logicalWidth);
        const clampMax = this.timeline.retakeVideo ? (this.timeline.retakeVideo.videoDurationFrames || totalFrames) : totalFrames;
        this.currentFrame = clamp(mouseFrameX, 0, clampMax);
        // Pause only the RAF playback loop so we can seek the video directly during scrub.
        // The video element itself keeps playing; we'll resume the loop on mouseup.
        this._retakeScrubWasPlaying = this.isPlaying;
        if (this.isPlaying) {
          this.isPlaying = false;
          this._currentPlayId = null;
        }
        if (this.timeline.retakeVideo && this.timeline.retakeVideo.videoEl) {
          this.timeline.retakeVideo.videoEl.currentTime = this.currentFrame / this.getFrameRate();
        }
        this.render();
        return;
      }

      if (y >= RULER_HEIGHT && y <= RULER_HEIGHT + this.blockHeight) {
        const logicalWidth = this.canvas.offsetWidth;
        const totalFrames = this.getVisualDurationFrames();
        const retakeStart = this.timeline.retakeStart ?? 0;
        const baseVideoDur = this.timeline.retakeVideo?.videoDurationFrames ?? totalFrames;
        const retakeLength = this.timeline.retakeLength ?? baseVideoDur;

        const x1 = (retakeStart / totalFrames) * logicalWidth;
        const x2 = ((retakeStart + retakeLength) / totalFrames) * logicalWidth;
        const threshold = HANDLE_HIT_PX;

        if (this.timeline.retakeVideo && Math.abs(x - x1) <= threshold) {
          this._isDragging = true;
          this._dragType = "retake_left";
          this._dragStartX = x;
          this._dragStartRetakeStart = retakeStart;
          this._dragStartRetakeLength = retakeLength;
          return;
        } else if (this.timeline.retakeVideo && Math.abs(x - x2) <= threshold) {
          this._isDragging = true;
          this._dragType = "retake_right";
          this._dragStartX = x;
          this._dragStartRetakeStart = retakeStart;
          this._dragStartRetakeLength = retakeLength;
          return;
        } else if (this.timeline.retakeVideo && x > x1 && x < x2) {
          this._isDragging = true;
          this._dragType = "retake_center";
          this._dragStartX = x;
          this._dragStartRetakeStart = retakeStart;
          this._dragStartRetakeLength = retakeLength;
          return;
        } else {
          this._isDragging = true;
          this._dragType = "playhead";
          let mouseFrameX = x * (totalFrames / logicalWidth);
          mouseFrameX = this.getSnappedPlayhead(mouseFrameX, logicalWidth);
          const clampMax = this.timeline.retakeVideo ? (this.timeline.retakeVideo.videoDurationFrames || totalFrames) : totalFrames;
          this.currentFrame = clamp(mouseFrameX, 0, clampMax);
          // Pause only the RAF playback loop so we can seek the video directly during scrub.
          this._retakeScrubWasPlaying = this.isPlaying;
          if (this.isPlaying) {
            this.isPlaying = false;
            this._currentPlayId = null;
          }
          if (this.timeline.retakeVideo && this.timeline.retakeVideo.videoEl) {
            this.timeline.retakeVideo.videoEl.currentTime = this.currentFrame / this.getFrameRate();
          }
          this.render();
          return;
        }
      }
      // Retake mode consumed the interaction — do NOT fall through to normal timeline
      return;
    }

    if (y >= RULER_HEIGHT && y <= this.canvasHeight) {
      const BTN_R = 12;
      const gapRegions = this.getGapRegions();
      for (let i = 0; i < gapRegions.length; i++) {
        const gap = gapRegions[i];
        if (gap.widthPx < BTN_R * 2 + 8) continue;
        const dx = x - gap.centerX, dy2 = y - gap.centerY;
        if (dx * dx + dy2 * dy2 <= BTN_R * BTN_R) {
          const currentTrack = gap.track;
          const hasCopied = this._copiedSegment || window._mmxCopiedSegmentCS;
          const copiedTrack = this._copiedSegmentTrack || window._mmxCopiedSegmentTypeCS;
          const isCompatible = hasCopied && this.getCanonicalTrack(copiedTrack) === currentTrack;

          if (currentTrack === "motion" && !isCompatible) {
            this.promptAddMotionInGap(gap.frameStart, gap.frameEnd);
          } else if (currentTrack === "audio" && !isCompatible) {
            this.promptAddAudioInGap(gap.frameStart, gap.frameEnd);
          } else {
            this.showGapMenu(e.clientX, e.clientY, gap);
          }
          return;
        }
      }
    }

    const isCtrl = e.ctrlKey || e.metaKey;
    const hit = this.getHitTest(x, y);
    if (!hit) {
      if (!isCtrl) {
        this.selectedSegmentIds = [];
        this.selectedIndex = -1;
        this.updateUIFromSelection();
      }
      this.render();
      return;
    }

    if (hit.type === "playhead" || hit.type === "ruler") {
      this._isDragging = true;
      this._dragType = "playhead";
      const logicalWidth = this.canvas.offsetWidth;
      const totalFrames = this.getVisualDurationFrames();
      let mouseFrameX = x * (totalFrames / logicalWidth);
      mouseFrameX = this.getSnappedPlayhead(mouseFrameX, logicalWidth);
      this.currentFrame = clamp(mouseFrameX, 0, totalFrames);
      this._liveScrubPlayhead();
      this.render();
      if (this.isPlaying) {
        this.playAudio();
      }
      return;
    }

    const clickedTrack = hit.track;
    const targetArray = this.getSegmentArray(clickedTrack);
    let clickedId = null;
    let clickedIdx = -1;
    if (hit.type === "joint") {
      clickedIdx = hit.leftIndex;
    } else {
      clickedIdx = hit.index;
    }
    if (clickedIdx !== -1 && targetArray[clickedIdx]) {
      clickedId = targetArray[clickedIdx].id;
    }

    if (clickedId) {
      if (isCtrl) {
        const sibId = clickedId.endsWith("_v") ? clickedId.slice(0, -2) + "_a" : (clickedId.endsWith("_a") ? clickedId.slice(0, -2) + "_v" : null);
        const isSelected = this.selectedSegmentIds.includes(clickedId);
        if (isSelected) {
          this.selectedSegmentIds = this.selectedSegmentIds.filter(id => id !== clickedId && id !== sibId);
        } else {
          if (!this.selectedSegmentIds.includes(clickedId)) this.selectedSegmentIds.push(clickedId);
          if (sibId && !this.selectedSegmentIds.includes(sibId)) this.selectedSegmentIds.push(sibId);
        }

        if (this.selectedSegmentIds.length > 0) {
          this.selectionType = clickedTrack;
          this.selectedIndex = clickedIdx;
        } else {
          this.selectedIndex = -1;
        }
        this._multiDragClickPendingDeselect = null;
      } else {
        if (this.selectedSegmentIds.includes(clickedId)) {
          this._multiDragClickPendingDeselect = clickedId;
        } else {
          this.selectedSegmentIds = [clickedId];
          const sibId = clickedId.endsWith("_v") ? clickedId.slice(0, -2) + "_a" : (clickedId.endsWith("_a") ? clickedId.slice(0, -2) + "_v" : null);
          if (sibId && !this.selectedSegmentIds.includes(sibId)) this.selectedSegmentIds.push(sibId);
          this.selectionType = clickedTrack;
          this.selectedIndex = clickedIdx;
          this._multiDragClickPendingDeselect = null;
        }
      }
    }

    this.updateUIFromSelection();

    if (this.isMultiSelectActive()) {
      this._isDragging = true;
      this._dragType = "center";
      this._dragStartX = x;
      this._isMultiDraggingAndMoved = false;
      this._multiDragInitialSegments = {
        image: this.timeline.segments.map(s => ({ ...s })),
        motion: this.timeline.motionSegments.map(s => ({ ...s })),
        audio: this.timeline.audioSegments.map(s => ({ ...s }))
      };
      this._multiDragPreviewTimelines = null;
    } else {
      this.selectionType = hit.track;
      if (hit.type === "joint") {
        this.selectedIndex = hit.leftIndex;
        this._dragType = "joint";
        this._dragTargetId = targetArray[hit.leftIndex].id;
        this._dragTargetIdRight = targetArray[hit.rightIndex].id;
      } else if (hit.type === "center") {
        this.selectedIndex = hit.index;
        this._dragType = "center";
      } else {
        if (this.selectedIndex !== hit.index) {
          this.selectedIndex = hit.index;
        }
        this._dragType = hit.dir;
      }

      this._isDragging = true;
      this._previewSegments = null;
      this._previewSiblingSegments = null;
      this._dragStartX = x;
      this._dragInitialTimeline = targetArray.map(s => ({ ...s }));
      this._dragInitialSiblingTimeline = this.selectionType === "motion" ? null : (this.selectionType === "audio" ? this.timeline.segments : this.timeline.audioSegments).map(s => ({ ...s }));

      if (hit.type !== "joint") {
        this._dragTargetId = targetArray[hit.index].id;
      }
    }

    if (this.isPlaying) {
      this.pauseAudio();
    }

    this.render();
  }

  onMouseMove(e) {
    const { x: mouseX, y: mouseY } = this.getMousePos(e);

    if (this._isSelectingBox && this._dragType === "box_select") {
      this.canvas.style.cursor = "crosshair";
      this._selectBoxCurrent = { x: mouseX, y: mouseY };
      this.updateSelectionFromBox();
      this.render();
      return;
    }

    if (this.retakeMode && !this._isDragging) {
      const visibleBottom = Math.min(this.canvasHeight, this.viewport.scrollTop + this.viewport.clientHeight);
      const isAtBottom = Math.abs(mouseY - visibleBottom) <= 15;
      const viewRect = this.viewport.getBoundingClientRect();
      const isAtRightEdge = Math.abs(e.clientX - viewRect.right) <= 20;

      if (isAtBottom) {
        this.canvas.style.cursor = "ns-resize";
        return;
      } else if (isAtRightEdge) {
        this.canvas.style.cursor = "ew-resize";
        return;
      }

      if (mouseY >= RULER_HEIGHT && mouseY <= RULER_HEIGHT + this.blockHeight) {
        const logicalWidth = this.canvas.offsetWidth;
        const totalFrames = this.getVisualDurationFrames();
        const retakeStart = this.timeline.retakeStart ?? 0;
        const baseVideoDur = this.timeline.retakeVideo?.videoDurationFrames ?? totalFrames;
        const retakeLength = this.timeline.retakeLength ?? baseVideoDur;

        const x1 = (retakeStart / totalFrames) * logicalWidth;
        const x2 = ((retakeStart + retakeLength) / totalFrames) * logicalWidth;
        const threshold = HANDLE_HIT_PX;

        if (Math.abs(mouseX - x1) <= threshold || Math.abs(mouseX - x2) <= threshold) {
          this.canvas.style.cursor = "ew-resize";
        } else if (mouseX > x1 && mouseX < x2) {
          this.canvas.style.cursor = "move";
        } else {
          this.canvas.style.cursor = "default";
        }
      } else if (mouseY < RULER_HEIGHT) {
        this.canvas.style.cursor = "ew-resize";
      } else {
        this.canvas.style.cursor = "default";
      }
      return;
    }

    if (!this._isDragging) {
      let newHoveredGapIdx = -1;
      const BTN_R = 12;
      const gapRegions = this.getGapRegions();
      for (let i = 0; i < gapRegions.length; i++) {
        const gap = gapRegions[i];
        if (gap.widthPx < BTN_R * 2 + 8) continue;
        const dx = mouseX - gap.centerX, dy2 = mouseY - gap.centerY;
        if (dx * dx + dy2 * dy2 <= BTN_R * BTN_R) { newHoveredGapIdx = i; break; }
      }
      if (this._hoveredGapIdx !== newHoveredGapIdx) {
        this._hoveredGapIdx = newHoveredGapIdx;
        this.render();
      }

      const isOverDivider = Math.abs(mouseY - (RULER_HEIGHT + this.blockHeight)) <= 8;
      const isOverAudioDivider = Math.abs(mouseY - (RULER_HEIGHT + this.blockHeight + this.audioTrackHeight)) <= 8;
      const visibleBottom = Math.min(this.canvasHeight, this.viewport.scrollTop + this.viewport.clientHeight);
      const isAtBottom = Math.abs(mouseY - visibleBottom) <= 15;
      const viewRect = this.viewport.getBoundingClientRect();
      const isAtRightEdge = Math.abs(e.clientX - viewRect.right) <= 20;
      const hit = this.getHitTest(mouseX, mouseY);
      if (isOverDivider || isOverAudioDivider || isAtBottom) {
        this.canvas.style.cursor = "ns-resize";
      } else if (isAtRightEdge) {
        this.canvas.style.cursor = "ew-resize";
      } else if (newHoveredGapIdx >= 0) {
        this.canvas.style.cursor = "pointer";
      } else if (hit?.type === "edge") {
        this.canvas.style.cursor = "ew-resize";
      } else if (hit?.type === "joint") {
        this.canvas.style.cursor = "col-resize";
      } else if (hit?.type === "center") {
        this.canvas.style.cursor = "grab";
      } else if (hit?.type === "playhead") {
        this.canvas.style.cursor = "ew-resize";
      } else {
        this.canvas.style.cursor = "default";
      }
      return;
    }

    if (this.retakeMode && this._isDragging) {
      const totalFrames = this.getVisualDurationFrames();
      const logicalWidth = this.canvas.offsetWidth;
      const deltaX = mouseX - this._dragStartX;
      const deltaFrames = Math.round(deltaX * (totalFrames / logicalWidth));

      const frameRate = this.getFrameRate();

      // Handle playhead drag in retakeMode — the RAF loop is paused, so seek directly
      if (this._dragType === "playhead") {
        this.canvas.style.cursor = "ew-resize";
        let mouseFrameX = mouseX * (totalFrames / logicalWidth);
        mouseFrameX = this.getSnappedPlayhead(mouseFrameX, logicalWidth);
        const clampMax = this.timeline.retakeVideo ? (this.timeline.retakeVideo.videoDurationFrames || totalFrames) : totalFrames;
        this.currentFrame = clamp(mouseFrameX, 0, clampMax);
        if (this.timeline.retakeVideo && this.timeline.retakeVideo.videoEl) {
          this.timeline.retakeVideo.videoEl.currentTime = this.currentFrame / frameRate;
        }
        this.render();
        return;
      }

      if (this._dragType === "retake_left") {
        this.canvas.style.cursor = "ew-resize";
        let newStart = this._dragStartRetakeStart + deltaFrames;
        let newLength = this._dragStartRetakeLength - deltaFrames;

        if (this.isSnapping) {
          const thresholdFrames = (15 / logicalWidth) * totalFrames;
          const baseVideoDur = this.timeline.retakeVideo?.videoDurationFrames ?? totalFrames;
          const candidates = [0, this.currentFrame, baseVideoDur];
          let bestStart = newStart;
          let minDiff = thresholdFrames;
          for (const c of candidates) {
            const diff = Math.abs(newStart - c);
            if (diff < minDiff) {
              minDiff = diff;
              bestStart = c;
            }
          }
          if (bestStart !== newStart) {
            newStart = bestStart;
            newLength = this._dragStartRetakeStart + this._dragStartRetakeLength - newStart;
          }
        }

        if (newStart < 0) {
          newStart = 0;
          newLength = this._dragStartRetakeStart + this._dragStartRetakeLength;
        }
        if (newLength < MIN_SEGMENT_LENGTH) {
          newLength = MIN_SEGMENT_LENGTH;
          newStart = this._dragStartRetakeStart + this._dragStartRetakeLength - MIN_SEGMENT_LENGTH;
        }

        this.timeline.retakeStart = newStart;
        this.timeline.retakeLength = newLength;

        if (this.timeline.retakeVideo && this.timeline.retakeVideo.videoEl) {
          this.timeline.retakeVideo.videoEl.currentTime = newStart / frameRate;
        }

        this.render();
        this.updateUIFromSelection();
        return;
      }

      if (this._dragType === "retake_right") {
        this.canvas.style.cursor = "ew-resize";
        let newLength = this._dragStartRetakeLength + deltaFrames;

        const baseVideoDur = this.timeline.retakeVideo?.videoDurationFrames ?? totalFrames;
        let newEnd = this._dragStartRetakeStart + newLength;

        if (this.isSnapping) {
          const thresholdFrames = (15 / logicalWidth) * totalFrames;
          const candidates = [0, this.currentFrame, baseVideoDur];
          let bestEnd = newEnd;
          let minDiff = thresholdFrames;
          for (const c of candidates) {
            const diff = Math.abs(newEnd - c);
            if (diff < minDiff) {
              minDiff = diff;
              bestEnd = c;
            }
          }
          if (bestEnd !== newEnd) {
            newEnd = bestEnd;
            newLength = newEnd - this._dragStartRetakeStart;
          }
        }

        if (this._dragStartRetakeStart + newLength > baseVideoDur) {
          newLength = baseVideoDur - this._dragStartRetakeStart;
        }
        if (newLength < MIN_SEGMENT_LENGTH) {
          newLength = MIN_SEGMENT_LENGTH;
        }

        this.timeline.retakeLength = newLength;

        if (this.timeline.retakeVideo && this.timeline.retakeVideo.videoEl) {
          this.timeline.retakeVideo.videoEl.currentTime = (this.timeline.retakeStart + newLength) / frameRate;
        }

        this.render();
        this.updateUIFromSelection();
        return;
      }

      if (this._dragType === "retake_center") {
        this.canvas.style.cursor = "grabbing";
        let newStart = this._dragStartRetakeStart + deltaFrames;

        if (this.isSnapping) {
          const thresholdFrames = (15 / logicalWidth) * totalFrames;
          const baseVideoDur = this.timeline.retakeVideo?.videoDurationFrames ?? totalFrames;
          const candidates = [0, this.currentFrame, baseVideoDur];
          let bestStart = newStart;
          let minDiff = thresholdFrames;

          for (const c of candidates) {
            const diffLeft = Math.abs(newStart - c);
            if (diffLeft < minDiff) {
              minDiff = diffLeft;
              bestStart = c;
            }
            const diffRight = Math.abs((newStart + this._dragStartRetakeLength) - c);
            if (diffRight < minDiff) {
              minDiff = diffRight;
              bestStart = c - this._dragStartRetakeLength;
            }
          }
          newStart = bestStart;
        }

        if (newStart < 0) {
          newStart = 0;
        }
        const baseVideoDur = this.timeline.retakeVideo?.videoDurationFrames ?? totalFrames;
        if (newStart + this._dragStartRetakeLength > baseVideoDur) {
          newStart = baseVideoDur - this._dragStartRetakeLength;
        }

        this.timeline.retakeStart = newStart;

        if (this.timeline.retakeVideo && this.timeline.retakeVideo.videoEl) {
          this.timeline.retakeVideo.videoEl.currentTime = newStart / frameRate;
        }

        this.render();
        this.updateUIFromSelection();
        return;
      }
    }

    if (this._dragType === "divider") {
      this.canvas.style.cursor = "ns-resize";
      const deltaY = mouseY - this._startY;

      const minBlockH = 50;
      const minAudioH = 50;

      let newBlockHeight = this._startBlockHeight + deltaY;
      let newAudioTrackHeight = this._startAudioTrackHeight - deltaY;

      if (newBlockHeight < minBlockH) {
        newBlockHeight = minBlockH;
        newAudioTrackHeight = this._startBlockHeight + this._startAudioTrackHeight - minBlockH;
      }
      if (newAudioTrackHeight < minAudioH) {
        newAudioTrackHeight = minAudioH;
        newBlockHeight = this._startBlockHeight + this._startAudioTrackHeight - minAudioH;
      }

      this.blockHeight = newBlockHeight;
      this.audioTrackHeight = newAudioTrackHeight;

      this.updateSidebarHeights();
      this.render();
      return;
    }

    if (this._dragType === "audio_divider") {
      this.canvas.style.cursor = "ns-resize";
      const deltaY = mouseY - this._startY;

      const minMotionH = 50;
      const minAudioH = 50;

      // Divider moves down: audio gets bigger, motion gets smaller
      let newAudioTrackHeight = this._startAudioTrackHeight + deltaY;
      let newMotionTrackHeight = this._startMotionTrackHeight - deltaY;

      if (newAudioTrackHeight < minAudioH) {
        newAudioTrackHeight = minAudioH;
        newMotionTrackHeight = this._startAudioTrackHeight + this._startMotionTrackHeight - minAudioH;
      }
      if (newMotionTrackHeight < minMotionH) {
        newMotionTrackHeight = minMotionH;
        newAudioTrackHeight = this._startAudioTrackHeight + this._startMotionTrackHeight - minMotionH;
      }

      this.motionTrackHeight = newMotionTrackHeight;
      this.audioTrackHeight = newAudioTrackHeight;

      this.updateSidebarHeights();
      this.render();
      return;
    }

    if (this._dragType === "height_resize") {
      this.canvas.style.cursor = "ns-resize";
      const deltaY = mouseY - this._startY;

      this.blockHeight = Math.max(100, this._startBlockHeight + deltaY);
      this.canvasHeight = this.rulerHeight + this.blockHeight + this.motionTrackHeight + this.audioTrackHeight;

      this.canvas.style.height = `${this.canvasHeight}px`;

      this.resizeCanvas(this.canvas.offsetWidth);
      this.updateSidebarHeights();
      this.render();

      if (this.node && this.node.computeSize) {
        const sz = this.node.computeSize();
        this.node.size[1] = sz[1];
        if (window.app && window.app.graph) {
          window.app.graph.setDirtyCanvas(true, true);
        }
      }
      return;
    }

    if (this._dragType === "width_resize") {
      this.canvas.style.cursor = "ew-resize";
      const deltaX = e.clientX - this._startX;

      this.node.size[0] = Math.max(300, this._startNodeWidth + deltaX);

      if (window.app && window.app.graph) {
        window.app.graph.setDirtyCanvas(true, true);
      }
      return;
    }

    if (this._dragType === "playhead") {
      this.canvas.style.cursor = "ew-resize";
      const logicalWidth = this.canvas.offsetWidth;
      const totalFrames = this.getVisualDurationFrames();
      let mouseFrameX = mouseX * (totalFrames / logicalWidth);
      mouseFrameX = this.getSnappedPlayhead(mouseFrameX, logicalWidth);
      this.currentFrame = clamp(mouseFrameX, 0, totalFrames);
      this._liveScrubPlayhead();
      this.render();
      if (this.isPlaying) {
        this.playAudio(); // Scrub (restart from new position)
      }
      return;
    }

    if (this._multiDragInitialSegments) {
      this.canvas.style.cursor = "grabbing";
      this._isMultiDraggingAndMoved = true;

      const logicalWidth = this.canvas.offsetWidth;
      const totalFrames = this.getVisualDurationFrames();
      const durationFrames = totalFrames;
      let dragDelta = Math.round((mouseX - this._dragStartX) * (totalFrames / logicalWidth));

      const selectedIds = this.selectedSegmentIds;

      // Group Blocking Physics Calculation
      let maxLeftShift = Infinity;
      let maxRightShift = Infinity;

      for (const track of ["image", "motion", "audio"]) {
        const allTrackSegs = this._multiDragInitialSegments[track];
        if (!allTrackSegs) continue;
        const selectedOnTrack = allTrackSegs.filter(s => selectedIds.includes(s.id));
        const nonSelectedOnTrack = allTrackSegs.filter(s => !selectedIds.includes(s.id));

        if (selectedOnTrack.length === 0) continue;

        for (const S of selectedOnTrack) {
          // Find closest non-selected segment to the left on the same track
          let closestLeftEnd = 0;
          for (const L of nonSelectedOnTrack) {
            if (L.start + L.length <= S.start) {
              closestLeftEnd = Math.max(closestLeftEnd, L.start + L.length);
            }
          }
          const spaceLeft = S.start - closestLeftEnd;
          maxLeftShift = Math.min(maxLeftShift, spaceLeft);

          // Find closest non-selected segment to the right on the same track
          let closestRightStart = durationFrames;
          for (const R of nonSelectedOnTrack) {
            if (R.start >= S.start + S.length) {
              closestRightStart = Math.min(closestRightStart, R.start);
            }
          }
          const spaceRight = closestRightStart - (S.start + S.length);
          maxRightShift = Math.min(maxRightShift, spaceRight);
        }
      }

      // Clamp drag delta
      let clampedDragDelta = clamp(dragDelta, -maxLeftShift, maxRightShift);

      // Apply snapping if active
      if (this.isSnapping) {
        const thresholdFrames = (15 / logicalWidth) * totalFrames;
        let bestAdjustment = null;
        let minDiff = thresholdFrames;

        // Collect snap candidates
        const snapCandidates = [0, this.getDurationFrames(), this.getStartFrames(), this.currentFrame];
        if (this.endFramesWidget && this.endFramesWidget.value !== undefined) {
          snapCandidates.push(parseInt(this.endFramesWidget.value, 10));
        }

        for (const track of ["image", "motion", "audio"]) {
          const allTrackSegs = this._multiDragInitialSegments[track];
          if (!allTrackSegs) continue;
          const nonSelectedOnTrack = allTrackSegs.filter(s => !selectedIds.includes(s.id));
          for (const L of nonSelectedOnTrack) {
            snapCandidates.push(L.start);
            snapCandidates.push(L.start + L.length);
          }
        }

        // Test all selected segments against candidates
        for (const track of ["image", "motion", "audio"]) {
          const allTrackSegs = this._multiDragInitialSegments[track];
          if (!allTrackSegs) continue;
          const selectedOnTrack = allTrackSegs.filter(s => selectedIds.includes(s.id));
          for (const S of selectedOnTrack) {
            const targetStart = S.start + clampedDragDelta;
            const targetEnd = S.start + S.length + clampedDragDelta;

            for (const cand of snapCandidates) {
              // Check start edge
              const diffStart = cand - targetStart;
              if (Math.abs(diffStart) < minDiff) {
                minDiff = Math.abs(diffStart);
                bestAdjustment = diffStart;
              }
              // Check end edge
              const diffEnd = cand - targetEnd;
              if (Math.abs(diffEnd) < minDiff) {
                minDiff = Math.abs(diffEnd);
                bestAdjustment = diffEnd;
              }
            }
          }
        }

        if (bestAdjustment !== null) {
          const adjustedDelta = clampedDragDelta + bestAdjustment;
          if (adjustedDelta >= -maxLeftShift && adjustedDelta <= maxRightShift) {
            clampedDragDelta = adjustedDelta;
          }
        }
      }

      // Compute previews
      this._multiDragPreviewTimelines = {
        image: this._multiDragInitialSegments.image.map(s => {
          if (selectedIds.includes(s.id)) {
            return { ...s, start: s.start + clampedDragDelta };
          }
          return s;
        }),
        motion: this._multiDragInitialSegments.motion.map(s => {
          if (selectedIds.includes(s.id)) {
            return { ...s, start: s.start + clampedDragDelta };
          }
          return s;
        }),
        audio: this._multiDragInitialSegments.audio.map(s => {
          if (selectedIds.includes(s.id)) {
            return { ...s, start: s.start + clampedDragDelta };
          }
          return s;
        })
      };

      // Scrub support for video segments being moved
      for (const track of ["image", "motion"]) {
        const prevSegs = this._multiDragPreviewTimelines[track];
        for (const s of prevSegs) {
          if (selectedIds.includes(s.id) && (s.type === "video" || s.type === "motion_video")) {
            this._liveScrubVideo(s, "start");
          }
        }
      }

      this.render();
      return;
    }

    this.canvas.style.cursor = this._dragType === "center" ? "grabbing" :
      this._dragType === "joint" ? "col-resize" : "ew-resize";

    const logicalWidth = this.canvas.offsetWidth;
    const totalFrames = this.getVisualDurationFrames();
    const durationFrames = totalFrames;
    let dragDelta = Math.round((mouseX - this._dragStartX) * (totalFrames / logicalWidth));

    let t = this._dragInitialTimeline.map(s => ({ ...s }));

    // --- Rolling Edit (Slide Edit) ---
    if (this._dragType === "joint") {
      let leftIdx = t.findIndex(s => s.id === this._dragTargetId);
      let rightIdx = t.findIndex(s => s.id === this._dragTargetIdRight);

      if (leftIdx >= 0 && rightIdx >= 0) {
        let origLeft = this._dragInitialTimeline.find(s => s.id === this._dragTargetId);
        let origRight = this._dragInitialTimeline.find(s => s.id === this._dragTargetIdRight);

        let maxDeltaRight = origRight.length - MIN_SEGMENT_LENGTH;
        let maxDeltaLeft = origLeft.length - MIN_SEGMENT_LENGTH;

        if (this.selectionType === "audio" || origRight.type === "video") {
          // Drag LEFT: right clip extends left by un-trimming its head.
          // Can only un-trim as much as the right clip has been trimmed (trimStart >= 0).
          maxDeltaLeft = Math.min(maxDeltaLeft, origRight.trimStart || 0);
        }
        if (this.selectionType === "audio" || origLeft.type === "video") {
          // Drag RIGHT: left clip extends right by consuming its remaining tail audio.
          // Can only extend as far as the left clip's unplayed tail allows.
          let origDur = origLeft.audioDurationFrames || origLeft.videoDurationFrames || origLeft.length;
          let availLeftTail = origDur - ((origLeft.trimStart || 0) + origLeft.length);
          maxDeltaRight = Math.min(maxDeltaRight, availLeftTail);
        }

        // Apply snapping to the shared boundary position
        if (this.isSnapping) {
          const thresholdFrames = (15 / logicalWidth) * totalFrames;
          const jointPos = origLeft.start + origLeft.length + dragDelta;
          let bestJoint = jointPos;
          let minDiff = thresholdFrames;

          const snapCandidates = [0, this.getDurationFrames(), this.currentFrame];
          snapCandidates.push(this.getStartFrames());
          if (this.endFramesWidget && this.endFramesWidget.value !== undefined) {
            snapCandidates.push(parseInt(this.endFramesWidget.value, 10));
          }
          const allTracks = [
            this.timeline.segments || [],
            this.timeline.motionSegments || [],
            this.timeline.audioSegments || []
          ];
          const ignoreIds = [String(this._dragTargetId), String(this._dragTargetIdRight)];
          for (const track of allTracks) {
            for (const seg of track) {
              if (ignoreIds.includes(String(seg.id))) continue;
              snapCandidates.push(seg.start);
              snapCandidates.push(seg.start + seg.length);
            }
          }

          for (const candidate of snapCandidates) {
            const diff = Math.abs(jointPos - candidate);
            if (diff < minDiff) {
              minDiff = diff;
              bestJoint = candidate;
            }
          }
          dragDelta = bestJoint - (origLeft.start + origLeft.length);
        }

        let safeDelta = clamp(dragDelta, -maxDeltaLeft, maxDeltaRight);

        t[leftIdx].length = origLeft.length + safeDelta;
        t[rightIdx].start = origRight.start + safeDelta;
        t[rightIdx].length = origRight.length - safeDelta;

        if (this.selectionType === "audio" || t[rightIdx].type === "video") {
          t[rightIdx].trimStart = origRight.trimStart + safeDelta;
        }
      }
    }
    // --- Edge & Center Drags ---
    else {
      const targetIdx = t.findIndex((s) => s.id === this._dragTargetId);
      if (targetIdx < 0) return;

      if (this._dragType === "right") {
        let newLen = t[targetIdx].length + dragDelta;
        if (this.isSnapping) {
          const thresholdFrames = (15 / logicalWidth) * totalFrames;
          const targetEnd = t[targetIdx].start + newLen;
          let bestEnd = targetEnd;
          let minDiff = thresholdFrames;

          const snapCandidates = [0, this.getDurationFrames(), this.currentFrame];
          // Add start and end frames of active generation range
          snapCandidates.push(this.getStartFrames());
          if (this.endFramesWidget && this.endFramesWidget.value !== undefined) {
            snapCandidates.push(parseInt(this.endFramesWidget.value, 10));
          }
          const allTracks = [
            this.timeline.segments || [],
            this.timeline.motionSegments || [],
            this.timeline.audioSegments || []
          ];
          const ignoreSegmentIds = [String(this._dragTargetId)];
          const isVid = String(this._dragTargetId).endsWith("_v");
          const isAud = String(this._dragTargetId).endsWith("_a");
          if (isVid || isAud) {
            const siblingId = isVid ? String(this._dragTargetId).slice(0, -2) + "_a" : String(this._dragTargetId).slice(0, -2) + "_v";
            ignoreSegmentIds.push(siblingId);
          }

          for (const track of allTracks) {
            for (const seg of track) {
              if (ignoreSegmentIds.includes(String(seg.id))) continue;
              snapCandidates.push(seg.start);
              snapCandidates.push(seg.start + seg.length);
            }
          }

          for (const candidate of snapCandidates) {
            const diff = Math.abs(targetEnd - candidate);
            if (diff < minDiff) {
              minDiff = diff;
              bestEnd = candidate;
            }
          }
          newLen = bestEnd - t[targetIdx].start;
          dragDelta = newLen - t[targetIdx].length;
        }
        let maxPossibleLength = totalFrames - t[targetIdx].start;
        let nextSeg = t.find(s => s.start >= t[targetIdx].start + t[targetIdx].length && s.id !== t[targetIdx].id);
        if (nextSeg) {
          maxPossibleLength = nextSeg.start - t[targetIdx].start;
        }

        // Check sibling track obstacles if linked
        const isVid = String(this._dragTargetId).endsWith("_v");
        const isAud = String(this._dragTargetId).endsWith("_a");
        const siblingId = (isVid || isAud) ? (isVid ? String(this._dragTargetId).slice(0, -2) + "_a" : String(this._dragTargetId).slice(0, -2) + "_v") : null;
        if (siblingId && this._dragInitialSiblingTimeline) {
          let nextSibSeg = this._dragInitialSiblingTimeline.find(s => s.start >= t[targetIdx].start + t[targetIdx].length && s.id !== siblingId);
          if (nextSibSeg) {
            let sibMaxPossible = nextSibSeg.start - t[targetIdx].start;
            maxPossibleLength = Math.min(maxPossibleLength, sibMaxPossible);
          }
        }

        if (this.selectionType === "audio" || t[targetIdx].type === "video" || t[targetIdx].type === "motion_video") {
          const origDur = t[targetIdx].audioDurationFrames || t[targetIdx].videoDurationFrames || t[targetIdx].length;
          maxPossibleLength = Math.min(maxPossibleLength, origDur - (t[targetIdx].trimStart || 0));
        }

        t[targetIdx].length = Math.max(MIN_SEGMENT_LENGTH, Math.min(newLen, maxPossibleLength));

      } else if (this._dragType === "left") {
        let newStart = t[targetIdx].start + dragDelta;
        if (this.isSnapping) {
          const thresholdFrames = (15 / logicalWidth) * totalFrames;
          let bestStart = newStart;
          let minDiff = thresholdFrames;

          const snapCandidates = [0, this.getDurationFrames(), this.currentFrame];
          // Add start and end frames of active generation range
          snapCandidates.push(this.getStartFrames());
          if (this.endFramesWidget && this.endFramesWidget.value !== undefined) {
            snapCandidates.push(parseInt(this.endFramesWidget.value, 10));
          }
          const allTracks = [
            this.timeline.segments || [],
            this.timeline.motionSegments || [],
            this.timeline.audioSegments || []
          ];
          const ignoreSegmentIds = [String(this._dragTargetId)];
          const isVid = String(this._dragTargetId).endsWith("_v");
          const isAud = String(this._dragTargetId).endsWith("_a");
          if (isVid || isAud) {
            const siblingId = isVid ? String(this._dragTargetId).slice(0, -2) + "_a" : String(this._dragTargetId).slice(0, -2) + "_v";
            ignoreSegmentIds.push(siblingId);
          }

          for (const track of allTracks) {
            for (const seg of track) {
              if (ignoreSegmentIds.includes(String(seg.id))) continue;
              snapCandidates.push(seg.start);
              snapCandidates.push(seg.start + seg.length);
            }
          }

          for (const candidate of snapCandidates) {
            const diff = Math.abs(newStart - candidate);
            if (diff < minDiff) {
              minDiff = diff;
              bestStart = candidate;
            }
          }
          newStart = bestStart;
          dragDelta = newStart - t[targetIdx].start;
        }
        let minPossibleStart = 0;
        let prevSeg = t.slice().reverse().find(s => s.start + s.length <= t[targetIdx].start && s.id !== t[targetIdx].id);
        if (prevSeg) {
          minPossibleStart = prevSeg.start + prevSeg.length;
        }

        // Check sibling track obstacles if linked
        const isVid = String(this._dragTargetId).endsWith("_v");
        const isAud = String(this._dragTargetId).endsWith("_a");
        const siblingId = (isVid || isAud) ? (isVid ? String(this._dragTargetId).slice(0, -2) + "_a" : String(this._dragTargetId).slice(0, -2) + "_v") : null;
        if (siblingId && this._dragInitialSiblingTimeline) {
          let prevSibSeg = this._dragInitialSiblingTimeline.slice().reverse().find(s => s.start + s.length <= t[targetIdx].start && s.id !== siblingId);
          if (prevSibSeg) {
            let sibMinPossible = prevSibSeg.start + prevSibSeg.length;
            minPossibleStart = Math.max(minPossibleStart, sibMinPossible);
          }
        }

        if (this.selectionType === "audio" || t[targetIdx].type === "video" || t[targetIdx].type === "motion_video") {
          minPossibleStart = Math.max(minPossibleStart, t[targetIdx].start - (t[targetIdx].trimStart || 0));
        }

        let maxStart = t[targetIdx].start + t[targetIdx].length - MIN_SEGMENT_LENGTH;
        newStart = Math.max(minPossibleStart, Math.min(newStart, maxStart));

        let diff = newStart - t[targetIdx].start;
        t[targetIdx].start = newStart;
        t[targetIdx].length -= diff;
        if (this.selectionType === "audio" || t[targetIdx].type === "video" || t[targetIdx].type === "motion_video") {
          t[targetIdx].trimStart += diff;
        }

      } else if (this._dragType === "center") {
        let initT = this._dragInitialTimeline;
        let dIdx = initT.findIndex(s => s.id === this._dragTargetId);
        if (dIdx < 0) return;
        let D = { ...initT[dIdx] };

        let D_mouse_start = D.start + dragDelta;
        let mouseFrameX = mouseX * (totalFrames / logicalWidth);

        if (this.isSnapping) {
          const thresholdFrames = (15 / logicalWidth) * totalFrames;
          let bestStart = D_mouse_start;
          let minDiff = thresholdFrames;

          const snapCandidates = [0, this.getDurationFrames(), this.currentFrame];
          // Add start and end frames of active generation range
          snapCandidates.push(this.getStartFrames());
          if (this.endFramesWidget && this.endFramesWidget.value !== undefined) {
            snapCandidates.push(parseInt(this.endFramesWidget.value, 10));
          }
          const allTracks = [
            this.timeline.segments || [],
            this.timeline.motionSegments || [],
            this.timeline.audioSegments || []
          ];
          const ignoreSegmentIds = [String(this._dragTargetId)];
          const isVid = String(this._dragTargetId).endsWith("_v");
          const isAud = String(this._dragTargetId).endsWith("_a");
          if (isVid || isAud) {
            const siblingId = isVid ? String(this._dragTargetId).slice(0, -2) + "_a" : String(this._dragTargetId).slice(0, -2) + "_v";
            ignoreSegmentIds.push(siblingId);
          }

          for (const track of allTracks) {
            for (const seg of track) {
              if (ignoreSegmentIds.includes(String(seg.id))) continue;
              snapCandidates.push(seg.start);
              snapCandidates.push(seg.start + seg.length);
            }
          }

          for (const candidate of snapCandidates) {
            // Check start snap
            const diffStart = Math.abs(D_mouse_start - candidate);
            if (diffStart < minDiff) {
              minDiff = diffStart;
              bestStart = candidate;
            }
            // Check end snap
            const diffEnd = Math.abs((D_mouse_start + D.length) - candidate);
            if (diffEnd < minDiff) {
              minDiff = diffEnd;
              bestStart = candidate - D.length;
            }
          }
          const rawStart = D_mouse_start;
          D_mouse_start = bestStart;
          const snapOffset = D_mouse_start - rawStart;
          dragDelta = D_mouse_start - D.start;
          mouseFrameX += snapOffset;
        }

        t = this._applyCenterDragPhysics(initT, D.id, D_mouse_start, mouseFrameX, durationFrames, totalFrames, logicalWidth);

        if (this._dragInitialSiblingTimeline) {
          let siblingPhysics = null;

          if (this._dragTargetId.endsWith("_v") || this._dragTargetId.endsWith("_a")) {
            const isVid = this._dragTargetId.endsWith("_v");
            const siblingId = isVid ? this._dragTargetId.slice(0, -2) + "_a" : this._dragTargetId.slice(0, -2) + "_v";
            siblingPhysics = this._applyCenterDragPhysics(this._dragInitialSiblingTimeline, siblingId, D_mouse_start, mouseFrameX, durationFrames, totalFrames, logicalWidth);

            // Ensure initial sync for the dragged segment so the solver starts from a good state
            const activeFinal = t.find(s => s.id === this._dragTargetId);
            const siblingFinal = siblingPhysics.find(s => s.id === siblingId);

            if (activeFinal && siblingFinal && activeFinal.start !== siblingFinal.start) {
              const origStart = D.start;
              const activeDelta = Math.abs(activeFinal.start - origStart);
              const siblingDelta = Math.abs(siblingFinal.start - origStart);
              const finalStart = activeDelta < siblingDelta ? activeFinal.start : siblingFinal.start;

              const finalMouseX = finalStart + D.length / 2;
              t = this._applyCenterDragPhysics(initT, D.id, finalStart, finalMouseX, durationFrames, totalFrames, logicalWidth, true);
              siblingPhysics = this._applyCenterDragPhysics(this._dragInitialSiblingTimeline, siblingId, finalStart, finalMouseX, durationFrames, totalFrames, logicalWidth, true);
            }
          } else {
            siblingPhysics = this._dragInitialSiblingTimeline.map(s => ({ ...s }));
          }

          // Resolve all secondary pushes to keep linked clips together
          this._resolveGlobalPhysics(t, siblingPhysics, durationFrames, initT, this._dragInitialSiblingTimeline);
          this._previewSiblingSegments = siblingPhysics;
        }
      }
    }

    const targetArray = this.getSegmentArray(this.selectionType);
    this._restoreTransientProperties(t, targetArray);

    if (this._dragType === "left") {
      this._liveScrubVideo(t.find(s => s.id === this._dragTargetId), "start");
    } else if (this._dragType === "right") {
      this._liveScrubVideo(t.find(s => s.id === this._dragTargetId), "end");
    } else if (this._dragType === "joint") {
      this._liveScrubVideo(t.find(s => s.id === this._dragTargetId), "end");
      this._liveScrubVideo(t.find(s => s.id === this._dragTargetIdRight), "start");
    }

    const syncSibling = (targetId, activeArray) => {
      if (!targetId || this._dragType === "center") return; // Center drag handles physics separately above
      const isVid = targetId.endsWith("_v");
      const isAud = targetId.endsWith("_a");
      if (!isVid && !isAud) return;

      const siblingId = isVid ? targetId.slice(0, -2) + "_a" : targetId.slice(0, -2) + "_v";
      if (!this._previewSiblingSegments) {
        this._previewSiblingSegments = this._dragInitialSiblingTimeline.map(s => ({ ...s }));
      }
      const sibling = this._previewSiblingSegments.find(s => s.id === siblingId);
      const active = activeArray.find(s => s.id === targetId);

      if (sibling && active) {
        sibling.start = active.start;
        sibling.length = active.length;
        if (active.trimStart !== undefined) sibling.trimStart = active.trimStart;
      }
    };

    syncSibling(this._dragTargetId, t);
    if (this._dragType === "joint") syncSibling(this._dragTargetIdRight, t);

    this._previewSegments = t;

    if (this._previewSiblingSegments) {
      let siblingArray = null;
      if (this.selectionType === "audio") siblingArray = this.timeline.segments;
      else if (this.selectionType === "image") siblingArray = this.timeline.audioSegments;
      if (siblingArray) {
        this._restoreTransientProperties(this._previewSiblingSegments, siblingArray);
      }
    }

    this.updateUIFromSelection(); // Live update of trim values
    this.render();
  }

  _applyCenterDragPhysics(initT, D_id, D_mouse_start, mouseFrameX, durationFrames, totalFrames, logicalWidth, forceStart = false) {
    let t_copy = initT.map(s => ({ ...s }));
    let dIdx = t_copy.findIndex(s => s.id === D_id);
    if (dIdx < 0) return t_copy;

    let D = t_copy[dIdx];
    let D_clamped_start = clamp(D_mouse_start, 0, durationFrames - D.length);

    let baseSegments = t_copy.filter(s => s.id !== D.id);

    let insertIdx = baseSegments.length;
    for (let i = 0; i < baseSegments.length; i++) {
      let centerBase = baseSegments[i].start + baseSegments[i].length / 2;
      if (mouseFrameX < centerBase) {
        insertIdx = i;
        break;
      }
    }

    if (!forceStart) {
      let leftBound = insertIdx > 0 ? baseSegments[insertIdx - 1].start + baseSegments[insertIdx - 1].length : 0;
      let rightBound = insertIdx < baseSegments.length ? baseSegments[insertIdx].start : durationFrames;

      if (rightBound - leftBound >= D.length) {
        D_clamped_start = clamp(D_clamped_start, leftBound, rightBound - D.length);
      } else {
        let gapCenter = (leftBound + rightBound) / 2;
        D_clamped_start = gapCenter - D.length / 2;
      }
    }

    let t_test = [];
    for (let i = 0; i < insertIdx; i++) {
      t_test.push({ ...baseSegments[i], original_start: baseSegments[i].start });
    }
    t_test.push({ ...D, start: D_clamped_start, original_start: D_clamped_start });
    let D_index = insertIdx;

    for (let i = insertIdx; i < baseSegments.length; i++) {
      t_test.push({ ...baseSegments[i], original_start: baseSegments[i].start });
    }

    for (let i = D_index + 1; i < t_test.length; i++) {
      let prev = t_test[i - 1];
      t_test[i].start = Math.max(t_test[i].original_start, prev.start + prev.length);
    }

    for (let i = D_index - 1; i >= 0; i--) {
      let next = t_test[i + 1];
      t_test[i].start = Math.min(t_test[i].original_start, next.start - t_test[i].length);
    }

    let rightCursor = durationFrames;
    for (let i = t_test.length - 1; i >= 0; i--) {
      if (t_test[i].start + t_test[i].length > rightCursor) {
        t_test[i].start = rightCursor - t_test[i].length;
      }
      rightCursor = t_test[i].start;
    }
    let leftCursor = 0;
    for (let i = 0; i < t_test.length; i++) {
      if (t_test[i].start < leftCursor) {
        t_test[i].start = leftCursor;
      }
      leftCursor = t_test[i].start + t_test[i].length;
    }

    let result = t_test.map(s => {
      let clean = { ...s };
      delete clean.original_start;
      return clean;
    });

    let draggedPreview = result.find(s => s.id === D.id);
    if (draggedPreview) {
      draggedPreview.resolvedStart = draggedPreview.start;
    }

    return result;
  }

  _resolveGlobalPhysics(activeTimeline, siblingTimeline, durationFrames, activeInitial, siblingInitial) {
    if (!siblingTimeline) return;

    let changed = true;
    let iters = 0;
    while (changed && iters < 10) {
      changed = false;
      iters++;

      let syncedActiveIndices = [];
      let syncedSiblingIndices = [];

      // 1. Sync linked clips
      for (let i = 0; i < activeTimeline.length; i++) {
        let seg = activeTimeline[i];
        if (seg.id.endsWith("_v") || seg.id.endsWith("_a")) {
          const isVid = seg.id.endsWith("_v");
          const sibId = isVid ? seg.id.slice(0, -2) + "_a" : seg.id.slice(0, -2) + "_v";
          let sibIndex = siblingTimeline.findIndex(s => s.id === sibId);

          if (sibIndex >= 0) {
            let sib = siblingTimeline[sibIndex];
            if (sib.start !== seg.start) {
              let origStart = seg.start;
              if (activeInitial) {
                const origSeg = activeInitial.find(s => s.id === seg.id);
                if (origSeg) origStart = origSeg.start;
              }

              let sibOrigStart = sib.start;
              if (siblingInitial) {
                const origSib = siblingInitial.find(s => s.id === sib.id);
                if (origSib) sibOrigStart = origSib.start;
              }

              const dSeg = Math.abs(seg.start - origStart);
              const dSib = Math.abs(sib.start - sibOrigStart);

              // The segment that was pushed furthest dictates the new position
              const targetStart = dSeg > dSib ? seg.start : sib.start;

              if (seg.start !== targetStart) {
                seg.start = targetStart;
                changed = true;
                syncedActiveIndices.push(i);
              }
              if (sib.start !== targetStart) {
                sib.start = targetStart;
                changed = true;
                syncedSiblingIndices.push(sibIndex);
              }
            }
          }
        }
      }

      // 2. Resolve overlaps on both tracks by pushing outward from epicenters
      if (changed) {
        const sweepTrack = (track, epicenterIndices) => {
          let didChange = false;

          for (let epIndex of epicenterIndices) {
            // Push elements to the right of the epicenter
            for (let i = epIndex + 1; i < track.length; i++) {
              let prev = track[i - 1];
              let targetStart = prev.start + prev.length;
              if (track[i].start < targetStart) {
                track[i].start = targetStart;
                didChange = true;
              }
            }
            // Push elements to the left of the epicenter
            for (let i = epIndex - 1; i >= 0; i--) {
              let next = track[i + 1];
              let targetStart = next.start - track[i].length;
              if (track[i].start > targetStart) {
                track[i].start = targetStart;
                didChange = true;
              }
            }
          }

          // Boundary clamping to ensure nothing falls off the edges
          let rightCursor = durationFrames;
          for (let i = track.length - 1; i >= 0; i--) {
            if (track[i].start + track[i].length > rightCursor) {
              let newStart = rightCursor - track[i].length;
              if (track[i].start !== newStart) { track[i].start = newStart; didChange = true; }
            }
            rightCursor = track[i].start;
          }

          let leftCursor = 0;
          for (let i = 0; i < track.length; i++) {
            if (track[i].start < leftCursor) {
              let newStart = leftCursor;
              if (track[i].start !== newStart) { track[i].start = newStart; didChange = true; }
            }
            leftCursor = track[i].start + track[i].length;
          }
          return didChange;
        };

        sweepTrack(activeTimeline, syncedActiveIndices);
        sweepTrack(siblingTimeline, syncedSiblingIndices);
      }
    }
  }

  _restoreTransientProperties(copiedSegs, originalSegs) {
    if (!copiedSegs || !originalSegs) return;
    for (let ps of copiedSegs) {
      const orig = originalSegs.find(s => s.id === ps.id);
      if (orig) {
        if (orig._uploading !== undefined) ps._uploading = orig._uploading;
        if (orig._decoding !== undefined) ps._decoding = orig._decoding;
        if (orig._blobUrl !== undefined) ps._blobUrl = orig._blobUrl;
        if (orig._audioBuffer !== undefined) ps._audioBuffer = orig._audioBuffer;
        if (orig.imgObj !== undefined) ps.imgObj = orig.imgObj;
        if (orig.videoEl !== undefined) ps.videoEl = orig.videoEl;
        if (orig.thumbnails !== undefined) ps.thumbnails = orig.thumbnails;
        if (orig._extractingThumbs !== undefined) ps._extractingThumbs = orig._extractingThumbs;
      }
    }
  }

  onMouseUp(e) {
    document.body.style.userSelect = "";
    document.body.style.cursor = "";

    if (e.button === 2 && this.retakeMode) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (this.retakeMode) {
      if (this._isDragging) {
        const wasPlayheadDrag = this._dragType === "playhead";
        const wasPlaying = this._retakeScrubWasPlaying;
        this._retakeScrubWasPlaying = false;
        if (this.timeline.retakeVideo && this.timeline.retakeVideo._scrubTargetSec !== undefined) {
          if (this.timeline.retakeVideo.videoEl) {
            this.timeline.retakeVideo.videoEl.currentTime = this.timeline.retakeVideo._scrubTargetSec;
          }
          delete this.timeline.retakeVideo._scrubTargetSec;
        }
        this._isDragging = false;
        this._dragType = null;
        this.canvas.style.cursor = "default";
        this.commitChanges();
        // If playback was active before the scrub, resume from the new scrub position
        if (wasPlayheadDrag && wasPlaying) {
          this.playAudio();
        } else {
          this.render();
        }
      }
      return;
    }

    // Commit scrub target to actual video element so it's ready for playback
    const commitScrub = (segs) => {
      if (!segs) return;
      for (const seg of segs) {
        if (seg._scrubTargetSec !== undefined) {
          if (seg.videoEl) seg.videoEl.currentTime = seg._scrubTargetSec;
          delete seg._scrubTargetSec;
        }
      }
    };

    commitScrub(this.timeline.segments);
    commitScrub(this.timeline.motionSegments);
    commitScrub(this._previewSegments);
    commitScrub(this._previewSiblingSegments);
    if (this._multiDragPreviewTimelines) {
      commitScrub(this._multiDragPreviewTimelines.image);
      commitScrub(this._multiDragPreviewTimelines.motion);
    }

    if (this._isDragging) {
      if (this._dragType === "box_select") {
        this._isSelectingBox = false;
        this._selectBoxStart = null;
        this._selectBoxCurrent = null;
        this._selectBoxInitialSelectedIds = null;
        this._isDragging = false;
        this.canvas.style.cursor = "default";
        this.updateUIFromSelection();
        this.render();
        this.commitChanges();
        return;
      }

      if (this._multiDragPreviewTimelines) {
        if (this._multiDragPreviewTimelines.image) {
          this.timeline.segments = this._multiDragPreviewTimelines.image.map(ps => {
            const orig = this.timeline.segments.find(s => s.id === ps.id);
            if (orig) {
              if (orig.imgObj) ps.imgObj = orig.imgObj;
              if (orig.videoEl) ps.videoEl = orig.videoEl;
              if (orig.thumbnails) ps.thumbnails = orig.thumbnails;
              if (orig._extractingThumbs !== undefined) ps._extractingThumbs = orig._extractingThumbs;
              if (orig._uploading !== undefined) ps._uploading = orig._uploading;
              if (orig._decoding !== undefined) ps._decoding = orig._decoding;
              if (orig._blobUrl !== undefined) ps._blobUrl = orig._blobUrl;
              if (orig._audioBuffer !== undefined) ps._audioBuffer = orig._audioBuffer;
            }
            return ps;
          });
        }
        if (this._multiDragPreviewTimelines.motion) {
          this.timeline.motionSegments = this._multiDragPreviewTimelines.motion.map(ps => {
            const orig = this.timeline.motionSegments.find(s => s.id === ps.id);
            if (orig) {
              if (orig.imgObj) ps.imgObj = orig.imgObj;
              if (orig.videoEl) ps.videoEl = orig.videoEl;
              if (orig.thumbnails) ps.thumbnails = orig.thumbnails;
              if (orig._extractingThumbs !== undefined) ps._extractingThumbs = orig._extractingThumbs;
              if (orig._uploading !== undefined) ps._uploading = orig._uploading;
              if (orig._decoding !== undefined) ps._decoding = orig._decoding;
              if (orig._blobUrl !== undefined) ps._blobUrl = orig._blobUrl;
              if (orig._audioBuffer !== undefined) ps._audioBuffer = orig._audioBuffer;
            }
            return ps;
          });
        }
        if (this._multiDragPreviewTimelines.audio) {
          this.timeline.audioSegments = this._multiDragPreviewTimelines.audio.map(ps => {
            const orig = this.timeline.audioSegments.find(s => s.id === ps.id);
            if (orig) {
              if (orig.imgObj) ps.imgObj = orig.imgObj;
              if (orig.videoEl) ps.videoEl = orig.videoEl;
              if (orig.thumbnails) ps.thumbnails = orig.thumbnails;
              if (orig._extractingThumbs !== undefined) ps._extractingThumbs = orig._extractingThumbs;
              if (orig._uploading !== undefined) ps._uploading = orig._uploading;
              if (orig._decoding !== undefined) ps._decoding = orig._decoding;
              if (orig._blobUrl !== undefined) ps._blobUrl = orig._blobUrl;
              if (orig._audioBuffer !== undefined) ps._audioBuffer = orig._audioBuffer;
            }
            return ps;
          });
        }
        this._multiDragPreviewTimelines = null;
      } else if (this._previewSegments) {
        const targetArray = this.getSegmentArray(this.selectionType);

        const mappedArray = this._previewSegments.map(ps => {
          const orig = targetArray.find(s => s.id === ps.id);
          let finalStart = ps.resolvedStart !== undefined ? ps.resolvedStart : ps.start;
          let newPs = { ...ps, start: finalStart };
          if (orig) {
            if (orig.imgObj) newPs.imgObj = orig.imgObj;
            if (orig.videoEl) newPs.videoEl = orig.videoEl;
            if (orig.thumbnails) newPs.thumbnails = orig.thumbnails;
            if (orig._extractingThumbs !== undefined) newPs._extractingThumbs = orig._extractingThumbs;
            if (orig._uploading !== undefined) newPs._uploading = orig._uploading;
            if (orig._decoding !== undefined) newPs._decoding = orig._decoding;
            if (orig._blobUrl !== undefined) newPs._blobUrl = orig._blobUrl;
            if (orig._audioBuffer !== undefined) newPs._audioBuffer = orig._audioBuffer;
          }
          delete newPs.resolvedStart;
          return newPs;
        });

        if (this.selectionType === "audio") {
          this.timeline.audioSegments = mappedArray;
          if (this._dragTargetId) this.selectedIndex = this.timeline.audioSegments.findIndex(s => s.id === this._dragTargetId);
        } else if (this.selectionType === "motion") {
          this.timeline.motionSegments = mappedArray;
          if (this._dragTargetId) this.selectedIndex = this.timeline.motionSegments.findIndex(s => s.id === this._dragTargetId);
        } else {
          this.timeline.segments = mappedArray;
          if (this._dragTargetId) this.selectedIndex = this.timeline.segments.findIndex(s => s.id === this._dragTargetId);
        }
      }

      if (this._previewSiblingSegments) {
        let siblingArray = null;
        if (this.selectionType === "audio") siblingArray = this.timeline.segments;
        else if (this.selectionType === "image") siblingArray = this.timeline.audioSegments;

        if (siblingArray) {
          const mappedSibling = this._previewSiblingSegments.map(ps => {
            const orig = siblingArray.find(s => s.id === ps.id);
            let finalStart = ps.resolvedStart !== undefined ? ps.resolvedStart : ps.start;
            let newPs = { ...ps, start: finalStart };
            if (orig) {
              if (orig.imgObj) newPs.imgObj = orig.imgObj;
              if (orig.videoEl) newPs.videoEl = orig.videoEl;
              if (orig.thumbnails) newPs.thumbnails = orig.thumbnails;
              if (orig._extractingThumbs !== undefined) newPs._extractingThumbs = orig._extractingThumbs;
              if (orig._uploading !== undefined) newPs._uploading = orig._uploading;
              if (orig._decoding !== undefined) newPs._decoding = orig._decoding;
              if (orig._blobUrl !== undefined) newPs._blobUrl = orig._blobUrl;
              if (orig._audioBuffer !== undefined) newPs._audioBuffer = orig._audioBuffer;
            }
            delete newPs.resolvedStart;
            return newPs;
          });

          if (this.selectionType === "audio") this.timeline.segments = mappedSibling;
          else if (this.selectionType === "image") this.timeline.audioSegments = mappedSibling;
        }
      }

      if (this._multiDragClickPendingDeselect && !this._isMultiDraggingAndMoved) {
        const clickedId = this._multiDragClickPendingDeselect;
        this.selectedSegmentIds = [clickedId];
        const sibId = clickedId.endsWith("_v") ? clickedId.slice(0, -2) + "_a" : (clickedId.endsWith("_a") ? clickedId.slice(0, -2) + "_v" : null);
        if (sibId && !this.selectedSegmentIds.includes(sibId)) this.selectedSegmentIds.push(sibId);

        let foundIdx = -1;
        let foundTrack = "image";
        for (const track of ["image", "motion", "audio"]) {
          const arr = this.getSegmentArray(track);
          const idx = arr.findIndex(s => s.id === clickedId);
          if (idx !== -1) {
            foundIdx = idx;
            foundTrack = track;
            break;
          }
        }
        if (foundIdx !== -1) {
          this.selectionType = foundTrack;
          this.selectedIndex = foundIdx;
        }
        this.updateUIFromSelection();
      }

      this._isDragging = false;
      this._previewSegments = null;
      this._previewSiblingSegments = null;
      this._ghostTrack = null;
      this._isMultiDraggingAndMoved = false;
      this._multiDragClickPendingDeselect = null;
      this._multiDragInitialSegments = null;
      this._multiDragPreviewTimelines = null;
      this.canvas.style.cursor = "default";
      this.commitChanges();
    }
  }

  // --- Backend Data Sync ---
  // --- Visual Character Reference Slots ---
  // The slots hold <Subject N> definitions, which the guide says may be "people, animals,
  // or objects; scenes, backgrounds, or environments; clothing, props, interfaces, or
  // visual effects; styles, actions, expressions, or poses" — not only characters. The
  // class names still say "character" because they are shared with a lot of CSS and with
  // the LTX editor this was forked from; the data key is `subjects`.
  subjectSlots() {
    if (!Array.isArray(this.timeline.subjects)) {
      this.timeline.subjects = normaliseSubjectSlots(
        this.timeline.subjects || this.timeline.characters);
    }
    return this.timeline.subjects;
  }

  // Dragged from the strip under the panel and remembered per node, exactly like
  // propHeight and globalPropHeight. Clamped on read so a workflow saved when the slot
  // was a fixed 148px does not come back too short for the two text boxes.
  subjectSlotHeight() {
    const stored = this.node?.properties?.subjectSlotHeight;
    return Math.max(SUBJECT_SLOT_MIN_H, stored || SUBJECT_SLOT_DEFAULT_H);
  }

  // Shown only on the ref2va path, where `summary` is a section of the prompt.
  _syncSummaryField() {
    if (!this.summaryField) return;
    const refsOn = String(this.timeline.reference_mode || "OFF").toUpperCase() !== "OFF";
    this.summaryField.style.display = refsOn ? "" : "none";
  }

  // Which slot is which `<Subject N>` is the planner's answer, taken from the last compile
  // rather than worked out again here: only slots that hand over a reference image are
  // numbered, so slot 2 is <Subject 1> when slot 1 is empty, and a menu that counted slots
  // named a subject the prompt did not have.
  //
  // A slot with no number has no label for a clip to be tied to — its description goes into
  // the prose instead — so it is offered as unavailable, with the reason, rather than
  // taking the click and doing nothing with it.
  _audioSubjectOptions(seg) {
    const subjectOfSlot = this.node?._mmxSubjectOfSlot;
    const refsOn = String(this.timeline.reference_mode || "OFF").toUpperCase() !== "OFF";
    return ['<option value="">— not a specific subject —</option>'].concat(
      this.subjectSlots().map((c, i) => {
        const desc = escapeAttr((c.description || "").trim().slice(0, 40));
        const tail = desc ? ` — ${desc}` : "";
        const sel = String(seg.subject || "") === String(i + 1) ? " selected" : "";
        const subject = subjectOfSlot?.[String(i + 1)];
        if (subject) {
          return `<option value="${i + 1}"${sel}>Subject ${subject}${tail}</option>`;
        }
        // No compile has answered yet: say nothing rather than guess a number
        if (!subjectOfSlot) {
          return `<option value="${i + 1}"${sel}>Slot ${i + 1}${tail}</option>`;
        }
        const why = !refsOn ? "Refs OFF sends no references"
          : (c.images && c.images.length) ? "not among the references sent"
          : "needs a reference image";
        return `<option value="" disabled${sel}>Slot ${i + 1}${tail} — ${why}</option>`;
      })).join("");
  }

  // The menu is built when a clip is selected, but what it says depends on the panel above
  // it: drop an image into a slot and that slot becomes bindable, delete one and it stops.
  // Only the options are replaced, so the `change` listener on the <select> survives — and
  // not while it has focus, which would shut an open menu under the pointer.
  refreshAudioSubjectMenu() {
    if (this.selectionType !== "audio") return;
    const sel = this.audioInfoArea?.querySelector(".mmxd-audio-subject");
    if (!sel || document.activeElement === sel) return;
    const seg = this.timeline.audioSegments?.[this.selectedIndex];
    if (!seg) return;
    sel.innerHTML = this._audioSubjectOptions(seg);
  }

  // The stepper owns this number and nothing else writes it. It used to grow on its own as
  // slots filled, which meant the value beside the buttons moved without anyone pressing
  // them — and `−` needed a two-stage rule to work around its own panel putting the slot
  // straight back. One owner, one meaning.
  visibleSlotCount() {
    return clampSubjectSlots(this.timeline.subjectSlotCount);
  }

  _buildSubjectSlotEl(i) {
    const slot = document.createElement("div");
    slot.className = "mmxd-character-slot";
    slot.dataset.index = i;

    slot.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      slot.classList.add("drag-over");
    });
    slot.addEventListener("dragleave", (e) => {
      e.stopPropagation();
      slot.classList.remove("drag-over");
    });
    slot.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      slot.classList.remove("drag-over");
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        Array.from(e.dataTransfer.files).forEach(f => (f.type || "").startsWith("audio/")
          ? this.handleSubjectVoiceUpload(f, i)
          : this.handleCharacterImageUpload(f, i));
      }
    });
    slot.addEventListener("click", (e) => {
      // clicking anywhere else in the slot opens a file picker, so every interactive
      // child has to be named here — including the field wrappers, whose border and
      // caption are part of the box the user is aiming at
      if (e.target.closest(".mmxd-character-delete") ||
          e.target.closest(".mmxd-character-validate-btn") ||
          e.target.closest(".mmxd-character-field") ||
          e.target.closest(".mmxd-character-desc") ||
          e.target.closest(".mmxd-voice-row") ||
          e.target.closest(".mmxd-msel")) return;

      const fi = document.createElement("input");
      fi.type = "file";
      fi.accept = "image/*";
      fi.multiple = true;
      fi.addEventListener("change", (ev) => {
        if (ev.target.files) {
          Array.from(ev.target.files).forEach(f => this.handleCharacterImageUpload(f, i));
        }
      });
      fi.click();
    });
    return slot;
  }

  createCharacterSlots(parent) {
    const wrap = document.createElement("div");
    wrap.style.position = "relative";
    wrap.style.width = "100%";
    wrap.style.flexShrink = "0";

    const container = document.createElement("div");
    container.className = "mmxd-characters-container";

    this.subjectSlots();

    this.characterSlots = [];
    this._charPanelParent = parent;
    this._charPanelContainerEl = container;

    wrap.appendChild(this._buildSubjectStepper());
    wrap.appendChild(container);
    wrap.appendChild(this._buildSubjectResizer());
    parent.appendChild(wrap);
    this.charPanelContainer = container;
    this.charPanelHeight = subjectPanelHeight(3, this.subjectSlotHeight());
    this.updateCharacterSlotsUI();
  }

  // Its own row above the slots, not a flex item among them: the container wraps three
  // slots to a line and subjectPanelHeight counts rows, so a stepper sitting in that flow
  // would push a slot onto a line the reserved height does not know about.
  _buildSubjectStepper() {
    const stepper = document.createElement("div");
    stepper.className = "mmxd-character-stepper";

    const mkBtn = (label, title, onClick) => {
      const b = document.createElement("button");
      b.className = "mmxd-character-step-btn";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
      return b;
    };
    const redraw = () => {
      this.updateCharacterSlotsUI();
      this.commitChanges(true);
    };

    const count = document.createElement("span");
    count.className = "mmxd-character-step-count";
    this._charStepperRefresh = () => {
      const n = this.visibleSlotCount();
      count.textContent = `${n} subject${n === 1 ? "" : "s"}`;
    };

    stepper.appendChild(mkBtn("−", "One subject fewer — the last slot and its images go",
                              () => {
      const n = this.visibleSlotCount();
      if (n <= 1) return;
      // the slot goes with the count, or its images would sit in the timeline JSON with
      // nothing on screen to show them and no way to reach them again
      this.subjectSlots().splice(n - 1, 1);
      this.timeline.subjectSlotCount = n - 1;
      redraw();
    }));
    stepper.appendChild(count);
    stepper.appendChild(mkBtn("+", "One subject more", () => {
      const n = this.visibleSlotCount();
      if (n >= MAX_SUBJECT_SLOTS) return;
      this.timeline.subjectSlotCount = n + 1;
      redraw();
    }));
    return stepper;
  }

  // Same grab strip as the prompt and global-prompt panels, so the reference panel resizes
  // the way every other part of the editor already does. Only the slot height is stored;
  // the panel height follows from it and the row count.
  _buildSubjectResizer() {
    const bar = document.createElement("div");
    bar.style.position = "absolute";
    bar.style.bottom = "0px";
    bar.style.left = "0px";
    bar.style.width = "100%";
    bar.style.height = `${SUBJECT_RESIZER_H}px`;
    bar.style.cursor = "ns-resize";
    bar.style.display = "flex";
    bar.style.justifyContent = "center";
    bar.style.alignItems = "flex-end";
    bar.style.paddingBottom = "4px";
    bar.title = "Drag to resize the reference images";
    bar.innerHTML = `<div style="width: 40px; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px;"></div>`;

    bar.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startY = e.clientY;
      const startH = this.subjectSlotHeight();

      const doDrag = (ev) => {
        if (ev.buttons === 0) { stopDrag(); return; }
        // one row of slots follows the pointer 1:1; with two rows the panel grows twice
        // as fast as the drag, which is the same deal the other resizers make
        const newH = Math.max(SUBJECT_SLOT_MIN_H, startH + (ev.clientY - startY));
        if (this.node?.properties) this.node.properties.subjectSlotHeight = newH;
        this._applySubjectSlotHeight();
      };
      const stopDrag = () => {
        window.removeEventListener("mousemove", doDrag, true);
        window.removeEventListener("mouseup", stopDrag, true);
        document.body.style.cursor = "default";
        this.commitChanges(true);
      };

      document.body.style.cursor = "ns-resize";
      window.addEventListener("mousemove", doDrag, true);
      window.addEventListener("mouseup", stopDrag, true);
    });
    return bar;
  }

  // Pushes the dragged height onto every slot element and re-reserves the node's room.
  _applySubjectSlotHeight() {
    const h = this.subjectSlotHeight();
    (this.characterSlots || []).forEach((el) => { el.style.height = `${h}px`; });
    this.charPanelHeight = subjectPanelHeight(this.characterSlots?.length || 3, h);
    if (this.node?.setDirtyCanvas && typeof this.node.computeSize === "function"
        && this.node.size) {
      this.node.setSize([this.node.size[0], this.node.computeSize()[1]]);
      this.node.setDirtyCanvas(true, true);
    }
  }

  // Adds or removes slot elements so the DOM matches visibleSlotCount(). Called from
  // updateCharacterSlotsUI, which is the only entry point that redraws the panel.
  _syncSubjectSlotEls() {
    const container = this.charPanelContainer;
    if (!container) return;
    const want = this.visibleSlotCount();
    const slots = this.subjectSlots();
    while (slots.length < want) slots.push(emptySubjectSlot());
    const slotH = this.subjectSlotHeight();
    while (this.characterSlots.length < want) {
      const el = this._buildSubjectSlotEl(this.characterSlots.length);
      container.appendChild(el);
      this.characterSlots.push(el);
    }
    while (this.characterSlots.length > want) {
      this.characterSlots.pop().remove();
    }
    this.characterSlots.forEach((el) => { el.style.height = `${slotH}px`; });
    this._charStepperRefresh?.();

    // Slots wrap three to a row, so the panel's reserved height has to follow the row
    // count or the node crops the last row the moment a fourth subject is added.
    const height = subjectPanelHeight(want, slotH);
    const grew = height !== this.charPanelHeight;
    this.charPanelHeight = height;
    // Only once the panel has been through a full build: during construction the widget's
    // computeSize is not installed yet, so resizing here would size the node against a
    // panel height it does not know about — and would fight the size a saved workflow
    // restored. After that, this fires whenever a slot is gained or lost.
    if (grew && this._subjectPanelReady && this.node?.setDirtyCanvas
        && typeof this.node.computeSize === "function" && this.node.size) {
      this.node.setSize([this.node.size[0], this.node.computeSize()[1]]);
      this.node.setDirtyCanvas(true, true);
    }
    this._subjectPanelReady = true;
  }

  handleCharacterImageUpload(file, idx) {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const imgObj = new Image();
      imgObj.onload = async () => {
        const maxDim = 1920;
        let w = imgObj.width;
        let h = imgObj.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
          else { w = Math.round((w * maxDim) / h); h = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(imgObj, 0, 0, w, h);

        // Upload the downscaled reference to the input folder and store only its
        // filename. Embedding base64 in the timeline bloats the saved workflow; the
        // backend loads the file directly for both Analyze and Ghost/MSR.
        let stored = null;
        try {
          const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.95));
          const base = (file.name || "ref").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
          const upName = `mmxref_${base}_${Date.now()}.jpg`;
          const body = new FormData();
          body.append("image", new File([blob], upName, { type: "image/jpeg" }));
          body.append("subfolder", "whatdreamscost");
          const resp = await api.fetchApi("/upload/image", { method: "POST", body });
          if (resp.status === 200) {
            const data = await resp.json();
            const sf = data.subfolder || "";
            stored = { name: sf ? sf + "/" + data.name : data.name };
          }
        } catch (err) {
          console.error("[MiniMaxDirector] ref upload failed, embedding b64 as fallback:", err);
        }
        if (!stored) {
          stored = { b64: canvas.toDataURL("image/jpeg", 0.95), name: file.name };
        }

        const subjects = this.subjectSlots();
        while (subjects.length <= idx) subjects.push(emptySubjectSlot());
        if (!subjects[idx].images) subjects[idx].images = [];
        if (subjects[idx].images.length >= 2) subjects[idx].images.shift();
        subjects[idx].images.push(stored);
        this.updateCharacterSlotsUI();
        this.commitChanges();
      };
      imgObj.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  _refImageSrc(imgData) {
    if (!imgData) return "";
    if (imgData.b64) return imgData.b64;            // legacy embedded data / fallback
    if (imgData.name) {
      const parts = imgData.name.split("/");
      const fn = parts.pop();
      const sf = parts.join("/");
      return api.apiURL(`/view?filename=${encodeURIComponent(fn)}&type=input&subfolder=${encodeURIComponent(sf)}`);
    }
    return "";
  }

  async _refImageToB64(imgData) {
    if (!imgData) return null;
    if (imgData.b64) return imgData.b64;            // legacy embedded data
    const src = this._refImageSrc(imgData);
    if (!src) return null;
    try {
      const resp = await fetch(src);
      const blob = await resp.blob();
      return await new Promise((res) => {
        const r = new FileReader();
        r.onloadend = () => res(r.result);
        r.readAsDataURL(blob);
      });
    } catch (err) {
      console.error("[MiniMaxDirector] could not load ref image for analyze:", err);
      return null;
    }
  }

  updateCharacterSlotsUI() {
    if (!this.characterSlots) return;
    const subjects = this.subjectSlots();
    this._syncSubjectSlotEls();

    for (let i = 0; i < this.characterSlots.length; i++) {
      const slot = this.characterSlots[i];
      const data = subjects[i] || emptySubjectSlot();
      slot.innerHTML = "";

      // A subject is a description first and an image second. The image is what earns it
      // a <Subject N> label on the ref2va path; on fl2va the image is discarded by the
      // render and the description is the whole subject. So the text boxes are always
      // here, and only the controls that can actually reach the prompt come and go.
      const refsOn = String(this.timeline.reference_mode || "OFF").toUpperCase() !== "OFF";
      const hasImages = !!(data.images && data.images.length);

      if (hasImages) {
        const previewsRow = document.createElement("div");
        previewsRow.className = "mmxd-character-previews-row";
        if (!refsOn) {
          // kept, because switching the toolbar back must not cost the upload — but said
          // out loud, because fl2va sends no reference images at all
          previewsRow.style.opacity = "0.45";
          previewsRow.title = "Not sent on the fl2va path. Switch to 'Refs ON (ref2va)' "
                            + "to use this image; the description below is used either way.";
        }

        data.images.forEach((imgData, imgIdx) => {
          const imgWrapper = document.createElement("div");
          imgWrapper.className = "mmxd-character-preview-wrapper";

          const img = document.createElement("img");
          img.className = "mmxd-character-preview";
          img.src = this._refImageSrc(imgData);
          imgWrapper.appendChild(img);

          const delBtn = document.createElement("button");
          delBtn.className = "mmxd-character-delete";
          delBtn.innerHTML = ICONS.close;
          delBtn.title = "Delete Image";
          delBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (subjects[i] && subjects[i].images) {
              subjects[i].images.splice(imgIdx, 1);
              this.updateCharacterSlotsUI();
              this.commitChanges();
            }
          });
          imgWrapper.appendChild(delBtn);
          previewsRow.appendChild(imgWrapper);
        });

        const _provider = this.timeline.analyzeProvider || "ollama";
        if (_provider !== "off") {
          const valBtn = document.createElement("button");
          valBtn.className = "mmxd-character-validate-btn";
          valBtn.textContent = data.description ? "Re-Analyze" : "Analyze";
          valBtn.title = "Run multimodal analysis on the reference image(s)";
          valBtn.style.left = "50%";
          valBtn.style.transform = "translateX(-50%)";
          valBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.runGemmaAnalysis(i, valBtn);
          });
          previewsRow.appendChild(valBtn);
        }

        slot.appendChild(previewsRow);
      } else {
        // Still the drop target for the whole slot, but no longer the whole slot: it
        // flexes so the text boxes below it keep their fixed height.
        const zone = document.createElement("div");
        zone.className = "mmxd-character-dropzone";

        const label = document.createElement("div");
        label.className = "mmxd-character-label";
        label.textContent = `@ref${i + 1}`;

        const placeholder = document.createElement("div");
        placeholder.className = "mmxd-character-placeholder";
        placeholder.innerHTML = `${ICONS.upload}<br>Drop Sheet`;

        zone.appendChild(label);
        zone.appendChild(placeholder);
        slot.appendChild(zone);
      }

      {
        // Captioned boxes, because two bare textareas in one box say nothing about which
        // is which. Which ones appear is a question of what can reach the prompt:
        // `retained` and the markers only exist once the slot has a picture to declare on
        // the ref2va path, and `called` only matters where the subject has no <Subject N>
        // label and lives in the prose instead.
        const makeSlotField = (label, key, placeholder, first) => {
          const field = document.createElement("div");
          field.className = "mmxd-character-field" + (first ? " mmxd-field-first" : "");

          const cap = document.createElement("div");
          cap.className = "mmxd-character-field-label";
          cap.textContent = label;
          field.appendChild(cap);

          const area = document.createElement("textarea");
          area.className = "mmxd-character-desc";
          area.value = data[key] || "";
          area.placeholder = placeholder;
          area.spellcheck = true;
          area.addEventListener("input", () => {
            subjects[i][key] = area.value;
            this.commitChanges();
            if (this.node?._mmxRefreshPrompt) this.node._mmxRefreshPrompt();
          });
          area.addEventListener("focus", () => field.classList.add("focus-active"));
          area.addEventListener("blur", () => field.classList.remove("focus-active"));
          // the slot's own click handler opens a file picker unless the click lands on a
          // child it knows about
          area.addEventListener("click", (e) => { e.stopPropagation(); });
          field.appendChild(area);
          slot.appendChild(field);
          return area;
        };

        makeSlotField("describes", "description", "a woman in a red coat…", true);

        if (refsOn && hasImages) {
          makeSlotField("retained", "retentionNote",
                        "identity, face and clothing — leave empty for the default");
        } else {
          // No <Subject N> to name this by, so the guide's own habit applies: written out
          // in full where it first appears, then a short handle, or the same paragraph
          // of description walks in again every shot as somebody new.
          makeSlotField("called", "shortName",
                        "the baker — after the first mention");
        }

        // What this subject IS, and how closely to follow it. The kind only supplies a
        // noun for the definition line when no description is typed, so a description
        // always wins; the retention marker is written into retention_analysis verbatim.
        // Both are ref2va-only, and both need a picture behind them to be declared on.
        if (refsOn && hasImages) {
          const row = document.createElement("div");
          row.className = "mmxd-ref-controls";

          const kindSel = createMenuSelect(SUBJECT_KIND_OPTIONS, { width: "100%" });
          kindSel.value = data.kind || "person";
          kindSel.title = "What this subject is. A typed description replaces it.";
          kindSel.addEventListener("change", () => {
            subjects[i].kind = kindSel.value;
            this.commitChanges();
          });

          const retSel = createMenuSelect(RETENTION_OPTIONS, { width: "100%" });
          retSel.value = data.retention || "fully_preserved";
          retSel.title = RETENTION_TIP;
          retSel.addEventListener("change", () => {
            subjects[i].retention = retSel.value;
            this.commitChanges();
          });

          row.appendChild(kindSel);
          row.appendChild(retSel);
          slot.appendChild(row);
        }

        // The voice this subject speaks with. Refs ON only: fl2va has no audio input.
        // It is not on the timeline, so it is not bounded by the render window and takes no
        // output time; it is sent as an <Audio N> reference tied to this subject.
        if (refsOn) {
          const vrow = document.createElement("div");
          vrow.className = "mmxd-voice-row";
          const voice = data.voice;
          if (voice) {
            const name = document.createElement("span");
            name.className = "mmxd-voice-name";
            const secs = voice.seconds ? ` · ${voice.seconds.toFixed(1)}s` : "";
            name.textContent = `♪ ${voice.fileName}${secs}`;
            name.title = `${voice.fileName} — this subject's voice reference. It is not on the `
              + `timeline, so it is not limited by the render length. H3 wants 2-15 s per clip.`
              + (hasImages ? "" : "\nThis slot has no reference image, so the clip is sent as a "
                + "plain voice reference and is not tied to a <Subject N>.");
            const del = document.createElement("button");
            del.className = "mmxd-voice-del";
            del.innerHTML = ICONS.close;
            del.title = "Remove this voice";
            del.addEventListener("click", (e) => {
              e.stopPropagation();
              subjects[i].voice = null;
              this.updateCharacterSlotsUI();
              this.commitChanges();
              if (this.node?._mmxRefreshPrompt) this.node._mmxRefreshPrompt();
            });
            vrow.appendChild(name);
            vrow.appendChild(del);
          } else {
            const add = document.createElement("button");
            add.className = "mmxd-voice-add";
            add.innerHTML = `${ICONS.audio} Add voice`;
            add.title = "A voice reference for this subject (2-15 s). It is not placed on the "
              + "timeline, so it takes no render time. You can also drop an audio file on the slot.";
            add.addEventListener("click", (e) => {
              e.stopPropagation();
              const fi = document.createElement("input");
              fi.type = "file";
              fi.accept = "audio/*";
              fi.addEventListener("change", (ev) => {
                const f = ev.target.files && ev.target.files[0];
                if (f) this.handleSubjectVoiceUpload(f, i);
              });
              fi.click();
            });
            vrow.appendChild(add);
          }
          slot.appendChild(vrow);
        }
      }
    }
  }

  // Uploads to the same folder as timeline audio and stores only the name on the slot.
  async handleSubjectVoiceUpload(file, idx) {
    if (!(file.type || "").startsWith("audio/")) return;
    try {
      const body = new FormData();
      body.append("image", file);
      body.append("subfolder", "whatdreamscost");
      const resp = await api.fetchApi("/upload/image", { method: "POST", body });
      if (resp.status !== 200) throw new Error("upload failed (" + resp.status + ")");
      const data = await resp.json();
      const audioFile = data.subfolder ? data.subfolder + "/" + data.name : data.name;

      let seconds = 0;
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const buf = await ctx.decodeAudioData(await file.arrayBuffer());
        seconds = buf.duration;
        ctx.close?.();
      } catch (e) { /* the length is only for display; the server reads the file itself */ }

      const slots = this.subjectSlots();
      while (slots.length <= idx) slots.push(emptySubjectSlot());
      slots[idx].voice = { audioFile, fileName: file.name, seconds };
      this.updateCharacterSlotsUI();
      this.commitChanges(true);
      if (this.node?._mmxRefreshPrompt) this.node._mmxRefreshPrompt();
    } catch (err) {
      console.error("[MiniMaxDirector] voice upload failed", err);
      alert(`Could not add "${file.name}" as a voice.\n\n${err.message || err}`);
    }
  }

  async runGemmaAnalysis(idx, btn) {
    if (btn.classList.contains("loading")) return;

    btn.classList.add("loading");
    btn.textContent = "Analyzing...";

    let clip_name = "";
    try {
      const inputs = this.node.inputs || [];
      const clipLink = inputs.find(i => i.name === "clip")?.link;
      if (clipLink) {
        const linkInfo = window.app.graph.links[clipLink];
        if (linkInfo) {
          const originNode = window.app.graph.getNodeById(linkInfo.origin_id);
          if (originNode) {
            const widgets = originNode.widgets || [];
            const modelWidget = widgets.find(w =>
              w.name === "clip_name" || w.name === "clip_name_1" ||
              w.name === "clip_name_2" || w.name === "clip" || w.name === "model_name"
            );
            if (modelWidget) clip_name = modelWidget.value;
          }
        }
      }
    } catch (e) {
      console.warn("[MiniMaxDirector] Could not traverse graph to find CLIPLoader name", e);
    }

    const b64_images = (await Promise.all(
      (this.subjectSlots()[idx].images || []).map(img => this._refImageToB64(img))
    )).filter(Boolean);

    try {
      const resp = await api.fetchApi("/minimax_director/analyze_character", {
        method: "POST",
        body: JSON.stringify({
          clip_name: clip_name,
          image_b64: b64_images,
          char_index: idx,
          // so the model is asked about a place or a garment when that is what the slot
          // holds, instead of being asked for hair and clothing regardless
          kind: this.subjectSlots()[idx]?.kind || "person",
          provider: this.timeline.analyzeProvider || "ollama",
          base_url: this.timeline.analyzeBaseUrl || "",
          model: this.timeline.analyzeModel || "",
          // read at send time, not stored with the timeline (issue #15)
          api_key: getAnalyzeApiKey(),
        })
      });
      const result = await resp.json();
      if (result.status === "success") {
        this.subjectSlots()[idx].description = result.description;
        // A model that ignored the two-line format returns everything as the description
        // and nothing here, which must not wipe a note the user wrote by hand.
        if (result.retention_note) {
          this.subjectSlots()[idx].retentionNote = result.retention_note;
        }
        btn.textContent = "Success!";
        setTimeout(() => { this.updateCharacterSlotsUI(); this.commitChanges(); }, 1500);
      } else {
        alert("Analysis Error: " + result.message);
        btn.classList.remove("loading");
        btn.textContent = "Analyze";
      }
    } catch (err) {
      console.error("[MiniMaxDirector] analysis request failed", err);
      alert("Request failed. Is your server running?");
      btn.classList.remove("loading");
      btn.textContent = "Analyze";
    }
  }

  // --- @refN auto-complete popup (attaches to a given textarea) ---
  setupAutocomplete(input) {
    if (!input || input._prAutocompleteAttached) return;
    input._prAutocompleteAttached = true;

    const menu = document.createElement("div");
    menu.className = "mmxd-autocomplete-menu";
    menu.style.display = "none";
    document.body.appendChild(menu);
    if (!this._autocompleteMenus) this._autocompleteMenus = [];
    this._autocompleteMenus.push(menu);

    // One entry per slot that has something in it, labelled with its description so a
    // panel of nine is still navigable. @char1..@char3 stay valid in typed prompts — the
    // planner accepts both spellings — but only @refN is offered, since a slot is no
    // longer necessarily a character.
    const buildSuggestions = () => {
      const slots = this.subjectSlots();
      const out = [];
      for (let i = 0; i < slots.length && i < MAX_SUBJECT_SLOTS; i++) {
        const s = slots[i] || {};
        // a description with no image is a whole subject on the fl2va path, where the
        // image would be discarded anyway — so an empty slot is one with neither
        if (!(s.images && s.images.length) && !(s.description || "").trim()) continue;
        const desc = (s.description || "").trim();
        out.push({
          tag: `@ref${i + 1}`,
          label: desc ? (desc.length > 40 ? desc.slice(0, 40) + "…" : desc)
                      : (s.kind || "person"),
        });
      }
      // nothing dropped yet: still offer the three that always exist, so the tag is
      // discoverable before the panel is filled
      if (!out.length) {
        for (let i = 0; i < 3; i++) out.push({ tag: `@ref${i + 1}`, label: `slot ${i + 1}` });
      }
      return out;
    };
    let suggestions = buildSuggestions();

    let activeIndex = 0;
    let showMenu = false;
    let queryStart = -1;

    const hideMenu = () => { menu.style.display = "none"; showMenu = false; };

    const getCaretCoordinates = () => {
      const rect = input.getBoundingClientRect();
      return { left: rect.left, top: rect.bottom + 2 };
    };

    const updateMenu = () => {
      if (!showMenu) return;
      const text = input.value;
      const cursor = input.selectionStart;
      const query = text.slice(queryStart + 1, cursor).toLowerCase();

      // rebuilt each time the menu is drawn: slots are added and described while the
      // editor is open, and a stale list would offer tags that no longer resolve
      suggestions = buildSuggestions();
      const filtered = suggestions.filter(s => s.tag.toLowerCase().includes("@" + query) || s.tag.toLowerCase().includes(query));
      if (filtered.length === 0) { hideMenu(); return; }

      menu.innerHTML = "";
      if (activeIndex >= filtered.length) activeIndex = 0;

      filtered.forEach((s, idx) => {
        const item = document.createElement("div");
        item.className = "mmxd-autocomplete-item" + (idx === activeIndex ? " active" : "");
        item.innerHTML = `<span>${s.tag}</span><small>${s.label}</small>`;
        item.addEventListener("mousedown", (e) => { e.preventDefault(); insertSuggestion(s.tag); });
        menu.appendChild(item);
      });

      const coords = getCaretCoordinates();
      menu.style.left = `${coords.left}px`;
      menu.style.top = `${coords.top}px`;
      menu.style.display = "flex";
    };

    const insertSuggestion = (tag) => {
      const text = input.value;
      const cursor = input.selectionStart;
      const before = text.slice(0, queryStart);
      const after = text.slice(cursor);
      input.value = before + tag + " " + after;
      input.selectionStart = input.selectionEnd = queryStart + tag.length + 1;
      input.dispatchEvent(new Event("input"));
      hideMenu();
      input.focus();
    };

    input.addEventListener("keydown", (e) => {
      if (showMenu) {
        const items = menu.querySelectorAll(".mmxd-autocomplete-item");
        if (items.length === 0) return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          activeIndex = (activeIndex + 1) % items.length;
          updateMenu();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          activeIndex = (activeIndex - 1 + items.length) % items.length;
          updateMenu();
        } else if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const activeItem = items[activeIndex];
          if (activeItem) insertSuggestion(activeItem.querySelector("span").textContent);
        } else if (e.key === "Escape") {
          e.preventDefault();
          hideMenu();
        }
      }
    });

    input.addEventListener("input", () => {
      const text = input.value;
      const cursor = input.selectionStart;
      const textBeforeCursor = text.slice(0, cursor);
      const lastAt = textBeforeCursor.lastIndexOf("@");
      if (lastAt !== -1 && (lastAt === 0 || textBeforeCursor[lastAt - 1] === " ")) {
        showMenu = true;
        queryStart = lastAt;
        updateMenu();
      } else {
        hideMenu();
      }
    });

    input.addEventListener("blur", () => { setTimeout(hideMenu, 150); });
  }

  commitChanges(skipRender = false) {
    if (this._suppressCommit) return;
    // Deduplicate segments by ID to clean up any duplicates created by the previous onseeked bug
    this.timeline.segments = this.timeline.segments.filter((seg, index, self) => index === self.findIndex((s) => s.id === seg.id));
    if (this.timeline.audioSegments) {
      this.timeline.audioSegments = this.timeline.audioSegments.filter((seg, index, self) => index === self.findIndex((s) => s.id === seg.id));
    }
    if (this.timeline.motionSegments) {
      this.timeline.motionSegments = this.timeline.motionSegments.filter((seg, index, self) => index === self.findIndex((s) => s.id === seg.id));
    }

    let sortedSegments = [...this.timeline.segments].sort((a, b) => a.start - b.start);
    let contiguousLengths = [];
    let contiguousPrompts = [];
    let imgStrengths = [];

    const startFrames = this.getStartFrames();
    const durationFrames = this.getDurationFrames();
    if (!this.retakeMode) {
      this.timeline.normalStartFrame = startFrames;
      this.timeline.normalDurationFrames = durationFrames;
    }
    const endFrames = startFrames + durationFrames;
    let currentCursor = startFrames;

    if (this.retakeMode) {
      const totalFrames = this.getVisualDurationFrames();
      const retakeStart = this.timeline.retakeStart ?? 0;
      const retakeLength = this.timeline.retakeLength ?? totalFrames;
      const retakeEnd = retakeStart + retakeLength;
      const retakePrompt = this.timeline.retakePrompt || "";
      const retakeStrength = this.timeline.retakeStrength ?? 1.0;
      const globalPrompt = this.globalPromptInput ? this.globalPromptInput.value : (this.node.properties?.global_prompt || "");

      // 1. Preserved before
      const pBeforeStart = startFrames;
      const pBeforeEnd = Math.min(endFrames, retakeStart);
      const pBeforeLen = pBeforeEnd - pBeforeStart;
      if (pBeforeLen > 0) {
        contiguousLengths.push(pBeforeLen);
        contiguousPrompts.push(globalPrompt || "video");
        imgStrengths.push("0.00");
      }

      // 2. Retake region
      const rStart = Math.max(startFrames, retakeStart);
      const rEnd = Math.min(endFrames, retakeEnd);
      const rLen = rEnd - rStart;
      if (rLen > 0) {
        contiguousLengths.push(rLen);
        contiguousPrompts.push(retakePrompt || "video");
        imgStrengths.push(retakeStrength.toFixed(2));
      }

      // 3. Preserved after
      const pAfterStart = Math.max(startFrames, retakeEnd);
      const pAfterEnd = endFrames;
      const pAfterLen = pAfterEnd - pAfterStart;
      if (pAfterLen > 0) {
        contiguousLengths.push(pAfterLen);
        contiguousPrompts.push(globalPrompt || "video");
        imgStrengths.push("0.00");
      }
    } else {
      // Build segment lengths clipped at the duration cutoff.
      // - Gaps before the first segment, or between segments, are absorbed into the adjacent
      //   segment's length (same as before), but are also clipped at endFrames.
      // - Segments completely before startFrames or after endFrames are excluded entirely.
      // - Segments that cross the boundaries are trimmed.
      let pendingGap = 0;
      for (let seg of sortedSegments) {
        if (seg.start + seg.length <= startFrames) continue;
        if (seg.start >= endFrames) break;

        const effectiveStart = Math.max(seg.start, startFrames);
        const clippedEnd = Math.min(seg.start + seg.length, endFrames);

        if (effectiveStart > currentCursor) {
          const gapLength = Math.min(effectiveStart, endFrames) - currentCursor;
          if (contiguousLengths.length > 0) {
            contiguousLengths[contiguousLengths.length - 1] += gapLength;
          } else {
            pendingGap += gapLength;
          }
        }

        const clippedLength = clippedEnd - effectiveStart;

        contiguousLengths.push(clippedLength + pendingGap);
        contiguousPrompts.push(seg.prompt || "");
        pendingGap = 0;
        currentCursor = Math.max(currentCursor, seg.start + seg.length);
      }

      const clampedCursor = Math.min(currentCursor, endFrames);
      if (contiguousLengths.length > 0 && clampedCursor < endFrames) {
        contiguousLengths[contiguousLengths.length - 1] += endFrames - clampedCursor;
      }
    }

    const toSave = {
      mainTrackEnabled: this.mainTrackEnabled,
      audioTrackEnabled: this.audioTrackEnabled,
      motionTrackEnabled: this.motionTrackEnabled,
      propHeight: this.propHeight,
      globalPropHeight: this.globalPropHeight,
      showFilenames: !!this.node.properties.showFilenames,
      showPromptZones: !!this.node.properties.showPromptZones,
      overrideAudio: !!this.node.properties.overrideAudio,
      inpaint_audio: !!(this.node.widgets?.find(w => w.name === "inpaint_audio")?.value),
      global_prompt: this.retakeMode ? (this.timeline.global_prompt || "") : (this.globalPromptInput ? this.globalPromptInput.value : ""),
      retake_global_prompt: this.retakeMode ? (this.globalPromptInput ? this.globalPromptInput.value : "") : (this.timeline.retake_global_prompt || ""),
      // this object is an allowlist: a key missing here is dropped on the next commit
      overall_soundscape: this.soundscapeInput ? this.soundscapeInput.value : (this.timeline.overall_soundscape || ""),
      non_diegetic_music: this.musicInput ? this.musicInput.value : (this.timeline.non_diegetic_music || ""),
      prompt_override: this.timeline.prompt_override || "",
      prompt_override_on: !!this.timeline.prompt_override_on,
      retakeMode: this.retakeMode,
      retakeStart: this.timeline.retakeStart,
      retakeLength: this.timeline.retakeLength,
      retakePrompt: this.timeline.retakePrompt,
      retakeStrength: this.timeline.retakeStrength,
      retakeVideo: this.timeline.retakeVideo ? {
        fileName: this.timeline.retakeVideo.fileName,
        imageFile: this.timeline.retakeVideo.imageFile,
        videoDurationFrames: this.timeline.retakeVideo.videoDurationFrames,
        fileSize: this.timeline.retakeVideo.fileSize,
      } : null,
      normalStartFrame: this.timeline.normalStartFrame,
      normalDurationFrames: this.timeline.normalDurationFrames,
      reference_mode: this.timeline.reference_mode || "OFF",
      prompt_format: this.timeline.prompt_format || "minimax",
      analyzeProvider: this.timeline.analyzeProvider || "ollama",
      analyzeBaseUrl: this.timeline.analyzeBaseUrl || "",
      analyzeModel: this.timeline.analyzeModel || "",
      summary: this.timeline.summary || "",
      task_type_override: this.timeline.task_type_override || "",
      // 0 means "however many the panel grew to on its own" — only the stepper writes it
      subjectSlotCount: this.visibleSlotCount(),
      // Only the slots that are on screen. The planner reads this array, not the count, so
      // a slot left behind by `−` would keep sending its images with no box anywhere to
      // show them or take them out again.
      subjects: this.subjectSlots().slice(0, this.visibleSlotCount()).map(c => ({
        images: (c.images || []).map(img => img.b64 ? { b64: img.b64, name: img.name } : { name: img.name }),
        description: c.description || "",
        shortName: c.shortName || "",
        kind: c.kind || "person",
        retention: c.retention || "fully_preserved",
        retentionNote: c.retentionNote || "",
        voice: voicePayload(c.voice)
      })),
      segments: sortedSegments.map(s => {
        const { imgObj, videoEl, _isSeeking, thumbnails, _extractingThumbs, _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, ...rest } = s;
        return rest;
      }),
      motionSegments: (this.timeline.motionSegments || []).map(s => {
        const { imgObj, videoEl, _isSeeking, thumbnails, _extractingThumbs, _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, ...rest } = s;
        return rest;
      }),
      audioSegments: (this.timeline.audioSegments || []).map(s => {
        const { _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _decoding, _blobUrl, _audioBuffer, ...rest } = s;
        return rest;
      })
    };

    const jsonStr = JSON.stringify(toSave);
    mmxdLog("[MiniMaxDirector debug] commitChanges: saving timelineDataWidget value:", jsonStr);

    const updateWidgetValue = (w, val) => {
      if (!w) return;
      const oldVal = w.value;
      w.value = val;
      if (this.node) {
        if (this.node.properties) {
          this.node.properties[w.name] = val;
        }
        if (this.node.onWidgetChanged) {
          this.node.onWidgetChanged(w.name, val, oldVal, w);
        }
      }
      if (w.callback) {
        try {
          w.callback(val);
        } catch (e) {
          // ignore
        }
      }
    };

    if (this.timelineDataWidget) {
      updateWidgetValue(this.timelineDataWidget, jsonStr);
    }

    if (this.node.properties) {
      this.node.properties.mainTrackEnabled = this.mainTrackEnabled;
      this.node.properties.audioTrackEnabled = this.audioTrackEnabled;
      this.node.properties.motionTrackEnabled = this.motionTrackEnabled;
      this.node.properties.audioTrackWasEnabledBeforeOverride = !!this._audioTrackWasEnabledBeforeOverride;

      if (this.node.widgets) {
        for (const w of this.node.widgets) {
          if (w.name && w.value !== undefined) {
            this.node.properties[w.name] = w.value;
          }
        }
      }
      const overrideWidget = this.node.widgets?.find(w => w.name === "override_audio");
      if (overrideWidget) {
        this.node.properties.overrideAudio = !!overrideWidget.value;
      }
    }

    const overrideWidget = this.node.widgets?.find(w => w.name === "override_audio");
    if (overrideWidget) {
      updateWidgetValue(overrideWidget, !!this.node.properties.overrideAudio);
    }

    if (this.localPromptsWidget) {
      updateWidgetValue(this.localPromptsWidget, contiguousPrompts.join(" | "));
    }
    if (this.segmentLengthsWidget) {
      updateWidgetValue(this.segmentLengthsWidget, contiguousLengths.join(","));
    }

    if (this.guideStrengthWidget) {
      let val = "";
      if (this.retakeMode) {
        val = imgStrengths.join(",");
      } else {
        const strList = sortedSegments
          .filter(s => s.type !== "text")
          .filter(s => s.start + s.length > startFrames && s.start < endFrames)
          .map(s => (s.guideStrength !== undefined ? s.guideStrength : 1.0).toFixed(2));
        val = strList.join(",");
      }
      updateWidgetValue(this.guideStrengthWidget, val);
    }

    // Keep zoom slider max in sync with the current timeline duration.
    this.updateZoomSliderMax();

    setTimeout(() => {
      if (this.node && this.node.computeSize) {
        const sz = this.node.computeSize();
        this.node.size[1] = sz[1];
        if (app.graph) {
          app.graph.setDirtyCanvas(true, true);
          if (app.graph.change) app.graph.change();
          if (app.graph.onNodeChanged) app.graph.onNodeChanged(this.node);
          if (app.graph.onStateChanged) app.graph.onStateChanged();
        }
      }
      try {
        const canvasEl = app.canvasEl || app.canvas?.canvas;
        if (canvasEl) {
          canvasEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
        }
        if (app.canvas && app.canvas.checkState) app.canvas.checkState();
        if (app.canvas && app.canvas.captureCanvasState) app.canvas.captureCanvasState();
      } catch (_) { }
    }, 100);

    // Stamp exact seconds on every live segment so FPS changes can recompute
    // frame values without cumulative rounding error.
    this._stampSegmentSeconds();

    if (this.isPlaying) {
      this.playAudio(); // Resync audio engine with new timeline data
    }

    if (!skipRender) this.render();
  }

  // Stamp _sSecs / _lSecs / _tSecs / _dSecs on every live segment
  // using the current frame rate. Call this whenever segments change
  // through normal timeline interactions (not FPS changes).
  _stampSegmentSeconds() {
    const fps = this.getFrameRate();
    if (fps <= 0) return;
    for (const seg of this.timeline.segments) {
      seg._sSecs = seg.start / fps;
      seg._lSecs = seg.length / fps;
      if (seg.trimStart !== undefined) seg._tSecs = seg.trimStart / fps;
      if (seg.videoDurationFrames !== undefined) seg._dSecs = seg.videoDurationFrames / fps;
    }
    for (const seg of this.timeline.audioSegments) {
      seg._sSecs = seg.start / fps;
      seg._lSecs = seg.length / fps;
      if (seg.trimStart !== undefined) seg._tSecs = seg.trimStart / fps;
      if (seg.audioDurationFrames !== undefined) seg._dSecs = seg.audioDurationFrames / fps;
    }
  }

  // Recompute all segment frame values from their seconds snapshots at `newFPS`.
  // If a segment has no snapshot yet (e.g. freshly added), fall back to scaling
  // from the previous FPS so it still moves correctly.
  _rebaseSegmentsToFPS(newFPS) {
    if (newFPS <= 0) return;
    const oldFPS = this._prevFrameRate || newFPS;
    const fallbackRatio = oldFPS > 0 ? newFPS / oldFPS : 1;
    for (const seg of this.timeline.segments) {
      if (seg._sSecs !== undefined) {
        seg.start = Math.round(seg._sSecs * newFPS);
        seg.length = Math.max(1, Math.round(seg._lSecs * newFPS));
        if (seg._tSecs !== undefined) seg.trimStart = Math.round(seg._tSecs * newFPS);
        if (seg._dSecs !== undefined) seg.videoDurationFrames = Math.round(seg._dSecs * newFPS);
      } else {
        seg.start = Math.round(seg.start * fallbackRatio);
        seg.length = Math.max(1, Math.round(seg.length * fallbackRatio));
        if (seg.trimStart !== undefined) seg.trimStart = Math.round(seg.trimStart * fallbackRatio);
        if (seg.videoDurationFrames !== undefined) seg.videoDurationFrames = Math.round(seg.videoDurationFrames * fallbackRatio);
      }
    }
    for (const seg of this.timeline.audioSegments) {
      if (seg._sSecs !== undefined) {
        seg.start = Math.round(seg._sSecs * newFPS);
        seg.length = Math.max(1, Math.round(seg._lSecs * newFPS));
        if (seg._tSecs !== undefined) seg.trimStart = Math.round(seg._tSecs * newFPS);
        if (seg._dSecs !== undefined) seg.audioDurationFrames = Math.round(seg._dSecs * newFPS);
      } else {
        seg.start = Math.round(seg.start * fallbackRatio);
        seg.length = Math.max(1, Math.round(seg.length * fallbackRatio));
        if (seg.trimStart !== undefined) seg.trimStart = Math.round(seg.trimStart * fallbackRatio);
        if (seg.audioDurationFrames !== undefined) seg.audioDurationFrames = Math.round(seg.audioDurationFrames * fallbackRatio);
      }
    }
  }

  // --- Gap Region Calculation ---
  getGapRegions() {
    const totalFrames = this.getVisualDurationFrames();
    const outputFrames = this.getStartFrames() + this.getDurationFrames();
    const width = this.canvas.offsetWidth || this._lastWidth || 0;
    const gaps = [];
    if (!width) return gaps;

    // Image gaps
    let cursor = 0;
    const sortedImg = [...this.timeline.segments].sort((a, b) => a.start - b.start);
    for (const seg of sortedImg) {
      if (seg.start > cursor) {
        const x0 = (cursor / totalFrames) * width;
        const x1 = (seg.start / totalFrames) * width;
        gaps.push({ track: 'image', frameStart: cursor, frameEnd: seg.start, centerX: (x0 + x1) / 2, centerY: RULER_HEIGHT + this.blockHeight / 2, widthPx: x1 - x0 });
      }
      cursor = seg.start + seg.length;
    }
    if (cursor < outputFrames) {
      const x0 = (cursor / totalFrames) * width;
      const x1 = (outputFrames / totalFrames) * width;
      gaps.push({ track: 'image', frameStart: cursor, frameEnd: outputFrames, centerX: (x0 + x1) / 2, centerY: RULER_HEIGHT + this.blockHeight / 2, widthPx: x1 - x0 });
    }

    // Motion gaps
    cursor = 0;
    const sortedMot = [...this.timeline.motionSegments].sort((a, b) => a.start - b.start);
    for (const seg of sortedMot) {
      if (seg.start > cursor) {
        const x0 = (cursor / totalFrames) * width;
        const x1 = (seg.start / totalFrames) * width;
        gaps.push({ track: 'motion', frameStart: cursor, frameEnd: seg.start, centerX: (x0 + x1) / 2, centerY: RULER_HEIGHT + this.blockHeight + this.audioTrackHeight + this.motionTrackHeight / 2, widthPx: x1 - x0 });
      }
      cursor = seg.start + seg.length;
    }
    if (cursor < outputFrames) {
      const x0 = (cursor / totalFrames) * width;
      const x1 = (outputFrames / totalFrames) * width;
      gaps.push({ track: 'motion', frameStart: cursor, frameEnd: outputFrames, centerX: (x0 + x1) / 2, centerY: RULER_HEIGHT + this.blockHeight + this.audioTrackHeight + this.motionTrackHeight / 2, widthPx: x1 - x0 });
    }

    // Audio gaps
    cursor = 0;
    const sortedAud = [...this.timeline.audioSegments].sort((a, b) => a.start - b.start);
    for (const seg of sortedAud) {
      if (seg.start > cursor) {
        const x0 = (cursor / totalFrames) * width;
        const x1 = (seg.start / totalFrames) * width;
        gaps.push({ track: 'audio', frameStart: cursor, frameEnd: seg.start, centerX: (x0 + x1) / 2, centerY: RULER_HEIGHT + this.blockHeight + this.audioTrackHeight / 2, widthPx: x1 - x0 });
      }
      cursor = seg.start + seg.length;
    }
    if (cursor < outputFrames) {
      const x0 = (cursor / totalFrames) * width;
      const x1 = (outputFrames / totalFrames) * width;
      gaps.push({ track: 'audio', frameStart: cursor, frameEnd: outputFrames, centerX: (x0 + x1) / 2, centerY: RULER_HEIGHT + this.blockHeight + this.audioTrackHeight / 2, widthPx: x1 - x0 });
    }

    return gaps;
  }

  promptAddAudioInGap(frameStart, frameEnd) {
    const fi = document.createElement("input");
    fi.type = "file";
    fi.accept = "audio/*";
    fi.addEventListener("change", (ev) => {
      if (ev.target.files?.[0]) this.handleAudioUpload([ev.target.files[0]], frameStart);
    });
    fi.click();
  }

  promptAddMotionInGap(frameStart, frameEnd) {
    const fi = document.createElement("input");
    fi.type = "file";
    fi.accept = "video/*";
    fi.addEventListener("change", (ev) => {
      if (ev.target.files?.[0]) this.handleMotionUpload([ev.target.files[0]], frameStart);
    });
    fi.click();
  }

  // --- Context Menu ---
  onContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();

    // In retake mode: suppress the normal timeline context menu entirely.
    // If a retake video is loaded, show a minimal retake-specific menu instead.
    if (this.retakeMode) {
      if (this.timeline.retakeVideo) {
        this._showRetakeContextMenu(e.clientX, e.clientY);
      }
      return;
    }

    const { x: mouseX, y: mouseY } = this.getMousePos(e);

    const trackHeight = this.blockHeight;
    const isAudioTrack = mouseY >= RULER_HEIGHT + trackHeight && mouseY <= RULER_HEIGHT + trackHeight + this.audioTrackHeight;
    const isMotionTrack = mouseY >= RULER_HEIGHT + trackHeight + this.audioTrackHeight && mouseY <= RULER_HEIGHT + trackHeight + this.audioTrackHeight + this.motionTrackHeight;
    const isImageTrack = mouseY >= RULER_HEIGHT && mouseY <= RULER_HEIGHT + trackHeight;

    const logicalWidth = this.canvas.offsetWidth || 1;
    const totalFrames = this.getVisualDurationFrames();
    const cursor = mouseX * (totalFrames / logicalWidth);

    let clickedSeg = null;
    let trackType = "";

    if (isMotionTrack) {
      clickedSeg = this.timeline.motionSegments.find(s => cursor >= s.start && cursor <= s.start + s.length);
      trackType = "motion";
    } else if (isAudioTrack) {
      clickedSeg = this.timeline.audioSegments.find(s => cursor >= s.start && cursor <= s.start + s.length);
      trackType = "audio";
    } else if (isImageTrack) {
      clickedSeg = this.timeline.segments.find(s => cursor >= s.start && cursor <= s.start + s.length);
      trackType = clickedSeg ? clickedSeg.type : "";
    }

    if (clickedSeg) {
      this.showContextMenu(e.clientX, e.clientY, clickedSeg, trackType);
    } else if (isMotionTrack || isImageTrack || isAudioTrack) {
      const gapRegions = this.getGapRegions();
      const currentTrack = isMotionTrack ? "motion" : (isAudioTrack ? "audio" : "image");
      let gap = gapRegions.find(g => cursor >= g.frameStart && cursor <= g.frameEnd && g.track === currentTrack);

      if (!gap) {
        const startFrame = Math.round(cursor);
        gap = {
          track: currentTrack,
          frameStart: startFrame,
          frameEnd: startFrame + Math.max(1, this.getFrameRate())
        };
      }
      gap.clickedFrame = cursor;

      this.showGapContextMenu(e.clientX, e.clientY, gap);
    }
  }

  _deleteRetakeVideo() {
    if (!this.timeline.retakeVideo) return;
    // Clean up the video element
    const vid = this.timeline.retakeVideo;
    if (vid.videoEl) {
      vid.videoEl.pause();
      vid.videoEl.src = "";
      vid.videoEl.load();
    }
    if (vid._blobUrl) {
      URL.revokeObjectURL(vid._blobUrl);
    }
    this.timeline.retakeVideo = null;
    this.timeline.retakeStart = 0;
    this.timeline.retakeLength = this.getDurationFrames();
    this.commitChanges();
    this.render();
  }

  _showRetakeContextMenu(clientX, clientY) {
    this.dismissContextMenu();

    const menu = document.createElement("div");
    menu.className = "mmxd-gap-menu";
    menu.style.left = `${clientX + 6}px`;
    menu.style.top = `${clientY - 10}px`;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "mmxd-gap-menu-btn";
    deleteBtn.innerHTML = `${ICONS.trash} Delete`;
    deleteBtn.style.color = "#ffaaaa";
    deleteBtn.onclick = () => {
      this.dismissContextMenu();
      this._deleteRetakeVideo();
    };
    menu.appendChild(deleteBtn);

    document.body.appendChild(menu);
    this._contextMenu = menu;
    setTimeout(() => {
      this._contextMenuDismisser = (ev) => { if (!menu.contains(ev.target)) this.dismissContextMenu(); };
      document.addEventListener("pointerdown", this._contextMenuDismisser, true);
      document.addEventListener("wheel", this._contextMenuDismisser, true);
    }, 0);
  }

  async _checkClipboardForImage(btn) {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const status = await navigator.permissions.query({ name: "clipboard-read" });
        if (status.state === "granted") {
          const items = await navigator.clipboard.read();
          let hasImg = false;
          for (const item of items) {
            if (item.types.some(t => t.startsWith("image/"))) {
              hasImg = true;
              break;
            }
          }
          if (!hasImg) {
            btn.disabled = true;
            btn.style.opacity = "0.4";
            btn.style.cursor = "not-allowed";
            btn.title = "No image found in clipboard";
          }
        } else if (status.state === "denied") {
          btn.disabled = true;
          btn.style.opacity = "0.4";
          btn.style.cursor = "not-allowed";
          btn.title = "Clipboard permission denied";
        }
      }
    } catch (e) {
      console.warn("Clipboard read permission query failed:", e);
    }
  }

  async _checkClipboardForText(btn) {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const status = await navigator.permissions.query({ name: "clipboard-read" });
        if (status.state === "granted") {
          const text = await navigator.clipboard.readText();
          if (!text || text.trim() === "") {
            btn.disabled = true;
            btn.style.opacity = "0.4";
            btn.style.cursor = "not-allowed";
            btn.title = "No text found in clipboard";
          }
        } else if (status.state === "denied") {
          btn.disabled = true;
          btn.style.opacity = "0.4";
          btn.style.cursor = "not-allowed";
          btn.title = "Clipboard permission denied";
        }
      }
    } catch (e) {
      console.warn("Clipboard read text permission query failed:", e);
    }
  }

  showContextMenu(clientX, clientY, seg, trackType) {
    this.dismissContextMenu();
    const menu = document.createElement("div");
    menu.className = "mmxd-gap-menu";
    menu.style.left = `${clientX + 6}px`;
    menu.style.top = `${clientY - 10}px`;

    const isImage = trackType === "image" && seg.imageB64;

    const makeDivider = () => {
      const d = document.createElement("div");
      d.className = "mmxd-settings-divider";
      return d;
    };

    // ==========================================
    // 1. Define Segment options (Copy, Paste, Replace Segment, Split)
    // ==========================================
    const copySegBtn = document.createElement("button");
    copySegBtn.className = "mmxd-gap-menu-btn";
    copySegBtn.innerHTML = `Copy Segment`;
    copySegBtn.onclick = () => {
      this._copiedSegment = { ...seg, id: Date.now().toString() + Math.random().toString(36).substr(2, 5) };
      this._copiedSegmentTrack = trackType;
      window._mmxCopiedSegmentCS = { main: { ...seg }, sibling: null };
      window._mmxCopiedSegmentTypeCS = this.getCanonicalTrack(trackType);
      if (seg.imgObj) window._mmxCopiedSegmentCS.main.imgObj = seg.imgObj;
      if (seg.videoEl) window._mmxCopiedSegmentCS.main.videoEl = seg.videoEl;

      if (seg.id && (seg.id.endsWith("_v") || seg.id.endsWith("_a"))) {
        const isVid = seg.id.endsWith("_v");
        const sibId = isVid ? seg.id.slice(0, -2) + "_a" : seg.id.slice(0, -2) + "_v";
        const sibArr = isVid ? this.timeline.audioSegments : this.timeline.segments;
        const sib = sibArr.find(s => s.id === sibId);
        if (sib) {
          window._mmxCopiedSegmentCS.sibling = { ...sib };
          if (sib.imgObj) window._mmxCopiedSegmentCS.sibling.imgObj = sib.imgObj;
          if (sib.videoEl) window._mmxCopiedSegmentCS.sibling.videoEl = sib.videoEl;
        }
      }
      this.dismissContextMenu();
    };

    const hasCopied = this._copiedSegment || window._mmxCopiedSegmentCS;
    const copiedTrack = this._copiedSegmentTrack || window._mmxCopiedSegmentTypeCS;
    const copiedSegData = this._copiedSegment || (window._mmxCopiedSegmentCS ? window._mmxCopiedSegmentCS.main : null);
    const copiedSibData = window._mmxCopiedSegmentCS ? window._mmxCopiedSegmentCS.sibling : null;

    const canPaste = hasCopied && this.getCanonicalTrack(copiedTrack) === this.getCanonicalTrack(trackType) && copiedSegData;
    const pasteSegBtn = document.createElement("button");
    pasteSegBtn.className = "mmxd-gap-menu-btn";
    pasteSegBtn.innerHTML = `Paste Segment`;
    if (!canPaste) {
      pasteSegBtn.disabled = true;
      pasteSegBtn.style.opacity = "0.4";
      pasteSegBtn.style.cursor = "not-allowed";
      pasteSegBtn.title = "No matching segment copied to clipboard";
    } else {
      pasteSegBtn.onclick = () => {
        const startFrame = Math.round(this.currentFrame);
        this.pasteSegmentAtFrame(copiedSegData, this.getCanonicalTrack(copiedTrack), copiedSibData, startFrame);
        this.dismissContextMenu();
      };
    }

    const currentTrack = trackType;
    const canReplace = hasCopied && this.getCanonicalTrack(copiedTrack) === this.getCanonicalTrack(currentTrack) && copiedSegData;
    const pasteReplaceBtn = document.createElement("button");
    pasteReplaceBtn.className = "mmxd-gap-menu-btn";
    pasteReplaceBtn.innerHTML = `Replace Segment`;
    if (!canReplace) {
      pasteReplaceBtn.disabled = true;
      pasteReplaceBtn.style.opacity = "0.4";
      pasteReplaceBtn.style.cursor = "not-allowed";
      pasteReplaceBtn.title = "No matching segment copied to clipboard";
    } else {
      pasteReplaceBtn.onclick = () => {
        const newSeg = {
          ...copiedSegData,
          id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
          start: seg.start,
          length: copiedSegData.length
        };
        const targetArray = this.getSegmentArray(this.getCanonicalTrack(currentTrack));
        const idx = targetArray.findIndex(s => s.id === seg.id);
        if (idx >= 0) targetArray[idx] = newSeg;
        this.commitChanges();
        this.dismissContextMenu();
      };
    }

    let splitBtn = null;
    const splitFrame = Math.round(this.currentFrame);
    if (splitFrame > seg.start && splitFrame < seg.start + seg.length) {
      splitBtn = document.createElement("button");
      splitBtn.className = "mmxd-gap-menu-btn";
      splitBtn.innerHTML = `Split at Playhead`;
      splitBtn.onclick = () => {
        this.splitSegmentAtPlayhead(seg, trackType);
        this.dismissContextMenu();
      };
    }

    // ==========================================
    // 2. Define Prompt options (if not audio)
    // ==========================================
    let copyPromptBtn = null;
    let pastePromptBtn = null;
    if (trackType !== "audio") {
      copyPromptBtn = document.createElement("button");
      copyPromptBtn.className = "mmxd-gap-menu-btn";
      copyPromptBtn.innerHTML = `Copy Prompt`;
      copyPromptBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(seg.prompt || "");
        } catch (err) {
          console.error("Failed to copy prompt", err);
        }
        this.dismissContextMenu();
      };

      pastePromptBtn = document.createElement("button");
      pastePromptBtn.className = "mmxd-gap-menu-btn";
      pastePromptBtn.innerHTML = `Paste Prompt`;
      this._checkClipboardForText(pastePromptBtn);
      pastePromptBtn.onclick = async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) {
            seg.prompt = text;
            this.commitChanges();
            this.render();
            if (this.selectedIndex === this.timeline.segments.findIndex(s => s.id === seg.id)) {
              this.updateUIFromSelection();
            }
          }
        } catch (err) {
          console.error("Failed to paste prompt", err);
        }
        this.dismissContextMenu();
      };
    }

    // ==========================================
    // 3. Define Image options (if isImage)
    // ==========================================
    let copyImgBtn = null;
    let saveImgBtn = null;
    let openImgBtn = null;
    let replaceImgBtn = null;
    let replaceWithFileBtn = null;

    if (isImage) {
      copyImgBtn = document.createElement("button");
      copyImgBtn.className = "mmxd-gap-menu-btn";
      copyImgBtn.innerHTML = `Copy Image`;
      copyImgBtn.onclick = async () => {
        try {
          const img = new Image();
          img.crossOrigin = "Anonymous";
          img.src = seg.imageB64;
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
          });
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          canvas.getContext("2d").drawImage(img, 0, 0);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        } catch (err) {
          console.error("Failed to copy image", err);
        }
        this.dismissContextMenu();
      };

      saveImgBtn = document.createElement("button");
      saveImgBtn.className = "mmxd-gap-menu-btn";
      saveImgBtn.innerHTML = `Save Image`;
      saveImgBtn.onclick = () => {
        const a = document.createElement("a");
        a.href = seg.imageB64;
        a.download = "timeline_image.jpg";
        a.click();
        this.dismissContextMenu();
      };

      openImgBtn = document.createElement("button");
      openImgBtn.className = "mmxd-gap-menu-btn";
      openImgBtn.innerHTML = `Open Image in New Tab`;
      openImgBtn.onclick = () => {
        const win = window.open();
        if (win) {
          win.document.write(`<body style="margin:0;display:flex;justify-content:center;align-items:center;background:#0e0e0e;height:100vh;"><img style="max-width:100%;max-height:100%;" src="${seg.imageB64}" /></body>`);
          win.document.close();
        }
        this.dismissContextMenu();
      };

      replaceImgBtn = document.createElement("button");
      replaceImgBtn.className = "mmxd-gap-menu-btn";
      replaceImgBtn.innerHTML = `Replace with Copied Image`;
      this._checkClipboardForImage(replaceImgBtn);
      replaceImgBtn.onclick = async () => {
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const imageTypes = item.types.filter(type => type.startsWith("image/"));
            if (imageTypes.length > 0) {
              const blob = await item.getType(imageTypes[0]);
              const file = new File([blob], "clipboard.png", { type: blob.type });

              const body = new FormData();
              body.append("image", file);
              body.append("subfolder", "whatdreamscost");
              const resp = await api.fetchApi("/upload/image", { method: "POST", body });
              if (resp.status === 200) {
                const data = await resp.json();
                const filename = data.name;
                const subfolder = data.subfolder || "";
                const imageFile = subfolder ? subfolder + "/" + filename : filename;
                const imgUrl = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

                const img = new Image();
                img.onload = () => {
                  seg.imageFile = imageFile;
                  seg.imageB64 = imgUrl;
                  seg.imgObj = img;
                  this.commitChanges();
                  this.render();
                  if (this.selectedIndex === this.timeline.segments.findIndex(s => s.id === seg.id)) {
                    this.updateUIFromSelection();
                  }
                };
                img.src = imgUrl;
              }
              break;
            }
          }
        } catch (err) {
          console.error("Failed to read image from clipboard", err);
        }
        this.dismissContextMenu();
      };

      replaceWithFileBtn = document.createElement("button");
      replaceWithFileBtn.className = "mmxd-gap-menu-btn";
      replaceWithFileBtn.innerHTML = `Replace with...`;
      replaceWithFileBtn.onclick = () => {
        this.dismissContextMenu();
        const fi = document.createElement("input");
        fi.type = "file";
        fi.accept = "image/*";
        fi.addEventListener("change", async (ev) => {
          const file = ev.target.files?.[0];
          if (!file) return;
          try {
            const body = new FormData();
            body.append("image", file);
            body.append("subfolder", "whatdreamscost");
            const resp = await api.fetchApi("/upload/image", { method: "POST", body });
            if (resp.status === 200) {
              const data = await resp.json();
              const filename = data.name;
              const subfolder = data.subfolder || "";
              const imageFile = subfolder ? subfolder + "/" + filename : filename;
              const imgUrl = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

              const img = new Image();
              img.onload = () => {
                seg.imageFile = imageFile;
                seg.imageB64 = imgUrl;
                seg.imgObj = img;
                this.commitChanges();
                this.render();
                if (this.selectedIndex === this.timeline.segments.findIndex(s => s.id === seg.id)) {
                  this.updateUIFromSelection();
                }
              };
              img.src = imgUrl;
            }
          } catch (err) {
            console.error("Failed to upload replacement image", err);
          }
        });
        fi.click();
      };
    }

    // ==========================================
    // 4. Define Convert to End Frame options (only image segment with type === "image")
    // ==========================================
    let toggleEndFrameBtn = null;
    if (trackType === "image" && seg.type === "image") {
      toggleEndFrameBtn = document.createElement("button");
      toggleEndFrameBtn.className = "mmxd-gap-menu-btn";
      if (seg.isEndFrame) {
        toggleEndFrameBtn.innerHTML = `Convert to Start Frame`;
        toggleEndFrameBtn.onclick = () => {
          seg.isEndFrame = false;
          this.commitChanges();
          this.render();
          this.dismissContextMenu();
        };
      } else {
        toggleEndFrameBtn.innerHTML = `Convert to End Frame`;
        toggleEndFrameBtn.onclick = () => {
          seg.isEndFrame = true;
          this.commitChanges();
          this.render();
          this.dismissContextMenu();
        };
      }
    }

    // ==========================================
    // 5. Define Unlink Media & Mark Selection options
    // ==========================================
    const isVidLink = trackType === "video" && seg.id.endsWith("_v");
    const isAudLink = trackType === "audio" && seg.id.endsWith("_a");
    let siblingForUnlink = null;

    if (isVidLink) {
      siblingForUnlink = this.timeline.audioSegments.find(s => s.id === seg.id.slice(0, -2) + "_a");
    } else if (isAudLink) {
      siblingForUnlink = this.timeline.segments.find(s => s.id === seg.id.slice(0, -2) + "_v");
    }

    let unlinkBtn = null;
    if (siblingForUnlink) {
      unlinkBtn = document.createElement("button");
      unlinkBtn.className = "mmxd-gap-menu-btn";
      unlinkBtn.innerHTML = `Unlink Media`;
      unlinkBtn.onclick = () => {
        seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        siblingForUnlink.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        this.commitChanges();
        this.render();
        this.dismissContextMenu();
      };
    }

    const markSelectionBtn = document.createElement("button");
    markSelectionBtn.className = "mmxd-gap-menu-btn";
    markSelectionBtn.innerHTML = `Mark Selection`;
    markSelectionBtn.onclick = () => {
      if (this.selectedSegmentIds && this.selectedSegmentIds.includes(seg.id)) {
        this.markCurrentSelection();
      } else {
        this.markSegment(seg);
      }
      this.dismissContextMenu();
    };

    // ==========================================
    // 5b. Reference role and retention (ref2va only — the fl2va path has no labels to
    // attach any of this to, so showing it there would offer a setting with no effect)
    // ==========================================
    const refBtns = [];
    if (String(this.timeline.reference_mode || "OFF").toUpperCase() !== "OFF") {
      let onRefChange = () => {};
      const cycler = (caption, options, key, fallback, tip) => {
        const btn = document.createElement("button");
        btn.className = "mmxd-gap-menu-btn";
        const draw = () => {
          const cur = options.find(o => o.value === seg[key]) || options[0];
          btn.innerHTML = `${caption}: <b style="color:#4fff8f">${cur.label}</b>`;
        };
        btn.title = tip;
        btn.onclick = (e) => {
          e.stopPropagation();
          const at = Math.max(0, options.findIndex(o => o.value === (seg[key] || fallback)));
          seg[key] = options[(at + 1) % options.length].value;
          draw();
          onRefChange();
          this.commitChanges();
          this.render();
          if (this.node?._mmxRefreshPrompt) this.node._mmxRefreshPrompt();
        };
        draw();
        return btn;
      };
      if (trackType === "image" && (seg.type === "image" || seg.type === "video")) {
        refBtns.push(cycler("Used as", REF_ROLE_OPTIONS, "refRole", "picture", REF_ROLE_TIP));
        // Only meaningful once the image defines something rather than anchoring a frame:
        // it picks the noun the <Subject N> line uses. Built either way and shown on
        // demand, so cycling the role reveals it without reopening the menu. A slot in
        // the panel above is the place for a subject that needs a written description.
        const kindBtn = cycler("Defines a", SUBJECT_KIND_OPTIONS, "refKind", "person",
                               "What this image defines, for its <Subject N> line.");
        onRefChange = () => {
          kindBtn.style.display = seg.refRole === "subject" ? "" : "none";
        };
        onRefChange();
        refBtns.push(kindBtn);
        refBtns.push(cycler("Follow it", RETENTION_OPTIONS, "retention",
                            "fully_preserved", RETENTION_TIP));
      } else if (trackType === "motion") {
        refBtns.push(cycler("Used as", CLIP_ROLE_OPTIONS, "refRole", "reference",
                            CLIP_ROLE_TIP));
        refBtns.push(cycler("Follow it", RETENTION_OPTIONS, "retention",
                            "fully_preserved", RETENTION_TIP));
      } else if (trackType === "audio") {
        refBtns.push(cycler("Used as", CLIP_ROLE_OPTIONS, "refRole", "reference",
                            CLIP_ROLE_TIP));
        refBtns.push(cycler("Audio use", RETENTION_AUDIO_OPTIONS, "retention",
                            "reference", RETENTION_AUDIO_TIP));
      }
    } else if (trackType === "audio") {
      const btn = document.createElement("button");
      btn.className = "mmxd-gap-menu-btn";
      btn.title = AUDIO_LOCK_TIP;
      const draw = () => {
        const cur = AUDIO_LOCK_OPTIONS.find(o => o.value === seg.retention) || AUDIO_LOCK_OPTIONS[0];
        btn.innerHTML = `Audio use: <b style="color:#4fff8f">${cur.label}</b>`;
      };
      btn.onclick = (e) => {
        e.stopPropagation();
        seg.retention = seg.retention === "lock" ? "reference" : "lock";
        draw();
        this.commitChanges();
        this.render();
        if (this.node?._mmxRefreshPrompt) this.node._mmxRefreshPrompt();
      };
      draw();
      refBtns.push(btn);
    }

    // ==========================================
    // 6. Define Delete Option
    // ==========================================
    const delBtn = document.createElement("button");
    delBtn.className = "mmxd-gap-menu-btn";
    delBtn.innerHTML = `Delete`;
    delBtn.style.color = "#ff4444";
    delBtn.onclick = () => {
      this.selectionType = trackType;
      const list = this.getSegmentArray(trackType);
      this.selectedIndex = list.findIndex(s => s.id === seg.id);
      this.deleteSelectedSegment();
      this.dismissContextMenu();
    };

    // Very top: Split at Playhead (if active/available)
    if (splitBtn) {
      menu.appendChild(splitBtn);
      menu.appendChild(makeDivider());
    }

    // Group 1: Segment Options (Always present)
    menu.appendChild(copySegBtn);
    menu.appendChild(pasteSegBtn);
    menu.appendChild(pasteReplaceBtn);
    menu.appendChild(makeDivider());

    // Group 2: Prompt Options (Only if not audio)
    if (copyPromptBtn && pastePromptBtn) {
      menu.appendChild(copyPromptBtn);
      menu.appendChild(pastePromptBtn);
      menu.appendChild(makeDivider());
    }

    // Group 3: Image Options (Only if isImage)
    if (isImage) {
      menu.appendChild(copyImgBtn);
      menu.appendChild(saveImgBtn);
      menu.appendChild(openImgBtn);
      menu.appendChild(replaceImgBtn);
      menu.appendChild(replaceWithFileBtn);
      menu.appendChild(makeDivider());
    }

    // Group 4: Convert to End Frame (Only if toggleEndFrameBtn is defined)
    if (toggleEndFrameBtn) {
      menu.appendChild(toggleEndFrameBtn);
      menu.appendChild(makeDivider());
    }

    // Group 5a: what this reference is for, and how closely to follow it
    if (refBtns.length) {
      refBtns.forEach(b => menu.appendChild(b));
      menu.appendChild(makeDivider());
    }

    // Group 5: Unlink Media & Mark Selection
    if (unlinkBtn) {
      menu.appendChild(unlinkBtn);
      menu.appendChild(makeDivider());
    }
    menu.appendChild(markSelectionBtn);
    menu.appendChild(makeDivider());

    // Group 6: Delete Option
    menu.appendChild(delBtn);

    document.body.appendChild(menu);
    this._contextMenu = menu;

    setTimeout(() => {
      this._contextMenuDismisser = (ev) => { if (!menu.contains(ev.target)) this.dismissContextMenu(); };
      document.addEventListener("pointerdown", this._contextMenuDismisser, true);
    }, 0);
  }

  showGapContextMenu(clientX, clientY, gap) {
    this.dismissContextMenu();
    const menu = document.createElement("div");
    menu.className = "mmxd-gap-menu";
    menu.style.left = `${clientX + 6}px`;
    menu.style.top = `${clientY - 10}px`;

    const currentTrack = gap.track;

    const hasCopied = this._copiedSegment || window._mmxCopiedSegmentCS;
    const copiedTrack = this._copiedSegmentTrack || window._mmxCopiedSegmentTypeCS;
    const copiedSegData = this._copiedSegment || (window._mmxCopiedSegmentCS ? window._mmxCopiedSegmentCS.main : null);
    const copiedSibData = window._mmxCopiedSegmentCS ? window._mmxCopiedSegmentCS.sibling : null;

    const canPaste = hasCopied && this.getCanonicalTrack(copiedTrack) === this.getCanonicalTrack(currentTrack) && copiedSegData;
    const pasteBtn = document.createElement("button");
    pasteBtn.className = "mmxd-gap-menu-btn";
    pasteBtn.innerHTML = `Paste Segment`;
    if (!canPaste) {
      pasteBtn.disabled = true;
      pasteBtn.style.opacity = "0.4";
      pasteBtn.style.cursor = "not-allowed";
      pasteBtn.title = "No matching segment copied to clipboard";
    } else {
      pasteBtn.onclick = () => {
        const startFrame = Math.round(gap.clickedFrame !== undefined ? gap.clickedFrame : gap.frameStart);
        this.pasteSegmentAtFrame(copiedSegData, this.getCanonicalTrack(copiedTrack), copiedSibData, startFrame);
        this.dismissContextMenu();
      };
    }
    menu.appendChild(pasteBtn);

    if (currentTrack === "image") {
      const textBtn = document.createElement("button");
      textBtn.className = "mmxd-gap-menu-btn";
      textBtn.innerHTML = `${ICONS.text} Text Segment`;
      textBtn.onclick = () => {
        this.addSegmentInGap(gap.frameStart, gap.frameEnd, "text");
        this.dismissContextMenu();
      };
      menu.appendChild(textBtn);

      const imgBtn = document.createElement("button");
      imgBtn.className = "mmxd-gap-menu-btn";
      imgBtn.innerHTML = `${ICONS.upload} Image Segment`;
      imgBtn.onclick = () => {
        this.dismissContextMenu();
        const fi = document.createElement("input");
        fi.type = "file"; fi.accept = "image/*";
        fi.addEventListener("change", (ev) => {
          if (ev.target.files?.[0]) {
            const gapLength = gap.frameEnd - gap.frameStart;
            this.handleImageUpload([ev.target.files[0]], gap.frameStart, gapLength);
          }
        });
        fi.click();
      };
      menu.appendChild(imgBtn);

      const pasteImageBtn = document.createElement("button");
      pasteImageBtn.className = "mmxd-gap-menu-btn";
      pasteImageBtn.innerHTML = `${ICONS.upload} Paste Image`;
      this._checkClipboardForImage(pasteImageBtn);
      pasteImageBtn.onclick = async () => {
        this.dismissContextMenu();
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const imageTypes = item.types.filter(type => type.startsWith("image/"));
            if (imageTypes.length > 0) {
              const blob = await item.getType(imageTypes[0]);
              const file = new File([blob], "clipboard.png", { type: blob.type });
              const startFrame = Math.round(gap.clickedFrame !== undefined ? gap.clickedFrame : gap.frameStart);
              const gapLength = gap.frameEnd - startFrame;

              await this.handleImageUpload([file], startFrame, gapLength);
              break;
            }
          }
        } catch (err) {
          console.error("Failed to paste image from clipboard", err);
        }
      };

      const vidBtn = document.createElement("button");
      vidBtn.className = "mmxd-gap-menu-btn";
      vidBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> Video Segment`;
      vidBtn.onclick = () => {
        this.dismissContextMenu();
        const fi = document.createElement("input");
        fi.type = "file"; fi.accept = "video/*";
        fi.addEventListener("change", (ev) => {
          if (ev.target.files?.[0]) this.handleVideoUpload([ev.target.files[0]], gap.frameStart);
        });
        fi.click();
      };

      menu.appendChild(vidBtn);
      menu.appendChild(pasteImageBtn);
    } else if (currentTrack === "motion") {
      const vidBtn = document.createElement("button");
      vidBtn.className = "mmxd-gap-menu-btn";
      vidBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> Video Segment`;
      vidBtn.onclick = () => {
        this.dismissContextMenu();
        this.promptAddMotionInGap(gap.frameStart, gap.frameEnd);
      };
      menu.appendChild(vidBtn);
    } else if (currentTrack === "audio") {
      const audBtn = document.createElement("button");
      audBtn.className = "mmxd-gap-menu-btn";
      audBtn.innerHTML = `${ICONS.audio} Audio Segment`;
      audBtn.onclick = () => {
        this.dismissContextMenu();
        this.promptAddAudioInGap(gap.frameStart, gap.frameEnd);
      };
      menu.appendChild(audBtn);
    }

    document.body.appendChild(menu);
    this._contextMenu = menu;
    setTimeout(() => {
      this._contextMenuDismisser = (ev) => { if (!menu.contains(ev.target)) this.dismissContextMenu(); };
      document.addEventListener("pointerdown", this._contextMenuDismisser, true);
      document.addEventListener("wheel", this._contextMenuDismisser, true);
    }, 0);
  }
  dismissContextMenu() {
    if (this._contextMenu) { this._contextMenu.remove(); this._contextMenu = null; }
    if (this._contextMenuDismisser) {
      document.removeEventListener("pointerdown", this._contextMenuDismisser, true);
      document.removeEventListener("wheel", this._contextMenuDismisser, true);
      this._contextMenuDismisser = null;
    }
  }

  // --- Gap Popup Menu ---
  showGapMenu(clientX, clientY, gap) {
    this.dismissGapMenu();
    const menu = document.createElement("div");
    menu.className = "mmxd-gap-menu";
    menu.style.left = `${clientX + 6}px`;
    menu.style.top = `${clientY - 10}px`;

    const currentTrack = gap.track;

    if (currentTrack === "image") {
      const textBtn = document.createElement("button");
      textBtn.className = "mmxd-gap-menu-btn";
      textBtn.innerHTML = `${ICONS.text} Text Segment`;
      textBtn.addEventListener("click", () => {
        this.addSegmentInGap(gap.frameStart, gap.frameEnd, "text");
        this.dismissGapMenu();
      });

      const imgBtn = document.createElement("button");
      imgBtn.className = "mmxd-gap-menu-btn";
      imgBtn.innerHTML = `${ICONS.upload} Image Segment`;
      imgBtn.addEventListener("click", () => {
        this.dismissGapMenu();
        const fi = document.createElement("input");
        fi.type = "file"; fi.accept = "image/*";
        fi.addEventListener("change", (ev) => {
          if (ev.target.files?.[0]) {
            const gapLength = gap.frameEnd - gap.frameStart;
            this.handleImageUpload([ev.target.files[0]], gap.frameStart, gapLength);
          }
        });
        fi.click();
      });

      const pasteImageBtn = document.createElement("button");
      pasteImageBtn.className = "mmxd-gap-menu-btn";
      pasteImageBtn.innerHTML = `${ICONS.upload} Paste Image`;
      this._checkClipboardForImage(pasteImageBtn);
      pasteImageBtn.addEventListener("click", async () => {
        this.dismissGapMenu();
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const imageTypes = item.types.filter(type => type.startsWith("image/"));
            if (imageTypes.length > 0) {
              const blob = await item.getType(imageTypes[0]);
              const file = new File([blob], "clipboard.png", { type: blob.type });
              const gapLength = gap.frameEnd - gap.frameStart;
              await this.handleImageUpload([file], gap.frameStart, gapLength);
              break;
            }
          }
        } catch (err) {
          console.error("Failed to paste image from clipboard", err);
        }
      });

      const vidBtn = document.createElement("button");
      vidBtn.className = "mmxd-gap-menu-btn";
      vidBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> Video Segment`;
      vidBtn.addEventListener("click", () => {
        this.dismissGapMenu();
        const fi = document.createElement("input");
        fi.type = "file"; fi.accept = "video/*";
        fi.addEventListener("change", (ev) => {
          if (ev.target.files?.[0]) {
            this.handleVideoUpload([ev.target.files[0]], gap.frameStart);
          }
        });
        fi.click();
      });

      menu.appendChild(textBtn);
      menu.appendChild(imgBtn);
      menu.appendChild(vidBtn);
      menu.appendChild(pasteImageBtn);
    } else if (currentTrack === "motion") {
      const vidBtn = document.createElement("button");
      vidBtn.className = "mmxd-gap-menu-btn";
      vidBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> Video Segment`;
      vidBtn.addEventListener("click", () => {
        this.dismissGapMenu();
        this.promptAddMotionInGap(gap.frameStart, gap.frameEnd);
      });
      menu.appendChild(vidBtn);
    } else if (currentTrack === "audio") {
      const audBtn = document.createElement("button");
      audBtn.className = "mmxd-gap-menu-btn";
      audBtn.innerHTML = `${ICONS.audio} Audio Segment`;
      audBtn.addEventListener("click", () => {
        this.dismissGapMenu();
        this.promptAddAudioInGap(gap.frameStart, gap.frameEnd);
      });
      menu.appendChild(audBtn);
    }

    const hasCopied = this._copiedSegment || window._mmxCopiedSegmentCS;
    const copiedTrack = this._copiedSegmentTrack || window._mmxCopiedSegmentTypeCS;
    const copiedSegData = this._copiedSegment || (window._mmxCopiedSegmentCS ? window._mmxCopiedSegmentCS.main : null);
    const copiedSibData = window._mmxCopiedSegmentCS ? window._mmxCopiedSegmentCS.sibling : null;

    const canPaste = hasCopied && this.getCanonicalTrack(copiedTrack) === this.getCanonicalTrack(currentTrack) && copiedSegData;
    const pasteBtn = document.createElement("button");
    pasteBtn.className = "mmxd-gap-menu-btn";
    pasteBtn.innerHTML = `Paste Segment`;
    if (!canPaste) {
      pasteBtn.disabled = true;
      pasteBtn.style.opacity = "0.4";
      pasteBtn.style.cursor = "not-allowed";
      pasteBtn.title = "No matching segment copied to clipboard";
    } else {
      pasteBtn.onclick = () => {
        const startFrame = Math.round(gap.frameStart);
        this.pasteSegmentAtFrame(copiedSegData, this.getCanonicalTrack(copiedTrack), copiedSibData, startFrame);
        this.dismissGapMenu();
      };
    }
    menu.appendChild(pasteBtn);

    document.body.appendChild(menu);
    this._gapMenu = menu;
    setTimeout(() => {
      this._gapMenuDismisser = (ev) => { if (!menu.contains(ev.target)) this.dismissGapMenu(); };
      document.addEventListener("pointerdown", this._gapMenuDismisser, true);
      document.addEventListener("wheel", this._gapMenuDismisser, true);
    }, 0);
  }

  dismissGapMenu() {
    if (this._gapMenu) { this._gapMenu.remove(); this._gapMenu = null; }
    if (this._gapMenuDismisser) {
      document.removeEventListener("pointerdown", this._gapMenuDismisser, true);
      document.removeEventListener("wheel", this._gapMenuDismisser, true);
      this._gapMenuDismisser = null;
    }
  }

  // --- Settings Menu ---
  // Widgets that are managed by the settings menu (hidden from node by default).
  get _settingsWidgetNames() {
    return ["display_mode", "shift_video", "shift_audio", "divisible_by", "img_compression"];
  }

  // Hide all settings widgets on the node (called on init).
  hideSettingsWidgets() {
    const isLiteGraph = !window.LiteGraph || !window.LiteGraph.vueNodesMode;
    // If any settings widgets have active connections, show settings widgets instead
    let hasActiveSettings = false;
    for (const name of this._settingsWidgetNames) {
      const hasInput = this.node.inputs?.find(i => i.name === name);
      if (hasInput && hasInput.link != null) {
        hasActiveSettings = true;
        break;
      }
    }

    if (hasActiveSettings) {
      this.showSettingsWidgets();
      return;
    }

    for (const name of this._settingsWidgetNames) {
      const w = this.node.widgets?.find(w => w.name === name);
      if (w) {
        hideWidget(w);
        // If it was converted to an input slot but is unconnected, remove the input slot
        if (isLiteGraph && this.node.inputs) {
          const idx = this.node.inputs.findIndex(i => i.name === name);
          if (idx !== -1 && this.node.inputs[idx].link == null) {
            this.node.removeInput(idx);
          }
        }
      }
    }
    this.updateWidgetVisibility();

    // Workaround: toggle display mode to force ComfyUI to refresh the node
    if (this.displayModeWidget) {
      const origVal = this.displayModeWidget.value;
      const otherVal = origVal === "frames" ? "seconds" : "frames";

      this.displayModeWidget.value = otherVal;
      if (this.displayModeWidget.callback) this.displayModeWidget.callback(otherVal);

      this.displayModeWidget.value = origVal;
      if (this.displayModeWidget.callback) this.displayModeWidget.callback(origVal);
    }
  }

  // Restore all settings widgets on the node.
  showSettingsWidgets() {
    const isLiteGraph = !window.LiteGraph || !window.LiteGraph.vueNodesMode;
    for (const name of this._settingsWidgetNames) {
      const w = this.node.widgets?.find(w => w.name === name);
      if (!w) continue;
      showWidget(w);

      // If the widget is a converted-widget but the input slot is missing, add it back!
      if (isLiteGraph && w.type === "converted-widget" && this.node.inputs) {
        if (!this.node.inputs.find(i => i.name === name)) {
          let type = "FLOAT";
          if (name === "divisible_by" || name === "img_compression") {
            type = "INT";
          } else if (name === "display_mode") {
            type = "COMBO";
          }
          const slot = this.node.addInput(name, type);
          if (slot != null) {
            const inp = this.node.inputs[this.node.inputs.length - 1];
            if (inp) inp.widget = { name };
          }
        }
      }
    }
    this.updateWidgetVisibility();

    // Workaround: toggle display mode to force ComfyUI to refresh the node
    if (this.displayModeWidget) {
      const origVal = this.displayModeWidget.value;
      const otherVal = origVal === "frames" ? "seconds" : "frames";

      this.displayModeWidget.value = otherVal;
      if (this.displayModeWidget.callback) this.displayModeWidget.callback(otherVal);

      this.displayModeWidget.value = origVal;
      if (this.displayModeWidget.callback) this.displayModeWidget.callback(origVal);
    }
  }

  // --- Save / Load Handlers ---
  async handleLoadTimeline() {
    try {
      if (window.showOpenFilePicker) {
        const [fileHandle] = await window.showOpenFilePicker({
          types: [{ description: 'Timeline JSON', accept: { 'application/json': ['.json'] } }],
          multiple: false
        });
        const file = await fileHandle.getFile();
        const content = await file.text();
        this._applyLoadedTimeline(content, fileHandle);
      } else {
        // Fallback for browsers without showOpenFilePicker (e.g. Firefox)
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = e => {
          const file = e.target.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = evt => this._applyLoadedTimeline(evt.target.result, null);
          reader.readAsText(file);
        };
        input.click();
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        console.error("Failed to load timeline:", e);
        alert("Failed to load timeline. See console for details.");
      }
    }
  }

  _applyLoadedTimeline(jsonStr, fileHandle) {
    try {
      const data = JSON.parse(jsonStr);

      // Load settings if present
      if (data.global_prompt !== undefined) {
        if (data.retake_global_prompt !== undefined) {
          this.timeline.global_prompt = data.global_prompt;
          this.timeline.retake_global_prompt = data.retake_global_prompt;
        } else {
          this.syncGlobalPrompt(data.global_prompt);
        }
      }
      if (data.settings) {
        for (const [key, value] of Object.entries(data.settings)) {
          // Handle legacy keys for backward compatibility
          if (key === "startFrames" && this.startFramesWidget) {
            this.startFramesWidget.value = value;
            if (this.startFramesWidget.callback) this.startFramesWidget.callback(value);
            continue;
          }
          if (key === "durationFrames" && this.durationFramesWidget) {
            this.durationFramesWidget.value = value;
            if (this.durationFramesWidget.callback) this.durationFramesWidget.callback(value);
            continue;
          }
          if (key === "frameRate" && this.frameRateWidget) {
            this.frameRateWidget.value = value;
            if (this.frameRateWidget.callback) this.frameRateWidget.callback(value);
            continue;
          }

          const w = this.node.widgets?.find(x => x.name === key);
          if (w) {
            w.value = value;
            if (w.callback) w.callback(w.value);
          }
        }
      }

      if (this.timelineDataWidget) this.timelineDataWidget.value = JSON.stringify(data.timeline || data);
      this.timeline = parseInitial(this.timelineDataWidget.value);
      this.mainTrackEnabled = this.timeline.mainTrackEnabled !== false;
      this.audioTrackEnabled = this.timeline.audioTrackEnabled !== false;
      this.motionTrackEnabled = this.timeline.motionTrackEnabled !== false;
      if (this.timeline.showFilenames !== undefined) {
        this.node.properties.showFilenames = this.timeline.showFilenames;
      }
      if (this.timeline.showPromptZones !== undefined) {
        this.node.properties.showPromptZones = this.timeline.showPromptZones;
      }
      if (this.timeline.overrideAudio !== undefined) {
        this.node.properties.overrideAudio = this.timeline.overrideAudio;
      }
      if (this.timeline.inpaint_audio !== undefined) {
        this.node.properties.inpaint_audio = this.timeline.inpaint_audio;
      }
      if (this.timeline.propHeight !== undefined) {
        this.node.properties.propHeight = this.timeline.propHeight;
        this.propHeight = this.timeline.propHeight;
        if (this.propContainer) {
          this.propContainer.style.height = `${this.propHeight}px`;
        }
      }
      if (this.timeline.globalPropHeight !== undefined) {
        const h = Math.max(this.timeline.globalPropHeight, GLOBAL_PROP_MIN_H);
        this.node.properties.globalPropHeight = h;
        this.globalPropHeight = h;
        if (this.globalPropContainer) {
          this.globalPropContainer.style.height = `${this.globalPropHeight}px`;
        }
      }
      this.currentFileHandle = fileHandle;
      this.retakeMode = this.timeline.retakeMode === true;

      this.loadMedia();

      if (!this.retakeMode) {
        this._suppressCommit = true;
        if (this.timeline.normalStartFrame !== undefined && this.startFramesWidget) {
          this.startFramesWidget.value = this.timeline.normalStartFrame;
          if (this.startFramesWidget.callback) {
            try { this.startFramesWidget.callback(this.timeline.normalStartFrame); } catch (_) {}
          }
        }
        if (this.timeline.normalDurationFrames !== undefined && this.durationFramesWidget) {
          this.durationFramesWidget.value = this.timeline.normalDurationFrames;
          if (this.durationFramesWidget.callback) {
            try { this.durationFramesWidget.callback(this.timeline.normalDurationFrames); } catch (_) {}
          }
        }
        this._suppressCommit = false;
      }

      this.updateRetakeUIState();
      this.updateUIFromSelection();
      this.syncWidgetsAndUI();
      if (this.updateCharacterSlotsUI) this.updateCharacterSlotsUI();
      this.commitChanges(true); // forces sync to UI and other widgets


      if (this.updateInpaintToggleStyle) {
        const inpaintWidget = this.node.widgets?.find(w => w.name === "inpaint_audio");
        if (inpaintWidget) this.updateInpaintToggleStyle(inpaintWidget.value);
      }

      this.render();
      this.dismissSettingsMenu();

      // Refresh the Resolution / Timing settings panel from the freshly loaded widget
      // values. The panel inputs are plain DOM elements that only re-read widgets when
      // explicitly refreshed (panel build + onConfigure) - without this, loading a
      // timeline .json updates the widgets (generation is correct) but the panel keeps
      // displaying the previous Duration/Start/End/resolution values.
      if (this.node._mmxSettingsRefresh) { try { this.node._mmxSettingsRefresh(); } catch (_) { } }

      // Trigger ComfyUI's change-detection pipeline the same way a real user
      // interaction does: by dispatching a pointerup on the canvas. This fires
      // LiteGraph's onAfterChange → ChangeTracker.captureCanvasState() →
      // workflowDraftStore.saveDraft() → localStorage. This is what the user
      // experiences when they "move something" and it persists correctly.
      setTimeout(() => {
        try {
          const canvasEl = app.canvasEl || app.canvas?.canvas;
          if (canvasEl) {
            canvasEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
          }
          // Also try the direct ChangeTracker API as a backup for both frontend versions
          if (app.canvas && app.canvas.checkState) app.canvas.checkState();
          if (app.canvas && app.canvas.captureCanvasState) app.canvas.captureCanvasState();
        } catch (_) { }
      }, 100);
    } catch (e) {
      console.error("Invalid timeline JSON:", e);
      alert("Invalid timeline file.");
    }
  }

  _getTimelineSavePayload() {
    const allSettings = {};
    const skipWidgets = ["timeline_data", "local_prompts", "segment_lengths", "guide_strength", "timeline_ui", "global_prompt"];

    for (const w of this.node.widgets || []) {
      if (!skipWidgets.includes(w.name) && w.value !== undefined) {
        allSettings[w.name] = w.value;
      }
    }

    const normPrompt = this.retakeMode ? (this.timeline.global_prompt || "") : (this.globalPromptInput ? this.globalPromptInput.value : "");
    const retPrompt = this.retakeMode ? (this.globalPromptInput ? this.globalPromptInput.value : "") : (this.timeline.retake_global_prompt || "");

    return JSON.stringify({
      version: 1,
      settings: allSettings,
      global_prompt: normPrompt,
      retake_global_prompt: retPrompt,
      timeline: {
        mainTrackEnabled: this.mainTrackEnabled,
        audioTrackEnabled: this.audioTrackEnabled,
        motionTrackEnabled: this.motionTrackEnabled,
        showFilenames: !!this.node.properties.showFilenames,
        showPromptZones: !!this.node.properties.showPromptZones,
        overrideAudio: !!this.node.properties.overrideAudio,
        inpaint_audio: !!(this.node.widgets?.find(w => w.name === "inpaint_audio")?.value),
        propHeight: this.propHeight,
        globalPropHeight: this.globalPropHeight,
        global_prompt: normPrompt,
        retake_global_prompt: retPrompt,
        // keep in step with the allowlist in commitChanges: a key missing here is silently lost on Save
        overall_soundscape: this.soundscapeInput ? this.soundscapeInput.value : (this.timeline.overall_soundscape || ""),
        non_diegetic_music: this.musicInput ? this.musicInput.value : (this.timeline.non_diegetic_music || ""),
        prompt_override: this.timeline.prompt_override || "",
        prompt_override_on: !!this.timeline.prompt_override_on,
        retakeMode: this.retakeMode,
        retakeStart: this.timeline.retakeStart,
        retakeLength: this.timeline.retakeLength,
        retakePrompt: this.timeline.retakePrompt,
        retakeStrength: this.timeline.retakeStrength,
        retakeVideo: this.timeline.retakeVideo ? {
          fileName: this.timeline.retakeVideo.fileName,
          imageFile: this.timeline.retakeVideo.imageFile,
          videoDurationFrames: this.timeline.retakeVideo.videoDurationFrames,
          fileSize: this.timeline.retakeVideo.fileSize,
        } : null,
        normalStartFrame: this.timeline.normalStartFrame,
        normalDurationFrames: this.timeline.normalDurationFrames,
        reference_mode: this.timeline.reference_mode || "OFF",
        prompt_format: this.timeline.prompt_format || "minimax",
        analyzeProvider: this.timeline.analyzeProvider || "ollama",
        analyzeBaseUrl: this.timeline.analyzeBaseUrl || "",
        analyzeModel: this.timeline.analyzeModel || "",
        summary: this.timeline.summary || "",
        task_type_override: this.timeline.task_type_override || "",
        subjectSlotCount: this.visibleSlotCount(),
        subjects: this.subjectSlots().slice(0, this.visibleSlotCount()).map(c => ({
          images: (c.images || []).map(img => img.b64 ? { b64: img.b64, name: img.name } : { name: img.name }),
          description: c.description || "",
          shortName: c.shortName || "",
          kind: c.kind || "person",
          retention: c.retention || "fully_preserved",
          retentionNote: c.retentionNote || "",
          voice: voicePayload(c.voice)
        })),
        segments: (this.timeline.segments || []).map(s => {
          const { imgObj, videoEl, _isSeeking, thumbnails, _extractingThumbs, _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, ...rest } = s;
          return rest;
        }),
        motionSegments: (this.timeline.motionSegments || []).map(s => {
          const { imgObj, videoEl, _isSeeking, thumbnails, _extractingThumbs, _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, ...rest } = s;
          return rest;
        }),
        audioSegments: (this.timeline.audioSegments || []).map(s => {
          const { _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _decoding, _blobUrl, _audioBuffer, ...rest } = s;
          return rest;
        })
      }
    }, null, 2);
  }

  async handleSaveTimeline() {
    if (!this.currentFileHandle) {
      return this.handleSaveTimelineAs();
    }

    try {
      const payload = this._getTimelineSavePayload();
      const writable = await this.currentFileHandle.createWritable();
      await writable.write(payload);
      await writable.close();
      this.dismissSettingsMenu();
    } catch (e) {
      console.error("Failed to save timeline:", e);
      alert("Failed to save. You may need to use Save As.");
    }
  }

  async handleSaveTimelineAs() {
    const payload = this._getTimelineSavePayload();

    try {
      if (window.showSaveFilePicker) {
        const fileHandle = await window.showSaveFilePicker({
          suggestedName: "timeline_export.json",
          types: [{ description: 'Timeline JSON', accept: { 'application/json': ['.json'] } }]
        });
        const writable = await fileHandle.createWritable();
        await writable.write(payload);
        await writable.close();
        this.currentFileHandle = fileHandle;
      } else {
        // Fallback for Firefox
        const blob = new Blob([payload], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "timeline_export.json";
        a.click();
        URL.revokeObjectURL(url);
        // Can't track file handle via download fallback
        this.currentFileHandle = null;
      }
      this.dismissSettingsMenu();
    } catch (e) {
      if (e.name !== "AbortError") {
        console.error("Failed to save timeline as:", e);
      }
    }
  }

  _makeSettingRow(label, inputEl) {
    const row = document.createElement("div");
    row.className = "mmxd-settings-row";
    const lbl = document.createElement("span");
    lbl.className = "mmxd-settings-label";
    lbl.textContent = label;
    row.appendChild(lbl);
    row.appendChild(inputEl);
    return row;
  }

  showSettingsMenu(anchorEl) {
    this.dismissSettingsMenu();
    const menu = document.createElement("div");
    menu.className = "mmxd-settings-menu";
    // Set sizing inline so it applies even if the injected stylesheet is cached/stale.
    menu.style.width = "560px";
    menu.style.maxWidth = "92vw";
    menu.style.maxHeight = "60vh";
    menu.style.overflowY = "auto";

    // Title & Close Button Container
    const titleContainer = document.createElement("div");
    titleContainer.className = "mmxd-settings-title";
    titleContainer.style.display = "flex";
    titleContainer.style.justifyContent = "space-between";
    titleContainer.style.alignItems = "center";

    const titleText = document.createElement("span");
    titleText.textContent = "Timeline Settings";
    titleContainer.appendChild(titleText);

    const closeBtn = document.createElement("button");
    closeBtn.className = "mmxd-settings-close-btn";
    closeBtn.innerHTML = ICONS.close;
    closeBtn.title = "Close Settings";
    closeBtn.addEventListener("click", () => this.dismissSettingsMenu());
    titleContainer.appendChild(closeBtn);

    menu.appendChild(titleContainer);

    // --- Save / Load / Show Widgets Grid (2x2) ---
    const gridContainer = document.createElement("div");
    gridContainer.style.display = "grid";
    gridContainer.style.gridTemplateColumns = "repeat(2, 1fr)";
    gridContainer.style.gap = "6px";
    gridContainer.style.marginBottom = "4px";

    const btnSave = document.createElement("button");
    btnSave.className = "mmxd-settings-toggle-btn";
    btnSave.textContent = "Save Timeline";
    btnSave.addEventListener("click", () => this.handleSaveTimeline());
    gridContainer.appendChild(btnSave);

    const btnSaveAs = document.createElement("button");
    btnSaveAs.className = "mmxd-settings-toggle-btn";
    btnSaveAs.textContent = "Save Timeline As";
    btnSaveAs.addEventListener("click", () => this.handleSaveTimelineAs());
    gridContainer.appendChild(btnSaveAs);

    const btnLoad = document.createElement("button");
    btnLoad.className = "mmxd-settings-toggle-btn";
    btnLoad.textContent = "Load Timeline";
    btnLoad.addEventListener("click", () => this.handleLoadTimeline());
    gridContainer.appendChild(btnLoad);

    // --- Show/Hide on Node Toggle ---
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "mmxd-settings-toggle-btn";
    const widgetsVisible = !!(this.node.widgets?.find(w => w.name === "display_mode" && !(w.options && w.options.hidden)));
    toggleBtn.textContent = widgetsVisible ? "Hide Widgets" : "Show Widgets";
    toggleBtn.addEventListener("click", () => {
      const nowVisible = !!(this.node.widgets?.find(w => w.name === "display_mode" && !(w.options && w.options.hidden)));
      if (nowVisible) {
        this.hideSettingsWidgets();
        const stillVisible = !!(this.node.widgets?.find(w => w.name === "display_mode" && !(w.options && w.options.hidden)));
        toggleBtn.textContent = stillVisible ? "Hide Widgets" : "Show Widgets";
      } else {
        this.showSettingsWidgets();
        toggleBtn.textContent = "Hide Widgets";
      }
    });
    gridContainer.appendChild(toggleBtn);

    menu.appendChild(gridContainer);

    const div2 = document.createElement("hr");
    div2.className = "mmxd-settings-divider";
    menu.appendChild(div2);

    // Helper: fire a widget's callback safely
    const fireCallback = (w, val) => {
      w.value = val;
      if (w.callback) {
        try { w.callback(val, app.canvas, this.node, null, null); } catch (e) { }
      }
      if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
    };

    // --- Display Mode ---
    const dmWidget = this.node.widgets?.find(w => w.name === "display_mode");
    if (dmWidget) {
      const ctrl = document.createElement("div");
      ctrl.className = "mmxd-segmented-control";

      const framesSeg = document.createElement("div");
      framesSeg.className = "mmxd-segment";
      framesSeg.textContent = "Frames";

      const secondsSeg = document.createElement("div");
      secondsSeg.className = "mmxd-segment";
      secondsSeg.textContent = "Seconds";

      const updateActive = (val) => {
        if (val === "frames") {
          framesSeg.classList.add("active");
          secondsSeg.classList.remove("active");
        } else {
          secondsSeg.classList.add("active");
          framesSeg.classList.remove("active");
        }
      };

      updateActive(dmWidget.value);

      const onSegClick = (val) => {
        fireCallback(dmWidget, val);
        updateActive(val);
        // Update ruler/timecode immediately
        if (this.updateWidgetVisibility) this.updateWidgetVisibility();
        if (this.updateUIFromSelection) this.updateUIFromSelection();
        this.render();
      };

      framesSeg.addEventListener("click", () => onSegClick("frames"));
      secondsSeg.addEventListener("click", () => onSegClick("seconds"));

      ctrl.appendChild(secondsSeg);
      ctrl.appendChild(framesSeg);

      menu.appendChild(this._makeSettingRow("Display Mode", ctrl));
    }



    // --- Show Filenames Toggle ---
    const showFnameCtrl = document.createElement("div");
    showFnameCtrl.className = "mmxd-segmented-control";

    const offSeg = document.createElement("div");
    offSeg.className = "mmxd-segment";
    offSeg.textContent = "Off";

    const onSeg = document.createElement("div");
    onSeg.className = "mmxd-segment";
    onSeg.textContent = "On";

    const updateFnameActive = (isEnabled) => {
      if (isEnabled) {
        onSeg.classList.add("active");
        offSeg.classList.remove("active");
      } else {
        offSeg.classList.add("active");
        onSeg.classList.remove("active");
      }
    };

    updateFnameActive(!!this.node.properties.showFilenames);

    const onFnameSegClick = (isEnabled) => {
      this.node.properties.showFilenames = isEnabled;
      updateFnameActive(isEnabled);
      this.render();
      this.commitChanges(true);
    };

    offSeg.addEventListener("click", () => onFnameSegClick(false));
    onSeg.addEventListener("click", () => onFnameSegClick(true));

    showFnameCtrl.appendChild(onSeg);
    showFnameCtrl.appendChild(offSeg);

    menu.appendChild(this._makeSettingRow("Show Filenames", showFnameCtrl));

    // --- Show Prompt Zones Toggle ---
    const showZonesCtrl = document.createElement("div");
    showZonesCtrl.className = "mmxd-segmented-control";

    const zonesOffSeg = document.createElement("div");
    zonesOffSeg.className = "mmxd-segment";
    zonesOffSeg.textContent = "Off";

    const zonesOnSeg = document.createElement("div");
    zonesOnSeg.className = "mmxd-segment";
    zonesOnSeg.textContent = "On";

    const updateZonesActive = (isEnabled) => {
      if (isEnabled) {
        zonesOnSeg.classList.add("active");
        zonesOffSeg.classList.remove("active");
      } else {
        zonesOffSeg.classList.add("active");
        zonesOnSeg.classList.remove("active");
      }
    };

    updateZonesActive(!!this.node.properties.showPromptZones);

    const onZonesSegClick = (isEnabled) => {
      this.node.properties.showPromptZones = isEnabled;
      updateZonesActive(isEnabled);
      this.render();
      this.commitChanges(true);
    };

    zonesOffSeg.addEventListener("click", () => onZonesSegClick(false));
    zonesOnSeg.addEventListener("click", () => onZonesSegClick(true));

    showZonesCtrl.appendChild(zonesOnSeg);
    showZonesCtrl.appendChild(zonesOffSeg);

    menu.appendChild(this._makeSettingRow("Prompt Zones", showZonesCtrl));

    // --- Compiled prompt preview toggle ---
    const promptPrevCtrl = document.createElement("div");
    promptPrevCtrl.className = "mmxd-segmented-control";

    const ppOffSeg = document.createElement("div");
    ppOffSeg.className = "mmxd-segment";
    ppOffSeg.textContent = "Off";

    const ppOnSeg = document.createElement("div");
    ppOnSeg.className = "mmxd-segment";
    ppOnSeg.textContent = "On";

    const updatePromptPrevActive = (isEnabled) => {
      ppOnSeg.classList.toggle("active", !!isEnabled);
      ppOffSeg.classList.toggle("active", !isEnabled);
    };

    if (this.node.properties.showPromptPreview === undefined) {
      this.node.properties.showPromptPreview = true;
    }
    updatePromptPrevActive(!!this.node.properties.showPromptPreview);

    const onPromptPrevClick = (isEnabled) => {
      this.node.properties.showPromptPreview = isEnabled;
      updatePromptPrevActive(isEnabled);
      if (this.node._mmxSetPromptPreview) this.node._mmxSetPromptPreview(isEnabled);
      this.commitChanges(true);
    };

    ppOffSeg.addEventListener("click", () => onPromptPrevClick(false));
    ppOnSeg.addEventListener("click", () => onPromptPrevClick(true));

    promptPrevCtrl.appendChild(ppOnSeg);
    promptPrevCtrl.appendChild(ppOffSeg);

    menu.appendChild(this._makeSettingRow("Compiled Prompt", promptPrevCtrl));

    // --- Prompt format: MiniMax's documented notation vs the ComfyUI templates' ---
    const fmtCtrl = document.createElement("div");
    fmtCtrl.className = "mmxd-segmented-control";

    const fmtMmSeg = document.createElement("div");
    fmtMmSeg.className = "mmxd-segment";
    fmtMmSeg.textContent = "MiniMax";
    fmtMmSeg.title = "[Shot 1] … [Shot 2] At 00:05.000, … plus subject_definitions and "
      + "overall_soundscape — the notation MiniMax documents in their prompt guides.";

    const fmtCuSeg = document.createElement("div");
    fmtCuSeg.className = "mmxd-segment";
    fmtCuSeg.textContent = "ComfyUI";
    fmtCuSeg.title = "[0s-1.5s] … — the notation used by the ComfyUI H3 templates.";

    const updateFmtActive = (fmt) => {
      fmtMmSeg.classList.toggle("active", fmt !== "comfyui");
      fmtCuSeg.classList.toggle("active", fmt === "comfyui");
    };

    if (!this.timeline.prompt_format) this.timeline.prompt_format = "minimax";
    updateFmtActive(this.timeline.prompt_format);

    const onFmtClick = (fmt) => {
      this.timeline.prompt_format = fmt;
      updateFmtActive(fmt);
      this.commitChanges(true);
      if (this.node._mmxRefreshPrompt) this.node._mmxRefreshPrompt();
    };

    fmtMmSeg.addEventListener("click", () => onFmtClick("minimax"));
    fmtCuSeg.addEventListener("click", () => onFmtClick("comfyui"));

    fmtCtrl.appendChild(fmtMmSeg);
    fmtCtrl.appendChild(fmtCuSeg);

    menu.appendChild(this._makeSettingRow("Prompt Format", fmtCtrl));

    // The [task type] prefix on `summary` is derived from what the references are
    // actually used for. This is the escape hatch for the two the timeline cannot know —
    // `video editing` and `video continuation`, which need a source video this node has
    // no path to edit or continue.
    const taskInput = document.createElement("input");
    taskInput.type = "text";
    taskInput.className = "mmxd-settings-input";
    taskInput.placeholder = "auto — e.g. video continuation + keyframe completion";
    taskInput.value = this.timeline.task_type_override || "";
    taskInput.title =
      "Overrides the square-bracketed task type on the summary line.\n" +
      "Leave empty to derive it from the references in use.\n" +
      "Guide values: keyframe completion, reference generation, video editing,\n" +
      "video continuation, audio reuse, audio reference — joined with ' + '.";
    taskInput.addEventListener("input", () => {
      this.timeline.task_type_override = taskInput.value;
      this.commitChanges(true);
      if (this.node._mmxRefreshPrompt) this.node._mmxRefreshPrompt();
    });
    menu.appendChild(this._makeSettingRow("Task Type", taskInput));

    const divider2 = document.createElement("div");
    divider2.className = "mmxd-settings-divider";
    menu.appendChild(divider2);

    // Helper to create scrubbable number control with horizontal buttons
    const createScrubbableNumberControl = (w, step, min, max, isFloat = false) => {
      const container = document.createElement("div");
      container.className = "mmxd-number-control";

      const decBtn = document.createElement("button");
      decBtn.className = "mmxd-number-btn";
      decBtn.textContent = "-";

      const inp = document.createElement("input");
      inp.type = "number";
      inp.className = "mmxd-settings-input";
      inp.value = w.value;
      inp.step = step.toString();
      inp.min = min.toString();
      inp.max = max.toString();

      const incBtn = document.createElement("button");
      incBtn.className = "mmxd-number-btn";
      incBtn.textContent = "+";

      decBtn.addEventListener("click", () => {
        let val = parseFloat(inp.value) - step;
        if (val < min) val = min;
        inp.value = isFloat ? val.toFixed(4) : Math.round(val);
        fireCallback(w, parseFloat(inp.value));
      });

      incBtn.addEventListener("click", () => {
        let val = parseFloat(inp.value) + step;
        if (val > max) val = max;
        inp.value = isFloat ? val.toFixed(4) : Math.round(val);
        fireCallback(w, parseFloat(inp.value));
      });

      inp.addEventListener("change", () => {
        let val = parseFloat(inp.value);
        if (isNaN(val)) val = w.value;
        if (val < min) val = min;
        if (val > max) val = max;
        inp.value = isFloat ? val.toFixed(4) : Math.round(val);
        fireCallback(w, parseFloat(inp.value));
      });

      // Dragging logic
      let isDragging = false;
      let startX = 0;
      let startVal = 0;
      let hasMoved = false;

      inp.style.cursor = "ew-resize";

      inp.addEventListener("mousedown", (e) => {
        startX = e.clientX;
        startVal = parseFloat(inp.value);
        hasMoved = false;

        const onMouseMove = (moveEvent) => {
          const deltaX = moveEvent.clientX - startX;
          if (Math.abs(deltaX) > 3) {
            hasMoved = true;
            isDragging = true;
          }

          if (isDragging) {
            moveEvent.preventDefault();
            const sensitivity = isFloat ? 0.001 : 0.5;
            let newVal = startVal + deltaX * sensitivity;

            if (newVal < min) newVal = min;
            if (newVal > max) newVal = max;

            inp.value = isFloat ? newVal.toFixed(4) : Math.round(newVal);
            fireCallback(w, parseFloat(inp.value));
          }
        };

        const onMouseUp = () => {
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);

          if (!hasMoved) {
            inp.focus();
            inp.select();
          }
          isDragging = false;
        };

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      });

      container.appendChild(decBtn);
      container.appendChild(inp);
      container.appendChild(incBtn);

      return container;
    };

    // --- Sigma shift (video / audio) ---
    const shiftVWidget = this.node.widgets?.find(w => w.name === "shift_video");
    if (shiftVWidget) {
      menu.appendChild(this._makeSettingRow("Shift Video", createScrubbableNumberControl(shiftVWidget, 0.1, 0.01, 100.0, true)));
    }
    const shiftAWidget = this.node.widgets?.find(w => w.name === "shift_audio");
    if (shiftAWidget) {
      menu.appendChild(this._makeSettingRow("Shift Audio", createScrubbableNumberControl(shiftAWidget, 0.1, 0.01, 100.0, true)));
    }

    // --- Divisible By ---
    const divByWidget = this.node.widgets?.find(w => w.name === "divisible_by");
    if (divByWidget) {
      menu.appendChild(this._makeSettingRow("Divisible By", createScrubbableNumberControl(divByWidget, 1, 1, 256, false)));
    }

    // --- Img Compression ---
    const compWidget = this.node.widgets?.find(w => w.name === "img_compression");
    if (compWidget) {
      menu.appendChild(this._makeSettingRow("Img Compression", createScrubbableNumberControl(compWidget, 1, 0, 100, false)));
    }

    // --- Divider ---
    const folderDivider = document.createElement("div");
    folderDivider.className = "mmxd-settings-divider";
    menu.appendChild(folderDivider);

    // --- Workspace Folder Button ---
    const btnOpenFolder = document.createElement("button");
    btnOpenFolder.className = "mmxd-settings-toggle-btn";
    btnOpenFolder.textContent = "Open";
    btnOpenFolder.style.width = "98px";
    btnOpenFolder.style.margin = "0";
    btnOpenFolder.addEventListener("click", async () => {
      try {
        const response = await api.fetchApi("/minimax_director_open_folder");
        const data = await response.json();
        if (!data.success) {
          console.error("Failed to open workspace folder:", data.error || "Unknown error");
          alert("Could not open workspace folder. This option is only supported when running ComfyUI locally.");
        }
      } catch (err) {
        console.error("Error opening workspace folder:", err);
        alert("Error opening workspace folder: " + err.message);
      }
    });

    menu.appendChild(this._makeSettingRow("Workspace Folder", btnOpenFolder));

    // --- Spacer + Analyze Backend section ---
    const provDivider = document.createElement("div");
    provDivider.className = "mmxd-settings-divider";
    menu.appendChild(provDivider);

    const provTitle = document.createElement("div");
    provTitle.className = "mmxd-settings-title";
    provTitle.style.marginBottom = "2px";
    provTitle.textContent = "Analyze Backend";
    menu.appendChild(provTitle);

    const PROVIDER_DEFAULTS = {
      "off": { url: "", model: "" },
      "ollama": { url: "http://127.0.0.1:11434", model: "qwen2.5vl:7b" },
      "lmstudio": { url: "http://127.0.0.1:1234", model: "" },
      "custom": { url: "", model: "" },
    };

    if (!this.timeline.analyzeProvider) this.timeline.analyzeProvider = "ollama";
    if (this.timeline.analyzeBaseUrl === undefined) this.timeline.analyzeBaseUrl = "";
    if (this.timeline.analyzeModel === undefined) this.timeline.analyzeModel = "";

    const provSelect = document.createElement("select");
    provSelect.className = "mmxd-settings-select";
    [
      { v: "off", label: "Off / Manual (no Analyze)" },
      { v: "ollama", label: "Ollama" },
      { v: "lmstudio", label: "LM Studio" },
      { v: "custom", label: "Custom (OpenAI-compatible)" },
    ].forEach(o => {
      const opt = document.createElement("option");
      opt.value = o.v;
      opt.textContent = o.label;
      provSelect.appendChild(opt);
    });
    provSelect.value = this.timeline.analyzeProvider;

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "mmxd-settings-input";
    urlInput.style.width = "150px";
    urlInput.style.textAlign = "left";

    const modelInput = document.createElement("input");
    modelInput.type = "text";
    modelInput.className = "mmxd-settings-input";
    modelInput.style.width = "150px";
    modelInput.style.textAlign = "left";

    // A cloud endpoint needs a bearer token, and this row is the only part of the panel
    // that is NOT written to the timeline — see ANALYZE_KEY_SETTING. type=password so it
    // is not readable over a shoulder or in the screenshots people attach to issues.
    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.className = "mmxd-settings-input";
    keyInput.style.width = "150px";
    keyInput.style.textAlign = "left";
    keyInput.placeholder = "sk-… (stays on this machine)";
    keyInput.value = getAnalyzeApiKey();

    const urlRow = this._makeSettingRow("Base URL", urlInput);
    const modelRow = this._makeSettingRow("Model", modelInput);
    const keyRow = this._makeSettingRow("API key", keyInput);

    const refreshProviderRows = () => {
      const prov = this.timeline.analyzeProvider || "ollama";
      const defs = PROVIDER_DEFAULTS[prov] || PROVIDER_DEFAULTS.ollama;
      urlInput.placeholder = defs.url || "http://your-server:port";
      modelInput.placeholder = defs.model || "your-loaded-model-name";
      urlInput.value = this.timeline.analyzeBaseUrl || "";
      modelInput.value = this.timeline.analyzeModel || "";
      keyInput.value = getAnalyzeApiKey();
      const isOff = (prov === "off");
      urlRow.style.display = isOff ? "none" : "";
      modelRow.style.display = isOff ? "none" : "";
      // Local servers want no key, so the row would only be one more thing to wonder
      // about; a reverse proxy in front of one is what 'custom' is for.
      keyRow.style.display = (prov === "custom") ? "" : "none";
    };

    provSelect.addEventListener("change", (e) => {
      this.timeline.analyzeProvider = e.target.value;
      this.timeline.analyzeBaseUrl = "";
      this.timeline.analyzeModel = "";
      refreshProviderRows();
      this.updateCharacterSlotsUI();
      this.commitChanges(true);
    });
    urlInput.addEventListener("change", () => {
      this.timeline.analyzeBaseUrl = urlInput.value.trim();
      this.commitChanges(true);
    });
    modelInput.addEventListener("change", () => {
      this.timeline.analyzeModel = modelInput.value.trim();
      this.commitChanges(true);
    });
    // No commitChanges — nothing about the key belongs in the timeline.
    keyInput.addEventListener("change", () => { setAnalyzeApiKey(keyInput.value.trim()); });

    menu.appendChild(this._makeSettingRow("Provider", provSelect));
    menu.appendChild(urlRow);
    menu.appendChild(modelRow);
    menu.appendChild(keyRow);

    const provNote = document.createElement("div");
    provNote.style.fontSize = "9px";
    provNote.style.color = "#777";
    provNote.style.padding = "2px 4px 0";
    provNote.style.lineHeight = "1.3";
    provNote.textContent = "Off = type descriptions by hand. LM Studio / Custom: hard VRAM eviction depends on your server version; set a short JIT/auto-unload TTL there if it doesn't release. An API key is saved in ComfyUI's settings, not in the workflow — or leave it empty and set MINIMAX_DIRECTOR_VLM_API_KEY in the environment.";
    menu.appendChild(provNote);

    refreshProviderRows();

    // Position the menu below the anchor button (pop down)
    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    const menuW = menu.offsetWidth || 230;
    const menuH = menu.offsetHeight || 350;
    let left = rect.right - menuW;
    let top = rect.bottom + 6;
    if (left < 4) left = 4;
    // Fallback to top if it overflows the bottom of the screen
    if (top + menuH > window.innerHeight - 4) {
      top = rect.top - menuH - 6;
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    this._settingsMenu = menu;
    setTimeout(() => {
      this._settingsDismisser = (ev) => {
        if (!menu.contains(ev.target) && !anchorEl.contains(ev.target)) this.dismissSettingsMenu();
      };
      document.addEventListener("pointerdown", this._settingsDismisser, true);
      document.addEventListener("wheel", this._settingsDismisser, true);
    }, 0);
  }

  dismissSettingsMenu() {
    if (this._settingsMenu) { this._settingsMenu.remove(); this._settingsMenu = null; }
    if (this._settingsDismisser) {
      document.removeEventListener("pointerdown", this._settingsDismisser, true);
      document.removeEventListener("wheel", this._settingsDismisser, true);
      this._settingsDismisser = null;
    }
  }


  addSegmentInGap(frameStart, frameEnd, type = "text") {
    const seg = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      start: frameStart, length: frameEnd - frameStart,
      prompt: "", type,
    };
    this.timeline.segments.push(seg);
    this.timeline.segments.sort((a, b) => a.start - b.start);

    if (!this.retakeMode) {
      this.growTimelineIfNeeded(seg.start + seg.length);
    }

    this.selectionType = "image";
    this.selectedIndex = this.timeline.segments.findIndex(s => s.id === seg.id);
    this.updateUIFromSelection();
    this.commitChanges();
  }

  addTextSegmentFreeSpace() {
    const frameRate = this.getFrameRate();
    const newLength = Math.max(1, frameRate); // 1 second default
    const sorted = [...this.timeline.segments].sort((a, b) => a.start - b.start);
    let newStart = 0;
    for (const seg of sorted) {
      if (newStart + newLength <= seg.start) break;
      newStart = Math.max(newStart, seg.start + seg.length);
    }
    // Place the segment at the first free slot in the visual timeline (no output duration change).
    const durationFrames = this.getVisualDurationFrames();
    const seg = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      start: newStart, length: Math.min(newLength, Math.max(newLength, durationFrames - newStart)),
      prompt: "", type: "text",
    };
    this.timeline.segments.push(seg);
    this.timeline.segments.sort((a, b) => a.start - b.start);

    if (!this.retakeMode) {
      this.growTimelineIfNeeded(seg.start + seg.length);
    }

    this.selectionType = "image";
    this.selectedIndex = this.timeline.segments.findIndex(s => s.id === seg.id);
    this.updateUIFromSelection();
    this.commitChanges();
  }

  updateSeekBarBackground() {
    if (!this.seekBar) return;
    const max = parseFloat(this.seekBar.max) || 1;
    const val = parseFloat(this.seekBar.value) || 0;
    const pct = (val / max) * 100;
    this.seekBar.style.background = `linear-gradient(to right, #ff4444 0%, #ff4444 ${pct}%, #444 ${pct}%, #444 100%)`;
  }

  // --- Audio Player Engine ---
  updatePlayerUI() {
    if (!this.playBtn || !this.loopBtn) return;
    this.playBtn.innerHTML = this.isPlaying ? ICONS.pause : ICONS.play;
    if (this.isLooping) {
      this.loopBtn.classList.add("active");
    } else {
      this.loopBtn.classList.remove("active");
    }
    if (this.seekBar) {
      this.seekBar.max = this.getVisualDurationFrames();
      this.seekBar.value = this.currentFrame;
      this.updateSeekBarBackground();
    }
    if (this.timeCodeDisplay) {
      this.timeCodeDisplay.textContent = this.formatTime(this.currentFrame);
    }
  }

  togglePlay() {
    if (this.isPlaying) {
      this.pauseAudio();
    } else {
      const playMax = this.retakeMode 
        ? (this.timeline.retakeVideo ? (this.timeline.retakeVideo.videoDurationFrames || this.getDurationFrames()) : this.getDurationFrames())
        : this.getVisualDurationFrames();
      if (this.currentFrame >= playMax) {
        this.currentFrame = 0;
      }
      this.playAudio();
    }
  }

  toggleLoop() {
    this.isLooping = !this.isLooping;
    this.updatePlayerUI();
  }

  async playAudio() {
    this.pauseAudio(true); // clear any existing playback, but don't suspend context if scrubbing

    this._playCounter = (this._playCounter || 0) + 1;
    const playId = this._playCounter;
    this._currentPlayId = playId;
    this.isPlaying = true;

    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state !== 'running') {
      try { await this.audioContext.resume(); } catch (e) { }
    }
    if (this._currentPlayId !== playId || !this.isPlaying) return;

    this.updatePlayerUI();

    const frameRate = this.getFrameRate();
    this.playbackStartFrame = this.currentFrame;
    this.playbackStartTime = this.audioContext.currentTime;

    // Build the list of active segments to play
    const segmentsToPlay = [];

    // 1. Standard Audio Segments on the audio track (only if the track is enabled and NOT in retake mode)
    if (this.audioTrackEnabled && !this.retakeMode) {
      if (this.timeline.audioSegments) {
        for (let seg of this.timeline.audioSegments) {
          segmentsToPlay.push({
            type: 'audio',
            originalSeg: seg,
            start: seg.start,
            length: seg.length,
            trimStart: seg.trimStart || 0,
            audioFile: seg.audioFile,
            audioB64: seg.audioB64,
            _blobUrl: seg._blobUrl,
            fileSize: seg.fileSize
          });
        }
      }
    }

    // 2. Motion Video Segments (only if overrideAudio toggle is ON and NOT in retake mode)
    const isOverrideAudio = !!(this.node.properties.overrideAudio || this.timeline.overrideAudio);
    if (isOverrideAudio && !this.retakeMode) {
      if (this.timeline.motionSegments) {
        for (let seg of this.timeline.motionSegments) {
          if (seg.videoFile || seg._blobUrl) {
            segmentsToPlay.push({
              type: 'motion',
              originalSeg: seg,
              start: seg.start,
              length: seg.length,
              trimStart: seg.trimStart || 0,
              audioFile: seg.videoFile || seg.fileName,
              audioB64: null,
              _blobUrl: seg._blobUrl,
              fileSize: seg.fileSize
            });
          }
        }
      }
    }

    // Decode and schedule all scheduled segments that happen AT or AFTER currentFrame in the background
    for (let item of segmentsToPlay) {
      const segStartFrame = item.start;
      const segEndFrame = item.start + item.length;

      if (segEndFrame <= this.currentFrame) continue;

      (async () => {
        try {
          // Build mock seg object for helper compatibility
          const mockSeg = {
            audioFile: item.audioFile,
            audioB64: item.audioB64,
            _blobUrl: item._blobUrl,
            fileSize: item.fileSize,
            waveformPeaks: item.originalSeg.waveformPeaks
          };

          await this._getOrExtractAudio(mockSeg);

          if (this._currentPlayId !== playId || !this.isPlaying) return;

          if (mockSeg.waveformPeaks && !item.originalSeg.waveformPeaks) {
            item.originalSeg.waveformPeaks = mockSeg.waveformPeaks;
            this.render();
          }

          if (!this._isAudioDecodingAllowed(mockSeg)) {
            return;
          }

          // Build audio buffer
          let audioBuffer = item.originalSeg._audioBuffer;
          if (!audioBuffer) {
            if (mockSeg.audioFile || mockSeg._blobUrl) {
              const parts = (mockSeg.audioFile || "").split(/[/\\\\]/);
              const filename = parts.pop() || '';
              const subfolder = parts.join('/');
              const audioUrl = mockSeg._blobUrl || api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

              this._audioBufferCache = this._audioBufferCache || new Map();
              this._audioBufferPromises = this._audioBufferPromises || new Map();
              const cacheKey = mockSeg.audioFile || audioUrl;

              if (this._audioBufferCache.has(cacheKey)) {
                audioBuffer = this._audioBufferCache.get(cacheKey);
              } else if (this._audioBufferPromises.has(cacheKey)) {
                audioBuffer = await this._audioBufferPromises.get(cacheKey);
              } else {
                const decodePromise = (async () => {
                  const resp = await fetch(audioUrl);
                  const arrayBuffer = await resp.arrayBuffer();
                  return await this.audioContext.decodeAudioData(arrayBuffer);
                })();
                this._audioBufferPromises.set(cacheKey, decodePromise);
                try {
                  audioBuffer = await decodePromise;
                  this._audioBufferCache.set(cacheKey, audioBuffer);
                } finally {
                  this._audioBufferPromises.delete(cacheKey);
                }
              }
              item.originalSeg._audioBuffer = audioBuffer;
            } else if (mockSeg.audioB64) {
              const binaryString = window.atob(mockSeg.audioB64);
              const len = binaryString.length;
              const bytes = new Uint8Array(len);
              for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              audioBuffer = await this.audioContext.decodeAudioData(bytes.buffer);
              item.originalSeg._audioBuffer = audioBuffer;
            } else {
              return;
            }
          }

          if (this._currentPlayId !== playId || !this.isPlaying) return;

          // Determine current playback position dynamically in Web Audio time
          const currentPlayTime = this.audioContext.currentTime;
          const elapsedSecSincePlayStart = currentPlayTime - this.playbackStartTime;
          const currentFrameCalculated = this.playbackStartFrame + elapsedSecSincePlayStart * frameRate;

          // If playback has already moved beyond the segment end, skip playing it
          if (currentFrameCalculated >= segEndFrame) return;

          let startTime, fileOffsetSec, playDurationSec;

          if (currentFrameCalculated < segStartFrame) {
            // Segment starts in the future relative to current playback position
            const waitFrames = segStartFrame - currentFrameCalculated;
            const waitTimeSec = waitFrames / frameRate;
            startTime = currentPlayTime + waitTimeSec;
            fileOffsetSec = item.trimStart / frameRate;
            playDurationSec = item.length / frameRate;
          } else {
            // Segment is already playing. Start immediately, but offset into the audio buffer
            startTime = currentPlayTime;
            const framesToSkip = currentFrameCalculated - segStartFrame;
            fileOffsetSec = (item.trimStart + framesToSkip) / frameRate;
            playDurationSec = (item.length - framesToSkip) / frameRate;
          }

          if (playDurationSec <= 0) return;

          const bufferNode = this.audioContext.createBufferSource();
          bufferNode.buffer = audioBuffer;
          bufferNode["connect"](this.audioContext.destination);
          bufferNode.start(startTime, fileOffsetSec, playDurationSec);

          this.activeAudioNodes.push(bufferNode);
        } catch (err) {
          console.error("Playback decode error for segment:", err);
        }
      })();
    }

    if (this._currentPlayId !== playId || !this.isPlaying) return;

    const loop = () => {
      if (!this.isPlaying || this._currentPlayId !== playId) return;

      const elapsedSec = this.audioContext.currentTime - this.playbackStartTime;
      const elapsedFrames = elapsedSec * frameRate;

      this.currentFrame = this.playbackStartFrame + elapsedFrames;

      const visualDurationFrames = this.getVisualDurationFrames();
      const durationFrames = this.getDurationFrames();

      let loopBound, stopBound;
      if (this.retakeMode) {
        const retakeLimit = this.timeline.retakeVideo ? (this.timeline.retakeVideo.videoDurationFrames || durationFrames) : durationFrames;
        loopBound = retakeLimit;
        stopBound = retakeLimit;
      } else {
        loopBound = (this.playbackStartFrame >= durationFrames) ? visualDurationFrames : durationFrames;
        stopBound = visualDurationFrames;
      }

      if (this.isLooping) {
        if (this.currentFrame >= loopBound) {
          this.currentFrame = 0;
          this.playAudio(); // Restart playback
          return;
        }
      } else {
        if (this.currentFrame >= stopBound) {
          this.currentFrame = stopBound;
          this.pauseAudio();
          this.render();
          return;
        }
      }

      // Sync video playback
      if (this.retakeMode) {
        if (this.timeline.retakeVideo) {
          const retakeVid = this.timeline.retakeVideo;
          this._ensureVideoEl(retakeVid);
          if (retakeVid.videoEl) {
            const expectedSec = this.currentFrame / frameRate;
            if (retakeVid.videoEl.paused && !retakeVid.videoEl.seeking) {
              retakeVid.videoEl.currentTime = expectedSec;
              retakeVid.videoEl.muted = false;
              retakeVid.videoEl.play().catch(e => console.warn("Retake video play prevented", e));
            } else if (!retakeVid.videoEl.paused && Math.abs(retakeVid.videoEl.currentTime - expectedSec) > 0.5) {
              retakeVid.videoEl.currentTime = expectedSec;
            }
          }
        }
        // Pause all other video elements
        const allSegments = [...(this.timeline.segments || []), ...(this.timeline.motionSegments || [])];
        for (const seg of allSegments) {
          if (seg.videoEl && !seg.videoEl.paused) {
            seg.videoEl.pause();
          }
        }
      } else {
        const activeSegments = (this._isDragging && this._previewSegments && this.selectionType !== "audio") ? this._previewSegments : this.timeline.segments;
        const activeSeg = activeSegments.find(s => s.type === "video" && this.currentFrame >= s.start && this.currentFrame < s.start + s.length);
        const activeVideoEl = activeSeg ? activeSeg.videoEl : null;

        for (const seg of activeSegments) {
          if (seg.type === "video" && seg.videoEl) {
            if (seg === activeSeg) {
              const expectedSec = (seg.trimStart + (this.currentFrame - seg.start)) / frameRate;
              if (seg.videoEl.paused && !seg.videoEl.seeking) {
                // Not playing and no seek in flight — start a fresh seek+play
                seg.videoEl.currentTime = expectedSec;
                seg.videoEl.play().catch(e => console.warn("Video play prevented", e));
              } else if (!seg.videoEl.paused && Math.abs(seg.videoEl.currentTime - expectedSec) > 0.5) {
                // Already playing but drifted — resync
                seg.videoEl.currentTime = expectedSec;
              }
              // If paused && seeking: a seek+play is already in flight, let it finish
            } else {
              // Only pause if this segment's video element is NOT shared with the currently active segment
              if (seg.videoEl !== activeVideoEl && !seg.videoEl.paused) {
                seg.videoEl.pause();
              }
            }
          }
        }
      }

      // Sync motion playback
      if (!this.retakeMode) {
        const activeMotionSegments = (this._isDragging && this._previewSegments && this.selectionType === "motion") ? this._previewSegments : this.timeline.motionSegments;
        const activeMotionSeg = activeMotionSegments.find(s => s.type === "motion_video" && this.currentFrame >= s.start && this.currentFrame < s.start + s.length);
        const activeMotionVideoEl = activeMotionSeg ? activeMotionSeg.videoEl : null;

        for (const seg of activeMotionSegments) {
          if (seg.type === "motion_video" && seg.videoEl) {
            if (seg === activeMotionSeg) {
              const expectedSec = (seg.trimStart + (this.currentFrame - seg.start)) / frameRate;
              if (seg.videoEl.paused && !seg.videoEl.seeking) {
                // Not playing and no seek in flight — start a fresh seek+play
                seg.videoEl.currentTime = expectedSec;
                seg.videoEl.play().catch(e => console.warn("Video play prevented", e));
              } else if (!seg.videoEl.paused && Math.abs(seg.videoEl.currentTime - expectedSec) > 0.5) {
                // Already playing but drifted — resync
                seg.videoEl.currentTime = expectedSec;
              }
              // If paused && seeking: a seek+play is already in flight, let it finish
            } else {
              // Only pause if this segment's video element is NOT shared with the currently active motion segment
              if (seg.videoEl !== activeMotionVideoEl && !seg.videoEl.paused) {
                seg.videoEl.pause();
              }
            }
          }
        }
      }

      this.render();
      this._playLoopId = requestAnimationFrame(loop);
    };

    this._playLoopId = requestAnimationFrame(loop);
  }

  pauseAudio(isScrubbing = false) {
    this.isPlaying = false;
    this._currentPlayId = null;

    if (!isScrubbing && this.audioContext && this.audioContext.state === 'running') {
      try { this.audioContext.suspend(); } catch (e) { }
    }

    if (this.retakeMode && this.timeline.retakeVideo) {
      const retakeVid = this.timeline.retakeVideo;
      if (retakeVid.videoEl) {
        if (!retakeVid.videoEl.paused) {
          retakeVid.videoEl.pause();
        }
        retakeVid.videoEl.muted = true; // Mute again on pause/stop to prevent transient audio bursts
        retakeVid.videoEl.currentTime = this.currentFrame / this.getFrameRate();
      }
    } else {
      // Sync video segments on pause
      for (const seg of this.timeline.segments) {
        if (seg.type === "video" && seg.videoEl) {
          if (!seg.videoEl.paused) {
            seg.videoEl.pause();
          }
          if (this.currentFrame >= seg.start && this.currentFrame < seg.start + seg.length) {
            seg.videoEl.currentTime = (seg.trimStart + (this.currentFrame - seg.start)) / this.getFrameRate();
          }
        }
      }

      // Sync motion segments on pause
      for (const seg of this.timeline.motionSegments) {
        if (seg.type === "motion_video" && seg.videoEl) {
          if (!seg.videoEl.paused) {
            seg.videoEl.pause();
          }
          if (this.currentFrame >= seg.start && this.currentFrame < seg.start + seg.length) {
            seg.videoEl.currentTime = (seg.trimStart + (this.currentFrame - seg.start)) / this.getFrameRate();
          }
        }
      }
    }

    for (let node of this.activeAudioNodes) {
      try { node.stop(); } catch (e) { }
      try { node.disconnect(); } catch (e) { }
    }
    this.activeAudioNodes = [];

    if (this._playLoopId) {
      cancelAnimationFrame(this._playLoopId);
      this._playLoopId = null;
    }
    this.updatePlayerUI();
  }
}

// --- Node Registration Hooks ---
const APPENDED_WIDGET_DEFAULTS = [
  ["timeline_data", "{}"],
  ["local_prompts", ""],
  ["segment_lengths", ""],
];

app.registerExtension({
  name: "MiniMaxH3DirectorCS",
  // Declared here so the key also has a home in ComfyUI's own Settings dialog, and so it
  // is stored server-side per user rather than in the workflow (issue #15).
  settings: [
    {
      id: ANALYZE_KEY_SETTING,
      category: ["MiniMax H3 Director", "Analyze", "API key"],
      name: "Analyze API key",
      tooltip: "Bearer token for a cloud OpenAI-compatible endpoint used by the Analyze "
             + "button. Stored in your ComfyUI user settings, never in a workflow. Leave "
             + "empty to use the MINIMAX_DIRECTOR_VLM_API_KEY or OPENAI_API_KEY "
             + "environment variable instead.",
      type: "text",
      attrs: { type: "password" },
      defaultValue: "",
    },
  ],
  async setup() {
    // On Run, ask the chosen analyze backend to release its model from VRAM so it doesn't
    // compete with MiniMax H3 generation. Only fires when an MiniMax H3 Director is in the graph and its
    // provider isn't "off". Fully tolerant: failures are swallowed so they never block a run.
    if (app._mmxDirectorUnloadHookInstalled) return;
    app._mmxDirectorUnloadHookInstalled = true;
    const origQueuePrompt = app.queuePrompt;
    app.queuePrompt = async function (...args) {
      try {
        const nodes = app.graph?._nodes || [];
        const director = nodes.find(n => n && (n.comfyClass === "MiniMaxH3DirectorCS" || n.type === "MiniMaxH3DirectorCS"));
        if (director) {
          // Read provider settings from the node's saved timeline_data widget.
          let provider = "ollama", baseUrl = "", model = "";
          try {
            const tdWidget = director.widgets?.find(w => w.name === "timeline_data");
            if (tdWidget && tdWidget.value) {
              const td = JSON.parse(tdWidget.value);
              provider = td.analyzeProvider || "ollama";
              baseUrl = td.analyzeBaseUrl || "";
              model = td.analyzeModel || "";
            }
          } catch (e) {}
          if (provider !== "off") {
            try {
              await api.fetchApi("/minimax_director/unload_ollama", {
                method: "POST",
                body: JSON.stringify({ provider, base_url: baseUrl, model,
                                       api_key: getAnalyzeApiKey() }),
              });
            } catch (e) {}
          }
        }
      } catch (e) {}
      return origQueuePrompt.apply(this, args);
    };
  },
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name === "MiniMaxH3DirectorCS") {

      const onNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        if (onNodeCreated) onNodeCreated.apply(this, arguments);

        if (!this.properties) this.properties = {};
        const DEFAULTS = {
          global_prompt: "",
          mainTrackEnabled: true,
          audioTrackEnabled: true,
          motionTrackEnabled: true,
          audioTrackWasEnabledBeforeOverride: false,
          inpaint_audio: true,
          override_audio: false,
          overrideAudio: false,
          showFilenames: true,
          showPromptZones: true,
          showPromptPreview: true,
          use_custom_audio: false,
          use_custom_motion: true,
          frame_rate: 24,
          display_mode: "seconds",
          custom_width: 0,
          custom_height: 0,
          resize_method: "maintain aspect ratio",
          divisible_by: 32,
          img_compression: 0,
          guide_strength: "",
          local_prompts: "",
          segment_lengths: "",
          timeline_data: "{}",
          shift_video: 12.0,
          shift_audio: 3.0,
          ref_image_size: "match",
          start_second: 0.0,
          end_second: 5.0,
          duration_seconds: 5.0,
          start_frame: 0,
          end_frame: 120,
          duration_frames: 120,
        };
        for (const [key, val] of Object.entries(DEFAULTS)) {
          if (this.properties[key] === undefined) {
            this.properties[key] = val;
          }
        }

        for (const [name, def] of APPENDED_WIDGET_DEFAULTS) {
          if (!this.widgets?.find(w => w.name === name)) {
            this.addWidget("string", name, def, () => { });
          }
        }
        const isLiteGraph = !window.LiteGraph || !window.LiteGraph.vueNodesMode;
        for (const w of this.widgets) {
          if (HIDDEN_WIDGET_NAMES.includes(w.name)) {
            hideWidget(w);
            if (isLiteGraph && this.inputs) {
              const idx = this.inputs.findIndex(i => i.name === w.name);
              if (idx !== -1 && this.inputs[idx].link == null) {
                this.removeInput(idx);
              }
            }
          }
        }

        // Set default width to be wider on creation (approx 2.5x default ~220px)
        this.size[0] = 1375;

        // Force default for img_compression if not set (ComfyUI sometimes skips optional defaults)
        const compWidget = this.widgets?.find(w => w.name === "img_compression");
        if (compWidget && (compWidget.value === undefined || compWidget.value === null || compWidget.value === 0)) {
          compWidget.value = 18;
        }

        const self = this;
        this._syncGlobalPromptFromLink = function () {
          const globalInput = self.inputs?.find(i => i.name === "global_prompt");
          if (globalInput && globalInput.link !== null && globalInput.link !== undefined) {
            const link = app.graph.links[globalInput.link];
            if (link) {
              const originNode = app.graph.getNodeById(link.origin_id);
              if (originNode) {
                // Usually string values are in widgets[0] for primitives
                if (originNode.widgets && originNode.widgets.length > 0) {
                  const val = originNode.widgets[0].value;
                  if (self._timelineEditor && self._timelineEditor.globalPromptInput) {
                    const isRetake = self._timelineEditor.retakeMode;
                    const currentValInEditor = isRetake ? (self._timelineEditor.timeline.retake_global_prompt || "") : (self._timelineEditor.timeline.global_prompt || "");
                    if (val !== currentValInEditor) {
                      if (isRetake) {
                        self._timelineEditor.timeline.retake_global_prompt = val;
                      } else {
                        self._timelineEditor.timeline.global_prompt = val;
                      }
                      self._timelineEditor.globalPromptInput.value = val;
                      if (self._timelineEditor.selectionType === "motion") {
                        self._timelineEditor.promptInput.value = val;
                      }
                      if (self.properties) {
                        self.properties.global_prompt = val;
                      }
                    } else if (self._timelineEditor.globalPromptInput.value !== val) {
                      self._timelineEditor.globalPromptInput.value = val;
                    }
                  }
                }
              }
            }
          } else {
            if (self.properties && self._timelineEditor && self._timelineEditor.globalPromptInput) {
              const val = self.properties.global_prompt || "";
              const isRetake = self._timelineEditor.retakeMode;
              const currentValInEditor = isRetake ? (self._timelineEditor.timeline.retake_global_prompt || "") : (self._timelineEditor.timeline.global_prompt || "");
              if (val !== currentValInEditor) {
                if (isRetake) {
                  self._timelineEditor.timeline.retake_global_prompt = val;
                } else {
                  self._timelineEditor.timeline.global_prompt = val;
                }
                self._timelineEditor.globalPromptInput.value = val;
                if (self._timelineEditor.selectionType === "motion") {
                  self._timelineEditor.promptInput.value = val;
                }
              } else if (self._timelineEditor.globalPromptInput.value !== val) {
                self._timelineEditor.globalPromptInput.value = val;
              }
            }
          }
        };

        const origOnConnectionsChange = this.onConnectionsChange;
        this.onConnectionsChange = function (type, index, connected, link_info) {
          if (origOnConnectionsChange) {
            origOnConnectionsChange.apply(this, arguments);
          }
          self._syncGlobalPromptFromLink();
        };

        const origOnDrawForeground = this.onDrawForeground;
        this.onDrawForeground = function (ctx) {
          if (origOnDrawForeground) {
            origOnDrawForeground.apply(this, arguments);
          }
          self._syncGlobalPromptFromLink();
        };

        // --- MiniMax H3 Director settings panel (Stage 1: Resolution | Timing/Reference) ---
        const _mmxBuildSettingsPanel = (node, panelRoot) => {
          const getW = (name) => (node.widgets ? node.widgets.find(w => w.name === name) : null);
          const setW = (name, val) => {
            const w = getW(name);
            if (!w) return;
            w.value = val;
            if (w.callback) { try { w.callback(val); } catch (e) {} }
            if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
          };
          // Frame-rate change: render length comes from duration_frames, so we must recompute
          // the frame-count widgets from the (constant) seconds values x new fps. The editor's
          // own recompute is wired for the fps slider; a dropdown/number change needs this.
          const applyFrameRate = (newFPS) => {
            const w = getW("frame_rate");
            const oldFPS = (w && parseInt(w.value) > 0) ? parseInt(w.value) : 24;
            if (w) w.value = newFPS;
            const syncFrm = (secName, frmName, minV) => {
              const sw = getW(secName), fw = getW(frmName);
              if (sw && fw) fw.value = Math.max(minV, Math.round((parseFloat(sw.value) || 0) * newFPS));
            };
            syncFrm("start_second", "start_frame", 0);
            syncFrm("end_second", "end_frame", 1);
            syncFrm("duration_seconds", "duration_frames", 1);
            const ed = node._timelineEditor;
            if (ed) {
              try {
                ed._prevFrameRate = oldFPS;
                if (ed._rebaseSegmentsToFPS) ed._rebaseSegmentsToFPS(newFPS);
                ed._prevFrameRate = newFPS;
                if (ed.commitChanges) ed.commitChanges();
              } catch (e) { console.error("[MiniMaxDirector] fps recompute:", e); }
            }
            if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
          };

          Object.assign(panelRoot.style, {
            display: "flex", gap: "8px", width: "100%", boxSizing: "border-box", padding: "0 2px",
          });

          const mkCol = (title) => {
            const col = document.createElement("div");
            Object.assign(col.style, {
              flex: "1", minWidth: "0", display: "flex", flexDirection: "column", gap: "5px",
              background: "#1e1e1e", border: "1px solid #3a3a3a", borderRadius: "8px", padding: "8px",
            });
            const h = document.createElement("div");
            h.textContent = title;
            Object.assign(h.style, {
              fontSize: "9px", fontWeight: "700", color: "#7a7a7a", letterSpacing: "0.6px",
              textTransform: "uppercase", marginBottom: "1px",
            });
            col.appendChild(h);
            return col;
          };
          const mkRow = (labelText) => {
            const row = document.createElement("div");
            Object.assign(row.style, {
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px", minHeight: "20px",
            });
            const lab = document.createElement("span");
            lab.textContent = labelText;
            Object.assign(lab.style, { color: "#9a9a9a", fontSize: "11px", flexShrink: "0" });
            row.appendChild(lab);
            return row;
          };
          const sIn = (el, w) => Object.assign(el.style, {
            background: "#2b2b2b", border: "1px solid #484848", borderRadius: "4px", color: "#eaeaea",
            padding: "1px 5px", fontSize: "11px", width: (w || "86px"), boxSizing: "border-box",
            textAlign: "right", outline: "none",
          });
          const sSel = (el, w) => {
            el.classList.add("mmxd-dropdown");
            el.style.width = (w || "126px");
            el.style.boxSizing = "border-box";
          };

          // ---------- LEFT: Resolution ----------
          const left = mkCol("Resolution");
          // MiniMax H3's native canvas is a 768 px short edge capped at 768x1344, and every
          // edge here is a multiple of 32: H3's own step, and what divisible_by defaults to,
          // so a preset is never quietly floored to something else on the way in.
          // Native holds the 768 short edge, and holds the long edge at 1344 for the two
          // widest ratios, letting the short edge give way instead. That 1344 is THIS
          // TABLE's ceiling, not the model's: adapt_canvas in comfy_extras/nodes_minimax_h3
          // is a 768 short edge plus an AREA cap of 768*1344, so at 21:9 the model's own
          // policy returns 1536x672 and this preset's 1344x576 spends a quarter less canvas
          // than it is allowed. Deliberate — a preset is the safe answer, and the
          // Aspect / MP row below is how you spend the whole budget at a wide ratio.
          // Fast is the same list at a 480 short edge.
          //
          // One entry sits past native, and says so. 1920x1088 is NOT what the model card
          // means by 2K, and calling it that was misleading (issue #14): the card's 2K comes
          // from H3-Regenerate-2K, a separate in-context regeneration module that MiniMax
          // has not open-sourced: "this module is not yet open-sourced. We will release
          // it once it is ready." What the preset does is render the base model well past
          // its own canvas, at real cost in time and memory, so it is labelled as what it is
          // rather than after a module that is not here.
          const RES = [
            { label: "Custom", w: 0, h: 0 },
            { head: "Native \u2014 768 short edge" },
            { label: "21:9 \u2014 1344\u00d7576", w: 1344, h: 576 },
            { label: "2:1 \u2014 1344\u00d7672", w: 1344, h: 672 },
            { label: "16:9 \u2014 1344\u00d7768", w: 1344, h: 768 },
            { label: "3:2 \u2014 1152\u00d7768", w: 1152, h: 768 },
            { label: "4:3 \u2014 1024\u00d7768", w: 1024, h: 768 },
            { label: "5:4 \u2014 960\u00d7768", w: 960, h: 768 },
            { label: "1:1 \u2014 992\u00d7992", w: 992, h: 992 },
            { label: "4:5 \u2014 768\u00d7960", w: 768, h: 960 },
            { label: "3:4 \u2014 768\u00d71024", w: 768, h: 1024 },
            { label: "2:3 \u2014 768\u00d71152", w: 768, h: 1152 },
            { label: "9:16 \u2014 768\u00d71344", w: 768, h: 1344 },
            { label: "1:2 \u2014 672\u00d71344", w: 672, h: 1344 },
            { label: "9:21 \u2014 576\u00d71344", w: 576, h: 1344 },
            { head: "Fast \u2014 480 short edge" },
            { label: "21:9 fast \u2014 1120\u00d7480", w: 1120, h: 480 },
            { label: "2:1 fast \u2014 960\u00d7480", w: 960, h: 480 },
            { label: "16:9 fast \u2014 864\u00d7480", w: 864, h: 480 },
            { label: "3:2 fast \u2014 736\u00d7480", w: 736, h: 480 },
            { label: "4:3 fast \u2014 640\u00d7480", w: 640, h: 480 },
            { label: "5:4 fast \u2014 608\u00d7480", w: 608, h: 480 },
            { label: "1:1 fast \u2014 640\u00d7640", w: 640, h: 640 },
            { label: "4:5 fast \u2014 480\u00d7608", w: 480, h: 608 },
            { label: "3:4 fast \u2014 480\u00d7640", w: 480, h: 640 },
            { label: "2:3 fast \u2014 480\u00d7736", w: 480, h: 736 },
            { label: "9:16 fast \u2014 480\u00d7864", w: 480, h: 864 },
            { label: "1:2 fast \u2014 480\u00d7960", w: 480, h: 960 },
            { label: "9:21 fast \u2014 480\u00d71120", w: 480, h: 1120 },
            { head: "Past native \u2014 outside the trained canvas" },
            { label: "16:9 past native \u2014 1920\u00d71088", w: 1920, h: 1088 },
          ];
          const presetRow = mkRow("Preset");
          const presetSel = createMenuSelect(
            RES.map((p, i) => (p.head ? { header: true, label: p.head }
                                      : { value: String(i), label: p.label })),
            { width: "126px" });
          presetRow.appendChild(presetSel); left.appendChild(presetRow);

          const widthRow = mkRow("Width");
          const widthIn = document.createElement("input"); widthIn.type = "number"; widthIn.step = "32"; widthIn.min = "0"; sIn(widthIn);
          widthRow.appendChild(widthIn); left.appendChild(widthRow);

          const heightRow = mkRow("Height");
          const heightIn = document.createElement("input"); heightIn.type = "number"; heightIn.step = "32"; heightIn.min = "0"; sIn(heightIn);
          heightRow.appendChild(heightIn); left.appendChild(heightRow);

          const wW = getW("custom_width"), hW = getW("custom_height");
          widthIn.value = wW ? wW.value : 768;
          heightIn.value = hW ? hW.value : 512;

          // The other way round: name a shape and a pixel budget instead of a canvas. The
          // ratio picks the shape, the megapixel figure picks how much canvas to spend on
          // it, and the two boxes above are filled with the best pair of /32 edges that
          // holds the ratio. 1.03 MP is H3's native 1344x768 area, so leaving the budget
          // where a preset put it and only changing the ratio re-shapes a canvas without
          // making it cost more. The MP box shows what the snapped edges actually came to,
          // not what was asked for.
          const ASPECTS = [
            { label: "21:9", r: 21 / 9 },
            { label: "2:1", r: 2 },
            { label: "16:9", r: 16 / 9 },
            { label: "3:2", r: 1.5 },
            { label: "4:3", r: 4 / 3 },
            { label: "5:4", r: 1.25 },
            { label: "1:1", r: 1 },
            { label: "4:5", r: 0.8 },
            { label: "3:4", r: 0.75 },
            { label: "2:3", r: 2 / 3 },
            { label: "9:16", r: 9 / 16 },
            { label: "1:2", r: 0.5 },
            { label: "9:21", r: 9 / 21 },
          ];
          // Both edges have to be multiples of 32, which usually means no pair holds the
          // ratio exactly, so pick the best of the four pairs around the ideal one rather
          // than snapping each edge on its own: snapping independently drifts up to 6% off
          // ratio, and snapping one and deriving the other drifts differently per
          // orientation — portrait 9:16 at 1.03 MP gives 768x1376 that way, where landscape
          // gives H3's own 1344x768.
          // Ratio error is what the user actually asked about, so it outweighs missing the
          // budget, and overshooting the budget is penalised twice as hard as undershooting
          // it: memory is the thing a budget is protecting.
          const fitAspect = (px, r) => {
            const edges = (v) => {
              const f = Math.max(32, Math.floor(v / 32) * 32), c = Math.max(32, Math.ceil(v / 32) * 32);
              return f === c ? [f] : [f, c];
            };
            let best = [768, 768], bestScore = Infinity;
            for (const w of edges(Math.sqrt(px * r))) {
              for (const h of edges(Math.sqrt(px / r))) {
                const score = Math.abs(w / h - r) / r
                            + (w * h > px ? 0.5 : 0.25) * Math.abs(w * h - px) / px;
                if (score < bestScore) { bestScore = score; best = [w, h]; }
              }
            }
            return best;
          };
          const aspectRow = mkRow("Aspect / MP");
          const aspectWrap = document.createElement("div");
          Object.assign(aspectWrap.style, { display: "flex", gap: "4px", alignItems: "center" });
          // The budget box is the full 86px of the Width and Height boxes, not the frame-rate
          // row's 48px, so it lines up with them and has room for "0.98" *and* the number
          // input's spin buttons — which sit on top of right-aligned text rather than beside
          // it, and clipped the last digit at 48px. The column has the width to spare; the
          // row runs wider than the others and stays right-aligned with them.
          const aspSel = createMenuSelect(ASPECTS.map((a, i) => ({ value: String(i), label: a.label })),
                                          { width: "74px", placeholder: "—" });
          aspSel.title = "Aspect ratio. Picking one keeps the current pixel budget and "
                       + "re-shapes the canvas to /32 edges.";
          const mpIn = document.createElement("input");
          mpIn.type = "number"; mpIn.step = "0.05"; mpIn.min = "0.01"; mpIn.max = "8"; sIn(mpIn, "86px");
          mpIn.title = "Pixel budget in megapixels. H3's native canvas is 1.03 MP "
                     + "(1344x768); past that you are outside its trained envelope.";
          aspectWrap.appendChild(aspSel); aspectWrap.appendChild(mpIn);
          aspectRow.appendChild(aspectWrap); left.insertBefore(aspectRow, widthRow);

          const syncPreset = () => {
            const cw = parseInt(widthIn.value) || 0, ch = parseInt(heightIn.value) || 0;
            const idx = RES.findIndex(p => p.w === cw && p.h === ch);
            presetSel.value = String(idx > 0 ? idx : 0);
          };
          const syncAspect = () => {
            const cw = parseInt(widthIn.value) || 0, ch = parseInt(heightIn.value) || 0;
            if (cw <= 0 || ch <= 0) { mpIn.value = ""; aspSel.value = ""; return; }
            mpIn.value = (cw * ch / 1e6).toFixed(2);
            // 4% is wide enough that the /32 fit always reads back as the ratio it was
            // picked from — 1344x768 is 1.6% off true 16:9, and the worst fit in the whole
            // ratio x budget sweep, a 0.25 MP 4:3, is 3.8% — while the nearest ratio wins
            // regardless, so the closest pair in the list (5:4 and 4:3, 6.7% apart) never
            // ends up ambiguous.
            const r = cw / ch;
            let best = -1, bestErr = 0.04;
            ASPECTS.forEach((a, i) => {
              const e = Math.abs(r - a.r) / a.r;
              if (e < bestErr) { bestErr = e; best = i; }
            });
            aspSel.value = best >= 0 ? String(best) : "";
          };
          const applyCanvas = (w, h) => {
            widthIn.value = w; heightIn.value = h;
            setW("custom_width", w); setW("custom_height", h);
            syncPreset(); syncAspect();
          };
          const applyAspectMp = () => {
            // Either box on its own is enough. With no ratio picked — the boxes hold a shape
            // this list does not name, or a preset was never chosen — a budget rescales the
            // shape that is already there rather than doing nothing; with nothing there at
            // all, both fall back to H3's native canvas.
            const a = ASPECTS[parseInt(aspSel.value)];
            const cw = parseInt(widthIn.value) || 0, ch = parseInt(heightIn.value) || 0;
            const r = a ? a.r : ((cw > 0 && ch > 0) ? cw / ch : 1344 / 768);
            let mp = parseFloat(mpIn.value);
            if (isNaN(mp) || mp <= 0) mp = 1344 * 768 / 1e6;
            const [w, h] = fitAspect(mp * 1e6, r);
            applyCanvas(w, h);
          };
          presetSel.addEventListener("change", () => {
            const p = RES[parseInt(presetSel.value)];
            if (p && p.w > 0) applyCanvas(p.w, p.h);
          });
          aspSel.addEventListener("change", applyAspectMp);
          mpIn.addEventListener("change", applyAspectMp);
          widthIn.addEventListener("change", () => { let v = Math.round(parseFloat(widthIn.value)); if (isNaN(v) || v < 0) v = 0; widthIn.value = v; setW("custom_width", v); syncPreset(); syncAspect(); });
          heightIn.addEventListener("change", () => { let v = Math.round(parseFloat(heightIn.value)); if (isNaN(v) || v < 0) v = 0; heightIn.value = v; setW("custom_height", v); syncPreset(); syncAspect(); });

          const FPS = [24, 25, 30, 48, 60];
          const fpsRow = mkRow("Frame rate");
          const fpsWrap = document.createElement("div"); Object.assign(fpsWrap.style, { display: "flex", gap: "4px", alignItems: "center" });
          const fpsSel = createMenuSelect([{ value: "0", label: "Custom" }].concat(FPS.map(v => ({ value: String(v), label: v + " fps" }))), { width: "74px" });
          const fpsIn = document.createElement("input"); fpsIn.type = "number"; fpsIn.min = "1"; sIn(fpsIn, "48px");
          const frW = getW("frame_rate"); fpsIn.value = frW ? frW.value : 24;
          const syncFps = () => { const v = parseInt(fpsIn.value) || 0; fpsSel.value = (FPS.indexOf(v) >= 0) ? String(v) : "0"; };
          fpsSel.addEventListener("change", () => { const v = parseInt(fpsSel.value) || 0; if (v > 0) { fpsIn.value = v; applyFrameRate(v); } });
          fpsIn.addEventListener("change", () => { let v = Math.round(parseFloat(fpsIn.value)); if (isNaN(v) || v < 1) v = 1; fpsIn.value = v; applyFrameRate(v); syncFps(); });
          fpsWrap.appendChild(fpsSel); fpsWrap.appendChild(fpsIn);
          fpsRow.appendChild(fpsWrap); left.appendChild(fpsRow);

          syncPreset(); syncAspect(); syncFps();

          // ---- shared seconds<->frames timing infrastructure ----
          const TIME_NAMES = ["start_second", "end_second", "duration_seconds", "start_frame", "end_frame", "duration_frames"];
          const timeMode = () => { const dm = getW("display_mode"); return (dm && dm.value === "frames") ? "frames" : "seconds"; };
          const hideTimingWidgets = () => {
            const isLG = !window.LiteGraph || !window.LiteGraph.vueNodesMode;
            for (const nm of TIME_NAMES) {
              const w = getW(nm);
              if (w) hideWidget(w);
              if (isLG && node.inputs) {
                const i = node.inputs.findIndex(sl => sl.name === nm);
                if (i !== -1 && node.inputs[i].link == null) node.removeInput(i);
              }
            }
          };
          const ensureTimingHidden = () => {
            const ed = node._timelineEditor;
            if (ed && typeof ed.updateWidgetVisibility === "function" && !ed._mmxTimingPatched) {
              const orig = ed.updateWidgetVisibility.bind(ed);
              ed.updateWidgetVisibility = function () { orig(); hideTimingWidgets(); };
              ed._mmxTimingPatched = true;
            }
            hideTimingWidgets();
          };
          const timeRefreshers = [];
          const mkTimeRow = (parentCol, labelText, secName, frmName, minSec, minFrm) => {
            const row = document.createElement("div");
            Object.assign(row.style, { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px", minHeight: "20px" });
            const labWrap = document.createElement("div");
            Object.assign(labWrap.style, { display: "flex", alignItems: "baseline", gap: "4px" });
            const lab = document.createElement("span"); lab.textContent = labelText;
            Object.assign(lab.style, { color: "#9a9a9a", fontSize: "11px" });
            const unit = document.createElement("span"); Object.assign(unit.style, { color: "#666", fontSize: "9px" });
            labWrap.appendChild(lab); labWrap.appendChild(unit);
            const input = document.createElement("input"); input.type = "number"; sIn(input, "86px");
            row.appendChild(labWrap); row.appendChild(input); parentCol.appendChild(row);
            const refresh = () => {
              if (timeMode() === "frames") { const w = getW(frmName); if (w) input.value = w.value; input.step = "1"; unit.textContent = "fr"; }
              else { const w = getW(secName); if (w) input.value = w.value; input.step = "0.01"; unit.textContent = "s"; }
            };
            input.addEventListener("change", () => {
              let v = parseFloat(input.value);
              if (isNaN(v)) v = 0;
              if (timeMode() === "frames") { v = Math.max(minFrm, Math.round(v)); setW(frmName, v); }
              else { v = Math.max(minSec, v); setW(secName, parseFloat(v.toFixed(3))); }
              timeRefreshers.forEach(fn => fn());
            });
            timeRefreshers.push(refresh);
            refresh();
            return input;
          };
          mkTimeRow(left, "Duration", "duration_seconds", "duration_frames", 0.1, 1);

          // ---------- RIGHT: Timing / Reference ----------
          const right = mkCol("Timing / Reference");
          const unitRow = mkRow("Units");
          const unitSel = createMenuSelect([{ value: "seconds", label: "Seconds" }, { value: "frames", label: "Frames" }], { width: "100px" });
          unitSel.value = timeMode();
          unitSel.addEventListener("change", () => {
            const w = getW("display_mode");
            const mode = unitSel.value;
            if (w) { w.value = mode; if (w.callback) { try { w.callback(mode); } catch (e) {} } }
            ensureTimingHidden();
            timeRefreshers.forEach(fn => fn());
            if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
          });
          unitRow.appendChild(unitSel); right.appendChild(unitRow);
          mkTimeRow(right, "Start", "start_second", "start_frame", 0, 0);
          mkTimeRow(right, "End", "end_second", "end_frame", 0, 1);
          const rmRow = mkRow("Resize");
          const rmW = getW("resize_method");
          let rmVals = (rmW && rmW.options && rmW.options.values) ? rmW.options.values : null;
          if (!rmVals || !rmVals.length) rmVals = ["stretch to fit", "maintain aspect ratio", "crop to fit"];
          const rmSel = createMenuSelect(rmVals.map(v => ({ value: v, label: v })), { width: "126px" });
          if (rmW) rmSel.value = rmW.value;
          rmSel.addEventListener("change", () => setW("resize_method", rmSel.value));
          rmRow.appendChild(rmSel); right.appendChild(rmRow);

          // ref2va only: how reference images are sized before they are encoded.
          // "match" scales them to the generation's pixel area (fast); "max" keeps a
          // 2048 px short edge for stronger identity, but ref tokens ride along every
          // sampling step, so it costs real time.
          const refRow = mkRow("Ref size");
          const refSel = createMenuSelect(
            [{ value: "match", label: "match (fast)" }, { value: "max", label: "max (identity)" }],
            { width: "126px" });
          const rsW = getW("ref_image_size"); refSel.value = rsW ? rsW.value : "match";
          refSel.addEventListener("change", () => setW("ref_image_size", refSel.value));
          refRow.appendChild(refSel); right.appendChild(refRow);

          panelRoot.appendChild(left);
          panelRoot.appendChild(right);

          // Re-read widget values into the panel. Saved values are restored AFTER onNodeCreated,
          // so we must refresh on load (onConfigure + a post-tick) or the panel shows defaults.
          const refreshFromWidgets = () => {
            const cw = getW("custom_width"), ch = getW("custom_height"), fr = getW("frame_rate"),
                  rm = getW("resize_method"), rs = getW("ref_image_size");
            if (cw) widthIn.value = cw.value;
            if (ch) heightIn.value = ch.value;
            if (fr) fpsIn.value = fr.value;
            if (rm && rm.value != null) rmSel.value = rm.value;
            if (rs && rs.value != null) refSel.value = rs.value;
            syncPreset(); syncAspect(); syncFps();
            if (typeof unitSel !== "undefined" && unitSel) unitSel.value = timeMode();
            timeRefreshers.forEach(fn => fn());
            ensureTimingHidden();
            // also on load: configure() restores whatever slots the saved JSON carried,
            // including the invisible ones a pre-0.2.1 workflow was saved with
            ["custom_width", "custom_height", "frame_rate", "resize_method", "ref_image_size"]
              .forEach(n => dropUnlinkedWidgetInput(node, n));
          };
          node._mmxSettingsRefresh = refreshFromWidgets;
          refreshFromWidgets();
          setTimeout(refreshFromWidgets, 0);
          requestAnimationFrame(refreshFromWidgets);
          setTimeout(refreshFromWidgets, 60);
          setTimeout(refreshFromWidgets, 250);

          ["custom_width", "custom_height", "frame_rate", "resize_method", "ref_image_size"]
            .forEach(n => { hideWidget(getW(n)); dropUnlinkedWidgetInput(node, n); });
          ensureTimingHidden();
        };
        const settingsContainer = document.createElement("div");
        settingsContainer.style.boxSizing = "border-box";
        _mmxBuildSettingsPanel(this, settingsContainer);
        const settingsWidget = this.addDOMWidget("minimax_settings_ui", "minimax_settings_ui", settingsContainer, {
          getValue: () => "",
          setValue: () => { },
        });
        // Tall enough for the longer of the two columns: Resolution carries six rows since
        // the aspect/megapixel row joined it, and a DOM widget that is short by a row
        // clips it rather than scrolling.
        settingsWidget.computeSize = function () { return [0, 210]; };
        const _mmxOrigOnConfigure = this.onConfigure;
        this.onConfigure = function () {
          if (_mmxOrigOnConfigure) _mmxOrigOnConfigure.apply(this, arguments);
          if (this._mmxSettingsRefresh) { try { this._mmxSettingsRefresh(); } catch (e) {} }
        };

        const container = document.createElement("div");

        container.style.boxSizing = "border-box";
        const widget = this.addDOMWidget("timeline_ui", "timeline_ui", container, {
          getValue: () => "",
          setValue: () => { },
        });

        widget.computeSize = function (width) {
          const canvasH = self._timelineEditor ? self._timelineEditor.canvasHeight : CANVAS_HEIGHT;
          const propH = self._timelineEditor ? (self._timelineEditor.propHeight || 90) : 90;
          const globalPropH = self._timelineEditor ? (self._timelineEditor.globalPropHeight || 60) : 60;
          // Reserve room for the @refN reference panel at the bottom so the node doesn't
          // collapse and crop it whenever ComfyUI recomputes the node height.
          const charPanelH = self._timelineEditor
            ? (self._timelineEditor.charPanelHeight || subjectPanelHeight(3, self.properties?.subjectSlotHeight))
            : subjectPanelHeight(3, self.properties?.subjectSlotHeight);
          const nodeWidth = self.size?.[0] || width || 1375;
          return [Math.max(10, nodeWidth - 30), canvasH + propH + globalPropH + charPanelH + 160];
        };

        // --- Live prompt preview -------------------------------------------------
        // Shows the storyboard the Director will actually encode. The text comes from
        // the same Python planner the node runs, so this panel cannot drift from the
        // real prompt the way a re-implementation in JS would.
        const promptBox = document.createElement("div");
        Object.assign(promptBox.style, {
          display: "flex", flexDirection: "column", gap: "4px", width: "100%",
          boxSizing: "border-box", background: "#1e1e1e", border: "1px solid #3a3a3a",
          borderRadius: "8px", padding: "6px 8px",
        });

        const pHead = document.createElement("div");
        Object.assign(pHead.style, {
          display: "flex", alignItems: "center", gap: "8px", cursor: "pointer",
          userSelect: "none",
        });
        const pCaret = document.createElement("span");
        pCaret.textContent = "▾";
        Object.assign(pCaret.style, { color: "#7a7a7a", fontSize: "10px", width: "10px" });
        const pTitle = document.createElement("span");
        pTitle.textContent = "COMPILED PROMPT";
        Object.assign(pTitle.style, {
          color: "#7a7a7a", fontSize: "9px", fontWeight: "700", letterSpacing: "0.6px",
        });
        const pBadge = document.createElement("span");
        Object.assign(pBadge.style, {
          color: "#8a8a8a", fontSize: "9px", fontFamily: "monospace", marginLeft: "auto",
        });
        pHead.appendChild(pCaret); pHead.appendChild(pTitle); pHead.appendChild(pBadge);

        const pWarn = document.createElement("div");
        Object.assign(pWarn.style, {
          color: "#d8a657", fontSize: "10px", lineHeight: "1.35", display: "none",
        });
        const pText = document.createElement("pre");
        pText.textContent = "…";
        Object.assign(pText.style, {
          margin: "0", padding: "6px", background: "#141414", border: "1px solid #303030",
          borderRadius: "4px", color: "#cfcfcf", fontSize: "11px", lineHeight: "1.4",
          whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "190px",
          overflowY: "auto", fontFamily: "ui-monospace, Consolas, monospace",
        });

        // --- writing the prompt by hand ---------------------------------------------
        // The panel normally shows what the timeline compiles to. `Edit` swaps in a
        // textarea whose contents are stored in the timeline and sent verbatim instead.
        //
        // Stored, not merged: there is no honest way to fold an edit back into a
        // recompile. Discarding it when a segment moves loses work without asking; keeping
        // it silently while the timeline says something else leaves a prompt that no
        // longer matches the screen. So the override is explicit, marked while it is on,
        // and `Revert` puts the compiled text back.
        const pEdit = document.createElement("textarea");
        pEdit.spellcheck = false;
        pEdit.placeholder = "Write the prompt yourself. The timeline still decides which "
          + "images, videos and audio are loaded — only the text is yours.";
        Object.assign(pEdit.style, {
          display: "none", margin: "0", padding: "6px", background: "#141414",
          border: "1px solid #4a4a4a", borderRadius: "4px", color: "#e6e6e6",
          fontSize: "11px", lineHeight: "1.4", height: "190px", resize: "none",
          fontFamily: "ui-monospace, Consolas, monospace", boxSizing: "border-box",
          outline: "none", width: "100%",
        });

        const mkPBtn = (label, title) => {
          const b = document.createElement("button");
          b.textContent = label;
          b.title = title;
          Object.assign(b.style, {
            background: "#2a2a2a", color: "#d0d0d0", border: "1px solid #444",
            borderRadius: "4px", fontSize: "9px", fontFamily: "inherit", height: "18px",
            padding: "0 7px", cursor: "pointer", letterSpacing: "0.4px",
          });
          b.addEventListener("mouseenter", () => { b.style.background = "#383838"; });
          b.addEventListener("mouseleave", () => { b.style.background = "#2a2a2a"; });
          b.addEventListener("click", (e) => e.stopPropagation());
          return b;
        };
        const pEditBtn = mkPBtn("EDIT", "Write this prompt by hand instead of compiling it");
        const pRevertBtn = mkPBtn("REVERT", "Throw the hand-written text away and compile again");
        pRevertBtn.style.display = "none";
        pHead.appendChild(pEditBtn);
        pHead.appendChild(pRevertBtn);

        const tlOf = () => self._timelineEditor?.timeline;
        const isOverridden = () => !!tlOf()?.prompt_override_on;

        const applyPromptMode = () => {
          const on = isOverridden();
          pTitle.textContent = on ? "PROMPT (HAND-WRITTEN)" : "COMPILED PROMPT";
          pTitle.style.color = on ? "#d8a657" : "#7a7a7a";
          pEditBtn.style.display = on ? "none" : "inline-block";
          pRevertBtn.style.display = on ? "inline-block" : "none";
          pText.style.display = (pCollapsed || on) ? "none" : "block";
          pEdit.style.display = (pCollapsed || !on) ? "none" : "block";
        };
        this._mmxApplyPromptMode = applyPromptMode;

        pEditBtn.addEventListener("click", () => {
          const t = tlOf();
          if (!t) return;
          // start from whatever is on screen, so nobody has to retype the compiled text
          t.prompt_override = pText.textContent || "";
          t.prompt_override_on = true;
          pEdit.value = t.prompt_override;
          applyPromptMode();
          self._timelineEditor.commitChanges(true);
          self._mmxRefreshPrompt?.();
          pEdit.focus();
        });

        pRevertBtn.addEventListener("click", () => {
          const t = tlOf();
          if (!t) return;
          t.prompt_override_on = false;
          t.prompt_override = "";
          applyPromptMode();
          self._timelineEditor.commitChanges(true);
          self._mmxRefreshPrompt?.();
        });

        pEdit.addEventListener("input", () => {
          const t = tlOf();
          if (!t) return;
          t.prompt_override = pEdit.value;
          self._timelineEditor.commitChanges(true);
        });

        promptBox.appendChild(pHead);
        promptBox.appendChild(pWarn);
        promptBox.appendChild(pText);
        promptBox.appendChild(pEdit);

        let pCollapsed = false;
        pHead.addEventListener("click", () => {
          pCollapsed = !pCollapsed;
          pCaret.textContent = pCollapsed ? "▸" : "▾";
          applyPromptMode();
          pWarn.style.display = (pCollapsed || !pWarn.textContent) ? "none" : "block";
          applyPanelHeight(true);
        });

        // Fixed height (min == max) so this panel never eats the timeline's space, and
        // declared through the layout API rather than computeSize — see the note in
        // minimax_preview.js about why computeSize ratchets node heights.
        const promptPanelHeight = () => {
          if (self.properties?.showPromptPreview === false) return 0;
          return pCollapsed ? 34 : 250;
        };
        const promptWidget = this.addDOMWidget("minimax_prompt_preview",
          "minimax_prompt_preview", promptBox, {
            getValue: () => "", setValue: () => {},
            getMinHeight: promptPanelHeight,
            getMaxHeight: promptPanelHeight,
          });
        // not serialised: keeps widgets_values the same length as before this panel existed
        promptWidget.serialize = false;

        // Changing what getMinHeight/getMaxHeight report is not enough on its own. The
        // frontend re-reads them in node.arrange(), and the draw loop only calls arrange()
        // for nodes whose `_widgetSlotsDirty` flag is set — setDirtyCanvas alone just
        // repaints. Without the flag the node body is drawn at its new height while the
        // widget's `position: fixed` overlay keeps the old one: an invisible strip left
        // lying over the canvas that eats clicks and hands right-clicks to the browser's
        // context menu instead of ComfyUI's.
        let pAppliedHeight = promptPanelHeight();
        const applyPanelHeight = (resizeNode) => {
          const next = promptPanelHeight();
          const delta = next - pAppliedHeight;
          pAppliedHeight = next;
          if (resizeNode && delta) {
            const floor = (typeof self.computeSize === "function") ? self.computeSize()[1] : 0;
            self.setSize([self.size[0], Math.max(floor, self.size[1] + delta)]);
          }
          self._widgetSlotsDirty = true;   // makes the next frame re-arrange the widgets
          self.setDirtyCanvas(true, true);
          if (self.graph) self.graph.setDirtyCanvas(true, true);
        };

        // toggled from the gear menu; `initial` is the call made on load, where the saved
        // node size already accounts for the panel and must not be adjusted again
        this._mmxSetPromptPreview = (enabled, initial) => {
          promptBox.style.display = enabled ? "flex" : "none";
          if (promptWidget.element) promptWidget.element.style.display = enabled ? "flex" : "none";
          // refreshed either way: the canvas badges anchors from the same answer, and a
          // badge that only appears while the prompt panel is open reads as a bug
          self._mmxRefreshPrompt();
          applyPanelHeight(!initial);
        };

        let pTimer = null;
        const w = (name) => self.widgets?.find(x => x.name === name);
        const refreshPrompt = async () => {
          try {
            const refNotes = w("ref_image_notes")?.value || "";
            const refTrimmed = refNotes.replace(/\s+$/, "");
            const refNoteCount = refTrimmed ? refTrimmed.split("\n").length : 0;
            const body = {
              timeline_data: w("timeline_data")?.value || "",
              start_frame: w("start_frame")?.value || 0,
              duration_frames: w("duration_frames")?.value || 1,
              frame_rate: w("frame_rate")?.value || 24,
              use_custom_motion: !!w("use_custom_motion")?.value,
              use_custom_audio: !!w("use_custom_audio")?.value,
              override_audio: !!w("override_audio")?.value,
              global_prompt: self.properties?.global_prompt || "",
              // a widget, so the panel must ship it or it would show pictures the node
              // describes and the preview does not
              ref_image_notes: refNotes,
              // How many images are on the ref_images wire is not knowable here — it is a
              // tensor that only exists once the graph runs. The described ones are, so
              // the panel previews those. Wire more than you describe and the node will
              // number more than the panel shows; describe them and the two agree.
              extra_ref_image_count: refNoteCount,
              // Which is why the wire's own state goes too: with nothing described there
              // is no count to preview at all, and the endpoint turns that into a caveat
              // rather than showing <Picture 2> where the render will send <Picture 5>.
              ref_images_connected:
                self.inputs?.find(i => i.name === "ref_images")?.link != null,
            };
            const resp = await api.fetchApi("/minimax_director/compile_prompt", {
              method: "POST", body: JSON.stringify(body),
            });
            const d = await resp.json();
            if (d.status !== "success") throw new Error(d.message || "compile failed");
            pText.textContent = d.prompt || "";
            // slot -> <Subject N>, straight from the planner, for the properties panel's
            // "Voice of" menu to label itself by. Cached because that menu is built on
            // selection, not on this refresh — and re-read here, because adding or deleting
            // a reference image changes what it should say while it is already on screen.
            self._mmxSubjectOfSlot = d.subject_of_slot || {};
            self._timelineEditor?.refreshAudioSubjectMenu?.();
            // segment id -> the output frame it is anchored at. The planner owns that
            // conversion — the timeline runs at the editor's fps and the anchor at the
            // model's 24 — and the canvas only draws the answer.
            self._mmxAnchors = d.anchors || {};
            self._mmxAnchorFps = d.anchor_fps || 24;
            self._timelineEditor?.render?.();
            // Keep the textarea in step with what is stored, but never while it has the
            // caret — clobbering someone's sentence mid-word is unforgivable.
            if (d.overridden && document.activeElement !== pEdit
                && pEdit.value !== (d.prompt || "")) {
              pEdit.value = d.prompt || "";
            }
            self._mmxApplyPromptMode?.();
            // The word count is information, not a verdict: the guide suggests 350-500 for
            // generation tasks, which is a lot for a 5-15s clip, so it sits in the badge
            // where it can be glanced at rather than in the warnings where it would fire
            // on almost every timeline.
            pBadge.textContent = `${d.mode} · ${d.format || ""} · ${d.shots} shot${d.shots === 1 ? "" : "s"} · `
              + `${d.length}f / ${d.seconds}s · refs ${d.refs.images}i/${d.refs.videos}v/${d.refs.audios}a`
              + (d.words ? ` · ${d.words} words` : "");
            pBadge.title = d.words
              ? `detailed_description is about ${d.words} words. The guide suggests 350-500 `
                + `for generation tasks; editing descriptions scale with the source instead.`
              : "";
            pWarn.textContent = (d.warnings || []).join("  •  ");
            pWarn.style.display = (!pCollapsed && pWarn.textContent) ? "block" : "none";
          } catch (e) {
            pBadge.textContent = "preview unavailable";
            // badges from a timeline that no longer compiles would keep naming frames
            // nothing is anchored at any more
            self._mmxAnchors = {};
            self._timelineEditor?.render?.();
            pWarn.textContent = String(e.message || e);
            pWarn.style.display = pCollapsed ? "none" : "block";
          }
          self.setDirtyCanvas(true, false);
        };
        this._mmxRefreshPrompt = () => {
          clearTimeout(pTimer);
          pTimer = setTimeout(refreshPrompt, 350);
        };

        setTimeout(() => {
          try {
            self._timelineEditor = new TimelineEditor(self, container, widget);
            // every edit funnels through commitChanges, so that is the one hook needed
            const ed = self._timelineEditor;
            if (ed && typeof ed.commitChanges === "function" && !ed._mmxPromptHooked) {
              const orig = ed.commitChanges.bind(ed);
              ed.commitChanges = function (...a) {
                const r = orig(...a);
                self._mmxRefreshPrompt();
                return r;
              };
              ed._mmxPromptHooked = true;
            }
            // honour the saved gear-menu setting on load
            self._mmxSetPromptPreview(self.properties?.showPromptPreview !== false, true);
          } catch (err) {
            console.error("[MiniMaxDirector] timeline editor init failed:", err);
          }
        }, 0);
      };

      const onResize = nodeType.prototype.onResize;
      nodeType.prototype.onResize = function (size) {
        const out = onResize?.apply(this, arguments);
        if (this._timelineEditor) {
          requestAnimationFrame(() => this._timelineEditor?.syncLayoutToNode());
        }
        return out;
      };

      const onRemoved = nodeType.prototype.onRemoved;
      nodeType.prototype.onRemoved = function () {
        this._timelineEditor?.destroy();
        return onRemoved?.apply(this, arguments);
      };

      const onConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function (info) {
        // 1. Call parent/original onConfigure first, with info.widgets_values intact
        const out = onConfigure ? onConfigure.apply(this, arguments) : undefined;

        if (info.properties) {
          this.properties = { ...this.properties, ...info.properties };
        }

        mmxdLog("[MiniMaxDirector debug] onConfigure called. info.widgets_values:", info.widgets_values ? JSON.stringify(info.widgets_values) : "undefined");

        // Helper to set widget value, sync DOM element, and trigger callbacks safely
        const setWidgetValue = (w, val) => {
          if (!w) return;
          w.value = val;
          if (w.element) {
            if (w.element.type === "checkbox") {
              w.element.checked = !!val;
            } else {
              w.element.value = val;
            }
          }
          if (w.callback) {
            try {
              w.callback(val);
            } catch (e) {
              // ignore
            }
          }
        };

        // 2. Check if we have serialized properties. If so, restore widgets from properties!
        if (info.properties && info.properties.has_serialized_properties) {
          mmxdLog("[MiniMaxDirector debug] Restoring widgets from properties");
          if (this.widgets) {
            for (const w of this.widgets) {
              if (w.name && this.properties[w.name] !== undefined) {
                setWidgetValue(w, this.properties[w.name]);
              }
            }
          }
        } else if (info.widgets_values) {
          // No legacy positional remap here. This node has shipped with serialized
          // properties from day one, and ComfyUI already applied info.widgets_values
          // against the CURRENT widget order before onConfigure ran. Re-mapping through a
          // hardcoded LTX widget order would only shuffle values around — and would reset
          // timeline_data to "{}", wiping the timeline. Adopt what is on the node instead.
          mmxdLog("[MiniMaxDirector debug] No serialized properties — adopting current widget values");

          const ALL_WIDGET_DEFAULTS = {
            inpaint_audio: true,
            override_audio: false,
            use_custom_audio: false,
            use_custom_motion: true,
            frame_rate: 24,
            display_mode: "seconds",
            custom_width: 0,
            custom_height: 0,
            resize_method: "maintain aspect ratio",
            divisible_by: 32,
            img_compression: 0,
            guide_strength: "",
            local_prompts: "",
            segment_lengths: "",
            timeline_data: "{}",
            shift_video: 12.0,
            shift_audio: 3.0,
            ref_image_size: "match",
            start_second: 0.0,
            end_second: 5.0,
            duration_seconds: 5.0,
            start_frame: 0,
            end_frame: 120,
            duration_frames: 120,
          };

          // Only fill in widgets that carry no value at all; never overwrite a restored one.
          if (this.widgets) {
            for (const w of this.widgets) {
              if (w.value === undefined && ALL_WIDGET_DEFAULTS.hasOwnProperty(w.name)) {
                setWidgetValue(w, ALL_WIDGET_DEFAULTS[w.name]);
              }
            }
          }

          // Populate properties with these restored values
          if (this.widgets) {
            for (const w of this.widgets) {
              if (w.name && w.value !== undefined) {
                this.properties[w.name] = w.value;
              }
            }
          }
          this.properties.has_serialized_properties = true;
        }

        for (const [name, def] of APPENDED_WIDGET_DEFAULTS) {
          const w = this.widgets.find(x => x.name === name);
          if (w && (w.value == null || w.value === "")) w.value = def;
        }

        // A widget added since this workflow was saved takes a row the saved height never
        // allowed for, and the DOM panels below it will not shrink past their floors — so
        // the timeline and the prompt preview end up hanging out of the node body. A fresh
        // node sits exactly on computeSize(), which means every older workflow is short by
        // whatever the new widget occupies; ref_image_notes is 66px of textarea. Grow to
        // the minimum, never shrink: anything above it is the user's own sizing.
        const minHeight = this.computeSize()[1];
        if (this.size[1] < minHeight) {
          this.size[1] = minHeight;
          // the draw loop only re-arranges widgets for nodes carrying this flag; without
          // it the body redraws taller while the overlays keep their old positions
          this._widgetSlotsDirty = true;
          this.setDirtyCanvas?.(true, true);
        }

        setTimeout(() => {
          if (this._timelineEditor) {
            mmxdLog("[MiniMaxDirector debug] setTimeout sync block called.");
            mmxdLog("[MiniMaxDirector debug] setTimeout: timelineDataWidget value:", this._timelineEditor.timelineDataWidget?.value);
            const tl = parseInitial(this._timelineEditor.timelineDataWidget?.value);
            mmxdLog("[MiniMaxDirector debug] setTimeout: parsed timeline:", JSON.stringify(tl));
            this._timelineEditor.timeline = tl;

            // Sync editor states from the parsed timeline object (the absolute source of truth)
            this._timelineEditor.mainTrackEnabled = tl.mainTrackEnabled !== false;
            this._timelineEditor.audioTrackEnabled = tl.audioTrackEnabled !== false;
            this._timelineEditor.motionTrackEnabled = tl.motionTrackEnabled !== false;
            this._timelineEditor.retakeMode = tl.retakeMode === true;
            this._timelineEditor._audioTrackWasEnabledBeforeOverride = !!this.properties.audioTrackWasEnabledBeforeOverride;

            // Sync properties to match
            this.properties.mainTrackEnabled = this._timelineEditor.mainTrackEnabled;
            this.properties.audioTrackEnabled = this._timelineEditor.audioTrackEnabled;
            this.properties.motionTrackEnabled = this._timelineEditor.motionTrackEnabled;
            this.properties.retakeMode = this._timelineEditor.retakeMode;
            if (tl.showFilenames !== undefined) {
              this.properties.showFilenames = tl.showFilenames;
            }
            if (tl.showPromptZones !== undefined) {
              this.properties.showPromptZones = tl.showPromptZones;
            }
            if (tl.overrideAudio !== undefined) {
              this.properties.overrideAudio = tl.overrideAudio;
            }
            if (tl.inpaint_audio !== undefined) {
              this.properties.inpaint_audio = tl.inpaint_audio;
            }

            // Sync widgets to match the timeline data
            const inpaintWidget = this.widgets?.find(w => w.name === "inpaint_audio");
            if (inpaintWidget && tl.inpaint_audio !== undefined) {
              inpaintWidget.value = tl.inpaint_audio;
            }
            const overrideWidget = this.widgets?.find(w => w.name === "override_audio");
            if (overrideWidget && tl.overrideAudio !== undefined) {
              overrideWidget.value = tl.overrideAudio;
            }

            this._timelineEditor.loadMedia();
            this._timelineEditor.selectionType = "image";
            this._timelineEditor.selectedIndex = clamp(
              this._timelineEditor.selectedIndex, -1,
              Math.max(-1, this._timelineEditor.timeline.segments.length - 1)
            );
            this._timelineEditor.updateRetakeUIState();
            this._timelineEditor.updateUIFromSelection();
            this._timelineEditor.syncWidgetsAndUI();
            if (this._timelineEditor.updateCharacterSlotsUI) this._timelineEditor.updateCharacterSlotsUI();
            this._timelineEditor.syncLayoutToNode();
            this._timelineEditor.render();
          }
        }, 0);

        return out;
      };

      const onSerialize = nodeType.prototype.onSerialize;
      nodeType.prototype.onSerialize = function (info) {
        if (onSerialize) {
          onSerialize.apply(this, arguments);
        }

        // Sync all current widgets to properties
        if (this.widgets) {
          for (const w of this.widgets) {
            if (w.name && w.value !== undefined) {
              this.properties[w.name] = w.value;
            }
          }
        }

        // Sync timeline editor state if it exists
        if (this._timelineEditor) {
          this.properties.mainTrackEnabled = this._timelineEditor.mainTrackEnabled !== false;
          this.properties.audioTrackEnabled = this._timelineEditor.audioTrackEnabled !== false;
          this.properties.motionTrackEnabled = this._timelineEditor.motionTrackEnabled !== false;
          this.properties.audioTrackWasEnabledBeforeOverride = !!this._timelineEditor._audioTrackWasEnabledBeforeOverride;
        }

        // Mark that properties have been serialized
        this.properties.has_serialized_properties = true;

        // Ensure info.properties is populated with all our properties
        info.properties = { ...this.properties };
      };
    }
  },
});
